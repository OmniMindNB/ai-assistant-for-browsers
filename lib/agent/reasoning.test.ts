import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASONING_LIMITS,
  MAX_REASONING_SEGMENT_CHARS,
  MAX_REASONING_TOTAL_CHARS,
  REASONING_SEGMENT_HEAD_CHARS,
  appendReasoning,
  emptyReasoning,
  reasoningMessageFields,
  reasoningSegmentTotal,
  slimLiveReasoning,
  stripHistoryReasoning,
  type ReasoningLimits,
} from './reasoning';

const small: ReasoningLimits = { segmentChars: 10, headChars: 3, totalChars: 25 };

describe('reasoning limits', () => {
  it('uses the spec values', () => {
    expect(MAX_REASONING_SEGMENT_CHARS).toBe(6_000);
    expect(REASONING_SEGMENT_HEAD_CHARS).toBe(1_500);
    expect(MAX_REASONING_TOTAL_CHARS).toBe(100_000);
    expect(DEFAULT_REASONING_LIMITS).toEqual({ segmentChars: 6_000, headChars: 1_500, totalChars: 100_000 });
  });
});

describe('appendReasoning', () => {
  it('appends deltas of the same LLM turn into one segment', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, '先');
    buffer = appendReasoning(buffer, 1, '想');
    expect(buffer.segments).toEqual(['先想']);
    expect(buffer.trimmedChars).toEqual([0]);
  });

  it('starts a new segment when the LLM turn changes', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'a');
    buffer = appendReasoning(buffer, 3, 'b');
    expect(buffer.segments).toEqual(['a', 'b']);
    expect(buffer.trimmedChars).toEqual([0, 0]);
  });

  it('ignores empty deltas and never creates an empty segment', () => {
    const buffer = appendReasoning(emptyReasoning(), 1, '');
    expect(buffer.segments).toEqual([]);
    expect(buffer.lastTurn).toBeNull();
  });

  it('does not mutate the input buffer', () => {
    const before = appendReasoning(emptyReasoning(), 1, 'x');
    appendReasoning(before, 1, 'y');
    expect(before.segments).toEqual(['x']);
    expect(before.trimmedChars).toEqual([0]);
  });

  it('keeps head + tail of an oversized segment and counts the trimmed middle', () => {
    const buffer = appendReasoning(emptyReasoning(), 1, 'ABCdefghijklmnXYZ', small);
    // 17 字 > 10：保留开头 3 字 + 结尾 7 字，中间 7 字省略。
    expect(buffer.segments).toEqual(['ABCklmnXYZ']);
    expect(buffer.trimmedChars).toEqual([7]);
  });

  it('keeps the head fixed while the tail slides across many deltas', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'HEAD-', small);
    for (let i = 0; i < 5; i += 1) buffer = appendReasoning(buffer, 1, `${i}${i}${i}`, small);
    expect(buffer.segments[0]).toHaveLength(10);
    expect(buffer.segments[0].startsWith('HEA')).toBe(true);
    expect(buffer.segments[0].endsWith('333444')).toBe(true);
    expect(buffer.trimmedChars[0]).toBe('HEAD-'.length + 15 - 10);
  });

  it('drops whole oldest segments once the stored total exceeds the cap', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'a'.repeat(10), small);
    buffer = appendReasoning(buffer, 2, 'b'.repeat(10), small);
    buffer = appendReasoning(buffer, 3, 'c'.repeat(10), small);
    // 30 > 25：整段丢掉 a 段，不在段中间删。
    expect(buffer.segments).toEqual(['b'.repeat(10), 'c'.repeat(10)]);
    expect(buffer.droppedSegments).toBe(1);
    expect(buffer.droppedChars).toBe(10);
  });

  it('counts the original size of a dropped trimmed segment', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'x'.repeat(14), small); // 存 10，省略 4
    buffer = appendReasoning(buffer, 2, 'y'.repeat(10), small);
    buffer = appendReasoning(buffer, 3, 'z'.repeat(10), small);
    expect(buffer.droppedSegments).toBe(1);
    expect(buffer.droppedChars).toBe(14);
    expect(buffer.trimmedChars).toEqual([0, 0]);
  });

  it('never drops the growing last segment and never lets the segment total go backwards', () => {
    const limits: ReasoningLimits = { segmentChars: 10, headChars: 3, totalChars: 12 };
    let buffer = emptyReasoning();
    let previousTotal = 0;
    for (let turn = 1; turn <= 6; turn += 1) {
      for (let i = 0; i < 4; i += 1) {
        buffer = appendReasoning(buffer, turn, 'abcd', limits);
        const total = buffer.droppedSegments + buffer.segments.length;
        expect(total).toBeGreaterThanOrEqual(previousTotal);
        expect(buffer.segments.length).toBeGreaterThan(0);
        previousTotal = total;
      }
    }
    expect(buffer.droppedSegments + buffer.segments.length).toBe(6);
  });

  it('does not push earlier segments out while the last one grows within the cap', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'aa', small);
    buffer = appendReasoning(buffer, 2, 'bb', small);
    for (let i = 0; i < 20; i += 1) buffer = appendReasoning(buffer, 3, 'cc', small);
    // 最后一段被单段上限截到 10，总长 14 ≤ 25，前两段都还在。
    expect(buffer.segments.slice(0, 2)).toEqual(['aa', 'bb']);
    expect(buffer.droppedSegments).toBe(0);
  });
});

