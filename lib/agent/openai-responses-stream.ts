// lib/agent/openai-responses-stream.ts
// OpenAI Responses API（POST /v1/responses）的 streamFn
// （ref: docs/superpowers/specs/2026-10-20-openai-responses-api-design.md）。
// OpenAI 自 GPT-6 Astra / GPT-6.1 Sol 起只在 Responses 上支持工具调用，Chat Completions
// 只剩文本对话，所以这是与 openai-stream.ts 并列的第三种协议，而不是它的一个开关。
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type ToolCall, type UserMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { buildPartial, createAssistantMessage, createThinkingEmitter, describeHttpFailure, describeStreamError, extractImageParts, fetchLlmWithRetry, finishStream, stringifyContent, type ToolCallAccumulator } from './stream-shared';
import { readOpenAiResponsesUsage, recordPerfUsage } from './perf-trace';

// 与 openAiCompletionsUrl 同一约定：版本段写在 baseURL 里，客户端只补 `/responses`；
// 唯一兜底的是把整条端点粘进设置页的手滑。
export function openAiResponsesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesStreamEvent {
  type: string;
  output_index?: number;
  delta?: string;
  arguments?: string;
  item?: ResponsesOutputItem;
  message?: string;
  code?: string;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string; code?: string } | null;
    usage?: unknown;
  };
}

// Responses 没有 finish_reason：函数调用以 output 条目出现，截断则是 response.incomplete 且
// reason 为 max_output_tokens。与另外两条流一样，截断必须报成 'length'，不能当正常结束。
export function mapResponsesStopReason(
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): 'stop' | 'toolUse' | 'length' {
  if (hasToolCalls) return 'toolUse';
  if (incompleteReason === 'max_output_tokens') return 'length';
  return 'stop';
}

export const browserOpenAIResponsesStream: StreamFn = (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();

  void runResponsesStream(model, context, options, stream.push.bind(stream));

  return stream;
};

