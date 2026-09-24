# 推理按段限量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 推理的限量从"每条消息 2 万字、从头删"改成"每段 6,000 字保留首尾 + 每条 10 万字兜底整段丢"，让段数和编号不再倒退；运行中快照只带正在增长的那一段；运行期间标题一直保持进行时。

**Architecture:** `lib/agent/reasoning.ts` 负责纯函数：累积、截断，以及把快照中最后一条消息瘦身。`lib/chat/messages.ts` 负责面板侧合并，把没发送的段补回来，补不上时并入丢弃计数。`run-registry.ts` 的 `snapshotOf` 判断这一帧要不要发完整的推理。`ReasoningBlock.tsx` 按绝对段号渲染。

**Tech Stack:** TypeScript、React、Zustand、vitest（`unit` / `ui` 两个 project）、WXT。

**Spec:** `docs/superpowers/specs/2026-09-24-reasoning-per-segment-budget-design.md`（修订 `docs/superpowers/specs/2026-09-24-reasoning-display-design.md` §3.2 / §3.4）

## Global Constraints

- `MAX_REASONING_SEGMENT_CHARS = 6_000`、`REASONING_SEGMENT_HEAD_CHARS = 1_500`、`MAX_REASONING_TOTAL_CHARS = 100_000`，都定义在 `lib/agent/reasoning.ts`；删除 `MAX_REASONING_CHARS`。
- 被截断的段存成"开头 1,500 字 + 结尾 4,500 字"，截断点固定在 `REASONING_SEGMENT_HEAD_CHARS`。
- 兜底只能从最前面**整段**丢弃，正在增长的最后一段永远不丢。
- 字段：`reasoningTrimmedChars?: number[]`（与 `reasoning` 等长，只要有一段被截断就整组写出）、`reasoningDroppedSegments?: number`（为 0 时不写）、`reasoningOmittedChars?: number`（只表示兜底丢弃的字数，为 0 时不写）。`reasoningUnsentSegments?: number` 只在传输中使用，**不能**写进 `toMessageRecords` / `ChatMessageRecord`。
- 推理不进导出、不回传给模型，这两点维持不变。
- 代码注释和提交信息使用中文，直接提交到 `main`，不开分支。
- 新文案 zh 和 en 都要加；`lib/i18n/i18n.test.ts` 会检查两份文案的键完全一致。

## Review Focus

1. **收尾快照不能被面板"补多"。** 兜底丢过段之后，busy:false 的完整快照到达时，面板不能把已经丢掉的段从自己手里补回来。→ Task 2 的 `restoreStrippedReasoning` 测试："没有 unsent 字段的消息原样采用"。
2. **面板中途挂载。** 运行中重新打开面板时，第一帧必须完整。→ Task 2 的 `attachPort` 测试。
3. **孤儿恢复。** 落库前要把 `reasoningUnsentSegments` 并入丢弃计数，否则 `toMessageRecords` 按白名单写库时这个字段会被丢掉，编号就错位了。→ Task 2 的 `foldUnsentReasoning` 测试，外加 `scanForOrphans` 对它的调用。
4. **旧记录。** 只有 `reasoningOmittedChars` 而没有新字段的消息，仍然显示"更早的 N 字已省略"。→ Task 3 的 UI 测试。
5. **正文出现之后**，标题仍然是"思考中 · 第 n 段"，但推理块已经自动折叠。→ Task 3 的 UI 测试。

---

### Task 1: 按段截断 + 兜底整段丢弃（纯函数与字段）

**Files:**
- Modify: `lib/agent/reasoning.ts`（改写 buffer / `appendReasoning` / `reasoningMessageFields` / `stripHistoryReasoning`）
- Modify: `lib/agent/reasoning.test.ts`
- Modify: `lib/chat/messages.ts:54-61`（`ChatMessage` 字段）、`lib/chat/messages.ts:139-142`（`toMessageRecords`）
- Modify: `lib/db.ts:77-83`（`ChatMessageRecord` 字段）
- Modify: `entrypoints/sidepanel/store.ts:969-970`（读库映射）
- Modify: `lib/agent/run-registry.ts:268-276`（`replaceLastAssistant` 的参数类型）
- Test: `lib/chat/messages.test.ts`、`entrypoints/sidepanel/store-context.test.tsx`、`lib/chat/conversation-export.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_REASONING_SEGMENT_CHARS = 6_000`、`REASONING_SEGMENT_HEAD_CHARS = 1_500`、`MAX_REASONING_TOTAL_CHARS = 100_000`
  - `export interface ReasoningLimits { segmentChars: number; headChars: number; totalChars: number }`，以及 `export const DEFAULT_REASONING_LIMITS: ReasoningLimits`
  - `export interface ReasoningBuffer { segments: string[]; trimmedChars: number[]; droppedSegments: number; droppedChars: number; lastTurn: number | null }`
  - `appendReasoning(buffer, turn, delta, limits = DEFAULT_REASONING_LIMITS): ReasoningBuffer`
  - `export type ReasoningFields = Pick<ChatMessage, 'reasoning' | 'reasoningTrimmedChars' | 'reasoningDroppedSegments' | 'reasoningOmittedChars'>`
  - `reasoningMessageFields(buffer): ReasoningFields`
  - `export function reasoningSegmentTotal(message: ChatMessage | undefined): number`，返回 `(reasoningDroppedSegments ?? 0) + (reasoningUnsentSegments ?? 0) + (reasoning?.length ?? 0)`
  - `ChatMessage` 新增 `reasoningTrimmedChars?`、`reasoningDroppedSegments?`、`reasoningUnsentSegments?`

