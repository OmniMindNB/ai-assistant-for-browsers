// 侧边栏一次 agent 运行的耗时画像：把墙钟时间拆进「LLM 往返 / 权限门+提交探测 /
// 工具执行 / afterToolCall 后置钩子」四个桶，另外记录每一轮实际送进模型的上下文规模。
//
// 存在的理由：整个代码库此前没有任何计时埋点，"最新版本变慢了"这类反馈无法定位到
// 具体是哪一段——是模型多跑了几轮，还是单个工具变慢，还是钩子里新加的固定 sleep。
//
// 所有边界都能从 pi-agent-core 的事件流上观测到，不需要侵入 Agent 内部：
//   turn_start   -> message_end        = 这一轮 LLM 请求（含首 token 前的排队与生成）
//   message_end  -> tool_start         = beforeToolCall（权限门 + PROBE_CLICK_TARGET 探测）
//   tool_start   -> tool_end           = 工具自身执行（executeScript 往返、页面采集…）
//   tool_end     -> 下一个 turn_start/tool_start = afterToolCall（GET_TAB_URL 探测、
//                                        POST_NAVIGATION_SETTLE_MS 固定 sleep、遮罩同步）

export interface PerfMark {
  kind: 'agent_start' | 'turn_start' | 'first_token' | 'message_end' | 'tool_start' | 'tool_end' | 'agent_end';
  at: number;
  toolName?: string;
}

/** 每次 transformContext 落一条：用来判断只读结果是不是被摘要掉之后模型又重新去读。 */
export interface PerfContextSample {
  turn: number;
  /** 压缩后真正进入模型的消息条数。 */
  messages: number;
  /** 压缩后所有消息的文本总字符数（粗略 token 代理量）。 */
  chars: number;
  /** 被压成 describeToolActivity 一句话摘要的只读工具结果条数。 */
  summarizedReadResults: number;
  /** 唯一保留完整内容的那份只读结果有多大。 */
  keptReadResultChars: number;
}

export interface PerfToolStat {
  name: string;
  count: number;
  totalMs: number;
}

export interface PerfSummary {
  totalMs: number;
  turns: number;
  toolCalls: number;
  llmMs: number;
  /** 每轮的首 token 延迟，按轮次顺序。 */
  ttftMs: number[];
  gateMs: number;
  toolMs: number;
  postToolMs: number;
  /** 按累计耗时降序。 */
  tools: PerfToolStat[];
  context: PerfContextSample[];
}

type Bucket = 'llmMs' | 'gateMs' | 'toolMs' | 'postToolMs';

/**
 * 上一个标记决定了刚刚过去的这段时间该记到哪个桶里。返回 undefined = 不计入任何桶
 * （agent_start 之前的空档，以及最后一轮 message_end 之后的收尾——那段不是权限门）。
 */
function bucketAfter(previous: PerfMark, next: PerfMark): Bucket | undefined {
  switch (previous.kind) {
    case 'turn_start':
    case 'first_token':
      return 'llmMs';
    case 'message_end':
      // 只有真的接着执行了工具，这段才是权限门/提交探测的开销。
      return next.kind === 'tool_start' ? 'gateMs' : undefined;
    case 'tool_start':
      return 'toolMs';
    case 'tool_end':
      return 'postToolMs';
    default:
      return undefined;
  }
}

export function summarizePerfMarks(marks: PerfMark[], context: PerfContextSample[]): PerfSummary {
  const summary: PerfSummary = {
    totalMs: 0,
    turns: 0,
    toolCalls: 0,
    llmMs: 0,
    ttftMs: [],
    gateMs: 0,
    toolMs: 0,
    postToolMs: 0,
    tools: [],
    context,
  };
  if (marks.length === 0) return summary;

  const first = marks[0];
  summary.totalMs = marks[marks.length - 1].at - first.at;

  const stats = new Map<string, PerfToolStat>();
  const pendingToolStart = new Map<string, number>();
  let turnStartedAt: number | undefined;

  for (let index = 1; index < marks.length; index += 1) {
    const previous = marks[index - 1];
    const current = marks[index];
    const bucket = bucketAfter(previous, current);
    if (bucket) summary[bucket] += current.at - previous.at;

    switch (current.kind) {
      case 'turn_start':
        summary.turns += 1;
        turnStartedAt = current.at;
        break;
      case 'first_token':
        if (turnStartedAt !== undefined) summary.ttftMs.push(current.at - turnStartedAt);
        break;
      case 'tool_start':
        summary.toolCalls += 1;
        if (current.toolName) pendingToolStart.set(current.toolName, current.at);
        break;
      case 'tool_end': {
        const name = current.toolName;
        if (!name) break;
        const startedAt = pendingToolStart.get(name);
        pendingToolStart.delete(name);
        const existing = stats.get(name) ?? { name, count: 0, totalMs: 0 };
        existing.count += 1;
        if (startedAt !== undefined) existing.totalMs += current.at - startedAt;
        stats.set(name, existing);
        break;
      }
      default:
        break;
    }
  }

  summary.tools = [...stats.values()].sort((a, b) => b.totalMs - a.totalMs);
  return summary;
}

