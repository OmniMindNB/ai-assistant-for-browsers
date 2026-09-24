# 显示推理过程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把推理模型流式返回的推理内容（OpenAI 兼容协议的 `reasoning_content` / `reasoning`、Anthropic 协议的 `thinking_delta`）展示在侧边栏 assistant 气泡上方的折叠块里，并随消息保存进历史。

**Architecture:** 流式层只发 pi-ai 已有的 `thinking_start/delta/end` 事件，推理不进 `AssistantMessage.content`。`run-registry.ts` 订阅这些事件，按 LLM 调用分段累积，限定 20,000 字符的滑动窗口，写到占位 assistant 消息的 `reasoning` 字段上，复用现有的 48ms 刷新和 Dexie 落库。面板新增 `ReasoningBlock` 组件渲染这个字段。

**Tech Stack:** TypeScript、React 19、Zustand、Dexie、vitest（`unit` / `ui` 两个 project）、`@earendil-works/pi-ai` 的 `AssistantMessageEvent`。

**Spec:** `docs/superpowers/specs/2026-09-24-reasoning-display-design.md`

## Global Constraints

- 推理**不进** `AssistantMessage.content`，两个 `convertMessages` 的请求体**不变**，推理不回传给模型。
- thinking 事件的 `contentIndex` 统一写 `0`。
- `MAX_REASONING_CHARS = 20_000`，定义在 `lib/agent/reasoning.ts`；超出时从最早的段开头删字，删空的段整段移除，删掉的字数累加到 `reasoningOmittedChars`。
- 一次 LLM 调用（`turn_start` 计数）最多一段；没有推理的调用不留空段。
- 新字段：`ChatMessage` / `ChatMessageRecord` 的 `reasoning?: string[]` 和 `reasoningOmittedChars?: number`，只在 assistant 消息上、且真的收到过推理时写。不建索引，不升级 Dexie 版本。
- 推理不经过 `redactText`，不进会话导出，`toAgentMessages` 不回放。
- 推理按纯文本渲染（`whitespace-pre-wrap`），不经过 Markdown。
- 新文案走 `lib/i18n`，zh/en 两个字典必须同时加（`lib/i18n/i18n.test.ts` 会检查两边键一致）。
- 代码注释用中文，与周边风格一致。直接提交到 `main`，不建分支（见 CLAUDE.md "Git" 一节）。每个提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. **用户在模型思考到一半时点停止**（还没有任何正文，也没等到 `message_end`）：已经流出的推理必须保留在消息上，消息同时标记 `stopped`。48ms 刷新定时器在 `finally` 里会被清掉，所以收尾路径必须自己把推理写进去。→ Task 5 Step 1 第二个用例。
2. **供应商在推理阶段发 `content: ""`、推理结束后发 `reasoning_content: null`**（DeepSeek 的实际行为）：不能因此产生空的 thinking 块，也不能提前结束推理块。→ Task 3 Step 1 "ignores empty and null fields"。
3. **只有推理、没有正文，因为 `finish_reason: "length"` 结束**：`thinking_end` 仍然要发，最终消息不能凭空多出正文；推理照常保留，由 `describeEmptyAgentRun` 给出"达到 token 上限"的提示。→ Task 3 Step 1 "closes the thinking block when the response ends with only reasoning"。
4. **单段推理本身超过 20,000 字**：从这一段的开头截掉，保留末尾，省略字数累计正确。→ Task 2 Step 1 "clips a single oversized segment from its head"。
5. **存量历史消息没有 `reasoning` 字段**：面板渲染必须和今天一模一样，不出现空的折叠块。→ Task 6 Step 1 "renders nothing without segments"。

---

### Task 1: 消息字段与持久化映射

**Files:**
- Modify: `lib/chat/messages.ts`（`ChatMessage` 接口；`toMessageRecords` 在约第 119–132 行）
- Modify: `lib/db.ts`（`ChatMessageRecord` 接口，从第 13 行开始）
- Modify: `entrypoints/sidepanel/store.ts`（`openConversation` 里 record → `UIMessage` 的映射，约第 950–967 行）
- Test: `lib/chat/messages.test.ts`、`lib/chat/conversation-export.test.ts`、`lib/agent/turn-context.test.ts`、`entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Produces: `ChatMessage.reasoning?: string[]`、`ChatMessage.reasoningOmittedChars?: number`；`ChatMessageRecord` 上的同名同类型字段。

- [ ] **Step 1: 写失败的测试**

在 `lib/chat/messages.test.ts` 的 `describe('toMessageRecords', ...)` 块末尾追加：

```ts
  it('carries reasoning and its omitted-char count into the record', () => {
    const records = toMessageRecords('c-1', [
      msg('a', 'user', '问'),
      { ...msg('b', 'assistant', '答'), reasoning: ['先想', '再想'], reasoningOmittedChars: 12 },
    ]);
    expect(records[1].reasoning).toEqual(['先想', '再想']);
    expect(records[1].reasoningOmittedChars).toBe(12);
  });