- [ ] **Step 1: 改写 `lib/agent/reasoning.test.ts` 里 `appendReasoning` 和 `reasoningMessageFields` 的 describe 块（`stripHistoryReasoning` 块先保留）**

把文件开头的 import 以及前两个 describe 块整体替换为：

```ts
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
```

同时在现有 `stripHistoryReasoning` 的 describe 块里，把 `history` 改成带上新字段，并在第一个 it 里补上断言：

```ts
  const history = {
    id: 'a1', role: 'assistant' as const, content: '旧答', createdAt: 1,
    reasoning: ['旧推理'], reasoningOmittedChars: 5, reasoningTrimmedChars: [3], reasoningDroppedSegments: 1,
  };
```

```ts
    expect(result[0]).not.toHaveProperty('reasoningTrimmedChars');
    expect(result[0]).not.toHaveProperty('reasoningDroppedSegments');
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/reasoning.test.ts`
Expected: FAIL（`MAX_REASONING_SEGMENT_CHARS`、`reasoningSegmentTotal` 等尚未导出）

- [ ] **Step 3: 在 `lib/chat/messages.ts` 的 `ChatMessage` 里补字段**

把 `reasoning` / `reasoningOmittedChars` 两个字段及其注释替换为：

```ts
  /**
   * 推理模型本轮流式返回的推理内容，按 LLM 调用分段（一次调用一段）。每段按
   * lib/agent/reasoning.ts 的 MAX_REASONING_SEGMENT_CHARS 保留首尾，整条按 MAX_REASONING_TOTAL_CHARS
   * 从最前面整段丢弃；仅 assistant 消息、且真的收到过推理时才有值。
   * 只供面板回看：不回传给模型、不进会话导出（ref: docs/superpowers/specs/2026-09-24-reasoning-per-segment-budget-design.md）。
   */
  reasoning?: string[];
  /** 与 reasoning 等长：每段中间被省略的字数；有任一段被截断才写。截断点固定在 REASONING_SEGMENT_HEAD_CHARS。 */
  reasoningTrimmedChars?: number[];
  /** 兜底上限从最前面整段丢掉的段数；编号与段数都从它往后数。为 0 时不写。 */
  reasoningDroppedSegments?: number;
  /** 兜底丢掉的那些段合计的字数（存量记录里是旧滑动窗口删掉的字数，含义一致）；为 0 时不写。 */
  reasoningOmittedChars?: number;
  /**
   * 仅运行中快照使用、从不落库：reasoning 前面还有几段这一帧没发（面板手里有）。
   * 面板用 restoreStrippedReasoning 补回；补不上时 foldUnsentReasoning 并进 reasoningDroppedSegments。
   */
  reasoningUnsentSegments?: number;
```

`toMessageRecords` 在 `reasoningOmittedChars: message.reasoningOmittedChars,` 之后加两行（**不要**写 `reasoningUnsentSegments`）：

```ts
    reasoningTrimmedChars: message.reasoningTrimmedChars,
    reasoningDroppedSegments: message.reasoningDroppedSegments,
```

- [ ] **Step 4: 在 `lib/db.ts` 的 `ChatMessageRecord` 里补字段**

把 `reasoningOmittedChars` 的注释和字段替换为：

```ts
  /** 兜底丢掉的推理字数，见 ChatMessage.reasoningOmittedChars。 */
  reasoningOmittedChars?: number;
  /** 每段中间省略的字数，见 ChatMessage.reasoningTrimmedChars。不建索引，无需版本迁移。 */
  reasoningTrimmedChars?: number[];
  /** 兜底丢掉的段数，见 ChatMessage.reasoningDroppedSegments。不建索引，无需版本迁移。 */
  reasoningDroppedSegments?: number;
```

- [ ] **Step 5: 改写 `lib/agent/reasoning.ts`**

用下面的内容替换文件中从开头到 `reasoningMessageFields` 结束（含该函数）的部分。原来的 `stripHistoryReasoning` 注释保留，函数体替换为本步骤末尾的新版本。

```ts
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
```

`stripHistoryReasoning` 的函数体改为（注释里把 `MAX_REASONING_CHARS 是按条限的` 改成 `MAX_REASONING_TOTAL_CHARS 是按条限的`）：

```ts
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
```

- [ ] **Step 6: `run-registry.ts` 的 `replaceLastAssistant` 改用 `ReasoningFields`**

import 行改为：

```ts
import { appendReasoning, emptyReasoning, reasoningMessageFields, stripHistoryReasoning, type ReasoningBuffer, type ReasoningFields } from './reasoning';
```

签名改为：

```ts
function replaceLastAssistant(
  state: RunState,
  content: string,
  extra: ReasoningFields = {},
): void {
```

- [ ] **Step 7: `entrypoints/sidepanel/store.ts` 读库映射**

在 `reasoningOmittedChars: r.reasoningOmittedChars,` 之后加：

```ts
        reasoningTrimmedChars: r.reasoningTrimmedChars,
        reasoningDroppedSegments: r.reasoningDroppedSegments,
```

- [ ] **Step 8: 补落库、读库、导出的测试**

`lib/chat/messages.test.ts` 在 `toMessageRecords` 相关的测试附近新增：

