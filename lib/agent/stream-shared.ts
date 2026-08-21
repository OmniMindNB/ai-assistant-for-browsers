// lib/agent/stream-shared.ts
// 协议无关的流式响应内部状态与事件构建工具，供 openai-stream.ts / anthropic-stream.ts 共用。
import type { AssistantMessage, AssistantMessageEvent, Api, ImageContent, Model, ToolCall, Usage } from '@earendil-works/pi-ai';

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

/**
 * 统一描述 LLM HTTP 失败。协议下拉框与 Base URL 是两个互不校验的独立字段，任一填错都只表现为
 * 一句 4xx：不带请求 URL 就分不清「路径拼错」还是「模型名在该端点不存在」（方舟对后者返回
 * 404 "The model or endpoint xxx does not exist"），而网关直接拒绝时 body 往往是空的，此时
 * 旧文案会退化成没有任何信息的 "LLM 请求失败 (404 )"。所以 URL 和模型名必须写进报错本身。
 */
export function describeHttpFailure(
  status: number,
  statusText: string,
  detail: string,
  url: string,
  modelId: string,
): string {
  const head = `LLM 请求失败 (${[status, statusText].filter(Boolean).join(' ')})`;
  const body = detail.trim() ? `：${detail.trim()}` : '：服务端未返回错误详情';
  const hint =
    status === 404
      ? '\n404 通常意味着请求路径或模型名不存在（API Key 本身是有效的），请核对设置页的「协议」下拉框是否与 Base URL 匹配，以及该模型在此端点下是否可用。'
      : '';
  return `${head}${body}\n请求地址：${url}\n模型：${modelId}${hint}`;
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

export function extractImageParts(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ImageContent =>
      Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'image'),
  );
}
