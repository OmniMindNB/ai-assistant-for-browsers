// 推理内容的累积与限量（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md §3.2）。
// 纯函数，run-registry.ts 在 thinking_delta 事件里调用。
//
// 上限不放进 context-budget.ts：那里管的是"多少文本能进模型上下文"，推理从不进上下文；
// 这里限的是快照体积——快照每 48ms 整份经 Port 发给面板并写 storage.session（上限 10MB），
// 推理动辄几万字，不在运行时就限量会把快照撑大。
import type { ChatMessage } from '@/lib/chat/messages';

/** 一条 assistant 消息上保留的推理总字数上限；超出时丢最早的，保留离最终行动最近的那部分。 */
export const MAX_REASONING_CHARS = 20_000;

export interface ReasoningBuffer {
  /** 一次 LLM 调用一段，按时间先后排列。 */
  segments: string[];
  /** 滑动窗口已经丢掉的字数。 */
  omittedChars: number;
  /** 最后一段属于哪次 LLM 调用（run-registry 的 turn_start 计数）；还没有推理时为 null。 */
  lastTurn: number | null;
}

export function emptyReasoning(): ReasoningBuffer {
  return { segments: [], omittedChars: 0, lastTurn: null };
}

/**
 * 追加一段推理增量，返回新的 buffer（不修改入参）。
 * 同一次 LLM 调用的增量并进同一段——即便中间被正文打断过，展示上"第 N 次思考"对应的是一次调用。
 */
export function appendReasoning(
  buffer: ReasoningBuffer,
  turn: number,
  delta: string,
  maxChars: number = MAX_REASONING_CHARS,
): ReasoningBuffer {
  if (!delta) return buffer;
  const segments = [...buffer.segments];
  if (buffer.lastTurn === turn && segments.length > 0) {
    segments[segments.length - 1] += delta;
  } else {
    segments.push(delta);
  }

  let omittedChars = buffer.omittedChars;
  let total = segments.reduce((sum, segment) => sum + segment.length, 0);
  while (total > maxChars && segments.length > 0) {
    const excess = total - maxChars;
    const head = segments[0];
    if (head.length <= excess) {
      segments.shift();
      omittedChars += head.length;
      total -= head.length;
    } else {
      segments[0] = head.slice(excess);
      omittedChars += excess;
      total -= excess;
    }
  }
  return { segments, omittedChars, lastTurn: turn };
}

/** 写到 assistant 消息上的字段；没有推理时返回空对象，保证不写出空数组或 0。 */
export function reasoningMessageFields(buffer: ReasoningBuffer): Pick<ChatMessage, 'reasoning' | 'reasoningOmittedChars'> {
  if (buffer.segments.length === 0) return {};
  return {
    reasoning: [...buffer.segments],
    ...(buffer.omittedChars > 0 ? { reasoningOmittedChars: buffer.omittedChars } : {}),
  };
}