```ts
describe('toMessageRecords reasoning', () => {
  it('persists per-segment reasoning fields but never the transport-only unsent count', () => {
    const records = toMessageRecords('conv-1', [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      {
        id: 'a1', role: 'assistant', content: 'done', createdAt: 2,
        reasoning: ['x'], reasoningTrimmedChars: [4], reasoningDroppedSegments: 2, reasoningOmittedChars: 90,
        reasoningUnsentSegments: 1,
      },
    ]);
    expect(records[1]).toMatchObject({ reasoningTrimmedChars: [4], reasoningDroppedSegments: 2, reasoningOmittedChars: 90 });
    expect(records[1]).not.toHaveProperty('reasoningUnsentSegments');
  });
});
```

`entrypoints/sidepanel/store-context.test.tsx` 的 `'restores reasoning fields when opening a stored conversation'` 里，record 改成带新字段，并补断言：

```ts
      { role: 'assistant', content: '答', createdAt: 2, reasoning: ['第一段', '第二段'], reasoningOmittedChars: 40, reasoningTrimmedChars: [0, 7], reasoningDroppedSegments: 3 },
```

```ts
    expect(assistant?.reasoningTrimmedChars).toEqual([0, 7]);
    expect(assistant?.reasoningDroppedSegments).toBe(3);
```

`lib/chat/conversation-export.test.ts` 的 `'never exports assistant reasoning'` 里，record 改为：

```ts
      record({ role: 'assistant', content: '答', reasoning: ['推理里的秘密步骤'], reasoningOmittedChars: 3, reasoningTrimmedChars: [9], reasoningDroppedSegments: 1 }),
```

并追加断言：

```ts
    expect(JSON.stringify(doc)).not.toContain('reasoningTrimmedChars');
    expect(JSON.stringify(doc)).not.toContain('reasoningDroppedSegments');
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/reasoning.test.ts lib/chat/messages.test.ts lib/chat/conversation-export.test.ts entrypoints/sidepanel/store-context.test.tsx lib/agent/run-registry.test.ts && pnpm compile`
Expected: 全部 PASS，tsc 无报错。`run-registry.test.ts` 现有的推理用例不涉及上限，应当不受影响。

- [ ] **Step 10: 提交**

```bash
git add lib/agent/reasoning.ts lib/agent/reasoning.test.ts lib/chat/messages.ts lib/chat/messages.test.ts lib/db.ts entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx lib/chat/conversation-export.test.ts lib/agent/run-registry.ts
git commit -m "feat(agent): 推理改为按段保留首尾、按条整段兜底，段数不再倒退"
```

---

### Task 2: 运行中快照只带正在增长的一段

**Files:**
- Modify: `lib/agent/reasoning.ts`（新增 `slimLiveReasoning`）
- Modify: `lib/chat/messages.ts`（新增 `foldUnsentReasoning`，扩展 `restoreStrippedReasoning`）
- Modify: `lib/agent/run-registry.ts`（`RunState.sentReasoningSegments`、`snapshotOf(state, full)`、`attachPort`、`scanForOrphans`）
- Test: `lib/agent/reasoning.test.ts`、`lib/chat/messages.test.ts`、`lib/agent/run-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `reasoningSegmentTotal`，以及 `ChatMessage.reasoningUnsentSegments` / `reasoningTrimmedChars` / `reasoningDroppedSegments`
- Produces:
  - `slimLiveReasoning(messages: ChatMessage[]): ChatMessage[]`：最后一条只留最后一段，并写上 `reasoningUnsentSegments`
  - `foldUnsentReasoning(message: ChatMessage): ChatMessage`：没有 unsent 字段时原样返回同一个引用
  - `restoreStrippedReasoning(previous, incoming)`：签名不变

- [ ] **Step 1: 写 `slimLiveReasoning` 的失败测试（`lib/agent/reasoning.test.ts`）**

import 里加上 `slimLiveReasoning`，然后在文件末尾追加：

```ts
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
```

- [ ] **Step 2: 写 `foldUnsentReasoning` 和合并逻辑的失败测试（`lib/chat/messages.test.ts`）**

import 里加上 `foldUnsentReasoning`。在现有的 `describe('restoreStrippedReasoning', ...)` 块里追加以下用例，并在其后新增一个 describe 块：

```ts
  it('fills segments the background did not send, by absolute segment index', () => {
    const previous: ChatMessage[] = [
      { id: 'a2', role: 'assistant', content: '', createdAt: 2, reasoning: ['一', '二'], reasoningTrimmedChars: [0, 6], reasoningDroppedSegments: 1, reasoningOmittedChars: 30 },
    ];
    const incoming: ChatMessage[] = [
      { id: 'a2', role: 'assistant', content: '', createdAt: 2, reasoning: ['三'], reasoningUnsentSegments: 2, reasoningDroppedSegments: 1, reasoningOmittedChars: 30 },
    ];
    const [merged] = restoreStrippedReasoning(previous, incoming);
    expect(merged.reasoning).toEqual(['一', '二', '三']);
    expect(merged.reasoningTrimmedChars).toEqual([0, 6, 0]);
    expect(merged.reasoningDroppedSegments).toBe(1);
    expect(merged.reasoningOmittedChars).toBe(30);
    expect(merged).not.toHaveProperty('reasoningUnsentSegments');
  });

  it('fills from the right offset when the background dropped more segments since', () => {
    const previous: ChatMessage[] = [
      { id: 'a2', role: 'assistant', content: '', createdAt: 2, reasoning: ['一', '二', '三'] },
    ];
    const incoming: ChatMessage[] = [
      { id: 'a2', role: 'assistant', content: '', createdAt: 2, reasoning: ['四'], reasoningUnsentSegments: 2, reasoningDroppedSegments: 1, reasoningOmittedChars: 9 },
    ];
    const [merged] = restoreStrippedReasoning(previous, incoming);
    expect(merged.reasoning).toEqual(['二', '三', '四']);
    expect(merged.reasoningDroppedSegments).toBe(1);
  });

  it('folds unsent segments into the dropped count when the panel cannot fill them', () => {
    const incoming: ChatMessage[] = [
      { id: 'a2', role: 'assistant', content: '', createdAt: 2, reasoning: ['三'], reasoningUnsentSegments: 2, reasoningDroppedSegments: 1, reasoningOmittedChars: 30 },
    ];
    const [merged] = restoreStrippedReasoning([], incoming);
    expect(merged.reasoning).toEqual(['三']);
    expect(merged.reasoningDroppedSegments).toBe(3);
    expect(merged).not.toHaveProperty('reasoningOmittedChars');
    expect(merged).not.toHaveProperty('reasoningUnsentSegments');
  });

  // Review Focus #1：收尾的完整快照不带 unsent，必须原样采用，不能从面板手里补出已经被兜底丢掉的段。
  it('adopts a full snapshot as-is even if the panel still holds segments dropped since', () => {
    const previous: ChatMessage[] = [
      { id: 'a2', role: 'assistant', content: '', createdAt: 2, reasoning: ['一', '二', '三'] },
    ];
    const full: ChatMessage = { id: 'a2', role: 'assistant', content: '答', createdAt: 2, reasoning: ['三', '四'], reasoningDroppedSegments: 2, reasoningOmittedChars: 7 };
    const [merged] = restoreStrippedReasoning(previous, [full]);
    expect(merged).toBe(full);
  });
});

