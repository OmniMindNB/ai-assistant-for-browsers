// lib/agent/stream-shared.ts
// 协议无关的流式响应内部状态与事件构建工具，供 openai-stream.ts / anthropic-stream.ts 共用。
import type { AssistantMessage, AssistantMessageEvent, Api, Model, ToolCall, Usage } from '@earendil-works/pi-ai';

export interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createAssistantMessage(
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

export function buildPartial(
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

export function finishStream(
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

export function parseToolArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
