// 推理内容的累积与限量（ref: docs/superpowers/specs/2026-09-24-reasoning-per-segment-budget-design.md §3.1-3.3）。
// 纯函数，run-registry.ts 在 thinking_delta 事件里调用。
//
// 上限不放进 context-budget.ts：那里管的是"多少文本能进模型上下文"，推理从不进上下文；
// 这里限的是快照与落库体积。按段限而不是按条限：一次 agent 运行的所有 LLM 调用都累积在同一条消息上，
// 按条限会让段数倒退、编号漂移（旧的 2 万字滑动窗口就是这样）。
import type { ChatMessage } from '@/lib/chat/messages';

/** 单段上限；超出后保留开头 REASONING_SEGMENT_HEAD_CHARS 字 + 结尾其余部分，中间省略。 */
export const MAX_REASONING_SEGMENT_CHARS = 6_000;
/** 被截断的段保留的开头字数：模型往往在开头写下对任务的理解和计划。 */
export const REASONING_SEGMENT_HEAD_CHARS = 1_500;
/** 一条 assistant 消息上保存的推理总字数兜底；超出时从最前面整段丢弃，正在增长的最后一段永远保留。 */
export const MAX_REASONING_TOTAL_CHARS = 100_000;

export interface ReasoningLimits {
  segmentChars: number;
  headChars: number;
  totalChars: number;
}

export const DEFAULT_REASONING_LIMITS: ReasoningLimits = {
  segmentChars: MAX_REASONING_SEGMENT_CHARS,
  headChars: REASONING_SEGMENT_HEAD_CHARS,
  totalChars: MAX_REASONING_TOTAL_CHARS,
};

export interface ReasoningBuffer {
  /** 一次 LLM 调用一段，按时间先后排列；被截断的段存的是 开头 + 结尾。 */
  segments: string[];
  /** 与 segments 等长：每段中间被省略的字数。 */
  trimmedChars: number[];
  /** 兜底上限从最前面整段丢掉的段数。 */
  droppedSegments: number;
  /** 丢掉的那些段的原始字数合计（存下的字数 + 它们各自被省略的字数）。 */
  droppedChars: number;
  /** 最后一段属于哪次 LLM 调用（run-registry 的 turn_start 计数）；还没有推理时为 null。 */
  lastTurn: number | null;
}

export type ReasoningFields = Pick<
  ChatMessage,
  'reasoning' | 'reasoningTrimmedChars' | 'reasoningDroppedSegments' | 'reasoningOmittedChars'
>;

export function emptyReasoning(): ReasoningBuffer {
  return { segments: [], trimmedChars: [], droppedSegments: 0, droppedChars: 0, lastTurn: null };
}

/** 超过单段上限时保留 开头 headChars + 结尾其余；已截断过的段开头恰好是 headChars 字，再截一次开头不变。 */
function clipSegment(text: string, limits: ReasoningLimits): { text: string; removed: number } {
  if (text.length <= limits.segmentChars) return { text, removed: 0 };
  const tailChars = limits.segmentChars - limits.headChars;
  return {
    text: text.slice(0, limits.headChars) + text.slice(text.length - tailChars),
    removed: text.length - limits.segmentChars,
  };
}

/**
 * 追加一段推理增量，返回新的 buffer（不修改入参）。
 * 同一次 LLM 调用的增量并进同一段——即便中间被正文打断过，展示上"第 N 次思考"对应的是一次调用。
 */
export function appendReasoning(
  buffer: ReasoningBuffer,
  turn: number,
  delta: string,
  limits: ReasoningLimits = DEFAULT_REASONING_LIMITS,
): ReasoningBuffer {
  if (!delta) return buffer;
  const segments = [...buffer.segments];
  const trimmedChars = [...buffer.trimmedChars];
  if (buffer.lastTurn === turn && segments.length > 0) {
    const last = segments.length - 1;
    const clipped = clipSegment(segments[last] + delta, limits);
    segments[last] = clipped.text;
    trimmedChars[last] += clipped.removed;
  } else {
    const clipped = clipSegment(delta, limits);
    segments.push(clipped.text);
    trimmedChars.push(clipped.removed);
  }

  let droppedSegments = buffer.droppedSegments;
  let droppedChars = buffer.droppedChars;
  let total = segments.reduce((sum, segment) => sum + segment.length, 0);
  // 只整段丢、且留下最后一段：单段上限远小于总量上限，留下的最后一段一定放得下。
  while (total > limits.totalChars && segments.length > 1) {
    const head = segments.shift()!;
    const headTrimmed = trimmedChars.shift()!;
    droppedSegments += 1;
    droppedChars += head.length + headTrimmed;
    total -= head.length;
  }
  return { segments, trimmedChars, droppedSegments, droppedChars, lastTurn: turn };
}

/** 写到 assistant 消息上的字段；没有推理时返回空对象，各计数为 0 时不写。 */
export function reasoningMessageFields(buffer: ReasoningBuffer): ReasoningFields {
  if (buffer.segments.length === 0) return {};
  return {
    reasoning: [...buffer.segments],
    ...(buffer.trimmedChars.some((n) => n > 0) ? { reasoningTrimmedChars: [...buffer.trimmedChars] } : {}),
    ...(buffer.droppedSegments > 0 ? { reasoningDroppedSegments: buffer.droppedSegments } : {}),
    ...(buffer.droppedChars > 0 ? { reasoningOmittedChars: buffer.droppedChars } : {}),
  };
}

/** 这条消息的推理一共有多少段（含兜底丢弃的、传输中没发的）：标题段数与编号都按它算。 */
export function reasoningSegmentTotal(message: ChatMessage | undefined): number {
  if (!message) return 0;
  return (message.reasoningDroppedSegments ?? 0) + (message.reasoningUnsentSegments ?? 0) + (message.reasoning?.length ?? 0);
}

/**
 * 运行中快照用：去掉最后一条以外所有消息上的推理（ref: 设计稿 §3.2 的补充，来自实现后的终审）。
 *
 * MAX_REASONING_TOTAL_CHARS 是按条限的，而 snapshotOf 每 48ms 把整段历史经 Port 发给面板、写进
 * storage.session——几十轮推理模型对话的历史推理能叠到 MB 级，把"运行时限量控制快照体积"
 * 这个初衷架空。历史推理在一轮运行中不会变，面板手里本来就有（restoreStrippedReasoning 按 id 补回），
 * 所以运行中的快照只带当前这条；state.messages 与落库不受影响，收尾快照仍然完整。
 *
 * 代价：worker 中途被回收时，孤儿恢复只能拿到这份瘦身快照，写回 Dexie 会丢掉历史轮次的推理
 * （正文不受影响）。那是罕见路径，用它换每一轮流式期间的快照体积。
 */
export function stripHistoryReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => {
    if (index === messages.length - 1 || message.reasoning === undefined) return message;
    const {
      reasoning: _reasoning,
      reasoningOmittedChars: _omitted,
      reasoningTrimmedChars: _trimmed,
      reasoningDroppedSegments: _dropped,
      reasoningUnsentSegments: _unsent,
      ...rest
    } = message;
    return rest;
  });
}