describe('reasoningMessageFields', () => {
  it('returns no fields when nothing was reasoned', () => {
    expect(reasoningMessageFields(emptyReasoning())).toEqual({});
  });

  it('writes only reasoning when nothing was trimmed or dropped', () => {
    const buffer = appendReasoning(emptyReasoning(), 1, 'r');
    expect(reasoningMessageFields(buffer)).toEqual({ reasoning: ['r'] });
  });

  it('writes trimmed/dropped fields and copies arrays', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'a'.repeat(10), small);
    buffer = appendReasoning(buffer, 2, 'b'.repeat(10), small);
    buffer = appendReasoning(buffer, 3, 'c'.repeat(12), small);
    const fields = reasoningMessageFields(buffer);
    expect(fields).toEqual({
      reasoning: ['b'.repeat(10), 'c'.repeat(10)],
      reasoningTrimmedChars: [0, 2],
      reasoningDroppedSegments: 1,
      reasoningOmittedChars: 10,
    });
    expect(fields.reasoning).not.toBe(buffer.segments);
    expect(fields.reasoningTrimmedChars).not.toBe(buffer.trimmedChars);
  });
});

describe('reasoningSegmentTotal', () => {
  it('adds dropped, unsent and present segments', () => {
    expect(reasoningSegmentTotal(undefined)).toBe(0);
    expect(reasoningSegmentTotal({ id: 'a', role: 'assistant', content: '', createdAt: 1 })).toBe(0);
    expect(reasoningSegmentTotal({
      id: 'a', role: 'assistant', content: '', createdAt: 1,
      reasoning: ['x'], reasoningDroppedSegments: 2, reasoningUnsentSegments: 3,
    })).toBe(6);
  });
});

describe('stripHistoryReasoning', () => {
  const history = {
    id: 'a1', role: 'assistant' as const, content: '旧答', createdAt: 1,
    reasoning: ['旧推理'], reasoningOmittedChars: 5, reasoningTrimmedChars: [3], reasoningDroppedSegments: 1,
  };
  const user = { id: 'u2', role: 'user' as const, content: '新问', createdAt: 2 };
  const live = { id: 'a2', role: 'assistant' as const, content: '', createdAt: 3, reasoning: ['正在想'] };

  it('drops reasoning from every message but the last', () => {
    const result = stripHistoryReasoning([history, user, live]);
    expect(result[0]).not.toHaveProperty('reasoning');
    expect(result[0]).not.toHaveProperty('reasoningOmittedChars');
    expect(result[0]).not.toHaveProperty('reasoningTrimmedChars');
    expect(result[0]).not.toHaveProperty('reasoningDroppedSegments');
    expect(result[0].content).toBe('旧答');
    expect(result[2].reasoning).toEqual(['正在想']);
  });

  it('keeps untouched messages by reference and never mutates its input', () => {
    const result = stripHistoryReasoning([history, user, live]);
    expect(result[1]).toBe(user);
    expect(result[2]).toBe(live);
    expect(history.reasoning).toEqual(['旧推理']);
  });
});

describe('slimLiveReasoning', () => {
  const user = { id: 'u', role: 'user' as const, content: 'q', createdAt: 1 };

  it('keeps only the growing segment of the last message and records how many were not sent', () => {
    const live = {
      id: 'a', role: 'assistant' as const, content: '', createdAt: 2,
      reasoning: ['一', '二', '三'], reasoningTrimmedChars: [0, 5, 2], reasoningDroppedSegments: 4, reasoningOmittedChars: 80,
    };
    const [, slim] = slimLiveReasoning([user, live]);
    expect(slim).toMatchObject({
      reasoning: ['三'], reasoningTrimmedChars: [2], reasoningUnsentSegments: 2,
      reasoningDroppedSegments: 4, reasoningOmittedChars: 80,
    });
    expect(live.reasoning).toEqual(['一', '二', '三']);
  });

  it('omits reasoningTrimmedChars when the kept segment was not trimmed', () => {
    const live = { id: 'a', role: 'assistant' as const, content: '', createdAt: 2, reasoning: ['一', '二'], reasoningTrimmedChars: [5, 0] };
    const [slim] = slimLiveReasoning([live]);
    expect(slim).not.toHaveProperty('reasoningTrimmedChars');
    expect(slim.reasoningUnsentSegments).toBe(1);
  });

  it('returns the same array when there is at most one segment', () => {
    const messages = [user, { id: 'a', role: 'assistant' as const, content: '', createdAt: 2, reasoning: ['一'] }];
    expect(slimLiveReasoning(messages)).toBe(messages);
    expect(slimLiveReasoning([])).toEqual([]);
  });
});
