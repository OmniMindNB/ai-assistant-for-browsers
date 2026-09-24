// lib/agent/stream-shared.ts
// 协议无关的流式响应内部状态与事件构建工具，供 openai-stream.ts / anthropic-stream.ts 共用。
import type { AssistantMessage, AssistantMessageEvent, Api, ImageContent, Model, ToolCall, Usage } from '@earendil-works/pi-ai';
import { repairToolArguments, salvageToolCallFromText } from './tool-call-repair';

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

/**
 * `toolNames` 是弱模型兜底用的：模型没走 tool_calls 而把调用写进正文时，据此把它捞回来
 * （ref: lib/agent/tool-call-repair.ts）。传空数组即关闭兜底。
 */
export function finishStream(
  model: Model<Api>,
  push: (event: AssistantMessageEvent) => void,
  timestamp: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  fallbackReason: 'stop' | 'toolUse' | 'length',
  toolNames: string[] = [],
): void {
  let finalText = text;
  let finalCalls = toolCalls;

  if (toolCalls.size === 0 && toolNames.length > 0) {
    const salvaged = salvageToolCallFromText(text, toolNames);
    if (salvaged) {
      finalText = salvaged.strippedText;
      finalCalls = new Map([
        [0, { id: `salvaged-${timestamp}`, name: salvaged.name, argumentsText: JSON.stringify(salvaged.arguments) }],
      ]);
    }
  }

  const reason = finalCalls.size > 0 ? 'toolUse' : fallbackReason;
  const message = buildPartial(model, timestamp, finalText, finalCalls, reason);
  let contentIndex = finalText ? 1 : 0;
  for (const toolCall of message.content) {
    if (toolCall.type !== 'toolCall') continue;
    push({ type: 'toolcall_end', contentIndex, toolCall, partial: message });
    contentIndex += 1;
  }
  push({ type: 'done', reason, message });
}

export function parseToolArguments(value: string): Record<string, unknown> {
  return repairToolArguments(value);
}

/**
 * 统一描述 LLM HTTP 失败。协议下拉框与 Base URL 是两个互不校验的独立字段，任一填错都只表现为
 * 一句 4xx：不带请求 URL 就分不清「路径拼错」还是「模型名在该端点不存在」（方舟对后者返回
 * 404 "The model or endpoint xxx does not exist"），而网关直接拒绝时 body 往往是空的，此时
 * 旧文案会退化成没有任何信息的 "LLM 请求失败 (404 )"。所以 URL 和模型名必须写进报错本身。
 */
/**
 * 判断 400 的 detail 是不是在说"上下文超长"，而不是鉴权失败或参数校验错误。
 *
 * 最初版本是任一命中 `context|length|token` 就触发，评审指出这太宽：`token` 在 LLM
 * 场景同时是"访问令牌"的常用词（`invalid token` / `access token expired`），`length`
 * 也会出现在与上下文无关的参数校验错误里（`string length must be <= 100`）——命中就
 * 给"换模型/减少引用"的建议，会把本该去查 API Key 的用户引向错误方向，一条误导性的
 * 诊断比没有诊断更糟。
 *
 * 改成要求"上下文语义词"与"超限语义词"同时出现，只有孤立的 token/length 不触发；
 * 另外单独识别 `context_length_exceeded`（下划线或空格分隔，大小写不敏感）这个
 * OpenAI 系标准错误码，因为它本身已经是明确信号，不需要再叠加超限词。
 */
const CONTEXT_OVERFLOW_ERROR_CODE_PATTERN = /context[_\s]?length[_\s]?exceeded/i;
const CONTEXT_WORD_PATTERN = /context|上下文|prompt/i;
const OVERFLOW_WORD_PATTERN = /exceed|maximum|too long|limit|overflow/i;

function looksLikeContextOverflow(detail: string): boolean {
  if (CONTEXT_OVERFLOW_ERROR_CODE_PATTERN.test(detail)) return true;
  return CONTEXT_WORD_PATTERN.test(detail) && OVERFLOW_WORD_PATTERN.test(detail);
}

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
      ? '\n404 通常意味着请求路径或模型名不存在，请核对设置页的「协议」下拉框是否与 Base URL 匹配，以及该模型在此端点下是否可用；少数网关也会用 404 表示 API Key 无效或无权访问该模型，所以排除前两项后再回头检查 Key。'
      : status === 400 && looksLikeContextOverflow(detail)
        ? '\n400 且报错像是在说上下文超长，大概率是这次请求的上下文超出了该模型的窗口；可以换一个窗口更大的模型，或减少这一轮引用的标签页/附件内容。'
        : '';
  return `${head}${body}\n请求地址：${url}\n模型：${modelId}${hint}`;
}

