// lib/agent/openai-stream.ts
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type ToolCall, type Usage, type UserMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { buildPartial, createAssistantMessage, describeHttpFailure, extractImageParts, finishStream, stringifyContent, type ToolCallAccumulator } from './stream-shared';

// OpenAI 生态的约定与 Anthropic 相反：版本段写在 base_url 里，客户端只补 `/chat/completions`
// （参见 anthropicMessagesUrl 的反向说明）。这里不替用户补版本段——各厂商版本段互不相同
// （OpenAI `/v1`、智谱 `/v4`、方舟 Coding Plan `/api/coding/v3`），猜错只会把 404 换个地方报。
// 唯一兜底的是「整条端点粘进设置页」这个高频手滑，避免拼成 `/chat/completions/chat/completions`。
export function openAiCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

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

// Mirrors mapAnthropicStopReason in anthropic-stream.ts: without reading `finish_reason`, a
// response truncated by the token limit (e.g. a reasoning model whose thinking/commentary ate the
// whole budget before any visible content) is silently reported as a normal "stop".
function mapOpenAiFinishReason(finishReason: string | null | undefined, hasToolCalls: boolean): 'stop' | 'toolUse' | 'length' {
  if (hasToolCalls || finishReason === 'tool_calls') return 'toolUse';
  if (finishReason === 'length') return 'length';
  return 'stop';
}

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
  let finishReason: string | null | undefined;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  // 弱模型兜底：模型没走 tool_calls 而把调用写进正文时，finishStream 据此把它捞回来。
  const toolNames = context.tools?.map((tool) => tool.name) ?? [];

  push({ type: 'start', partial });

  try {
    const url = openAiCompletionsUrl(model.baseUrl);
    const response = await fetch(url, {
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
      throw new Error(describeHttpFailure(response.status, response.statusText, detail, url, model.id));
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
          finishStream(model, push, startedAt, text, toolCalls, mapOpenAiFinishReason(finishReason, toolCalls.size > 0), toolNames);
          return;
        }
        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        processChunk(chunk, model, push, startedAt, text, toolCalls, (delta) => {
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
    finishStream(model, push, startedAt, text, toolCalls, mapOpenAiFinishReason(finishReason, toolCalls.size > 0), toolNames);
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

function convertMessages(context: Context): Array<Record<string, unknown>> {
  return context.messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: convertUserContent(message.content) };
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

/**
 * 无图片时必须原样返回 stringifyContent() 拍平出的纯字符串，不能因为这次改动把所有
 * user content 都换成数组形态——否则会改变既有请求体的形状。
 */
export function convertUserContent(content: UserMessage['content']): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  const images = extractImageParts(content);
  if (images.length === 0) return stringifyContent(content);
  const parts: Array<Record<string, unknown>> = [];
  const text = stringifyContent(content);
  if (text) parts.push({ type: 'text', text });
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
  }
  return parts;
}