describe('foldUnsentReasoning', () => {
  it('returns the same message when nothing is unsent', () => {
    const message: ChatMessage = { id: 'a', role: 'assistant', content: '', createdAt: 1, reasoning: ['x'] };
    expect(foldUnsentReasoning(message)).toBe(message);
  });

  // Review Focus #3：孤儿恢复写库前要先并掉，否则 toMessageRecords 丢了这个字段，编号就错位了。
  it('moves the unsent count into reasoningDroppedSegments and drops the now-unknown char count', () => {
    const message: ChatMessage = {
      id: 'a', role: 'assistant', content: '', createdAt: 1,
      reasoning: ['x'], reasoningUnsentSegments: 4, reasoningOmittedChars: 12,
    };
    const folded = foldUnsentReasoning(message);
    expect(folded.reasoningDroppedSegments).toBe(4);
    expect(folded).not.toHaveProperty('reasoningUnsentSegments');
    expect(folded).not.toHaveProperty('reasoningOmittedChars');
  });
```

在同一个 describe 块外，把现有的 `'puts back reasoning the background stripped from history, matched by id'` 用例中的 previous 改为带新字段，并补断言：

```ts
      { id: 'a1', role: 'assistant', content: '旧答', createdAt: 1, reasoning: ['旧推理'], reasoningOmittedChars: 5, reasoningTrimmedChars: [2], reasoningDroppedSegments: 1 },
```

```ts
    expect(result[0]).toMatchObject({ reasoningTrimmedChars: [2], reasoningDroppedSegments: 1 });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/reasoning.test.ts lib/chat/messages.test.ts`
Expected: FAIL（`slimLiveReasoning` / `foldUnsentReasoning` 未导出，合并用例不通过）

- [ ] **Step 4: 在 `lib/agent/reasoning.ts` 末尾实现 `slimLiveReasoning`**

```ts
/**
 * 运行中快照用：最后一条消息只带正在增长的那一段（ref: 设计稿 §3.5）。
 * 已完成的段在它们定型后的"段数变化帧"或 attachPort 的完整帧里发过，面板按绝对段号补回
 * （lib/chat/messages.ts 的 restoreStrippedReasoning）。这样每帧推理体积 ≤ 单段上限，不随运行长度增长。
 */
export function slimLiveReasoning(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last?.reasoning || last.reasoning.length <= 1) return messages;
  const keptTrimmed = last.reasoningTrimmedChars?.at(-1) ?? 0;
  const { reasoningTrimmedChars: _trimmed, ...rest } = last;
  const slim: ChatMessage = {
    ...rest,
    reasoning: [last.reasoning[last.reasoning.length - 1]],
    ...(keptTrimmed > 0 ? { reasoningTrimmedChars: [keptTrimmed] } : {}),
    reasoningUnsentSegments: (last.reasoningUnsentSegments ?? 0) + last.reasoning.length - 1,
  };
  return [...messages.slice(0, -1), slim];
}
```

- [ ] **Step 5: 在 `lib/chat/messages.ts` 实现 `foldUnsentReasoning` 并扩展 `restoreStrippedReasoning`**

用下面的代码替换现有的 `restoreStrippedReasoning`（连同它上方的注释）：

```ts
function reasoningFieldsOf(source: ChatMessage): Partial<ChatMessage> {
  return {
    reasoning: source.reasoning,
    ...(source.reasoningTrimmedChars !== undefined ? { reasoningTrimmedChars: source.reasoningTrimmedChars } : {}),
    ...(source.reasoningDroppedSegments !== undefined ? { reasoningDroppedSegments: source.reasoningDroppedSegments } : {}),
    ...(source.reasoningOmittedChars !== undefined ? { reasoningOmittedChars: source.reasoningOmittedChars } : {}),
  };
}

/**
 * 补不回的传输省略段并进 reasoningDroppedSegments：编号仍然正确，块顶显示"更早的 k 段已省略"。
 * 这时省略的字数已经说不准了，所以一并去掉 reasoningOmittedChars，免得显示一个偏小的数。
 * 孤儿恢复写库前也要走这里（toMessageRecords 不写 reasoningUnsentSegments）。
 */
export function foldUnsentReasoning(message: ChatMessage): ChatMessage {
  if (!message.reasoningUnsentSegments) return message;
  const { reasoningUnsentSegments, reasoningOmittedChars: _omitted, ...rest } = message;
  return { ...rest, reasoningDroppedSegments: (message.reasoningDroppedSegments ?? 0) + reasoningUnsentSegments };
}

/** 按绝对段号从面板手里取出这一帧没发的那几段补在前面；补不上就 fold。 */
function fillUnsentReasoning(message: ChatMessage, source: ChatMessage | undefined): ChatMessage {
  const unsent = message.reasoningUnsentSegments ?? 0;
  const own = message.reasoning ?? [];
  const from = (message.reasoningDroppedSegments ?? 0) - (source?.reasoningDroppedSegments ?? 0);
  const held = source?.reasoning;
  if (!held || from < 0 || held.length < from + unsent) return foldUnsentReasoning(message);
  const trimmed = [
    ...(source?.reasoningTrimmedChars?.slice(from, from + unsent) ?? new Array<number>(unsent).fill(0)),
    ...(message.reasoningTrimmedChars ?? new Array<number>(own.length).fill(0)),
  ];
  const { reasoningUnsentSegments: _unsent, reasoningTrimmedChars: _trimmed, ...rest } = message;
  return {
    ...rest,
    reasoning: [...held.slice(from, from + unsent), ...own],
    ...(trimmed.some((n) => n > 0) ? { reasoningTrimmedChars: trimmed } : {}),
  };
}

/**
 * background 运行中的快照会瘦身推理（见 lib/agent/reasoning.ts 的 stripHistoryReasoning / slimLiveReasoning）：
 * 历史消息整份去掉推理，最后一条只带正在增长的那一段。面板按消息 id 把自己手里的那份补回来，
 * 避免运行期间推理折叠块闪没或段数跳动。没有 reasoningUnsentSegments 的消息（收尾的完整快照）原样采用。
 */
export function restoreStrippedReasoning(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const known = new Map<string, ChatMessage>();
  for (const message of previous) {
    if (message.reasoning !== undefined) known.set(message.id, message);
  }
  return incoming.map((message) => {
    const source = known.get(message.id);
    if (message.reasoning === undefined) {
      return source ? { ...message, ...reasoningFieldsOf(source) } : message;
    }
    if (!message.reasoningUnsentSegments) return message;
    return fillUnsentReasoning(message, source);
  });
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/reasoning.test.ts lib/chat/messages.test.ts`
Expected: PASS。其中原有用例 `'returns incoming messages untouched when nothing needs restoring'` 仍然通过，因为逐条比较时没有需要补的字段，会原样返回同一个引用。

- [ ] **Step 7: 写 run-registry 的失败测试（`lib/agent/run-registry.test.ts`）**

在 `'strips history reasoning from in-flight snapshots ...'` 用例之后追加：

```ts
  // 设计稿 §3.5：段数变化那一帧带全，平时只带正在增长的那一段。
  it('sends every segment on the frame a new segment appears and only the growing one otherwise', async () => {
    const agent = makeFakeAgent([]);
    let listener: (event: unknown) => void = () => undefined;
    let release: () => void = () => undefined;
    agent.prompt = vi.fn(async () => {
      listener = agent.subscribe.mock.calls[0]?.[0] as (event: unknown) => void;
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '一' } });
      listener({ type: 'message_end', message: { role: 'assistant', content: [] } });
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '二' } });
      listener({ type: 'message_end', message: { role: 'assistant', content: [] } });
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '三' } });
      await new Promise<void>((resolve) => { release = resolve; });
    });
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(25, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 25 }));
    // 等 48ms flush 把第三段首次刷出去（段数 2 → 3，这一帧带全）。
    await vi.waitFor(() => expect(lastSnapshot(posted).messages.at(-1)?.reasoning).toEqual(['一', '二', '三']));
    // 同一段继续增长：再一帧只带这一段。
    listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '续' } });
    await vi.waitFor(() => expect(lastSnapshot(posted).messages.at(-1)?.reasoning).toEqual(['三续']));
    expect(lastSnapshot(posted).messages.at(-1)?.reasoningUnsentSegments).toBe(2);

    // Review Focus #2：面板中途挂上来，拿到的是完整一帧。
    const attached = attachPort(25, { postMessage: (m) => posted.push(m) });
    expect(attached?.messages.at(-1)?.reasoning).toEqual(['一', '二', '三续']);
    expect(attached?.messages.at(-1)).not.toHaveProperty('reasoningUnsentSegments');

    release();
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));
    const final = lastSnapshot(posted).messages.at(-1);
    expect(final?.reasoning).toEqual(['一', '二', '三续']);
    expect(final).not.toHaveProperty('reasoningUnsentSegments');
  });