/**
 * describeHttpFailure 处理的是"拿到了 HTTP 响应，但状态码非 2xx"；这里补的是更底层的一类——
 * fetch() 自身失败，从未拿到过响应（DNS 解析失败、连接被拒绝、CORS 拦截等），两个浏览器引擎
 * 都以 TypeError 形式抛出，原始文案通常只有一句 "Failed to fetch"，既不说往哪儿发的请求，
 * 也不给排查方向。AbortError 走的是另一条路径（options.signal 触发的正常停止），不在这里处理，
 * 调用方已经用 options?.signal?.aborted 单独判断。
 */
export function describeStreamError(error: unknown, url: string, modelId: string): string {
  if (error instanceof Error && error.name === 'TypeError') {
    return `无法连接到 LLM 服务：${error.message}\n请求地址：${url}\n模型：${modelId}\n请检查网络连接、Base URL 是否正确，以及该地址是否允许来自浏览器扩展的跨域请求。`;
  }
  return error instanceof Error ? error.message : String(error);
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

/**
 * 退避重试的间隔：第 n 次重试前等 LLM_RETRY_DELAYS_MS[n]，数组长度即最多重试次数。
 * 一次多步任务的每一轮都要打一次 LLM，跑到第九步时撞上一次偶发的 429/503，此前花掉的轮数就全白费了；
 * 这类失败绝大多数几秒内就会自愈，值得在报错前再试两次。
 */
export const LLM_RETRY_DELAYS_MS = [1000, 3000] as const;

/**
 * 服务端用 Retry-After 要求等待的时长超过这个值时不再干等，直接把 429 交给用户：
 * 侧边栏里静默卡半分钟以上，比一条讲清楚原因的报错更让人困惑。
 */
export const MAX_RETRY_AFTER_MS = 20_000;

/**
 * 只重试"过一会儿大概率就好"的状态码：超时、限流、网关/服务端故障，以及 Anthropic 的 529 过载。
 * 400/401/403/404 是配置或请求本身的问题，重试只会让用户多等几秒才看到同一个错误。
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

function isAbortError(error: unknown): boolean {
  return error instanceof Error ? error.name === 'AbortError' : (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** 等待 ms；signal 触发时立即以 AbortError 结束，用户在退避期间点"停止"不必等完这段间隔。 */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException('signal is aborted without reason', 'AbortError');
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After 可以是秒数，也可以是 HTTP 日期；解析不出来返回 undefined，交给默认退避间隔。 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export interface LlmFetchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

const defaultLlmFetchDeps: LlmFetchDeps = {
  // 惰性读取全局 fetch：测试用 vi.stubGlobal 替换它，模块加载时就绑定会绕过替换。
  fetch: (url, init) => fetch(url, init),
  sleep: abortableSleep,
};

/**
 * 发起一次 LLM 请求，对瞬时故障做有限次数的退避重试。只覆盖"还没拿到响应体"这一段：
 * 流已经开始输出后中途断开不在这里重试，因为已经推给界面的增量无法收回。
 * 重试用尽后把最后一次响应（或错误）原样交回，报错文案仍由调用方的 describeHttpFailure/describeStreamError 负责。
 */
export async function fetchLlmWithRetry(
  url: string,
  init: RequestInit,
  deps: LlmFetchDeps = defaultLlmFetchDeps,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const isLastAttempt = attempt >= LLM_RETRY_DELAYS_MS.length;
    let delay: number;
    try {
      const response = await deps.fetch(url, init);
      if (response.ok || isLastAttempt || !RETRYABLE_STATUSES.has(response.status)) return response;
      const retryAfter = parseRetryAfterMs(response.headers.get('Retry-After'));
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) return response;
      delay = retryAfter ?? LLM_RETRY_DELAYS_MS[attempt];
      // 这条响应不会再读了，释放它的连接。
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      // 只有网络层失败（fetch 自身抛 TypeError）值得重试；用户停止（AbortError）必须立刻结束。
      if (isLastAttempt || isAbortError(error) || !(error instanceof TypeError)) throw error;
      delay = LLM_RETRY_DELAYS_MS[attempt];
    }
    await deps.sleep(delay, init.signal);
  }
}