// ── 记录器 ─────────────────────────────────────────────────────────────────
// agent.ts 与 store.ts 都跑在侧边栏这一个上下文里，所以用模块级单例即可，不需要把
// 记录器一路透传进 createBrowserAgentOptions。

/** 在侧边栏 DevTools 控制台里执行 `__RUNI_PERF__ = true` 可在生产构建上临时打开。 */
export const PERF_TRACE_FLAG = '__RUNI_PERF__';

export function isPerfTraceEnabled(): boolean {
  const override = (globalThis as Record<string, unknown>)[PERF_TRACE_FLAG];
  if (typeof override === 'boolean') return override;
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

let marks: PerfMark[] = [];
let contextSamples: PerfContextSample[] = [];

export function resetPerfTrace(): void {
  marks = [];
  contextSamples = [];
  // usageSamples 声明在下方的 usage 小节里；这里在运行时引用，不存在 TDZ 问题。
  usageSamples = [];
}

export function recordPerfMark(kind: PerfMark['kind'], toolName?: string): void {
  if (!isPerfTraceEnabled()) return;
  if (kind === 'agent_start') resetPerfTrace();
  marks.push(toolName ? { kind, at: Date.now(), toolName } : { kind, at: Date.now() });
}

/** 一轮里只记第一次 text_delta；之后的增量不再重复打点。 */
export function recordPerfFirstToken(): void {
  if (!isPerfTraceEnabled()) return;
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (marks[index].kind === 'turn_start') break;
    if (marks[index].kind === 'first_token') return;
  }
  marks.push({ kind: 'first_token', at: Date.now() });
}

export function recordPerfContext(sample: Omit<PerfContextSample, 'turn'>): void {
  if (!isPerfTraceEnabled()) return;
  contextSamples.push({ ...sample, turn: contextSamples.length + 1 });
}

export function currentPerfSummary(): PerfSummary {
  return summarizePerfMarks(marks, contextSamples);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 运行结束时把画像打到控制台。返回 summary 便于测试/外部复用。 */
export function flushPerfTrace(): PerfSummary | undefined {
  if (!isPerfTraceEnabled()) return undefined;
  const summary = currentPerfSummary();
  const { totalMs } = summary;
  console.log(
    `[Runi perf] 总耗时 ${seconds(totalMs)}｜LLM ${summary.turns} 轮 ${seconds(summary.llmMs)}(${percent(summary.llmMs, totalMs)})` +
      `｜工具 ${summary.toolCalls} 次 ${seconds(summary.toolMs)}(${percent(summary.toolMs, totalMs)})` +
      `｜权限门/提交探测 ${seconds(summary.gateMs)}(${percent(summary.gateMs, totalMs)})` +
      `｜afterToolCall 后置 ${seconds(summary.postToolMs)}(${percent(summary.postToolMs, totalMs)})` +
      `｜首 token ${summary.ttftMs.map((ms) => `${ms}ms`).join(' / ') || '—'}`,
  );
  if (summary.tools.length > 0) console.table(summary.tools);
  if (summary.context.length > 0) console.table(summary.context);
  const usage = currentPerfUsage();
  if (usage.length > 0) {
    const prompt = usage.reduce((total, sample) => total + sample.promptTokens, 0);
    const hit = usage.reduce((total, sample) => total + sample.cacheHitTokens, 0);
    console.log(`[Runi perf] 前缀缓存命中 ${hit}/${prompt} tokens (${percent(hit, prompt)})`);
    console.table(usage);
  }
  return summary;
}

// ── 供应商 usage：缓存命中率 ───────────────────────────────────────────────
// DeepSeek 等厂商在 OpenAI 兼容响应的 usage 里额外回报前缀缓存命中情况。命中率是
// 判断"首 token 为什么这么久"的直接证据：如果每轮都几乎全是 miss，说明请求前缀在轮
// 之间不稳定，整段上下文每次都要重新处理，而不是模型或网络本身慢。
// stream-shared.ts 的 finishStream 目前一律写 ZERO_USAGE，这些字段此前被整个丢弃。

export interface PerfUsageSample {
  turn: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
}

interface RawOpenAiUsageChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * 供应商不回报缓存字段时，未命中数退化为整个 prompt——把"没有缓存"和"缓存全未命中"
 * 归为同一种情况，避免在表里显示成 0/0 让人误以为请求很小。
 */
export function readOpenAiUsage(chunk: unknown): Omit<PerfUsageSample, 'turn'> | undefined {
  const usage = (chunk as RawOpenAiUsageChunk | null | undefined)?.usage;
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  return {
    promptTokens,
    completionTokens: usage.completion_tokens ?? 0,
    cacheHitTokens,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? promptTokens - cacheHitTokens,
  };
}

let usageSamples: PerfUsageSample[] = [];

export function recordPerfUsage(sample: Omit<PerfUsageSample, 'turn'>): void {
  if (!isPerfTraceEnabled()) return;
  usageSamples.push({ ...sample, turn: usageSamples.length + 1 });
}

export function currentPerfUsage(): PerfUsageSample[] {
  return usageSamples;
}
