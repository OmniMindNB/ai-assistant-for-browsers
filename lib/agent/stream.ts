import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Model, type ToolCall, type Usage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Partial<Usage>;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const browserOpenAIStream: StreamFn = (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();

  void runOpenAIStream(model, context, options, stream.push.bind(stream));

  return stream;
};

async function runOpenAIStream(
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

  push({ type: 'start', partial });

  try {
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options?.apiKey ?? ''}`,
        ...(model.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        messages: convertMessages(context),
        tools: context.tools?.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: context.tools?.length ? 'auto' : undefined,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
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
        if (data === '[DONE]') {
          if (textStarted) {
            push({
              type: 'text_end',
              contentIndex: 0,
              content: text,
              partial: buildPartial(model, startedAt, text, toolCalls, 'stop'),
            });
          }
          finishStream(model, push, startedAt, text, toolCalls, 'stop');
          return;
        }
        processChunk(JSON.parse(data) as OpenAIStreamChunk, model, push, startedAt, text, toolCalls, (delta) => {
          if (!textStarted) {
            textStarted = true;
            push({ type: 'text_start', contentIndex: 0, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          text += delta;
          push({ type: 'text_delta', contentIndex: 0, delta, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
        });
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

function processChunk(
  chunk: OpenAIStreamChunk,
  model: Model<Api>,
  push: (event: AssistantMessageEvent) => void,
  startedAt: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  appendText: (delta: string) => void,
): void {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (!delta) return;

  if (delta.content) appendText(delta.content);

  for (const toolCall of delta.tool_calls ?? []) {
    const current = toolCalls.get(toolCall.index) ?? {
      id: toolCall.id ?? `tool-${toolCall.index}`,
      name: '',
      argumentsText: '',
    };
    if (toolCall.id) current.id = toolCall.id;
    if (toolCall.function?.name) current.name = toolCall.function.name;
    if (toolCall.function?.arguments) current.argumentsText += toolCall.function.arguments;
    toolCalls.set(toolCall.index, current);
    push({
      type: 'toolcall_delta',
      contentIndex: text ? toolCall.index + 1 : toolCall.index,
      delta: toolCall.function?.arguments ?? '',
      partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
    });
  }
}

function finishStream(
  model: Model<Api>,
  push: (event: AssistantMessageEvent) => void,
  timestamp: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  fallbackReason: 'stop' | 'toolUse' | 'length',
): void {
  const reason = toolCalls.size > 0 ? 'toolUse' : fallbackReason;
  const message = buildPartial(model, timestamp, text, toolCalls, reason);
  let contentIndex = text ? 1 : 0;
  for (const toolCall of message.content) {
    if (toolCall.type !== 'toolCall') continue;
    push({ type: 'toolcall_end', contentIndex, toolCall, partial: message });
    contentIndex += 1;
  }
  push({ type: 'done', reason, message });
}

function buildPartial(
  model: Model<Api>,
  timestamp: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: parseToolArguments(call.argumentsText),
    } satisfies ToolCall);
  }
  return { ...createAssistantMessage(model, timestamp, stopReason), content };
}

function createAssistantMessage(
  model: Model<Api>,
  timestamp: number,
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    errorMessage,
    timestamp,
  };
}

function parseToolArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function convertMessages(context: Context): Array<Record<string, unknown>> {
  return context.messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: stringifyContent(message.content) };
    }
    if (message.role === 'toolResult') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: stringifyContent(message.content),
      };
    }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const toolCalls = message.content
      .filter((part): part is ToolCall => part.type === 'toolCall')
      .map((part) => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.arguments) },
      }));
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  });
}