async function runResponsesStream(
  model: Model<Api>,
  context: Context,
  options: Parameters<StreamFn>[2],
  push: (event: AssistantMessageEvent) => void,
): Promise<void> {
  const startedAt = Date.now();
  const partial = createAssistantMessage(model, startedAt, 'stop');
  let text = '';
  let textStarted = false;
  // 以 output_index 为键：同一响应里的并行函数调用各占一个 output 条目。
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const toolNames = context.tools?.map((tool) => tool.name) ?? [];
  // 推理只走事件、不进 content、不回传——与另两条流一致。我们不请求推理摘要（部分组织
  // 需要额外验证才能开启，开了反而可能 400），只有端点主动推送推理文本时才会走到这里。
  const thinking = createThinkingEmitter(push, () => buildPartial(model, startedAt, text, toolCalls, 'stop'));
  let url = model.baseUrl;

  const appendText = (delta: string) => {
    if (!delta) return;
    thinking.end();
    if (!textStarted) {
      textStarted = true;
      push({ type: 'text_start', contentIndex: 0, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
    }
    text += delta;
    push({ type: 'text_delta', contentIndex: 0, delta, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
  };

  const finish = (incompleteReason: string | undefined) => {
    thinking.end();
    if (textStarted) {
      push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
    }
    finishStream(model, push, startedAt, text, toolCalls, mapResponsesStopReason(incompleteReason, toolCalls.size > 0), toolNames);
  };

  push({ type: 'start', partial });

  try {
    url = openAiResponsesUrl(model.baseUrl);
    const response = await fetchLlmWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options?.apiKey ?? ''}`,
        ...(model.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        ...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
        input: convertResponsesInput(context),
        tools: context.tools?.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          // 省略 strict 时 Responses 会尝试严格模式并改写 schema 的约束语义；我们的工具参数
          // 有可选字段，按 Chat Completions 一直以来的非严格语义处理。
          strict: false,
        })),
        tool_choice: context.tools?.length ? 'auto' : undefined,
        // 不发 temperature：当前 OpenAI 推理模型对采样参数不保证接受，默认值本就合适。
        max_output_tokens: options?.maxTokens,
        // 不在 OpenAI 侧留存对话：每轮都完整重放历史，用不到服务端状态（隐私默认值）。
        store: false,
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
        // Responses 的 SSE 同时带 `event:` 行，但 data 里的 JSON 自带 type，只读 data 即可。
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as ResponsesStreamEvent;

        switch (event.type) {
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            appendText(event.delta ?? '');
            break;
          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta':
            thinking.delta(event.delta ?? '');
            break;
          case 'response.output_item.added':
          case 'response.output_item.done': {
            const item = event.item;
            if (item?.type !== 'function_call' || event.output_index === undefined) break;
            thinking.end();
            const current = toolCalls.get(event.output_index) ?? {
              id: item.call_id ?? item.id ?? `tool-${event.output_index}`,
              name: '',
              argumentsText: '',
            };
            if (item.call_id) current.id = item.call_id;
            if (item.name) current.name = item.name;
            // done 事件里的 arguments 是完整权威值；added 时通常为空串，增量随后到。
            if (event.type === 'response.output_item.done' && typeof item.arguments === 'string') {
              current.argumentsText = item.arguments;
            }
            toolCalls.set(event.output_index, current);
            break;
          }
          case 'response.function_call_arguments.delta': {
            if (event.output_index === undefined) break;
            const current = toolCalls.get(event.output_index);
            if (!current) break;
            current.argumentsText += event.delta ?? '';
            push({
              type: 'toolcall_delta',
              contentIndex: (text ? 1 : 0) + [...toolCalls.keys()].sort((a, b) => a - b).indexOf(event.output_index),
              delta: event.delta ?? '',
              partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
            });
            break;
          }
          case 'response.function_call_arguments.done': {
            if (event.output_index === undefined || typeof event.arguments !== 'string') break;
            const current = toolCalls.get(event.output_index);
            if (current) current.argumentsText = event.arguments;
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            const usage = readOpenAiResponsesUsage(event.response?.usage);
            if (usage) recordPerfUsage(usage);
            finish(event.response?.incomplete_details?.reason ?? undefined);
            return;
          }
          case 'response.failed':
            throw new Error(event.response?.error?.message || 'Responses API 返回 response.failed，未附错误信息');
          case 'error':
            throw new Error(event.message || event.code || 'Responses API 流中返回了 error 事件');
          default:
            break;
        }
      }
    }

    // 流在终止事件之前就断了：按已收到的内容收尾，与另两条流的行为一致。
    finish(undefined);
  } catch (error) {
    thinking.end();
    const aborted = Boolean(options?.signal?.aborted);
    const message = createAssistantMessage(
      model,
      startedAt,
      aborted ? 'aborted' : 'error',
      describeStreamError(error, url, model.id),
    );
    push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
  }
}

function imagePart(image: { mimeType: string; data: string }): Record<string, unknown> {
  return { type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` };
}

/** 用户消息：无图片时保持纯字符串，有图片时拆成 input_text + input_image。 */
export function convertResponsesUserContent(content: UserMessage['content']): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  const images = extractImageParts(content);
  if (images.length === 0) return stringifyContent(content);
  const parts: Array<Record<string, unknown>> = [];
  const text = stringifyContent(content);
  if (text) parts.push({ type: 'input_text', text });
  for (const image of images) parts.push(imagePart(image));
  return parts;
}

/**
 * context.messages → Responses 的 input 条目列表。
 *
 * 与 Chat Completions 的两处关键差异：
 * - 函数调用与其结果是独立条目（function_call / function_call_output），以 call_id 关联；
 *   重放 function_call 时刻意不带条目 id（fc_…）——带了 id 而不带对应的 reasoning 条目会被
 *   推理模型拒绝，而我们按设计不回传推理。
 * - function_call_output.output 可以直接是 input_text + input_image 数组，截图留在它所属的
 *   工具结果里，不需要 openai-stream.ts 那种「合成一条 user 消息」的绕法；工具结果文本里
 *   已带 untrusted-content 提示，图片与它同处一条，不会脱离那句声明。
 */
export function convertResponsesInput(context: Context): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of context.messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: convertResponsesUserContent(message.content) });
      continue;
    }
    if (message.role === 'toolResult') {
      const images = extractImageParts(message.content);
      const text = stringifyContent(message.content);
      result.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: images.length
          ? [...(text ? [{ type: 'input_text', text }] : []), ...images.map(imagePart)]
          : text,
      });
      continue;
    }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text) result.push({ role: 'assistant', content: text });
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      const call = part as ToolCall;
      result.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return result;
}
