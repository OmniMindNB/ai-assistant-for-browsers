// lib/agent/anthropic-stream.ts
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { splitSystemPromptForCache } from './system-prompt';
import { readAnthropicUsage, recordPerfUsage } from './perf-trace';
import { buildPartial, createAssistantMessage, createThinkingEmitter, describeHttpFailure, describeStreamError, extractImageParts, fetchLlmWithRetry, finishStream, stringifyContent, type ToolCallAccumulator } from './stream-shared';

export const ANTHROPIC_VERSION = '2023-06-01';

// OpenAI 与 Anthropic 两个生态对 base_url 的约定相反：OpenAI 把版本段写在 base_url 里
// （客户端只补 `/chat/completions`），Anthropic 则约定 base_url 不带版本段、由客户端补
// `/v1/messages`。厂商文档照搬各自生态的写法，所以 Provider 设置里填的 baseURL 两种形态
// 都会出现 —— 官方 `https://api.anthropic.com`、火山方舟
// `https://ark.cn-beijing.volces.com/api/coding` 都不带版本段。若只补 `/messages`，请求会
// 打到不存在的路径；方舟网关对未命中的路由返回的是 401 AuthenticationError 而非 404，
// 排查时极易误判成 API key 的问题。这里两种形态都兼容。
export function anthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

interface AnthropicSseEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  error?: { message?: string };
  // usage 分两处到达：message_start 带输入侧（含缓存命中与写入的 token 数），
  // message_delta 带累计的输出 token 数。缓存到底有没有生效，只有这里看得到。
  message?: { usage?: unknown };
  usage?: { output_tokens?: number };
}