```

- [ ] **Step 8: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts -t "new segment appears"`
Expected: FAIL（`['三续']` 那一步拿到的仍是完整数组）

- [ ] **Step 9: 修改 `lib/agent/run-registry.ts`**

1. import 行：

```ts
import { appendReasoning, emptyReasoning, reasoningMessageFields, reasoningSegmentTotal, slimLiveReasoning, stripHistoryReasoning, type ReasoningBuffer, type ReasoningFields } from './reasoning';
```

同时在从 `@/lib/chat/messages` 导入的列表里加上 `foldUnsentReasoning`（该文件已有 `toMessageRecords, conversationTitle` 的 import，追加到同一行）。

2. `interface RunState` 里，在 `recordingChainStarted: boolean;` 之后加：

```ts
  /**
   * 上一次快照里最后一条消息的推理段数（含丢弃的）。段数比它大就说明刚开了新段，
   * 这一帧要把已定型的段全发出去；否则只发正在增长的那一段（ref: 推理按段限量设计稿 §3.5）。
   */
  sentReasoningSegments: number;
```

3. 创建 state 的对象字面量里，在 `recordingChainStarted: false,` 之后加 `sentReasoningSegments: 0,`。

4. 把 `snapshotOf` 替换为：

```ts
function snapshotOf(state: RunState, full = false): RunSnapshot {
  let messages = state.messages;
  if (state.busy) {
    // 运行中只带当前这条的推理，见 stripHistoryReasoning；收尾（busy:false）那份完整带上。
    messages = stripHistoryReasoning(messages);
    const total = reasoningSegmentTotal(messages[messages.length - 1]);
    if (!full && total <= state.sentReasoningSegments) messages = slimLiveReasoning(messages);
    state.sentReasoningSegments = Math.max(state.sentReasoningSegments, total);
  }
  return {
    tabId: state.tabId,
    conversationId: state.conversationId,
    busy: state.busy,
    messages,
    activitySteps: state.activitySteps,
    pendingConfirmation: state.pendingConfirmation,
    pendingQuestion: state.pendingQuestion,
  };
}
```

