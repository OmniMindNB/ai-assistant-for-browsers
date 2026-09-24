import { describe, expect, it } from 'vitest';
import { MAX_REASONING_CHARS, appendReasoning, emptyReasoning, reasoningMessageFields } from './reasoning';

describe('appendReasoning', () => {
  it('appends deltas of the same LLM turn into one segment', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, '先');
    buffer = appendReasoning(buffer, 1, '想');
    expect(buffer.segments).toEqual(['先想']);
    expect(buffer.omittedChars).toBe(0);
  });

  it('starts a new segment when the LLM turn changes', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'a');
    buffer = appendReasoning(buffer, 3, 'b');
    expect(buffer.segments).toEqual(['a', 'b']);
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
  });

  it('drops the oldest segments first once the total exceeds the cap', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'aaaa', 10);
    buffer = appendReasoning(buffer, 2, 'bbbb', 10);
    buffer = appendReasoning(buffer, 3, 'cccccc', 10);
    // 总长 14 > 10：第一段 4 字整段移除，total 10，恰好不超。
    expect(buffer.segments).toEqual(['bbbb', 'cccccc']);
    expect(buffer.omittedChars).toBe(4);
  });

  it('trims the head of the oldest remaining segment when dropping it whole is not needed', () => {
    let buffer = emptyReasoning();
    buffer = appendReasoning(buffer, 1, 'abcdef', 8);
    buffer = appendReasoning(buffer, 2, 'XYZ', 8);
    expect(buffer.segments).toEqual(['bcdef', 'XYZ']);
    expect(buffer.omittedChars).toBe(1);
  });

  // Review Focus #4
  it('clips a single oversized segment from its head, keeping the latest text', () => {
    const buffer = appendReasoning(emptyReasoning(), 1, 'x'.repeat(MAX_REASONING_CHARS) + 'TAIL');
    expect(buffer.segments).toHaveLength(1);
    expect(buffer.segments[0]).toHaveLength(MAX_REASONING_CHARS);
    expect(buffer.segments[0].endsWith('TAIL')).toBe(true);
    expect(buffer.omittedChars).toBe(4);
  });

  it('keeps accumulating omittedChars across many clipped deltas', () => {
    let buffer = emptyReasoning();
    for (let i = 0; i < 5; i += 1) buffer = appendReasoning(buffer, 1, '12345', 10);
    expect(buffer.segments).toEqual(['1234512345']);
    expect(buffer.omittedChars).toBe(15);
  });
});

describe('reasoningMessageFields', () => {
  it('returns no fields when nothing was reasoned', () => {
    expect(reasoningMessageFields(emptyReasoning())).toEqual({});
  });

  it('omits reasoningOmittedChars when nothing was dropped', () => {
    const buffer = appendReasoning(emptyReasoning(), 1, 'r');
    expect(reasoningMessageFields(buffer)).toEqual({ reasoning: ['r'] });
  });

  it('includes reasoningOmittedChars and copies the segment array', () => {
    const buffer = appendReasoning(emptyReasoning(), 1, 'abcdef', 3);
    const fields = reasoningMessageFields(buffer);
    expect(fields).toEqual({ reasoning: ['def'], reasoningOmittedChars: 3 });
    expect(fields.reasoning).not.toBe(buffer.segments);
  });
});
