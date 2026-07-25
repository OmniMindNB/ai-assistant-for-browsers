// lib/agent/anthropic-stream.ts
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { buildPartial, createAssistantMessage, finishStream, stringifyContent, type ToolCallAccumulator } from './stream-shared';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicSseEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  delta?: { type?: string; text?: string; partial_json?: string };
  error?: { message?: string };
}

export const browserAnthropicStream: StreamFn = (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();

  void runAnthropicStream(model, context, options, stream.push.bind(stream));

  return stream;
};

async function runAnthropicStream(
  model: Model<Api>,
  context: Context,
  options: Parameters<StreamFn>[2],
  push: (event: AssistantMessageEvent) => void,
): Promise<void> {
  const startedAt = Date.now();
  const partial = createAssistantMessage(model, startedAt, 'stop');
  let text = '';
  let textStarted = false;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const toolBlockIndexes = new Set<number>();
  const toolDeltaSeen = new Set<number>();

  function toolContentIndex(blockIndex: number): number {
    return (text ? 1 : 0) + [...toolCalls.keys()].sort((a, b) => a - b).indexOf(blockIndex);
  }

  push({ type: 'start', partial });

  try {
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options?.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
        ...(model.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        system: context.systemPrompt,
        messages: convertMessagesForAnthropic(context),
        tools: context.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        max_tokens: options?.maxTokens ?? model.maxTokens,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${response.status} ${response.statusText})${detail ? `：${detail}` : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (!data) continue;
        const event = JSON.parse(data) as AnthropicSseEvent;

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'text') {
          if (!textStarted) {
            textStarted = true;
            push({ type: 'text_start', contentIndex: 0, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          continue;
        }

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'tool_use') {
          toolBlockIndexes.add(event.index);
          toolCalls.set(event.index, {
            id: event.content_block.id ?? `tool-${event.index}`,
            name: event.content_block.name ?? '',
            // Seed with any inline `input` the server sent up front (some Anthropic-compatible
            // vendors emit the full arguments here and no input_json_delta events at all). If
            // deltas do arrive later, the first one resets this and rebuilds argumentsText from
            // scratch — see the input_json_delta handler below.
            argumentsText: event.content_block.input ? JSON.stringify(event.content_block.input) : '',
          });
          push({
            type: 'toolcall_delta',
            contentIndex: toolContentIndex(event.index),
            delta: '',
            partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
          });
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          text += event.delta.text;
          push({ type: 'text_delta', contentIndex: 0, delta: event.delta.text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          continue;
        }

        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'input_json_delta' &&
          event.index !== undefined &&
          toolBlockIndexes.has(event.index)
        ) {
          const accumulator = toolCalls.get(event.index);
          const delta = event.delta.partial_json ?? '';
          if (accumulator) {
            // First delta for this block wins over any inline `input` seeded at
            // content_block_start — deltas are assembled from scratch, not appended to it.
            if (!toolDeltaSeen.has(event.index)) {
              toolDeltaSeen.add(event.index);
              accumulator.argumentsText = '';
            }
            accumulator.argumentsText += delta;
          }
          push({
            type: 'toolcall_delta',
            contentIndex: toolContentIndex(event.index),
            delta,
            partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
          });
          continue;
        }

        if (event.type === 'error') {
          throw new Error(event.error?.message ?? 'Anthropic 流式请求返回错误');
        }

        if (event.type === 'message_stop') {
          if (textStarted) {
            push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          finishStream(model, push, startedAt, text, toolCalls, 'stop');
          return;
        }
      }
    }

    if (textStarted) {
      push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
    }
    finishStream(model, push, startedAt, text, toolCalls, toolCalls.size > 0 ? 'toolUse' : 'stop');
  } catch (error) {
    const message = createAssistantMessage(model, startedAt, 'error', error instanceof Error ? error.message : String(error));
    push({ type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: message });
  }
}

function isToolResultGroup(content: unknown): content is Array<{ type: string }> {
  return Array.isArray(content) && content.length > 0 && (content[0] as { type?: string })?.type === 'tool_result';
}

export function convertMessagesForAnthropic(context: Context): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of context.messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'text', text: stringifyContent(message.content) }] });
      continue;
    }
    if (message.role === 'toolResult') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: stringifyContent(message.content),
      };
      const prev = result[result.length - 1];
      if (prev && prev.role === 'user' && isToolResultGroup(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        // Anthropic rejects empty-string text blocks; skip them rather than pushing `{ type: 'text', text: '' }`.
        if (!part.text.trim()) continue;
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'toolCall') {
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.arguments });
      }
    }
    // Anthropic rejects messages with an empty `content` array (e.g. an assistant message left
    // over from a generation stopped before any text/tool call streamed) — drop it entirely
    // rather than emitting `{ role: 'assistant', content: [] }`.
    if (content.length === 0) continue;
    result.push({ role: 'assistant', content });
  }
  return result;
}