5. `attachPort` 改为 `return state ? snapshotOf(state, true) : undefined;`，并在上方加注释：`// 新挂上来的面板手里没有已完成的段，第一帧必须完整。`

6. `scanForOrphans` 里，把 `const last = snapshot.messages[...]` 这一行之前的取值改为先 fold：

```ts
    // 持久化的是瘦身快照：先把没发的段并进丢弃计数，否则 toMessageRecords 丢掉这个字段后编号会错位。
    const recovered = snapshot.messages.map(foldUnsentReasoning);
    const last = recovered[recovered.length - 1];
    const messages: ChatMessage[] = last && last.role === 'assistant' && !last.content
      ? [...recovered.slice(0, -1), { ...last, content: t('store.interruptedByRestart') }]
      : [...recovered, { id: `orphan-${tabId}-${Date.now()}`, role: 'assistant' as const, content: t('store.interruptedByRestart'), createdAt: Date.now() }];
```

- [ ] **Step 10: 运行全部相关测试 + 类型检查**

Run: `pnpm vitest run lib/agent lib/chat && pnpm compile`
Expected: PASS。如果 `'strips history reasoning from in-flight snapshots ...'` 这类旧用例出了问题，先检查它们是否依赖"运行中最后一条消息带完整推理"，再按设计稿 §3.5 调整断言，不要改实现。

- [ ] **Step 11: 提交**

```bash
git add lib/agent/reasoning.ts lib/agent/reasoning.test.ts lib/chat/messages.ts lib/chat/messages.test.ts lib/agent/run-registry.ts lib/agent/run-registry.test.ts
git commit -m "feat(agent): 运行中快照只带正在增长的推理段，面板按段号补回"
```

---

### Task 3: 界面按绝对段号渲染，运行期间标题保持进行时

**Files:**
- Modify: `entrypoints/sidepanel/components/ReasoningBlock.tsx`
- Modify: `entrypoints/sidepanel/components/ReasoningBlock.test.tsx`
- Modify: `entrypoints/sidepanel/App.tsx:595-601`
- Modify: `lib/i18n/locales/zh.ts:168-172`、`lib/i18n/locales/en.ts:174-178`

**Interfaces:**
- Consumes: Task 1 的 `REASONING_SEGMENT_HEAD_CHARS`，以及 `ChatMessage` 的新字段
- Produces: `ReasoningBlock` 的 props 为 `{ segments: string[]; trimmedChars?: number[]; droppedSegments?: number; omittedChars?: number; running: boolean; autoExpand: boolean }`

- [ ] **Step 1: 新增文案（zh / en）**

`lib/i18n/locales/zh.ts` 在 `'chat.reasoning.omitted'` 之后加：

```ts
  'chat.reasoning.liveSegment': '思考中 · 第 {n} 段',
  'chat.reasoning.trimmed': '…中间省略 {count} 字…',
  'chat.reasoning.droppedSegments': '更早的 {count} 段已省略',
  'chat.reasoning.droppedSegmentsWithChars': '更早的 {count} 段已省略（约 {chars} 字）',
```

`lib/i18n/locales/en.ts` 在 `'chat.reasoning.omitted'` 之后加：

```ts
  'chat.reasoning.liveSegment': 'Thinking · step {n}',
  'chat.reasoning.trimmed': '… {count} characters omitted …',
  'chat.reasoning.droppedSegments': '{count} earlier steps omitted',
  'chat.reasoning.droppedSegmentsWithChars': '{count} earlier steps omitted (about {chars} characters)',
```

- [ ] **Step 2: 改写 `ReasoningBlock.test.tsx`**

把 `renderBlock` 和所有用例替换为：