// Anthropic's own "stop_reason" on the final `message_delta` event, mapped to pi-ai's StopReason.
// "max_tokens" in particular matters here: reasoning models spend part of `max_tokens` on a hidden
// `thinking` block before any visible text, so a response can be truncated with nothing visible at
// all — without reading this field that truncation is silently reported as a normal "stop".
function mapAnthropicStopReason(stopReason: string | undefined, hasToolCalls: boolean): 'stop' | 'toolUse' | 'length' {
  if (hasToolCalls || stopReason === 'tool_use') return 'toolUse';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
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
  let anthropicStopReason: string | undefined;
  // usage 的输入侧与输出侧分两个事件到达，先各自暂存，收尾时合成一条样本。
  let inputUsage: unknown;
  let outputTokens = 0;
  // 弱模型兜底：模型没走 tool_use 而把调用写进正文时，finishStream 据此把它捞回来。
  const toolNames = context.tools?.map((tool) => tool.name) ?? [];
  // 与 openai-stream.ts 同一套发射器：推理只走事件、不进 content，也不回传（我们不发 thinking 参数，
  // 只有兼容端点主动返回推理时才会走到这里）。signature_delta 与 redacted_thinking 块没有可展示的内容，直接忽略。
  const thinking = createThinkingEmitter(push, () => buildPartial(model, startedAt, text, toolCalls, 'stop'));
  const thinkingBlockIndexes = new Set<number>();
  // catch 块要用它拼网络层失败的提示，声明在 try 外面才能跨块读到。
  let url = model.baseUrl;

  function toolContentIndex(blockIndex: number): number {
    return (text ? 1 : 0) + [...toolCalls.keys()].sort((a, b) => a - b).indexOf(blockIndex);
  }

  push({ type: 'start', partial });

  try {
    url = anthropicMessagesUrl(model.baseUrl);
    const response = await fetchLlmWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options?.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
        ...(model.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        system: buildAnthropicSystem(context.systemPrompt),
        messages: withConversationBreakpoint(convertMessagesForAnthropic(context)),
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
        if (!data) continue;
        const event = JSON.parse(data) as AnthropicSseEvent;

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'thinking') {
          thinkingBlockIndexes.add(event.index);
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          thinking.delta(event.delta.thinking ?? '');
          continue;
        }

        if (event.type === 'content_block_stop' && event.index !== undefined && thinkingBlockIndexes.has(event.index)) {
          thinking.end();
          continue;
        }

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'text') {
          // 给不发 content_block_stop 的兼容端点兜底：正文开始即收口推理。
          thinking.end();
          if (!textStarted) {
            textStarted = true;
            push({ type: 'text_start', contentIndex: 0, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          continue;
        }

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'tool_use') {
          thinking.end();
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

        // 纯观测：把供应商回报的 usage 记进耗时画像。前缀缓存是否真的命中，
        // 只有 cache_read_input_tokens 是证据——加了 cache_control 却每轮全 miss
        // 是最贵的那种失败：请求照样成功，只是账单更高，没有任何报错。
        if (event.type === 'message_start') {
          inputUsage = event.message?.usage;
          continue;
        }
        if (event.type === 'message_delta') {
          if (typeof event.usage?.output_tokens === 'number') outputTokens = event.usage.output_tokens;
          if (event.delta?.stop_reason) anthropicStopReason = event.delta.stop_reason;
          continue;
        }

        if (event.type === 'error') {
          throw new Error(event.error?.message ?? 'Anthropic 流式请求返回错误');
        }

        if (event.type === 'message_stop') {
          thinking.end();
          const usage = readAnthropicUsage(inputUsage, outputTokens);
          if (usage) recordPerfUsage(usage);
          if (textStarted) {
            push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          finishStream(model, push, startedAt, text, toolCalls, mapAnthropicStopReason(anthropicStopReason, toolCalls.size > 0), toolNames);
          return;
        }
      }
    }

    thinking.end();
    if (textStarted) {
      push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
    }
    finishStream(model, push, startedAt, text, toolCalls, mapAnthropicStopReason(anthropicStopReason, toolCalls.size > 0), toolNames);
  } catch (error) {
    thinking.end();
    // 与 openai-stream.ts 同因：stopReason 要跟事件 reason 一致，否则用户主动停止会被上层
    // 当成模型调用失败（详见那边的注释）。
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

function isToolResultGroup(content: unknown): content is Array<{ type: string }> {
  return Array.isArray(content) && content.length > 0 && (content[0] as { type?: string })?.type === 'tool_result';
}

export function convertMessagesForAnthropic(context: Context): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of context.messages) {
    if (message.role === 'user') {
      const blocks: Array<Record<string, unknown>> = [];
      const text = stringifyContent(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const image of extractImageParts(message.content)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
      }
      result.push({ role: 'user', content: blocks });
      continue;
    }
    if (message.role === 'toolResult') {
      // Anthropic 的 tool_result 原生支持内嵌 image 块，直接放进去即可。
      const inner: Array<Record<string, unknown>> = [];
      const text = stringifyContent(message.content);
      if (text) inner.push({ type: 'text', text });
      for (const image of extractImageParts(message.content)) {
        inner.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
      }
      // 既没有文本也没有图片时，`content: []` 是这次改动才可能出现的新形状（改动前
      // stringifyContent 兜底吐出 ''，`content: ''` 至少是个字符串）；Anthropic 是否接受
      // 空数组没有把握，给个占位文本，别把这种边界情况留给线上第一次调用去发现。
      if (inner.length === 0) inner.push({ type: 'text', text: '(empty)' });
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: inner,
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

/** 前缀缓存断点。ephemeral 是 5 分钟 TTL，正好覆盖 agent 循环里一轮接一轮的节奏。 */
const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

/**
 * system 字段：切成「稳定正文 + 运行时尾巴」两块，断点只打在稳定那块。
 *
 * 渲染顺序是 tools → system → messages，所以这个断点把整张工具表和规则正文一起缓存住——
 * 那是请求里最大也最稳定的一块。整段 system 打一个断点是不行的：尾巴上的 <runtime_context>
 * 带着页面地址和时间戳，每轮都变，那样每轮都只是写一条再也读不到的新缓存。
 *
 * 尾巴为空时只发一块：Anthropic 拒绝空字符串的 text 块，无条件发两块会直接 400。
 * 同理，整段提示词缺失时返回 undefined 让调用方整个省掉 system 字段，而不是发一个空块——
 * Context.systemPrompt 是可选的，快捷方式那类调用确实可能不带。
 */
export function buildAnthropicSystem(systemPrompt: string | undefined): Array<Record<string, unknown>> | undefined {
  if (!systemPrompt) return undefined;
  const { stable, volatile } = splitSystemPromptForCache(systemPrompt);
  if (!stable) return volatile ? [{ type: 'text', text: volatile }] : undefined;
  const blocks: Array<Record<string, unknown>> = [
    { type: 'text', text: stable, cache_control: CACHE_BREAKPOINT },
  ];
  if (volatile) blocks.push({ type: 'text', text: volatile });
  return blocks;
}

/**
 * 在最新一轮的最后一个内容块上打第二个断点——多轮对话的标准打法：下一轮整段历史就成了
 * 可读前缀，命中随对话增长而累积，而写入只计最后一轮新增的那点增量。
 *
 * 只打最后一处，不是每轮都留一个：断点名额总共只有 4 个，而更早的位置在下一轮本来就会
 * 被新的断点覆盖，多打没有额外收益。
 *
 * ⚠️ 这一半的命中率注定不如 system 那一半：compactAgentMessages 会在新的只读结果到达时
 * 把上一份就地改写成摘要，请求前缀在那个位置断一次（见 agent.ts 里那段注释）。写操作居多的
 * 轮次之间它是连续的，读操作一多就会断。system 那个断点不受影响，那才是这次改动的主要收益。
 */
function withConversationBreakpoint(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const content = last.content;
  if (!Array.isArray(content) || content.length === 0) return messages;
  const blocks = content as Array<Record<string, unknown>>;
  const tail = blocks[blocks.length - 1];
  if (!tail || typeof tail !== 'object') return messages;
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...blocks.slice(0, -1), { ...tail, cache_control: CACHE_BREAKPOINT }] },
  ];
}