```

在 `lib/chat/conversation-export.test.ts` 的 `describe('buildConversationExport', ...)` 块末尾追加：

```ts
  // 推理只给面板回看用，导出不带（ref: 2026-09-24-reasoning-display-design.md §3.3）。
  it('never exports assistant reasoning', () => {
    const doc = build([
      record({ content: '问' }),
      record({ role: 'assistant', content: '答', reasoning: ['推理里的秘密步骤'], reasoningOmittedChars: 3 }),
    ]);
    expect(JSON.stringify(doc)).not.toContain('推理里的秘密步骤');
    expect(renderConversationExportMarkdown(doc, t)).not.toContain('推理里的秘密步骤');
  });
```

在 `lib/agent/turn-context.test.ts` 的 `describe('toAgentMessages', ...)` 块末尾追加：

```ts
  it('never replays assistant reasoning to the model', () => {
    const result = toAgentMessages([userMsg(), assistantMsg({ reasoning: ['不该回传的推理'] })]);
    expect(JSON.stringify(result)).not.toContain('不该回传的推理');
  });
```

在 `entrypoints/sidepanel/store-context.test.tsx` 里 `it('keeps the latest conversation selection when an earlier read resolves late', ...)` 之后追加：

```tsx
  it('restores reasoning fields when opening a stored conversation', async () => {
    mocks.getConversationMessages.mockResolvedValueOnce([
      { role: 'user', content: '问', createdAt: 1 },
      { role: 'assistant', content: '答', createdAt: 2, reasoning: ['第一段', '第二段'], reasoningOmittedChars: 40 },
    ]);
    await expect(useChat.getState().openConversation('R')).resolves.toBe(true);
    const assistant = useChat.getState().messages[1];
    expect(assistant?.reasoning).toEqual(['第一段', '第二段']);
    expect(assistant?.reasoningOmittedChars).toBe(40);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/chat/messages.test.ts lib/chat/conversation-export.test.ts lib/agent/turn-context.test.ts entrypoints/sidepanel/store-context.test.tsx`
Expected: 类型检查不在 vitest 里做，所以 `toMessageRecords` 和 store 这两条用例会以 `expected undefined to deeply equal [...]` 失败；导出和 turn-context 两条守卫用例此时应该已经通过（导出按白名单取字段，`toAgentMessages` 只读 `content`），这是预期的：它们是防回归的守卫。

- [ ] **Step 3: 加字段并补映射**

`lib/chat/messages.ts` 的 `ChatMessage` 接口，在 `runDiagnostics?` 之后加：

```ts
  /**
   * 推理模型本轮流式返回的推理内容，按 LLM 调用分段（一次调用一段），已按
   * lib/agent/reasoning.ts 的 MAX_REASONING_CHARS 滑动窗口限量；仅 assistant 消息、且真的收到过推理时才有值。
   * 只供面板回看：不回传给模型、不进会话导出（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md）。
   */
  reasoning?: string[];
  /** 滑动窗口丢掉的最早那部分推理的字数；没有丢弃时不写。 */
  reasoningOmittedChars?: number;
```

`lib/db.ts` 的 `ChatMessageRecord` 接口末尾加：

```ts
  /**
   * 推理内容（按 LLM 调用分段，已限量），仅 assistant 消息有意义，见 ChatMessage.reasoning。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为没有推理。
   */
  reasoning?: string[];
  /** 滑动窗口丢掉的推理字数，见 ChatMessage.reasoningOmittedChars。 */
  reasoningOmittedChars?: number;
```

`lib/chat/messages.ts` 的 `toMessageRecords`，在 `runDiagnostics: message.runDiagnostics,` 之后加：

```ts
    reasoning: message.reasoning,
    reasoningOmittedChars: message.reasoningOmittedChars,
```

`entrypoints/sidepanel/store.ts` 的 `openConversation` 映射，在 `runDiagnostics: r.runDiagnostics,` 之后加：

```ts
        reasoning: r.reasoning,
        reasoningOmittedChars: r.reasoningOmittedChars,
```

- [ ] **Step 4: 运行测试和类型检查，确认通过**

Run: `pnpm vitest run lib/chat/messages.test.ts lib/chat/conversation-export.test.ts lib/agent/turn-context.test.ts entrypoints/sidepanel/store-context.test.tsx && pnpm compile`
Expected: 全部 PASS，`tsc --noEmit` 无输出。

- [ ] **Step 5: 提交**

```bash
git add lib/chat/messages.ts lib/db.ts entrypoints/sidepanel/store.ts lib/chat/messages.test.ts lib/chat/conversation-export.test.ts lib/agent/turn-context.test.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "$(cat <<'EOF'
feat(chat): 消息新增 reasoning 字段并随会话落库

推理按 LLM 调用分段存在 assistant 消息上，写库与读库两处映射都补上；
补守卫测试：导出不带推理，toAgentMessages 不回放推理。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 推理累积的纯函数（`lib/agent/reasoning.ts`）

**Files:**
- Create: `lib/agent/reasoning.ts`
- Test: `lib/agent/reasoning.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ChatMessage.reasoning` / `reasoningOmittedChars`。
- Produces:
  - `export const MAX_REASONING_CHARS = 20_000;`
  - `export interface ReasoningBuffer { segments: string[]; omittedChars: number; lastTurn: number | null }`
  - `export function emptyReasoning(): ReasoningBuffer`
  - `export function appendReasoning(buffer: ReasoningBuffer, turn: number, delta: string, maxChars?: number): ReasoningBuffer`（不修改入参，返回新对象）
  - `export function reasoningMessageFields(buffer: ReasoningBuffer): Pick<ChatMessage, 'reasoning' | 'reasoningOmittedChars'>`（没有推理时返回 `{}`）

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/reasoning.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/reasoning.test.ts`
Expected: FAIL，报 `Failed to resolve import "./reasoning"`。

- [ ] **Step 3: 实现**

创建 `lib/agent/reasoning.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/reasoning.test.ts`
Expected: PASS（11 个用例）。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/reasoning.ts lib/agent/reasoning.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): 推理内容按 LLM 调用分段累积，20k 字滑动窗口限量

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: thinking 发射器 + OpenAI 兼容流解析推理

**Files:**
- Modify: `lib/agent/stream-shared.ts`（新增 `createThinkingEmitter`）
- Modify: `lib/agent/openai-stream.ts`（`OpenAIStreamChunk` 类型、`runOpenAIStream`、`processChunk`）
- Test: `lib/agent/openai-stream.test.ts`

**Interfaces:**
- Produces（`stream-shared.ts`）：

```ts
export interface ThinkingEmitter {
  /** 追加一段推理；空串忽略。第一次调用时先发 thinking_start。 */
  delta(text: string): void;
  /** 推理块开着时发 thinking_end 并关闭；没开着时什么都不做。可重复调用。 */
  end(): void;
}
export function createThinkingEmitter(
  push: (event: AssistantMessageEvent) => void,
  partial: () => AssistantMessage,
): ThinkingEmitter;
```

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/openai-stream.test.ts` 文件末尾追加：

```ts
describe('reasoning content', () => {
  async function eventsFor(body: Response): Promise<AssistantMessageEvent[]> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body));
    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserOpenAIStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    return collectEvents(stream);
  }

  /** 只看推理、正文、工具调用和收尾这几类事件的顺序。 */
  function kinds(events: AssistantMessageEvent[]): string[] {
    return events
      .map((event) => event.type)
      .filter((type) => type.startsWith('thinking') || type.startsWith('text') || type === 'toolcall_delta' || type === 'done' || type === 'error');
  }

  function doneContent(events: AssistantMessageEvent[]): unknown[] {
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error(`expected done, got ${done?.type}`);
    return done.message.content;
  }

  it('emits thinking events for reasoning_content and closes them before the answer text', async () => {
    const events = await eventsFor(sseResponse([
      { choices: [{ delta: { reasoning_content: '先想' } }] },
      { choices: [{ delta: { reasoning_content: '一下' } }] },
      { choices: [{ delta: { content: '答案' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    expect(kinds(events)).toEqual([
      'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end',
      'text_start', 'text_delta', 'text_end', 'done',
    ]);
    expect(events.find((event) => event.type === 'thinking_end')).toMatchObject({ content: '先想一下', contentIndex: 0 });
    // 推理只走事件，不进最终消息的 content。
    expect(doneContent(events)).toEqual([{ type: 'text', text: '答案' }]);
  });

  it('accepts the `reasoning` field used by OpenRouter and some vLLM deployments', async () => {
    const events = await eventsFor(sseResponse([
      { choices: [{ delta: { reasoning: 'r1' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
    ]));
    expect(events.find((event) => event.type === 'thinking_delta')).toMatchObject({ delta: 'r1' });
  });

  // Review Focus #2：DeepSeek 推理阶段 content 是 ""，推理结束后 reasoning_content 是 null。
  it('ignores empty and null fields instead of opening or closing blocks early', async () => {
    const events = await eventsFor(sseResponse([
      { choices: [{ delta: { reasoning_content: 'a', content: '' } }] },
      { choices: [{ delta: { reasoning_content: '', content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'b', content: null } }] },
      { choices: [{ delta: { reasoning_content: null, content: '答' } }] },
    ]));
    expect(kinds(events)).toEqual([
      'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end',
      'text_start', 'text_delta', 'text_end', 'done',
    ]);
  });

  it('closes the thinking block before the first tool call', async () => {
    const events = await eventsFor(sseResponse([
      { choices: [{ delta: { reasoning_content: '要点击按钮' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'browser_click', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    const order = kinds(events);
    expect(order.indexOf('thinking_end')).toBeLessThan(order.indexOf('toolcall_delta'));
    expect(doneContent(events)).toEqual([expect.objectContaining({ type: 'toolCall', name: 'browser_click' })]);
  });

  // Review Focus #3
  it('closes the thinking block when the response ends with only reasoning', async () => {
    const events = await eventsFor(sseResponse([
      { choices: [{ delta: { reasoning_content: '想太久了' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]));
    expect(kinds(events)).toEqual(['thinking_start', 'thinking_delta', 'thinking_end', 'done']);
    expect(doneContent(events)).toEqual([]);
  });

  it('opens a fresh thinking block each time reasoning resumes after text', async () => {
    const events = await eventsFor(sseResponse([
      { choices: [{ delta: { reasoning_content: 'r1' } }] },
      { choices: [{ delta: { content: 't1' } }] },
      { choices: [{ delta: { reasoning_content: 'r2' } }] },
      { choices: [{ delta: { content: 't2' } }] },
    ]));
    expect(events.filter((event) => event.type === 'thinking_start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'thinking_end')).toHaveLength(2);
    expect(doneContent(events)).toEqual([{ type: 'text', text: 't1t2' }]);
  });

  it('closes an open thinking block before reporting a mid-stream error', async () => {
    const body = 'data: {"choices":[{"delta":{"reasoning_content":"r"}}]}\n\ndata: {broken\n\n';
    const events = await eventsFor(new Response(body, { status: 200 }));
    expect(kinds(events)).toEqual(['thinking_start', 'thinking_delta', 'thinking_end', 'error']);
  });

  it('never sends thinking parts back in the request body', () => {
    const context = {
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '不该回传' }, { type: 'text', text: '答' }] },
      ],
    } as unknown as Context;
    const wire = convertMessages(context);
    expect(JSON.stringify(wire)).not.toContain('不该回传');
    expect(wire[1]).toEqual({ role: 'assistant', content: '答', tool_calls: undefined });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/openai-stream.test.ts -t "reasoning content"`
Expected: 除最后一条 `never sends thinking parts back` 以外全部 FAIL（事件序列里没有任何 `thinking_*`）。最后一条是锁住现状的守卫，此时应该已经通过。

- [ ] **Step 3: 在 `stream-shared.ts` 里加发射器**

先运行 `sed -n 1,20p lib/agent/stream-shared.ts` 看现有的 import。确保从 `@earendil-works/pi-ai` 引入了 `AssistantMessage` 和 `AssistantMessageEvent` 两个类型，缺哪个补哪个。然后在 `buildPartial` 之后加：

```ts
export interface ThinkingEmitter {
  /** 追加一段推理；空串忽略。第一次调用时先发 thinking_start。 */
  delta(text: string): void;
  /** 推理块开着时发 thinking_end 并关闭；没开着时什么都不做。可重复调用。 */
  end(): void;
}

/**
 * 两个 streamFn 共用的推理事件发射器（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md §3.1）。
 *
 * 推理只走事件，不进 AssistantMessage.content：content 被上下文压缩、tool-call-repair、
 * task-outcome 等多处读取，正文固定在 contentIndex 0 的约定也依赖它；我们本来就不回传推理，
 * 放进去没有好处。因此 partial 仍由调用方用 buildPartial 构造（不带推理），thinking 事件的
 * contentIndex 统一写 0——pi-ai 的类型要求有这个字段，唯一的消费方 run-registry.ts 不读它。
 */
export function createThinkingEmitter(
  push: (event: AssistantMessageEvent) => void,
  partial: () => AssistantMessage,
): ThinkingEmitter {
  let open = false;
  let content = '';
  return {
    delta(text) {
      if (!text) return;
      if (!open) {
        open = true;
        content = '';
        push({ type: 'thinking_start', contentIndex: 0, partial: partial() });
      }
      content += text;
      push({ type: 'thinking_delta', contentIndex: 0, delta: text, partial: partial() });
    },
    end() {
      if (!open) return;
      open = false;
      push({ type: 'thinking_end', contentIndex: 0, content, partial: partial() });
    },
  };
}
```

- [ ] **Step 4: 在 `openai-stream.ts` 里解析推理**

1. `OpenAIStreamChunk.choices[].delta` 里，在 `content?: string | null;` 之后加：

```ts
      /** DeepSeek / Qwen / Kimi 等推理模型的推理增量。 */
      reasoning_content?: string | null;
      /** OpenRouter 与部分 vLLM 部署用这个字段名。 */
      reasoning?: string | null;
```

2. 顶部 `./stream-shared` 的 import 里加上 `createThinkingEmitter, type ThinkingEmitter`。

3. `runOpenAIStream` 里，在 `const toolNames = ...` 这一行之后加：

```ts
  // text 与 toolCalls 是下面持续改写的局部变量，partial 用闭包现取，拿到的永远是当下状态。
  const thinking = createThinkingEmitter(push, () => buildPartial(model, startedAt, text, toolCalls, 'stop'));
```

4. `if (data === '[DONE]') {` 分支内部第一行加 `thinking.end();`。循环结束后的收尾处，在 `if (textStarted) {` 之前加一行 `thinking.end();`。

5. `catch (error) {` 分支内部第一行加：

```ts
    // 推理块开着就先收口，保证 start/end 成对，再报错。
    thinking.end();
```

6. `processChunk(...)` 的调用处，把 `thinking` 作为最后一个参数传进去：

```ts
        processChunk(chunk, model, push, startedAt, text, toolCalls, (delta) => {
          // ……原有函数体不变……
        }, thinking);
```

7. `processChunk` 函数签名末尾加参数 `thinking: ThinkingEmitter`。把函数体开头的

```ts
  if (delta.content) appendText(delta.content);
```

替换为：

```ts
  // 推理与正文 / 工具调用的先后：同一个 chunk 里先推理、后正文。只接受非空字符串——
  // DeepSeek 推理阶段 content 是 ""、推理结束后 reasoning_content 是 null，都不能开关推理块。
  const reasoning = typeof delta.reasoning_content === 'string' && delta.reasoning_content
    ? delta.reasoning_content
    : typeof delta.reasoning === 'string' ? delta.reasoning : '';
  if (reasoning) thinking.delta(reasoning);

  if (delta.content) {
    thinking.end();
    appendText(delta.content);
  }
  if (delta.tool_calls?.length) thinking.end();
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/openai-stream.test.ts && pnpm compile`
Expected: 整个文件 PASS（原有用例也不能坏），`tsc` 无输出。

- [ ] **Step 6: 提交**

```bash
git add lib/agent/stream-shared.ts lib/agent/openai-stream.ts lib/agent/openai-stream.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): OpenAI 兼容流解析 reasoning_content/reasoning 为 thinking 事件

推理只走事件、不进 content，请求体不变；空串与 null 不开关推理块，
正文、工具调用、流结束和出错时都会收口。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Anthropic 流解析 thinking 块

**Files:**
- Modify: `lib/agent/anthropic-stream.ts`（`AnthropicSseEvent` 类型、`runAnthropicStream`）
- Test: `lib/agent/anthropic-stream.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `createThinkingEmitter` / `ThinkingEmitter`（来自 `./stream-shared`）。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/anthropic-stream.test.ts` 文件末尾追加：

```ts
describe('thinking blocks', () => {
  function sse(events: Array<Record<string, unknown>>): string {
    return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n`).join('\n');
  }

  async function eventsFor(body: string): Promise<AssistantMessageEvent[]> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(body)));
    const context = { systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    return collectEvents(stream);
  }

  function kinds(events: AssistantMessageEvent[]): string[] {
    return events
      .map((event) => event.type)
      .filter((type) => type.startsWith('thinking') || type.startsWith('text') || type === 'done');
  }

  it('turns thinking_delta into thinking events and ignores signatures and redacted blocks', async () => {
    const events = await eventsFor(sse([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'OPAQUE' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]));
    expect(kinds(events)).toEqual([
      'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end',
      'text_start', 'text_delta', 'text_end', 'done',
    ]);
    expect(events.find((event) => event.type === 'thinking_end')).toMatchObject({ content: 'Let me think' });
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.message.content).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(JSON.stringify(events)).not.toContain('SIG');
    expect(JSON.stringify(events)).not.toContain('OPAQUE');
  });

  it('closes an unterminated thinking block at message_stop', async () => {
    const events = await eventsFor(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'cut' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ]));
    expect(kinds(events)).toEqual(['thinking_start', 'thinking_delta', 'thinking_end', 'done']);
  });

  it('never sends thinking parts back in the request body', () => {
    const context = {
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '不该回传', thinkingSignature: 'S' }, { type: 'text', text: '答' }] },
      ],
    } as unknown as Context;
    expect(JSON.stringify(convertMessagesForAnthropic(context))).not.toContain('不该回传');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/anthropic-stream.test.ts -t "thinking blocks"`
Expected: 前两条 FAIL（没有 `thinking_*` 事件），第三条守卫用例此时应该已经通过。

- [ ] **Step 3: 实现**

1. `AnthropicSseEvent.delta` 的类型里加 `thinking?: string`：

```ts
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
```

2. `./stream-shared` 的 import 里加 `createThinkingEmitter`。

3. `runAnthropicStream` 里，在 `const toolNames = ...` 之后加：

```ts
  // 与 openai-stream.ts 同一套发射器：推理只走事件、不进 content，也不回传（我们不发 thinking 参数，
  // 只有兼容端点主动返回推理时才会走到这里）。signature_delta 与 redacted_thinking 块没有可展示的内容，直接忽略。
  const thinking = createThinkingEmitter(push, () => buildPartial(model, startedAt, text, toolCalls, 'stop'));
  const thinkingBlockIndexes = new Set<number>();
```

4. 在事件循环里，`const event = JSON.parse(data) as AnthropicSseEvent;` 之后、处理 `text` 块开始的 `if` 之前，加：

```ts
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
```

5. 在 text 块开始（`content_block?.type === 'text'`）和 tool_use 块开始（`content_block?.type === 'tool_use'`）两个分支的第一行，都加 `thinking.end();`。这是给不发 `content_block_stop` 的兼容端点兜底。

6. `if (event.type === 'message_stop') {` 分支内部第一行加 `thinking.end();`；循环结束后收尾处的 `if (textStarted) {` 之前加 `thinking.end();`；`catch (error) {` 分支第一行加 `thinking.end();`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/anthropic-stream.test.ts && pnpm compile`
Expected: 整个文件 PASS，`tsc` 无输出。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/anthropic-stream.ts lib/agent/anthropic-stream.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): Anthropic 流解析 thinking 块为 thinking 事件

忽略 signature_delta 与 redacted_thinking；不发 thinking 参数，只在兼容端点主动返回时生效。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: run-registry 累积推理并写到消息上

**Files:**
- Modify: `lib/agent/run-registry.ts`（`replaceLastAssistant` 约第 266 行；`startRun` 里的 `flush`、`agent.subscribe`、`prompt` 收尾的四处 `replaceLastAssistant` 调用）
- Test: `lib/agent/run-registry.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `emptyReasoning`、`appendReasoning`、`reasoningMessageFields`、`ReasoningBuffer`；Task 1 的 `ChatMessage.reasoning` / `reasoningOmittedChars`。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/run-registry.test.ts` 的 `describe('run-registry startRun', ...)` 块末尾追加：

```ts
  /** 最后一条推给面板的快照。 */
  function lastSnapshot(posted: unknown[]): { busy: boolean; messages: Array<Record<string, unknown>> } {
    const snapshots = posted.filter((m) => (m as { type?: string }).type === 'snapshot');
    return snapshots.at(-1) as { busy: boolean; messages: Array<Record<string, unknown>> };
  }

  it('segments reasoning by LLM turn and archives it on the final assistant message', async () => {
    const agent = makeFakeAgent([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想' } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '再想' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '答案' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '答案' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(21, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 21 }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const last = lastSnapshot(posted).messages.at(-1);
    expect(last?.content).toBe('答案');
    expect(last?.reasoning).toEqual(['先想', '再想']);
    expect(last).not.toHaveProperty('reasoningOmittedChars');

    // 同一份字段也落进了 Dexie。
    const persisted = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1] as Array<Record<string, unknown>>;
    expect(persisted.at(-1)?.reasoning).toEqual(['先想', '再想']);
  });

  // Review Focus #1：思考到一半点停止，没有正文、也没等到 message_end。
  it('keeps reasoning streamed before the user stopped the run', async () => {
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const listener = agent.subscribe.mock.calls[0]?.[0] as (event: unknown) => void;
      listener({ type: 'turn_start' });
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想到一半' } });
      stopRun(22);
    });
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(22, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 22 }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const last = lastSnapshot(posted).messages.at(-1);
    expect(last?.stopped).toBe(true);
    expect(last?.reasoning).toEqual(['想到一半']);
  });

  it('writes no reasoning fields when the model produced none', async () => {
    const agent = makeFakeAgent([
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const posted: unknown[] = [];
    attachPort(23, { postMessage: (m) => posted.push(m) });

    await startRun(makeRequest({ tabId: 23 }));
    await vi.waitFor(() => expect(lastSnapshot(posted)?.busy).toBe(false));

    const last = lastSnapshot(posted).messages.at(-1);
    expect(last).not.toHaveProperty('reasoning');
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts -t "reasoning"`
Expected: 前两条 FAIL（`reasoning` 为 `undefined`），第三条此时应该已经通过。

- [ ] **Step 3: 实现**

1. 顶部 import 加：

```ts
import { appendReasoning, emptyReasoning, reasoningMessageFields, type ReasoningBuffer } from './reasoning';
```

2. 把 `replaceLastAssistant` 改为：

```ts
function replaceLastAssistant(
  state: RunState,
  content: string,
  extra: Pick<ChatMessage, 'reasoning' | 'reasoningOmittedChars'> = {},
): void {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;
  state.messages = [...state.messages.slice(0, -1), { ...last, content, ...extra }];
}
```

3. `startRun` 里，在 `let acc = '';` 之后加：

```ts
  // 推理与 acc 平行累积：同一个 48ms flush 一起写到占位 assistant 消息上（ref: 设计稿 §3.2）。
  let reasoning: ReasoningBuffer = emptyReasoning();
```

4. `flush` 里的 `replaceLastAssistant(state, acc);` 改为：

```ts
    replaceLastAssistant(state, acc, reasoningMessageFields(reasoning));
```

5. 在 `agent.subscribe` 回调里，处理 `text_delta` 的 `if` 块之后加：

```ts
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') {
      reasoning = appendReasoning(reasoning, llmTurns, event.assistantMessageEvent.delta);
      if (flushTimer === null) flushTimer = setTimeout(flush, STREAM_FLUSH_INTERVAL_MS);
    }
```

6. `void (async () => { try { ... } catch (e) { ... } })` 里的四处 `replaceLastAssistant(state, <内容>)` 调用，全部追加第三个参数 `reasoningMessageFields(reasoning)`。四处分别是：用户停止分支的 `t('store.generationAborted')`、正常结束的 `acc`、catch 里用户中止分支、catch 里报错分支。在第一处上方加注释：

```ts
        // finally 会清掉尚未触发的 flush 定时器：停止/出错时最后几段推理可能还没刷进消息，
        // 所以收尾这几处都要显式带上推理，不能指望 flush 已经写过。
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/run-registry.test.ts && pnpm compile`
Expected: 整个文件 PASS，`tsc` 无输出。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/run-registry.ts lib/agent/run-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): run-registry 按 LLM 调用累积推理并归档到 assistant 消息

复用 48ms 流式刷新推送；停止/出错的收尾路径显式带上推理，避免最后几段丢失。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 面板 `ReasoningBlock` 组件与文案

**Files:**
- Create: `entrypoints/sidepanel/components/ReasoningBlock.tsx`
- Create: `entrypoints/sidepanel/components/ReasoningBlock.test.tsx`
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`（在 `'chat.contextTruncatedNotice'` 之后）
- Modify: `entrypoints/sidepanel/App.tsx`（`Message` 组件 assistant 分支，约第 590–603 行）

**Interfaces:**
- Consumes: Task 1 的 `ChatMessage.reasoning` / `reasoningOmittedChars`。
- Produces: `export function ReasoningBlock(props: { segments: string[]; omittedChars?: number; live: boolean }): JSX.Element | null`

- [ ] **Step 1: 写失败的测试**

创建 `entrypoints/sidepanel/components/ReasoningBlock.test.tsx`（测试环境语言解析为 en）：

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocaleProvider } from '@/lib/i18n';
import { ReasoningBlock } from './ReasoningBlock';

function renderBlock(props: { segments: string[]; omittedChars?: number; live: boolean }) {
  return render(
    <LocaleProvider>
      <ReasoningBlock {...props} />
    </LocaleProvider>,
  );
}

describe('ReasoningBlock', () => {
  // Review Focus #5：存量消息没有推理，渲染必须与今天一致。
  it('renders nothing without segments', () => {
    const { container } = renderBlock({ segments: [], live: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('is expanded with a live title while the model is thinking', () => {
    renderBlock({ segments: ['正在分析页面结构'], live: true });
    const toggle = screen.getByRole('button', { name: /Thinking/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('正在分析页面结构')).toBeVisible();
  });

  it('collapses once finished and shows the segment count', () => {
    renderBlock({ segments: ['a', 'b'], live: false });
    const toggle = screen.getByRole('button', { name: 'Thought process · 2 steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a')).toBeNull();
  });

  it('uses the plain title for a single segment', () => {
    renderBlock({ segments: ['only'], live: false });
    expect(screen.getByRole('button', { name: 'Thought process' })).toBeInTheDocument();
  });

  it('expands on click and labels each segment', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['第一段推理', '第二段推理'], live: false });
    await user.click(screen.getByRole('button', { name: 'Thought process · 2 steps' }));
    expect(screen.getByText('Step 1')).toBeVisible();
    expect(screen.getByText('Step 2')).toBeVisible();
    expect(screen.getByText('第二段推理')).toBeVisible();
  });

  it('collapses automatically when the live phase ends', () => {
    const { rerender } = renderBlock({ segments: ['r'], live: true });
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r']} live={false} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Thought process' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a manual collapse even while new live reasoning arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = renderBlock({ segments: ['r'], live: true });
    await user.click(screen.getByRole('button', { name: /Thinking/ }));
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r more']} live />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: /Thinking/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('r more')).toBeNull();
  });

  it('shows how many earlier characters were omitted', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['tail'], omittedChars: 1200, live: false });
    await user.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('1200 earlier characters omitted')).toBeVisible();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/components/ReasoningBlock.test.tsx`
Expected: FAIL，报 `Failed to resolve import "./ReasoningBlock"`。

- [ ] **Step 3: 加文案**

`lib/i18n/locales/zh.ts`，在 `'chat.contextTruncatedNotice': ...,` 之后加：

```ts
  'chat.reasoning.live': '思考中…',
  'chat.reasoning.done': '已思考',
  'chat.reasoning.doneSegments': '已思考 · {count} 段',
  'chat.reasoning.segment': '第 {n} 次思考',
  'chat.reasoning.omitted': '更早的 {count} 字已省略',
```

`lib/i18n/locales/en.ts`，在同一位置加：

```ts
  'chat.reasoning.live': 'Thinking…',
  'chat.reasoning.done': 'Thought process',
  'chat.reasoning.doneSegments': 'Thought process · {count} steps',
  'chat.reasoning.segment': 'Step {n}',
  'chat.reasoning.omitted': '{count} earlier characters omitted',
```

- [ ] **Step 4: 实现组件**

创建 `entrypoints/sidepanel/components/ReasoningBlock.tsx`：

```tsx
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';

// 推理过程折叠块（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md §3.4）。
// 纯文本渲染、不走 Markdown：流式期间每 48ms 重渲一次，Markdown 解析成本太高，推理文本也不依赖排版。
// 内容区不是 live region——状态播报只交给 header 那一行（沿用 2026-09-03 走查 P2-9 的约定）。
export function ReasoningBlock({
  segments,
  omittedChars,
  live,
}: {
  segments: string[];
  omittedChars?: number;
  /** 本轮最后一条消息、运行中、且还没有正文：此时默认展开并自动滚到底。 */
  live: boolean;
}) {
  const { t } = useTranslation();
  // null = 跟随自动状态；用户点过之后记住选择，自动状态不再覆盖（不持久化）。
  const [manual, setManual] = useState<boolean | null>(null);
  const contentId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const expanded = manual ?? live;
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);

  useEffect(() => {
    if (!live || !expanded) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [live, expanded, totalChars]);

  if (segments.length === 0) return null;

  const title = live
    ? t('chat.reasoning.live')
    : segments.length > 1
      ? t('chat.reasoning.doneSegments', { count: segments.length })
      : t('chat.reasoning.done');

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
        <span className={live ? 'animate-pulse' : undefined}>{title}</span>
      </button>
      {expanded && (
        <div
          id={contentId}
          ref={scrollRef}
          className={`mt-1.5 overflow-y-auto border-l-2 border-neutral-200 pl-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 ${
            live ? 'max-h-40' : 'max-h-80'
          }`}
        >
          {omittedChars ? (
            <p className="mb-1 italic text-neutral-400 dark:text-neutral-500">
              {t('chat.reasoning.omitted', { count: omittedChars })}
            </p>
          ) : null}
          {segments.map((segment, index) => (
            <div key={index} className={index > 0 ? 'mt-2' : undefined}>
              {segments.length > 1 && (
                <p className="mb-0.5 font-medium text-neutral-400 dark:text-neutral-500">
                  {t('chat.reasoning.segment', { n: index + 1 })}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words">{segment}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 运行组件测试和 i18n 测试，确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/components/ReasoningBlock.test.tsx lib/i18n/i18n.test.ts`
Expected: PASS。如果 `toBeVisible` 断言因为 jsdom 不支持 `overflow` 相关计算而失败，把对应的 `toBeVisible()` 改成 `toBeInTheDocument()`，不要改组件。

- [ ] **Step 6: 接进 `App.tsx`**

1. 顶部 import 区加 `import { ReasoningBlock } from './components/ReasoningBlock';`（与其它 `./components/...` import 放在一起）。

2. `Message` 组件 assistant 分支里，把：

```tsx
        {content ? (
          <MarkdownBlock content={content} />
        ) : busy ? (
          <TypingDots />
        ) : null}
```

替换为：

```tsx
        {message.reasoning && message.reasoning.length > 0 && (
          <ReasoningBlock
            segments={message.reasoning}
            omittedChars={message.reasoningOmittedChars}
            live={busy && isLastMessage && !content}
          />
        )}
        {content ? (
          <MarkdownBlock content={content} />
        ) : busy && !(isLastMessage && message.reasoning?.length) ? (
          // 正在流式输出推理时，"思考中…"标题已经是等待反馈，不再叠一个 TypingDots。
          <TypingDots />
        ) : null}
```

`isLastMessage` 是 `Message` 已有的 prop（约第 487 行解构），函数体里可以直接用。

- [ ] **Step 7: 运行面板相关测试与类型检查**

Run: `pnpm vitest run entrypoints/sidepanel && pnpm compile`
Expected: 全部 PASS，`tsc` 无输出。

- [ ] **Step 8: 提交**

```bash
git add entrypoints/sidepanel/components/ReasoningBlock.tsx entrypoints/sidepanel/components/ReasoningBlock.test.tsx entrypoints/sidepanel/App.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "$(cat <<'EOF'
feat(sidepanel): assistant 气泡上方新增推理过程折叠块

运行中展开并自动滚到底，正文出现或本轮结束后折叠；用户手动切换后不被自动状态覆盖。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 文档收尾与全量验证

**Files:**
- Modify: `CLAUDE.md`（`stream-shared.ts` 那一条，以及 `lib/chat/` 下 `messages.ts` 那一条）
- Modify: `docs/superpowers/specs/2026-09-24-reasoning-display-design.md`（状态行）

- [ ] **Step 1: 更新 CLAUDE.md**

在 "Agent loop (`lib/agent/`)" 一节 `stream-shared.ts` 那一条里，`fetchLlmWithRetry` 那句之后插入：

```markdown
It also holds `createThinkingEmitter`, which both `streamFn`s use to turn provider reasoning (OpenAI-compatible `reasoning_content`/`reasoning`, Anthropic `thinking_delta`) into pi-ai `thinking_*` events — reasoning travels **only** as events and never enters `AssistantMessage.content`, so the wire format, `contentIndex` layout and every content reader stay unchanged, and reasoning is never sent back to the model. `run-registry.ts` accumulates it per LLM turn through `lib/agent/reasoning.ts` (a `MAX_REASONING_CHARS` 20,000 sliding window, applied at run time because every 48ms snapshot carries it) onto `ChatMessage.reasoning`, which the panel renders with `ReasoningBlock.tsx` and which is excluded from conversation export (ref: `docs/superpowers/specs/2026-09-24-reasoning-display-design.md`).
```

- [ ] **Step 2: 更新 spec 状态**

把 `docs/superpowers/specs/2026-09-24-reasoning-display-design.md` 的 `- 状态：设计已确认，待写实现计划` 改为 `- 状态：已实现`。

- [ ] **Step 3: 全量验证**

Run: `pnpm compile && pnpm test && pnpm build && pnpm verify:pdfjs-assets`
Expected: `tsc` 无输出；vitest 全部 PASS（基线 110 个文件 / 2122 个用例，新增后两个数都会变多，但不能有 FAIL）；`wxt build` 成功产出 `.output/chrome-mv3`；pdfjs 资产校验通过。这四步和 `.github/workflows/deploy-pages.yml` 在 CI 里跑的一致。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-24-reasoning-display-design.md
git commit -m "$(cat <<'EOF'
docs: 推理过程显示实现完成，更新 spec 状态与 CLAUDE.md 架构说明

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: 真实模型手动验证（需要用户参与）**

在 `lib/dev-config.ts` 里临时配一个 DeepSeek-reasoner（或其他会返回 `reasoning_content` 的模型）的 key（**不要提交**），执行 `pnpm dev`，在任意页面上提一个需要调用工具的问题，确认：
- 等待首 token 期间出现"思考中…"并实时滚动；
- 正文出现后折叠为"已思考 · N 段"，点击能展开；
- 重开这个会话，推理仍然可以展开；
- 思考中途点停止，推理保留，消息带"已停止"标记。

把结果告诉用户；spec §5 的两个待验证事项（DeepSeek 工具循环、推理与正文交替的显示效果）也在这一步顺带观察并记录。