```tsx
type BlockProps = {
  segments: string[];
  trimmedChars?: number[];
  droppedSegments?: number;
  omittedChars?: number;
  running: boolean;
  autoExpand: boolean;
};

function renderBlock(props: BlockProps) {
  return render(
    <LocaleProvider>
      <ReasoningBlock {...props} />
    </LocaleProvider>,
  );
}

const idle = { running: false, autoExpand: false };
const thinking = { running: true, autoExpand: true };

describe('ReasoningBlock', () => {
  it('renders nothing without segments', () => {
    const { container } = renderBlock({ segments: [], ...idle });
    expect(container).toBeEmptyDOMElement();
  });

  it('is expanded with a live title while the model is thinking', () => {
    renderBlock({ segments: ['正在分析页面结构'], ...thinking });
    const toggle = screen.getByRole('button', { name: 'Thinking…' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('正在分析页面结构')).toBeVisible();
  });

  it('shows the current step number while running with several steps', () => {
    renderBlock({ segments: ['a', 'b'], droppedSegments: 3, ...thinking });
    expect(screen.getByRole('button', { name: 'Thinking · step 5' })).toBeInTheDocument();
  });

  // Review Focus #5：正文出来之后折叠，但标题仍是进行时。
  it('keeps the running title but collapses once body text appears', () => {
    renderBlock({ segments: ['a', 'b'], running: true, autoExpand: false });
    const toggle = screen.getByRole('button', { name: 'Thinking · step 2' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses once finished and counts dropped steps too', () => {
    renderBlock({ segments: ['a', 'b'], droppedSegments: 2, ...idle });
    const toggle = screen.getByRole('button', { name: 'Thought process · 4 steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a')).toBeNull();
  });

  it('uses the plain title for a single segment', () => {
    renderBlock({ segments: ['only'], ...idle });
    expect(screen.getByRole('button', { name: 'Thought process' })).toBeInTheDocument();
  });

  it('numbers steps from the dropped offset', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['第一段推理', '第二段推理'], droppedSegments: 3, omittedChars: 900, ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process · 5 steps' }));
    expect(screen.getByText('3 earlier steps omitted (about 900 characters)')).toBeVisible();
    expect(screen.getByText('Step 4')).toBeVisible();
    expect(screen.getByText('Step 5')).toBeVisible();
    expect(screen.getByText('第二段推理')).toBeVisible();
  });

  it('shows dropped steps without a char count when it is unknown', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['x'], droppedSegments: 2, ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process · 3 steps' }));
    expect(screen.getByText('2 earlier steps omitted')).toBeVisible();
  });

  it('marks the trimmed middle of a segment at the fixed head length', async () => {
    const user = userEvent.setup();
    const head = 'H'.repeat(REASONING_SEGMENT_HEAD_CHARS);
    renderBlock({ segments: [`${head}TAIL`], trimmedChars: [321], ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('… 321 characters omitted …')).toBeVisible();
    expect(screen.getByText(head)).toBeVisible();
    expect(screen.getByText('TAIL')).toBeVisible();
  });

  it('collapses automatically when the live phase ends', () => {
    const { rerender } = renderBlock({ segments: ['r'], ...thinking });
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r']} {...idle} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Thought process' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a manual collapse even while new live reasoning arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = renderBlock({ segments: ['r'], ...thinking });
    await user.click(screen.getByRole('button', { name: 'Thinking…' }));
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r more']} {...thinking} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Thinking…' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('r more')).toBeNull();
  });

  // Review Focus #4：存量记录只有旧的字数字段。
  it('keeps the legacy char-count notice for old records', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['tail'], omittedChars: 1200, ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('1200 earlier characters omitted')).toBeVisible();
  });
});
```

并在 import 里加上：`import { REASONING_SEGMENT_HEAD_CHARS } from '@/lib/agent/reasoning';`

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/components/ReasoningBlock.test.tsx`
Expected: FAIL（props 仍然是 `live`，新文案和编号都不对）

- [ ] **Step 4: 改写 `ReasoningBlock.tsx`**

整个文件替换为：

```tsx
import { useEffect, useId, useRef, useState } from 'react';
import { REASONING_SEGMENT_HEAD_CHARS } from '@/lib/agent/reasoning';
import { useTranslation } from '@/lib/i18n';

// 推理过程折叠块（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md §3.4，
// 按段限量的修订见 2026-09-24-reasoning-per-segment-budget-design.md §3.6）。
// 纯文本渲染、不走 Markdown：流式期间每 48ms 重渲一次，Markdown 解析成本太高，推理文本也不依赖排版。
// 内容区不是 live region——状态播报只交给 header 那一行（沿用 2026-09-03 走查 P2-9 的约定）。
export function ReasoningBlock({
  segments,
  trimmedChars,
  droppedSegments = 0,
  omittedChars,
  running,
  autoExpand,
}: {
  segments: string[];
  /** 与 segments 等长：每段中间省略的字数，截断点固定在 REASONING_SEGMENT_HEAD_CHARS。 */
  trimmedChars?: number[];
  /** 最前面不在 segments 里的段数；段数与编号都从它往后数。 */
  droppedSegments?: number;
  omittedChars?: number;
  /** 本轮最后一条消息且运行中：标题保持进行时，与有没有正文无关。 */
  running: boolean;
  /** 运行中且还没有正文：默认展开并自动滚到底。 */
  autoExpand: boolean;
}) {
  const { t } = useTranslation();
  // null = 跟随自动状态；用户点过之后记住选择，自动状态不再覆盖（不持久化）。
  const [manual, setManual] = useState<boolean | null>(null);
  const contentId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const expanded = manual ?? autoExpand;
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);
  const totalSegments = droppedSegments + segments.length;

  useEffect(() => {
    if (!running || !expanded) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [running, expanded, totalChars]);

  if (segments.length === 0) return null;

  const title = running
    ? totalSegments > 1
      ? t('chat.reasoning.liveSegment', { n: totalSegments })
      : t('chat.reasoning.live')
    : totalSegments > 1
      ? t('chat.reasoning.doneSegments', { count: totalSegments })
      : t('chat.reasoning.done');

  // 新记录用段数；存量记录只有 omittedChars（旧滑动窗口删掉的字数），沿用原文案。
  const omittedNotice = droppedSegments > 0
    ? omittedChars
      ? t('chat.reasoning.droppedSegmentsWithChars', { count: droppedSegments, chars: omittedChars })
      : t('chat.reasoning.droppedSegments', { count: droppedSegments })
    : omittedChars
      ? t('chat.reasoning.omitted', { count: omittedChars })
      : null;

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        onClick={() => setManual(!expanded)}
        className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-neutral-500 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <span aria-hidden="true" className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>
          ›
        </span>
        <span className={running ? 'animate-pulse' : undefined}>{title}</span>
      </button>
      {expanded && (
        <div
          id={contentId}
          ref={scrollRef}
          className={`mt-1.5 overflow-y-auto border-l-2 border-neutral-200 pl-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 ${
            autoExpand ? 'max-h-40' : 'max-h-80'
          }`}
        >
          {omittedNotice ? (
            <p className="mb-1 italic text-neutral-400 dark:text-neutral-500">{omittedNotice}</p>
          ) : null}
          {segments.map((segment, index) => {
            const trimmed = trimmedChars?.[index] ?? 0;
            return (
              <div key={droppedSegments + index} className={index > 0 ? 'mt-2' : undefined}>
                {totalSegments > 1 && (
                  <p className="mb-0.5 font-medium text-neutral-400 dark:text-neutral-500">
                    {t('chat.reasoning.segment', { n: droppedSegments + index + 1 })}
                  </p>
                )}
                {trimmed > 0 ? (
                  <>
                    <p className="whitespace-pre-wrap break-words">{segment.slice(0, REASONING_SEGMENT_HEAD_CHARS)}</p>
                    <p className="my-0.5 italic text-neutral-400 dark:text-neutral-500">
                      {t('chat.reasoning.trimmed', { count: trimmed })}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{segment.slice(REASONING_SEGMENT_HEAD_CHARS)}</p>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{segment}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 修改 `App.tsx` 的调用处**

```tsx
        {message.reasoning && message.reasoning.length > 0 && (
          <ReasoningBlock
            segments={message.reasoning}
            trimmedChars={message.reasoningTrimmedChars}
            droppedSegments={message.reasoningDroppedSegments}
            omittedChars={message.reasoningOmittedChars}
            running={busy && isLastMessage}
            autoExpand={busy && isLastMessage && !content}
          />
        )}
```

- [ ] **Step 6: 运行测试 + 类型检查**

Run: `pnpm vitest run entrypoints/sidepanel lib/i18n && pnpm compile`
Expected: PASS（`i18n.test.ts` 的键一致性检查通过）

- [ ] **Step 7: 提交**

```bash
git add entrypoints/sidepanel/components/ReasoningBlock.tsx entrypoints/sidepanel/components/ReasoningBlock.test.tsx entrypoints/sidepanel/App.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(sidepanel): 推理块按绝对段号编号，运行中标题保持进行时，段内省略就地标注"
```

---

### Task 4: 文档收尾与全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-reasoning-per-segment-budget-design.md`（状态改为"已实现"）
- Modify: `docs/superpowers/specs/2026-09-24-reasoning-display-design.md`（状态行后加一行：§3.2 / §3.4 的限量与标题已由按段限量设计稿修订）
- Modify: `CLAUDE.md`（`stream-shared.ts` 那一段里关于 `MAX_REASONING_CHARS` 的描述）

- [ ] **Step 1: 更新 CLAUDE.md**

把 `(a \`MAX_REASONING_CHARS\` 20,000 sliding window, applied at run time because every 48ms snapshot carries it)` 替换为：

```
(per segment: `MAX_REASONING_SEGMENT_CHARS` 6,000 keeping the first `REASONING_SEGMENT_HEAD_CHARS` 1,500 plus the tail; per message: `MAX_REASONING_TOTAL_CHARS` 100,000, dropping whole oldest segments and counting them in `reasoningDroppedSegments` so step numbers never shift; in-flight snapshots carry only the growing segment plus a transport-only `reasoningUnsentSegments`, which the panel's `restoreStrippedReasoning` fills back by absolute segment index — ref: `docs/superpowers/specs/2026-09-24-reasoning-per-segment-budget-design.md`)
```

- [ ] **Step 2: 更新两份设计稿的状态行**

新设计稿：`- 状态：待审` → `- 状态：已实现`。
旧设计稿：在 `- 状态：已实现` 之后插入一行 `- 修订：§3.2 的限量与 §3.4 的标题、省略提示已由 \`2026-09-24-reasoning-per-segment-budget-design.md\` 取代`。

- [ ] **Step 3: 全量验证**

Run: `pnpm compile && pnpm test && pnpm build`
Expected: 三者都成功；`pnpm test` 全绿（包括 `lib/brand-*.test.ts` 等全仓守卫测试）。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-24-reasoning-per-segment-budget-design.md docs/superpowers/specs/2026-09-24-reasoning-display-design.md
git commit -m "docs: 推理按段限量实现完成，更新设计稿状态与 CLAUDE.md"
```
