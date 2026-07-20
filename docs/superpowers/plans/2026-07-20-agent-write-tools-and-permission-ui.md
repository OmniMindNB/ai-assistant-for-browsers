# Agent Write Tools + Permission Confirmation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconnect the "页面改造" (page transformation) feature by registering a full set of write/interaction Agent tools and building the permission-confirmation UI that was scaffolded but never wired up.

**Architecture:** Nine new/reused Agent tools call new/existing `background.ts` message handlers over the existing `lib/messaging.ts` protocol. A per-tab "turn snapshot" (pure module, no browser API) backs a single whole-turn undo. `lib/agent/agent.ts`'s `beforeToolCall` gate awaits a real UI confirmation exactly once per turn via a new `onConfirm` callback threaded in from `entrypoints/sidepanel/store.ts`; the confirmation card and undo button render in `App.tsx`.

**Tech Stack:** WXT (MV3) + React 19 + TypeScript + Zustand + `@earendil-works/pi-agent-core`. Vitest is added in Task 1 for pure-logic unit tests (no test framework exists in the repo today).

**Spec:** `docs/specs/0001-agent-write-tools-and-permission-ui.md` — read it before starting; this plan implements it task by task and does not repeat its rationale.

## Global Constraints

- Every new Agent tool name, message type, and payload/result shape below is used verbatim by later tasks — do not rename anything mid-plan.
- All new backend logic reuses the existing `executeInActiveTab` MAIN-world execution pattern in `entrypoints/background.ts` — no new execution surface.
- Chinese user-facing strings (error messages, UI copy) must match the project's existing Chinese-language convention seen throughout `entrypoints/` and `lib/`.
- Run `pnpm compile` after every task that touches TypeScript; it must pass before moving to the next task.
- Only `git add` the files a task actually touches, then commit — never a blanket `git add -A`.

---

### Task 1: Test infrastructure + per-tab turn-snapshot store

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add `vitest` devDependency + `"test"` script)
- Create: `lib/agent/turn-snapshot.ts`
- Test: `lib/agent/turn-snapshot.test.ts`

**Interfaces:**
- Produces: `StorageSnapshotEntry { area: 'local' | 'session'; key: string; previousValue: string | null }`, `CapturePageState { url: string; bodyHTML: string; scrollX: number; scrollY: number }`, `TurnSnapshot extends CapturePageState { storageEntries: StorageSnapshotEntry[] }`, `hasSnapshot(tabId: number): boolean`, `getSnapshot(tabId: number): TurnSnapshot | undefined`, `beginSnapshotIfNeeded(tabId: number, capture: CapturePageState): TurnSnapshot`, `recordStorageEntryIfAbsent(tabId: number, entry: StorageSnapshotEntry): void`, `clearSnapshot(tabId: number): void` — all consumed by `entrypoints/background.ts` starting in Task 5.

- [ ] **Step 1: Install vitest**

Run: `pnpm add -D vitest`
Expected: `vitest` added to `devDependencies` in `package.json`.

- [ ] **Step 2: Add the vitest config**

Create `vitest.config.ts`:

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
```

- [ ] **Step 3: Add the test script**

In `package.json`, inside `"scripts"`, add:

```json
"test": "vitest run",
```

- [ ] **Step 4: Write the failing tests**

Create `lib/agent/turn-snapshot.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
} from './turn-snapshot';

describe('turn-snapshot', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    clearSnapshot(TAB_ID);
  });

  it('has no snapshot for an untouched tab', () => {
    expect(hasSnapshot(TAB_ID)).toBe(false);
    expect(getSnapshot(TAB_ID)).toBeUndefined();
  });

  it('creates a snapshot on first call and keeps it on later calls', () => {
    const first = beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://a.example',
      bodyHTML: '<p>a</p>',
      scrollX: 0,
      scrollY: 0,
    });
    const second = beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://b.example',
      bodyHTML: '<p>b</p>',
      scrollX: 10,
      scrollY: 20,
    });
    expect(first).toBe(second);
    expect(getSnapshot(TAB_ID)?.url).toBe('https://a.example');
  });

  it('records a storage entry only once per key', () => {
    beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'dark' });
    expect(getSnapshot(TAB_ID)?.storageEntries).toEqual([
      { area: 'local', key: 'theme', previousValue: 'light' },
    ]);
  });

  it('does nothing when recording a storage entry without an existing snapshot', () => {
    recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    expect(hasSnapshot(TAB_ID)).toBe(false);
  });

  it('clears the snapshot', () => {
    beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    clearSnapshot(TAB_ID);
    expect(hasSnapshot(TAB_ID)).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `lib/agent/turn-snapshot.ts` does not exist yet.

- [ ] **Step 6: Implement the turn-snapshot store**

Create `lib/agent/turn-snapshot.ts`:

```ts
// 每个标签页一份"本轮"快照，用于"撤销本轮更改"。
// 快照只在本轮第一次写操作时创建（beginSnapshotIfNeeded），
// RESET_TURN_SNAPSHOT（新一轮开始）或 REVERT_CHANGES（撤销后）会清空它。

export interface StorageSnapshotEntry {
  area: 'local' | 'session';
  key: string;
  previousValue: string | null;
}

export interface CapturePageState {
  url: string;
  bodyHTML: string;
  scrollX: number;
  scrollY: number;
}

export interface TurnSnapshot extends CapturePageState {
  storageEntries: StorageSnapshotEntry[];
}

const snapshots = new Map<number, TurnSnapshot>();

export function hasSnapshot(tabId: number): boolean {
  return snapshots.has(tabId);
}

export function getSnapshot(tabId: number): TurnSnapshot | undefined {
  return snapshots.get(tabId);
}

/** 若该 tab 本轮还没有快照，用给定的页面状态创建一份；已存在则原样返回，不覆盖。 */
export function beginSnapshotIfNeeded(tabId: number, capture: CapturePageState): TurnSnapshot {
  const existing = snapshots.get(tabId);
  if (existing) return existing;
  const created: TurnSnapshot = { ...capture, storageEntries: [] };
  snapshots.set(tabId, created);
  return created;
}

/** 记录某个 storage key 本轮修改前的值；同一个 key 本轮只记录一次（保留最早的原值）。 */
export function recordStorageEntryIfAbsent(tabId: number, entry: StorageSnapshotEntry): void {
  const snapshot = snapshots.get(tabId);
  if (!snapshot) return;
  const exists = snapshot.storageEntries.some((e) => e.area === entry.area && e.key === entry.key);
  if (!exists) snapshot.storageEntries.push(entry);
}

export function clearSnapshot(tabId: number): void {
  snapshots.delete(tabId);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all 5 tests green.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts lib/agent/turn-snapshot.ts lib/agent/turn-snapshot.test.ts
git commit -m "test: add vitest infra and per-tab turn-snapshot store"
```

---

### Task 2: Confirmation summary text

**Files:**
- Create: `lib/agent/confirm-summary.ts`
- Test: `lib/agent/confirm-summary.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ConfirmationSummary { summary: string; codePreview?: string }`, `summarizeToolCallForConfirmation(toolName: string, args: unknown): ConfirmationSummary` — consumed by `entrypoints/sidepanel/store.ts` in Task 10.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/confirm-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { summarizeToolCallForConfirmation } from './confirm-summary';

describe('summarizeToolCallForConfirmation', () => {
  it('summarizes inject_script with a code preview', () => {
    const result = summarizeToolCallForConfirmation('browser_inject_script', { code: 'document.title = "x"' });
    expect(result.summary).toContain('注入');
    expect(result.codePreview).toBe('document.title = "x"');
  });

  it('summarizes set_style with the selector', () => {
    const result = summarizeToolCallForConfirmation('browser_set_style', { selector: '.ad', styles: { display: 'none' } });
    expect(result.summary).toContain('.ad');
    expect(result.codePreview).toBeUndefined();
  });

  it('summarizes modify_dom with selector and action', () => {
    const result = summarizeToolCallForConfirmation('browser_modify_dom', { selector: '.ad', action: 'remove' });
    expect(result.summary).toContain('.ad');
    expect(result.summary).toContain('remove');
  });

  it('summarizes click, type, select, scroll, navigate, set_storage', () => {
    expect(summarizeToolCallForConfirmation('browser_click', { selector: 'button' }).summary).toContain('button');
    expect(summarizeToolCallForConfirmation('browser_type', { selector: 'input' }).summary).toContain('input');
    expect(summarizeToolCallForConfirmation('browser_select', { selector: 'select', value: 'a' }).summary).toContain('a');
    expect(summarizeToolCallForConfirmation('browser_scroll', {}).summary).toContain('滚动');
    expect(summarizeToolCallForConfirmation('browser_navigate', { url: 'https://x.test' }).summary).toContain(
      'https://x.test',
    );
    expect(summarizeToolCallForConfirmation('browser_set_storage', { area: 'local', key: 'k' }).summary).toContain('k');
  });

  it('falls back to a generic summary for an unknown tool', () => {
    const result = summarizeToolCallForConfirmation('browser_something_new', {});
    expect(result.summary).toContain('browser_something_new');
  });

  it('handles non-object args without throwing', () => {
    expect(() => summarizeToolCallForConfirmation('browser_click', undefined)).not.toThrow();
    expect(() => summarizeToolCallForConfirmation('browser_click', 'not an object')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `lib/agent/confirm-summary.ts` does not exist yet.

- [ ] **Step 3: Implement the summary function**

Create `lib/agent/confirm-summary.ts`:

```ts
export interface ConfirmationSummary {
  summary: string;
  codePreview?: string;
}

export function summarizeToolCallForConfirmation(toolName: string, args: unknown): ConfirmationSummary {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');

  switch (toolName) {
    case 'browser_inject_script':
      return { summary: 'AI 想要注入一段脚本来修改当前页面。', codePreview: str('code') };
    case 'browser_set_style':
      return { summary: `AI 想要修改匹配 "${str('selector')}" 的元素样式。` };
    case 'browser_modify_dom':
      return { summary: `AI 想要对匹配 "${str('selector')}" 的元素执行 "${str('action')}"。` };
    case 'browser_click':
      return { summary: `AI 想要点击 "${str('selector')}"。` };
    case 'browser_type':
      return { summary: `AI 想要在 "${str('selector')}" 中输入文本。` };
    case 'browser_select':
      return { summary: `AI 想要把 "${str('selector')}" 的选项设为 "${str('value')}"。` };
    case 'browser_scroll':
      return { summary: 'AI 想要滚动页面。' };
    case 'browser_navigate':
      return { summary: `AI 想要跳转到 "${str('url')}"。` };
    case 'browser_set_storage':
      return { summary: `AI 想要写入 ${str('area')}Storage 的 "${str('key')}"。` };
    default:
      return { summary: `AI 想要执行 "${toolName}"。` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/confirm-summary.ts lib/agent/confirm-summary.test.ts
git commit -m "feat: add human-readable summaries for write tool confirmations"
```

---

### Task 3: Confirm-gate mechanics (memoized per-turn wait + abort handling)

**Files:**
- Create: `lib/agent/confirm-gate.ts`
- Test: `lib/agent/confirm-gate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (only the `BeforeToolCallResult` type from `@earendil-works/pi-agent-core`, already a project dependency).
- Produces: `ConfirmFn = (toolCallId: string, toolName: string, args: unknown, reason: string) => Promise<boolean>`, `ConfirmGateState { decision: 'unset' | 'approved' | 'denied' }`, `createConfirmGateState(): ConfirmGateState`, `raceWithAbort(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean>`, `resolveConfirmGate(state, toolCallId, toolName, args, reason, onConfirm, signal): Promise<BeforeToolCallResult | undefined>` — all consumed by `lib/agent/permissions.ts` in Task 4.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/confirm-gate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createConfirmGateState, raceWithAbort, resolveConfirmGate } from './confirm-gate';

describe('raceWithAbort', () => {
  it('returns the promise result when there is no signal', async () => {
    await expect(raceWithAbort(Promise.resolve(true))).resolves.toBe(true);
  });

  it('resolves to false immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const never = new Promise<boolean>(() => {});
    await expect(raceWithAbort(never, controller.signal)).resolves.toBe(false);
  });

  it('resolves to false when the signal aborts before the promise settles', async () => {
    const controller = new AbortController();
    let settleLater: (value: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      settleLater = resolve;
    });
    const result = raceWithAbort(pending, controller.signal);
    controller.abort();
    await expect(result).resolves.toBe(false);
    settleLater(true); // 迟到的 resolve 不应再影响已经返回的结果
  });
});

describe('resolveConfirmGate', () => {
  it('asks onConfirm once and remembers approval for later calls in the same turn', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);

    const first = await resolveConfirmGate(state, 'call-1', 'browser_click', { selector: 'button' }, '需要确认', onConfirm);
    expect(first).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const second = await resolveConfirmGate(state, 'call-2', 'browser_type', { selector: 'input' }, '需要确认', onConfirm);
    expect(second).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('remembers denial and blocks subsequent calls without asking again', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(false);

    const first = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm);
    expect(first).toEqual({ block: true, reason: '用户拒绝了该操作。' });

    const second = await resolveConfirmGate(state, 'call-2', 'browser_type', {}, '需要确认', onConfirm);
    expect(second).toEqual({ block: true, reason: '用户已拒绝本轮页面修改，不再重复询问。' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('blocks with a fixed message when no onConfirm is supplied', async () => {
    const state = createConfirmGateState();
    const result = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', undefined);
    expect(result).toEqual({ block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' });
  });

  it('treats an aborted signal as a denial', async () => {
    const state = createConfirmGateState();
    const controller = new AbortController();
    controller.abort();
    const onConfirm = vi.fn().mockImplementation(() => new Promise<boolean>(() => {}));
    const result = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, controller.signal);
    expect(result).toEqual({ block: true, reason: '用户拒绝了该操作。' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `lib/agent/confirm-gate.ts` does not exist yet.

- [ ] **Step 3: Implement the confirm gate**

Create `lib/agent/confirm-gate.ts`:

```ts
import type { BeforeToolCallResult } from '@earendil-works/pi-agent-core';

export type ConfirmFn = (toolCallId: string, toolName: string, args: unknown, reason: string) => Promise<boolean>;

export interface ConfirmGateState {
  decision: 'unset' | 'approved' | 'denied';
}

export function createConfirmGateState(): ConfirmGateState {
  return { decision: 'unset' };
}

/** signal 触发 abort 时把 promise 当作 false（拒绝）处理。 */
export async function raceWithAbort(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return promise;
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

/**
 * 每轮只向用户确认一次：第一次 confirm 级工具调用会等待 onConfirm 的结果并记忆下来，
 * 同一个 state 实例（= 同一轮）内后续 confirm 级调用直接复用这个决定，不再重复询问。
 */
export async function resolveConfirmGate(
  state: ConfirmGateState,
  toolCallId: string,
  toolName: string,
  args: unknown,
  reason: string,
  onConfirm: ConfirmFn | undefined,
  signal?: AbortSignal,
): Promise<BeforeToolCallResult | undefined> {
  if (state.decision === 'approved') return undefined;
  if (state.decision === 'denied') {
    return { block: true, reason: '用户已拒绝本轮页面修改，不再重复询问。' };
  }
  if (!onConfirm) {
    return { block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' };
  }
  const approved = await raceWithAbort(onConfirm(toolCallId, toolName, args, reason), signal);
  state.decision = approved ? 'approved' : 'denied';
  if (!approved) return { block: true, reason: '用户拒绝了该操作。' };
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/confirm-gate.ts lib/agent/confirm-gate.test.ts
git commit -m "feat: add per-turn confirmation gate with abort handling"
```

---

### Task 4: Permission gate — deny non-http(s) navigation, wire real confirmation end-to-end

**Files:**
- Modify: `lib/agent/permissions.ts`
- Test: `lib/agent/permissions.test.ts`
- Modify: `lib/agent/agent.ts`

**Interfaces:**
- Consumes: `createConfirmGateState`, `resolveConfirmGate`, `ConfirmFn`, `ConfirmGateState` from `./confirm-gate` (Task 3).
- Produces: `PermissionGateOptions { gateState: ConfirmGateState; onConfirm?: ConfirmFn; signal?: AbortSignal }`; `beforeToolCallPermissionGate(context: BeforeToolCallContext, options: PermissionGateOptions): Promise<BeforeToolCallResult | undefined>` — **signature changed** from the current `(context)` to `(context, options)`, with its one call site (in `lib/agent/agent.ts`) updated in the same task so the build never sits broken between commits. `decideToolPermission` keeps its existing signature and behavior, with one new branch for `browser_navigate`. `BrowserAgentOptions` (in `agent.ts`) gains `onConfirm?: ConfirmFn` — consumed by `entrypoints/sidepanel/store.ts` in Task 10.

**Note:** No test file exists for this module today. This task adds the first one.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/permissions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { beforeToolCallPermissionGate, decideToolPermission } from './permissions';
import { createConfirmGateState } from './confirm-gate';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';

function makeContext(toolName: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: { role: 'assistant', content: [] } as unknown as BeforeToolCallContext['assistantMessage'],
    toolCall: { id: 'call-1', type: 'toolCall', name: toolName, arguments: args } as unknown as BeforeToolCallContext['toolCall'],
    args,
    context: {} as BeforeToolCallContext['context'],
  };
}

describe('decideToolPermission', () => {
  it('always allows read-only tools', () => {
    expect(decideToolPermission('browser_read_page', {})).toEqual({ level: 'always_allow' });
  });

  it('auto-allows revert_changes', () => {
    expect(decideToolPermission('browser_revert_changes', {})).toEqual({ level: 'auto_allow' });
  });

  it('denies an unknown tool', () => {
    expect(decideToolPermission('browser_made_up', {}).level).toBe('deny');
  });

  it('denies eval_raw unconditionally', () => {
    expect(decideToolPermission('browser_eval_raw', {}).level).toBe('deny');
  });

  it('requires confirmation for the write/interaction tools', () => {
    for (const tool of [
      'browser_inject_script',
      'browser_set_style',
      'browser_modify_dom',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_select',
      'browser_set_storage',
    ]) {
      expect(decideToolPermission(tool, { code: 'void 0' }).level).toBe('confirm');
    }
  });

  it('denies inject_script with dangerous code', () => {
    expect(decideToolPermission('browser_inject_script', { code: 'eval("x")' }).level).toBe('deny');
  });

  it('denies navigate to a javascript: URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'javascript:alert(1)' }).level).toBe('deny');
  });

  it('denies navigate to a malformed URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'not a url' }).level).toBe('deny');
  });

  it('requires confirmation for navigate to an https URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'https://example.com' })).toEqual({
      level: 'confirm',
      reason: expect.stringContaining('修改页面'),
    });
  });
});

describe('beforeToolCallPermissionGate', () => {
  it('allows read-only tools without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_read_page', {}), {
      gateState: createConfirmGateState(),
      onConfirm,
    });
    expect(result).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('denies immediately without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_eval_raw', {}), {
      gateState: createConfirmGateState(),
      onConfirm,
    });
    expect(result?.block).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('awaits onConfirm for a confirm-tier tool and allows once approved', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const result = await beforeToolCallPermissionGate(makeContext('browser_click', { selector: 'button' }), {
      gateState: createConfirmGateState(),
      onConfirm,
    });
    expect(result).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledWith('call-1', 'browser_click', { selector: 'button' }, expect.any(String));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — navigate cases fail (no such branch yet), and `beforeToolCallPermissionGate` tests fail (signature mismatch).

- [ ] **Step 3: Implement the changes**

In `lib/agent/permissions.ts`, add the import and the navigate rule, then replace `beforeToolCallPermissionGate`.

Change the top import line:

```ts
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { analyzeScript } from '@/lib/security';
```

to:

```ts
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { analyzeScript } from '@/lib/security';
import { resolveConfirmGate, type ConfirmFn, type ConfirmGateState } from './confirm-gate';
```

In `decideToolPermission`, right after the existing `browser_inject_script` block (the one calling `analyzeScript`), add:

```ts
  if (toolName === 'browser_navigate') {
    const url = extractStringArg(args, 'url');
    let isHttpUrl = false;
    try {
      isHttpUrl = /^https?:$/.test(new URL(url).protocol);
    } catch {
      isHttpUrl = false;
    }
    if (!isHttpUrl) {
      return { level: 'deny', reason: '仅允许跳转到 http/https 地址。' };
    }
  }
```

Replace the existing `beforeToolCallPermissionGate` function (which currently just hard-blocks `confirm`) with:

```ts
export interface PermissionGateOptions {
  gateState: ConfirmGateState;
  onConfirm?: ConfirmFn;
  signal?: AbortSignal;
}

export async function beforeToolCallPermissionGate(
  context: BeforeToolCallContext,
  options: PermissionGateOptions,
): Promise<BeforeToolCallResult | undefined> {
  const decision = decideToolPermission(context.toolCall.name, context.args);
  if (decision.level === 'always_allow' || decision.level === 'auto_allow') return undefined;
  if (decision.level === 'deny') {
    return { block: true, reason: decision.reason ?? '该操作已被安全策略阻止。' };
  }
  return resolveConfirmGate(
    options.gateState,
    context.toolCall.id,
    context.toolCall.name,
    context.args,
    decision.reason ?? '该操作会修改页面或浏览器状态，需要用户确认。',
    options.onConfirm,
    options.signal,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all `permissions.test.ts` cases green, plus all previous suites still green.

- [ ] **Step 5: Update `beforeToolCallPermissionGate`'s only call site**

`lib/agent/agent.ts` currently calls `beforeToolCallPermissionGate(context)` with the old one-argument signature — update it in this same task so the build is never left broken between commits.

Change the import line:

```ts
import { beforeToolCallPermissionGate } from './permissions';
import { createBrowserTools, type BrowserAgentTool } from './tools';
```

to:

```ts
import { beforeToolCallPermissionGate } from './permissions';
import { createConfirmGateState, type ConfirmFn } from './confirm-gate';
import { createBrowserTools, type BrowserAgentTool } from './tools';
```

Add `onConfirm` to `BrowserAgentOptions`:

```ts
export interface BrowserAgentOptions {
  provider: ProviderConfig;
  systemPrompt?: string;
  tools?: BrowserAgentTool[];
  messages?: AgentMessage[];
  maxToolTurns?: number;
  onConfirm?: ConfirmFn;
}
```

Inside `createBrowserAgent`, add the per-agent gate state alongside the other closure variables (`completedToolTurns`, `implementationDossierCollected`, etc.):

```ts
  const toolCallCounts = new Map<string, number>();
  const confirmGateState = createConfirmGateState();
  let agent: Agent;
```

Replace the final line of `beforeToolCall`:

```ts
      return beforeToolCallPermissionGate(context);
```

with:

```ts
      return beforeToolCallPermissionGate(context, {
        gateState: confirmGateState,
        onConfirm: options.onConfirm,
        signal,
      });
```

- [ ] **Step 6: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors anywhere in the project.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites from Tasks 1-4 still green.

- [ ] **Step 8: Commit**

```bash
git add lib/agent/permissions.ts lib/agent/permissions.test.ts lib/agent/agent.ts
git commit -m "feat: deny non-http(s) navigation and wire real confirmation end-to-end"
```

---

### Task 5: `SET_STYLE` + `MODIFY_DOM` — style and DOM-edit tools

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/agent/tools.ts`

**Interfaces:**
- Consumes: `hasSnapshot`, `beginSnapshotIfNeeded`, `type CapturePageState` from `lib/agent/turn-snapshot.ts` (Task 1).
- Produces: message types `'SET_STYLE' | 'MODIFY_DOM'`; `SetStylePayload { selector: string; styles: Record<string, string> }`, `SetStyleResult { selector: string; matched: number }`, `ModifyDomPayload { selector: string; action: 'remove' | 'setText' | 'setHtml' | 'setAttribute' | 'addClass' | 'removeClass'; value?: string; attribute?: string }`, `ModifyDomResult { selector: string; matched: number; action: ModifyDomPayload['action'] }`; background function `ensureTurnSnapshot(tabId: number): Promise<void>` (reused by every task through Task 9); Agent tools `browser_set_style`, `browser_modify_dom`.

No automated test for this task — DOM mutation requires a real `browser.scripting` execution context that isn't available under Node/vitest. Verified manually in Step 5.

- [ ] **Step 1: Add the new message types and payload/result interfaces**

In `lib/messaging.ts`, add `'SET_STYLE'` and `'MODIFY_DOM'` to the `MessageType` union:

```ts
export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'GET_ACTIVE_TAB'
  | 'QUERY_DOM'
  | 'GET_HTML'
  | 'GET_SCRIPTS'
  | 'GET_STYLESHEETS'
  | 'GET_COMPUTED_STYLE'
  | 'GET_PAGE_META'
  | 'CAPTURE_SCREENSHOT'
  | 'INJECT_SCRIPT'
  | 'UNDO_SCRIPT'
  | 'SET_STYLE'
  | 'MODIFY_DOM'
  | 'CHAT';
```

(`'UNDO_SCRIPT'` is removed in Task 9, not here — leave it for now so Task 9's diff is self-contained.)

Add near the `InjectScriptPayload`/`InjectScriptResult` interfaces:

```ts
export interface SetStylePayload {
  selector: string;
  styles: Record<string, string>;
}

export interface SetStyleResult {
  selector: string;
  matched: number;
}

export interface ModifyDomPayload {
  selector: string;
  action: 'remove' | 'setText' | 'setHtml' | 'setAttribute' | 'addClass' | 'removeClass';
  value?: string;
  attribute?: string;
}

export interface ModifyDomResult {
  selector: string;
  matched: number;
  action: ModifyDomPayload['action'];
}
```

- [ ] **Step 2: Add the background handlers**

In `entrypoints/background.ts`, add to the import block from `@/lib/messaging`:

```ts
  type ModifyDomPayload,
  type ModifyDomResult,
  type SetStylePayload,
  type SetStyleResult,
```

Add a new import line right below the existing `import { analyzeScript } from '@/lib/security';`:

```ts
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
  type CapturePageState,
} from '@/lib/agent/turn-snapshot';
```

Add `'SET_STYLE'` and `'MODIFY_DOM'` to `SUPPORTED_MESSAGE_TYPES`:

```ts
const SUPPORTED_MESSAGE_TYPES = [
  'PING',
  'EXTRACT_PAGE',
  'GET_SELECTION',
  'GET_ACTIVE_TAB',
  'QUERY_DOM',
  'GET_HTML',
  'GET_SCRIPTS',
  'GET_STYLESHEETS',
  'GET_COMPUTED_STYLE',
  'GET_PAGE_META',
  'CAPTURE_SCREENSHOT',
  'INJECT_SCRIPT',
  'UNDO_SCRIPT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CHAT',
] as const;
```

Add two cases to the `handleMessage` switch, right before `case 'INJECT_SCRIPT':`:

```ts
    case 'SET_STYLE':
      return setStyle(message.payload as SetStylePayload);

    case 'MODIFY_DOM':
      return modifyDom(message.payload as ModifyDomPayload);

```

Add the shared snapshot helper and the two handlers right before the existing `injectScript` function:

```ts
async function ensureTurnSnapshot(tabId: number): Promise<void> {
  if (hasSnapshot(tabId)) return;
  const capture = await executeInActiveTab(
    null,
    (): CapturePageState => ({
      url: location.href,
      bodyHTML: document.body.innerHTML,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  );
  beginSnapshotIfNeeded(tabId, capture);
}

async function setStyle(payload: SetStylePayload): Promise<SetStyleResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): SetStyleResult => {
    const selector = input?.selector || '';
    const styles = input?.styles || {};
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      for (const [prop, value] of Object.entries(styles)) {
        node.style.setProperty(prop, value);
      }
    }
    return { selector, matched: nodes.length };
  });
}

async function modifyDom(payload: ModifyDomPayload): Promise<ModifyDomResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): ModifyDomResult => {
    const selector = input?.selector || '';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      switch (input?.action) {
        case 'remove':
          node.remove();
          break;
        case 'setText':
          node.textContent = input?.value ?? '';
          break;
        case 'setHtml':
          node.innerHTML = input?.value ?? '';
          break;
        case 'setAttribute':
          if (input?.attribute) node.setAttribute(input.attribute, input?.value ?? '');
          break;
        case 'addClass':
          if (input?.value) node.classList.add(input.value);
          break;
        case 'removeClass':
          if (input?.value) node.classList.remove(input.value);
          break;
      }
    }
    return { selector, matched: nodes.length, action: input?.action ?? 'remove' };
  });
}
```

Note: `clearSnapshot` and `getSnapshot` are imported now but unused until Task 9. Confirmed `.wxt/tsconfig.json` does not set `noUnusedLocals`, so `pnpm compile` will not flag this — no action needed, this resolves naturally once Task 9 lands.

- [ ] **Step 3: Register the Agent tools**

In `lib/agent/tools.ts`, add to the import block from `@/lib/messaging`:

```ts
  type ModifyDomPayload,
  type ModifyDomResult,
  type SetStylePayload,
  type SetStyleResult,
```

Add both tool names to the array returned by `createBrowserTools()`:

```ts
export function createBrowserTools(): BrowserAgentTool[] {
  return [
    browserGetActiveTabTool,
    browserReadPageTool,
    browserGetPageMetaTool,
    browserInspectPageImplementationTool,
    browserQueryDomTool,
    browserGetHtmlTool,
    browserGetScriptsTool,
    browserGetStylesheetsTool,
    browserGetComputedStyleTool,
    browserScreenshotTool,
    browserSetStyleTool,
    browserModifyDomTool,
  ];
}
```

Add the two tool definitions anywhere below `browserScreenshotTool`'s definition:

```ts
const browserSetStyleTool: BrowserAgentTool = {
  name: 'browser_set_style',
  label: 'Set Style',
  description:
    'Apply inline CSS properties to every element matching a CSS selector on the current page. Use this for visual page transformations such as reading mode, dark backgrounds, or hiding floating ads.',
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector for the elements to restyle.' }),
    styles: Type.Record(Type.String(), Type.String(), {
      description: 'CSS property/value pairs, e.g. {"display":"none"}.',
    }),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as SetStylePayload;
    const response = (await sendMessage<SetStylePayload, SetStyleResult>('SET_STYLE', payload)) as MessageResponse<SetStyleResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '样式修改失败');
    return textResult(
      `已对匹配 "${response.data.selector}" 的 ${response.data.matched} 个元素应用样式。`,
      response.data as unknown as Record<string, unknown>,
    );
  },
};

const browserModifyDomTool: BrowserAgentTool = {
  name: 'browser_modify_dom',
  label: 'Modify DOM',
  description:
    'Modify DOM elements matching a CSS selector: remove, setText, setHtml, setAttribute, addClass, or removeClass. Use this for content edits like removing ad elements, without writing raw JavaScript.',
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector for the target elements.' }),
    action: Type.Union([
      Type.Literal('remove'),
      Type.Literal('setText'),
      Type.Literal('setHtml'),
      Type.Literal('setAttribute'),
      Type.Literal('addClass'),
      Type.Literal('removeClass'),
    ]),
    value: Type.Optional(Type.String({ description: 'Text, HTML, attribute value, or class name, depending on action.' })),
    attribute: Type.Optional(Type.String({ description: 'Attribute name, required for setAttribute.' })),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as ModifyDomPayload;
    const response = (await sendMessage<ModifyDomPayload, ModifyDomResult>('MODIFY_DOM', payload)) as MessageResponse<ModifyDomResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? 'DOM 修改失败');
    return textResult(
      `已对匹配 "${response.data.selector}" 的 ${response.data.matched} 个元素执行 "${response.data.action}"。`,
      response.data as unknown as Record<string, unknown>,
    );
  },
};
```

- [ ] **Step 4: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 5: Manual verification**

Run: `pnpm dev`, load the unpacked extension, open a real page. `onConfirm` isn't supplied from the store until Task 10, so calling `browser_set_style`/`browser_modify_dom` right now will still hard-block with "该操作需要用户确认，当前确认 UI 尚未接入。" (the no-`onConfirm` branch in `resolveConfirmGate` from Task 3). That is expected — full manual verification of these tools happens in Task 12 after the UI is wired. For this task, it is enough that `pnpm compile` and `pnpm test` both pass.

- [ ] **Step 6: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts
git commit -m "feat: add browser_set_style and browser_modify_dom tools"
```

---

### Task 6: `CLICK_ELEMENT` + `TYPE_TEXT` + `SELECT_OPTION` + `SCROLL_PAGE` — interaction tools

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/agent/tools.ts`

**Interfaces:**
- Consumes: `ensureTurnSnapshot` (Task 5, same file).
- Produces: message types `'CLICK_ELEMENT' | 'TYPE_TEXT' | 'SELECT_OPTION' | 'SCROLL_PAGE'`; `ClickElementPayload { selector: string; index?: number }`, `ClickElementResult { selector: string; matched: number; clickedIndex: number | null }`; `TypeTextPayload { selector: string; text: string; replace?: boolean }`, `TypeTextResult { selector: string; matched: boolean; value: string }`; `SelectOptionPayload { selector: string; value: string }`, `SelectOptionResult { selector: string; matched: boolean; value: string }`; `ScrollPagePayload { selector?: string; x?: number; y?: number; behavior?: 'auto' | 'smooth' }`, `ScrollPageResult { selector?: string; x: number; y: number }`; Agent tools `browser_click`, `browser_type`, `browser_select`, `browser_scroll`.

No automated test — same reasoning as Task 5.

- [ ] **Step 1: Add the new message types and payload/result interfaces**

In `lib/messaging.ts`, extend `MessageType`:

```ts
  | 'SET_STYLE'
  | 'MODIFY_DOM'
  | 'CLICK_ELEMENT'
  | 'TYPE_TEXT'
  | 'SELECT_OPTION'
  | 'SCROLL_PAGE'
  | 'CHAT';
```

Add the payload/result interfaces:

```ts
export interface ClickElementPayload {
  selector: string;
  index?: number;
}

export interface ClickElementResult {
  selector: string;
  matched: number;
  clickedIndex: number | null;
}

export interface TypeTextPayload {
  selector: string;
  text: string;
  replace?: boolean;
}

export interface TypeTextResult {
  selector: string;
  matched: boolean;
  value: string;
}

export interface SelectOptionPayload {
  selector: string;
  value: string;
}

export interface SelectOptionResult {
  selector: string;
  matched: boolean;
  value: string;
}

export interface ScrollPagePayload {
  selector?: string;
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollPageResult {
  selector?: string;
  x: number;
  y: number;
}
```

- [ ] **Step 2: Add the background handlers**

In `entrypoints/background.ts`, extend the `@/lib/messaging` import block with the four new payload/result type groups above, extend `SUPPORTED_MESSAGE_TYPES` with `'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE'`, and add four cases to `handleMessage` alongside the Task 5 ones:

```ts
    case 'CLICK_ELEMENT':
      return clickElement(message.payload as ClickElementPayload);

    case 'TYPE_TEXT':
      return typeText(message.payload as TypeTextPayload);

    case 'SELECT_OPTION':
      return selectOption(message.payload as SelectOptionPayload);

    case 'SCROLL_PAGE':
      return scrollPage(message.payload as ScrollPagePayload);

```

Add the four handlers below `modifyDom`:

```ts
async function clickElement(payload: ClickElementPayload): Promise<ClickElementResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): ClickElementResult => {
    const selector = input?.selector || '';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const index = input?.index ?? 0;
    const target = nodes[index];
    if (target) target.click();
    return { selector, matched: nodes.length, clickedIndex: target ? index : null };
  });
}

async function typeText(payload: TypeTextPayload): Promise<TypeTextResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): TypeTextResult => {
    const selector = input?.selector || '';
    const target = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!target) return { selector, matched: false, value: '' };

    const nextValue = input?.replace === false ? `${target.value}${input?.text ?? ''}` : input?.text ?? '';
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(target, nextValue);
    else target.value = nextValue;

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector, matched: true, value: nextValue };
  });
}

async function selectOption(payload: SelectOptionPayload): Promise<SelectOptionResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): SelectOptionResult => {
    const selector = input?.selector || '';
    const target = document.querySelector<HTMLSelectElement>(selector);
    if (!target) return { selector, matched: false, value: input?.value ?? '' };
    target.value = input?.value ?? '';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector, matched: true, value: target.value };
  });
}

async function scrollPage(payload: ScrollPagePayload): Promise<ScrollPageResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): ScrollPageResult => {
    const behavior = input?.behavior ?? 'auto';
    if (input?.selector) {
      const target = document.querySelector(input.selector);
      target?.scrollIntoView({ behavior, block: 'center' });
    } else {
      window.scrollTo({ left: input?.x ?? window.scrollX, top: input?.y ?? window.scrollY, behavior });
    }
    return { selector: input?.selector, x: window.scrollX, y: window.scrollY };
  });
}
```

- [ ] **Step 3: Register the Agent tools**

In `lib/agent/tools.ts`, extend the `@/lib/messaging` import block with the four new payload/result type groups, add the four tool names to `createBrowserTools()`'s array (after `browserModifyDomTool`), and add the four definitions:

```ts
const browserClickTool: BrowserAgentTool = {
  name: 'browser_click',
  label: 'Click',
  description: 'Click the first (or nth) element matching a CSS selector. Use this to interact with buttons, links, or other clickable elements.',
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector for the element to click.' }),
    index: Type.Optional(Type.Number({ description: 'Which matched element to click, 0-based. Defaults to 0.' })),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as ClickElementPayload;
    const response = (await sendMessage<ClickElementPayload, ClickElementResult>('CLICK_ELEMENT', payload)) as MessageResponse<ClickElementResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '点击失败');
    if (response.data.clickedIndex === null) throw new Error(`未找到匹配 "${response.data.selector}" 的元素。`);
    return textResult(
      `已点击匹配 "${response.data.selector}" 的第 ${response.data.clickedIndex} 个元素。`,
      response.data as unknown as Record<string, unknown>,
    );
  },
};

const browserTypeTool: BrowserAgentTool = {
  name: 'browser_type',
  label: 'Type',
  description:
    'Set the value of an input or textarea matching a CSS selector, dispatching input/change events so frameworks like React observe the change.',
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector for the input or textarea.' }),
    text: Type.String({ description: 'Text to type.' }),
    replace: Type.Optional(Type.Boolean({ description: 'Replace the existing value (default true). Set to false to append.' })),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as TypeTextPayload;
    const response = (await sendMessage<TypeTextPayload, TypeTextResult>('TYPE_TEXT', payload)) as MessageResponse<TypeTextResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '输入失败');
    if (!response.data.matched) throw new Error(`未找到匹配 "${response.data.selector}" 的元素。`);
    return textResult(`已在匹配 "${response.data.selector}" 的元素中输入文本。`, response.data as unknown as Record<string, unknown>);
  },
};

const browserSelectTool: BrowserAgentTool = {
  name: 'browser_select',
  label: 'Select',
  description: 'Set a select element value by CSS selector, dispatching a change event.',
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector for the select element.' }),
    value: Type.String({ description: 'Option value to select.' }),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as SelectOptionPayload;
    const response = (await sendMessage<SelectOptionPayload, SelectOptionResult>('SELECT_OPTION', payload)) as MessageResponse<SelectOptionResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '选择失败');
    if (!response.data.matched) throw new Error(`未找到匹配 "${response.data.selector}" 的元素。`);
    return textResult(
      `已将匹配 "${response.data.selector}" 的选项设为 "${response.data.value}"。`,
      response.data as unknown as Record<string, unknown>,
    );
  },
};

const browserScrollTool: BrowserAgentTool = {
  name: 'browser_scroll',
  label: 'Scroll',
  description: 'Scroll the page to specific coordinates, or scroll a specific element into view.',
  parameters: Type.Object({
    selector: Type.Optional(Type.String({ description: 'CSS selector to scroll into view. If omitted, scrolls the window to x/y.' })),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
    behavior: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('smooth')])),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as ScrollPagePayload;
    const response = (await sendMessage<ScrollPagePayload, ScrollPageResult>('SCROLL_PAGE', payload)) as MessageResponse<ScrollPageResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '滚动失败');
    return textResult(`已滚动到 (${response.data.x}, ${response.data.y})。`, response.data as unknown as Record<string, unknown>);
  },
};
```

- [ ] **Step 4: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts
git commit -m "feat: add browser_click, browser_type, browser_select, browser_scroll tools"
```

---

### Task 7: `NAVIGATE_TAB` — navigation tool with hard scheme validation

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/agent/tools.ts`

**Interfaces:**
- Consumes: `ensureTurnSnapshot` (Task 5).
- Produces: message type `'NAVIGATE_TAB'`; `NavigateTabPayload { url: string }`, `NavigateTabResult { url: string }`; background function `isNavigableUrl(rawUrl: string): boolean`; Agent tool `browser_navigate`.

- [ ] **Step 1: Add the message type and payload/result interfaces**

In `lib/messaging.ts`, add `'NAVIGATE_TAB'` to `MessageType` and:

```ts
export interface NavigateTabPayload {
  url: string;
}

export interface NavigateTabResult {
  url: string;
}
```

- [ ] **Step 2: Add the background handler**

In `entrypoints/background.ts`: extend the `@/lib/messaging` import with `NavigateTabPayload`/`NavigateTabResult`, add `'NAVIGATE_TAB'` to `SUPPORTED_MESSAGE_TYPES`, add the case:

```ts
    case 'NAVIGATE_TAB':
      return navigateTab(message.payload as NavigateTabPayload);

```

Add the handler (this mirrors the scheme check already added to `decideToolPermission` in Task 4 — background enforces it independently as defense in depth, the same pattern already used for `isFetchUrlAllowed`):

```ts
function isNavigableUrl(rawUrl: string): boolean {
  try {
    return /^https?:$/.test(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

async function navigateTab(payload: NavigateTabPayload): Promise<NavigateTabResult> {
  const url = payload?.url ?? '';
  if (!isNavigableUrl(url)) throw new Error('仅允许跳转到 http/https 地址。');

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  await browser.tabs.update(tab.id, { url });
  return { url };
}
```

- [ ] **Step 3: Register the Agent tool**

In `lib/agent/tools.ts`: extend the `@/lib/messaging` import with `NavigateTabPayload`/`NavigateTabResult`, add `browserNavigateTool` to `createBrowserTools()`'s array, and define it:

```ts
const browserNavigateTool: BrowserAgentTool = {
  name: 'browser_navigate',
  label: 'Navigate',
  description: 'Navigate the active tab to a new http or https URL.',
  parameters: Type.Object({
    url: Type.String({ description: 'Destination URL, must be http or https.' }),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as NavigateTabPayload;
    const response = (await sendMessage<NavigateTabPayload, NavigateTabResult>('NAVIGATE_TAB', payload)) as MessageResponse<NavigateTabResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '跳转失败');
    return textResult(`已跳转到 "${response.data.url}"。`, response.data as unknown as Record<string, unknown>);
  },
};
```

- [ ] **Step 4: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts
git commit -m "feat: add browser_navigate tool with hard http(s)-only scheme check"
```

---

### Task 8: `SET_STORAGE` — localStorage/sessionStorage tool

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/agent/tools.ts`

**Interfaces:**
- Consumes: `ensureTurnSnapshot` (Task 5), `recordStorageEntryIfAbsent` (Task 1).
- Produces: message type `'SET_STORAGE'`; `SetStoragePayload { area: 'local' | 'session'; key: string; value: string | null }`, `SetStorageResult { area: 'local' | 'session'; key: string; previousValue: string | null }`; Agent tool `browser_set_storage`.

- [ ] **Step 1: Add the message type and payload/result interfaces**

In `lib/messaging.ts`, add `'SET_STORAGE'` to `MessageType` and:

```ts
export interface SetStoragePayload {
  area: 'local' | 'session';
  key: string;
  value: string | null;
}

export interface SetStorageResult {
  area: 'local' | 'session';
  key: string;
  previousValue: string | null;
}
```

- [ ] **Step 2: Add the background handler**

In `entrypoints/background.ts`: extend the `@/lib/messaging` import with `SetStoragePayload`/`SetStorageResult`, add `'SET_STORAGE'` to `SUPPORTED_MESSAGE_TYPES`, add the case:

```ts
    case 'SET_STORAGE':
      return setStorage(message.payload as SetStoragePayload);

```

Add the handler — this is the one place `recordStorageEntryIfAbsent` is used, so make sure it is imported (it already is, from Task 5's import block):

```ts
async function setStorage(payload: SetStoragePayload): Promise<SetStorageResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const result = await executeInActiveTab(payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    const previousValue = store.getItem(key);
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key, previousValue };
  });

  recordStorageEntryIfAbsent(tab.id, { area: result.area, key: result.key, previousValue: result.previousValue });
  return result;
}
```

- [ ] **Step 3: Register the Agent tool**

In `lib/agent/tools.ts`: extend the `@/lib/messaging` import with `SetStoragePayload`/`SetStorageResult`, add `browserSetStorageTool` to `createBrowserTools()`'s array, and define it:

```ts
const browserSetStorageTool: BrowserAgentTool = {
  name: 'browser_set_storage',
  label: 'Set Storage',
  description: 'Write or remove a key in localStorage or sessionStorage on the current page. Pass value: null to remove the key.',
  parameters: Type.Object({
    area: Type.Union([Type.Literal('local'), Type.Literal('session')]),
    key: Type.String(),
    value: Type.Union([Type.String(), Type.Null()]),
  }),
  execute: async (_toolCallId, params) => {
    const payload = params as SetStoragePayload;
    const response = (await sendMessage<SetStoragePayload, SetStorageResult>('SET_STORAGE', payload)) as MessageResponse<SetStorageResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '写入存储失败');
    return textResult(
      `已写入 ${response.data.area}Storage 的 "${response.data.key}"。`,
      response.data as unknown as Record<string, unknown>,
    );
  },
};
```

- [ ] **Step 4: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts
git commit -m "feat: add browser_set_storage tool"
```

---

### Task 9: Generalize undo — `RESET_TURN_SNAPSHOT` + `REVERT_CHANGES` replace `UNDO_SCRIPT`

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/agent/tools.ts`

**Interfaces:**
- Consumes: `getSnapshot`, `clearSnapshot` (Task 1, imported but unused until now).
- Produces: message types `'RESET_TURN_SNAPSHOT' | 'REVERT_CHANGES'` (replacing `'UNDO_SCRIPT'`); `RevertChangesResult { reverted: boolean; navigatedBack?: boolean }`; Agent tool `browser_revert_changes` (already `auto_allow` in `permissions.ts` — no change needed there).

- [ ] **Step 1: Update the message types**

In `lib/messaging.ts`, replace `'UNDO_SCRIPT'` in the `MessageType` union with `'RESET_TURN_SNAPSHOT'` and `'REVERT_CHANGES'`:

```ts
export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'GET_ACTIVE_TAB'
  | 'QUERY_DOM'
  | 'GET_HTML'
  | 'GET_SCRIPTS'
  | 'GET_STYLESHEETS'
  | 'GET_COMPUTED_STYLE'
  | 'GET_PAGE_META'
  | 'CAPTURE_SCREENSHOT'
  | 'INJECT_SCRIPT'
  | 'SET_STYLE'
  | 'MODIFY_DOM'
  | 'CLICK_ELEMENT'
  | 'TYPE_TEXT'
  | 'SELECT_OPTION'
  | 'SCROLL_PAGE'
  | 'NAVIGATE_TAB'
  | 'SET_STORAGE'
  | 'RESET_TURN_SNAPSHOT'
  | 'REVERT_CHANGES'
  | 'CHAT';
```

Update the comment above `InjectScriptResult` (it referenced `UNDO_SCRIPT`) and add `RevertChangesResult`:

```ts
/** INJECT_SCRIPT 返回结果 */
export interface InjectScriptResult {
  /** 脚本返回值的文本化表示（如有） */
  result?: string;
  /** 是否已保存可撤销快照 */
  snapshotSaved?: boolean;
}

export interface RevertChangesResult {
  reverted: boolean;
  navigatedBack?: boolean;
}
```

- [ ] **Step 2: Replace the background handlers**

In `entrypoints/background.ts`, replace `'UNDO_SCRIPT'` with `'RESET_TURN_SNAPSHOT'` and `'REVERT_CHANGES'` in `SUPPORTED_MESSAGE_TYPES`, and replace the `case 'UNDO_SCRIPT':` case with:

```ts
    case 'RESET_TURN_SNAPSHOT':
      return resetTurnSnapshot();

    case 'REVERT_CHANGES':
      return revertChanges();
```

Modify `injectScript` to use the shared snapshot instead of the old ad hoc `window.__aluminumSnapshot`. Replace:

```ts
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [code],
    func: (userCode: string) => {
      try {
        // 保存可撤销快照（仅 body 结构，不保留 JS 状态）
        (window as any).__aluminumSnapshot = document.body.innerHTML;
        // eslint-disable-next-line no-new-func
        const fn = new Function(userCode);
```

with:

```ts
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [code],
    func: (userCode: string) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(userCode);
```

Delete the whole `undoScript` function and replace it with:

```ts
// 撤销"本轮"全部改动：若本轮发生过跳转，直接跳回原 URL（跳转前的 DOM 已不可复原，
// 也没有意义）；否则依次恢复 storage、body.innerHTML、滚动位置。撤销后清空该 tab 的快照。
async function revertChanges(): Promise<RevertChangesResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const snapshot = getSnapshot(tab.id);
  if (!snapshot) return { reverted: false };

  const currentUrl = await executeInActiveTab(null, (): string => location.href);
  if (currentUrl !== snapshot.url) {
    await browser.tabs.update(tab.id, { url: snapshot.url });
    clearSnapshot(tab.id);
    return { reverted: true, navigatedBack: true };
  }

  await executeInActiveTab(snapshot, (snap): void => {
    for (const entry of snap.storageEntries) {
      const store = entry.area === 'session' ? sessionStorage : localStorage;
      if (entry.previousValue === null) store.removeItem(entry.key);
      else store.setItem(entry.key, entry.previousValue);
    }
    document.body.innerHTML = snap.bodyHTML;
    window.scrollTo(snap.scrollX, snap.scrollY);
  });
  clearSnapshot(tab.id);
  return { reverted: true, navigatedBack: false };
}

async function resetTurnSnapshot(): Promise<{ ok: true }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) clearSnapshot(tab.id);
  return { ok: true };
}
```

- [ ] **Step 3: Register the Agent tool**

In `lib/agent/tools.ts`, extend the `@/lib/messaging` import with `RevertChangesResult`, add `browserRevertChangesTool` to `createBrowserTools()`'s array (this is the 20th and final tool), and define it:

```ts
const browserRevertChangesTool: BrowserAgentTool = {
  name: 'browser_revert_changes',
  label: 'Revert Changes',
  description:
    'Undo every page modification made during this turn (DOM edits, style changes, storage writes, navigation), restoring the page to its state before this turn started. Safe to call whenever the user asks to undo.',
  parameters: Type.Object({}),
  execute: async () => {
    const response = (await sendMessage('REVERT_CHANGES')) as MessageResponse<RevertChangesResult>;
    if (!response.ok || !response.data) throw new Error(response.error ?? '撤销失败');
    if (!response.data.reverted) {
      return textResult('本轮没有可撤销的改动。', response.data as unknown as Record<string, unknown>);
    }
    return textResult(
      response.data.navigatedBack ? '已跳转回本轮开始前的页面。' : '已撤销本轮的全部改动。',
      response.data as unknown as Record<string, unknown>,
    );
  },
};
```

- [ ] **Step 4: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors. `getSnapshot`/`clearSnapshot` imports from Task 5 are now used, so no unused-import warnings either.

- [ ] **Step 5: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts
git commit -m "feat: generalize undo into whole-turn REVERT_CHANGES, replacing UNDO_SCRIPT"
```

---

### Task 10: Store — confirmation state, undo action, and turn lifecycle wiring

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`

**Interfaces:**
- Consumes: `summarizeToolCallForConfirmation` from `@/lib/agent/confirm-summary` (Task 2); `RevertChangesResult` from `@/lib/messaging`; `onConfirm` option on `createBrowserAgent` (Task 4).
- Produces: `PendingConfirmation { toolName: string; summary: string; codePreview?: string }`; `ChatState` gains `pendingConfirmation: PendingConfirmation | null`, `turnHasChanges: boolean`, `respondToConfirmation: (approved: boolean) => void`, `revertTurnChanges: () => Promise<void>`; `ToolActivity['status']` gains `'confirming'` — all consumed by `entrypoints/sidepanel/App.tsx` in Task 11.

No automated test — this module pulls in Dexie/`browser` globals that aren't available under plain Node/vitest. Verified via `pnpm compile` and the manual QA pass in Task 12.

- [ ] **Step 1: Add imports**

Change the `@/lib/messaging` import:

```ts
import {
  sendMessage,
  type MessageResponse,
  type PageSelection,
} from '@/lib/messaging';
```

to:

```ts
import {
  sendMessage,
  type MessageResponse,
  type PageSelection,
  type RevertChangesResult,
} from '@/lib/messaging';
```

Add a new import right below the `createBrowserAgent` import:

```ts
import { createBrowserAgent } from '@/lib/agent/agent';
import { summarizeToolCallForConfirmation } from '@/lib/agent/confirm-summary';
```

- [ ] **Step 2: Extend `ToolActivity` and `REQUIRED_AGENT_MESSAGE_TYPES`, add `PendingConfirmation` and `WRITE_TOOL_NAMES`**

Change:

```ts
export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'blocked';
  detail?: string;
}
```

to:

```ts
export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'confirming' | 'done' | 'error' | 'blocked';
  detail?: string;
}

export interface PendingConfirmation {
  toolName: string;
  summary: string;
  codePreview?: string;
}
```

Change:

```ts
const REQUIRED_AGENT_MESSAGE_TYPES = [
  'GET_PAGE_META',
  'GET_SCRIPTS',
  'GET_STYLESHEETS',
  'QUERY_DOM',
  'GET_HTML',
  'GET_COMPUTED_STYLE',
  'CAPTURE_SCREENSHOT',
] as const;
```

to:

```ts
const REQUIRED_AGENT_MESSAGE_TYPES = [
  'GET_PAGE_META',
  'GET_SCRIPTS',
  'GET_STYLESHEETS',
  'QUERY_DOM',
  'GET_HTML',
  'GET_COMPUTED_STYLE',
  'CAPTURE_SCREENSHOT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'SELECT_OPTION',
  'SCROLL_PAGE',
  'NAVIGATE_TAB',
  'SET_STORAGE',
  'RESET_TURN_SNAPSHOT',
  'REVERT_CHANGES',
] as const;

const WRITE_TOOL_NAMES = new Set([
  'browser_inject_script',
  'browser_set_style',
  'browser_modify_dom',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_scroll',
  'browser_navigate',
  'browser_set_storage',
]);
```

- [ ] **Step 3: Extend `ChatState` and the module-level resolver variable**

Add to the `ChatState` interface, after `error: string | null;`:

```ts
  pendingConfirmation: PendingConfirmation | null;
  turnHasChanges: boolean;
```

Add to the end of the interface (near `removeConversation`):

```ts
  respondToConfirmation: (approved: boolean) => void;
  revertTurnChanges: () => Promise<void>;
```

Add below `let activeAgent: Agent | null = null;`:

```ts
let pendingConfirmResolve: ((approved: boolean) => void) | null = null;
```

- [ ] **Step 4: Add initial state and the two new actions**

In the `create<ChatState>` object, add to the initial state (after `error: null,`):

```ts
  pendingConfirmation: null,
  turnHasChanges: false,
```

Change `stop`:

```ts
  stop: () => {
    activeAgent?.abort();
  },
```

to:

```ts
  stop: () => {
    activeAgent?.abort();
    pendingConfirmResolve = null;
    set({ pendingConfirmation: null });
  },
```

Add the two new actions right after `stop`:

```ts
  respondToConfirmation: (approved) => {
    pendingConfirmResolve?.(approved);
    pendingConfirmResolve = null;
    set({ pendingConfirmation: null });
  },

  revertTurnChanges: async () => {
    try {
      const res = (await sendMessage('REVERT_CHANGES')) as MessageResponse<RevertChangesResult>;
      if (!res.ok) throw new Error(res.error ?? '撤销失败');
      set({ turnHasChanges: false });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
```

- [ ] **Step 5: Reset confirmation/undo state at the start of each turn and wire `onConfirm`**

In `runAgent`, change the `set({...})` call that starts a turn:

```ts
  const history = get().messages;
  set({
    messages: [...history, display, { role: 'assistant', content: '' }],
    toolActivities: [],
    input: '',
    busy: true,
    error: null,
  });
```

to:

```ts
  const history = get().messages;
  set({
    messages: [...history, display, { role: 'assistant', content: '' }],
    toolActivities: [],
    input: '',
    busy: true,
    error: null,
    pendingConfirmation: null,
    turnHasChanges: false,
  });
  await sendMessage('RESET_TURN_SNAPSHOT').catch(() => undefined);
```

Right before `const agent = createBrowserAgent({...})`, add the `onConfirm` implementation:

```ts
  const onConfirm = async (toolCallId: string, toolName: string, args: unknown, _reason: string): Promise<boolean> => {
    const { summary, codePreview } = summarizeToolCallForConfirmation(toolName, args);
    upsertToolActivity(set, { id: toolCallId, name: toolName, status: 'confirming', detail: summary });
    set({ pendingConfirmation: { toolName, summary, codePreview } });
    return new Promise<boolean>((resolve) => {
      pendingConfirmResolve = resolve;
    });
  };

  const agent = createBrowserAgent({
    provider: agentProvider,
    systemPrompt: SYSTEM_PROMPT,
    messages: toAgentMessages(history),
    maxToolTurns: MAX_AGENT_TOOL_TURNS,
    onConfirm,
  });
```

- [ ] **Step 6: Track `turnHasChanges` from tool results**

Change the `tool_execution_end` branch inside `agent.subscribe`:

```ts
    if (event.type === 'tool_execution_end') {
      const blocked = event.isError && isToolGuardBlockResult(event.result);
      upsertToolActivity(set, {
        id: event.toolCallId,
        name: event.toolName,
        status: blocked ? 'blocked' : event.isError ? 'error' : 'done',
        detail: event.isError ? compactJson(event.result) : undefined,
      });
    }
```

to:

```ts
    if (event.type === 'tool_execution_end') {
      const blocked = event.isError && isToolGuardBlockResult(event.result);
      upsertToolActivity(set, {
        id: event.toolCallId,
        name: event.toolName,
        status: blocked ? 'blocked' : event.isError ? 'error' : 'done',
        detail: event.isError ? compactJson(event.result) : undefined,
      });
      if (!event.isError) {
        if (event.toolName === 'browser_revert_changes') {
          set({ turnHasChanges: false });
        } else if (WRITE_TOOL_NAMES.has(event.toolName)) {
          set({ turnHasChanges: true });
        }
      }
    }
```

- [ ] **Step 7: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 8: Commit**

```bash
git add entrypoints/sidepanel/store.ts
git commit -m "feat: wire confirmation and whole-turn undo state into the chat store"
```

---

### Task 11: UI — confirmation card, undo bar, and `confirming` tool-activity status

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx`

**Interfaces:**
- Consumes: `pendingConfirmation`, `turnHasChanges`, `respondToConfirmation`, `revertTurnChanges` from `useChat()` (Task 10); `type PendingConfirmation` from `./store` (Task 10).

No automated test — React UI with no test runner configured for it. Verified via `pnpm compile` and manual QA in Task 12.

- [ ] **Step 1: Import the new type and destructure the new store fields**

Change:

```ts
import type { ToolActivity } from './store';
```

to:

```ts
import type { PendingConfirmation, ToolActivity } from './store';
```

In `App()`, add to the destructured `useChat()` fields (after `error,`):

```ts
    pendingConfirmation,
    turnHasChanges,
```

and (after `removeConversation,`):

```ts
    respondToConfirmation,
    revertTurnChanges,
```

- [ ] **Step 2: Render the confirmation card and the undo bar**

In the message-list `<main>` block, change:

```tsx
              {toolActivities.length > 0 && <ToolActivityList activities={toolActivities} />}
              {error && (
```

to:

```tsx
              {toolActivities.length > 0 && <ToolActivityList activities={toolActivities} />}
              {pendingConfirmation && (
                <ConfirmationCard
                  confirmation={pendingConfirmation}
                  onApprove={() => respondToConfirmation(true)}
                  onDeny={() => respondToConfirmation(false)}
                />
              )}
              {!busy && !pendingConfirmation && turnHasChanges && <UndoBar onRevert={revertTurnChanges} />}
              {error && (
```

- [ ] **Step 3: Define the two new components**

Add these two functions right after `ToolActivityList`'s closing brace (before `statusLabel`):

```tsx
function ConfirmationCard({
  confirmation,
  onApprove,
  onDeny,
}: {
  confirmation: PendingConfirmation;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-2 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        ⚠️ 需要你确认后才能修改页面
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">{confirmation.summary}</p>
      {confirmation.codePreview && (
        <pre className="mb-2 max-h-40 overflow-auto rounded-lg bg-neutral-900/90 p-2 text-[11px] text-neutral-100">
          {confirmation.codePreview}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
        >
          批准本轮操作
        </button>
        <button
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          拒绝
        </button>
      </div>
      <p className="mt-2 text-[11px] text-amber-800/70 dark:text-amber-300/60">
        批准后，本轮内后续的写操作将自动执行，无需逐条确认。
      </p>
    </div>
  );
}

function UndoBar({ onRevert }: { onRevert: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-emerald-600 dark:text-emerald-400">● 本轮已修改页面</span>
      <button onClick={onRevert} className="font-medium text-red-600 hover:underline dark:text-red-400">
        撤销本轮更改
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Handle the `confirming` status**

Change `ToolActivityList`'s running count:

```tsx
  const running = activities.filter((a) => a.status === 'running').length;
```

to:

```tsx
  const running = activities.filter((a) => a.status === 'running' || a.status === 'confirming').length;
```

Change `statusLabel`:

```ts
function statusLabel(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'blocked':
      return '已拦截';
    case 'error':
      return '失败';
    default:
      return '完成';
  }
}
```

to:

```ts
function statusLabel(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'confirming':
      return '待确认';
    case 'blocked':
      return '已拦截';
    case 'error':
      return '失败';
    default:
      return '完成';
  }
}
```

Change `statusColor`:

```ts
function statusColor(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return 'text-blue-500';
    case 'blocked':
      return 'text-amber-600 dark:text-amber-500';
    case 'error':
      return 'text-red-500';
    default:
      return 'text-emerald-600 dark:text-emerald-400';
  }
}
```

to:

```ts
function statusColor(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return 'text-blue-500';
    case 'confirming':
      return 'text-amber-600 dark:text-amber-500';
    case 'blocked':
      return 'text-amber-600 dark:text-amber-500';
    case 'error':
      return 'text-red-500';
    default:
      return 'text-emerald-600 dark:text-emerald-400';
  }
}
```

- [ ] **Step 5: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/App.tsx
git commit -m "feat: render the confirmation card and whole-turn undo bar"
```

---

### Task 12: Full manual QA pass against the spec's acceptance criteria

**Files:** none (verification only).

- [ ] **Step 1: Build and load the extension**

Run: `pnpm dev`
Load the unpacked extension from `.output/chrome-mv3` (or let WXT's dev server auto-reload if already loaded). Open a real page (e.g. a news article or blog post) and open the Aluminum side panel.

- [ ] **Step 2: Exercise `browser_inject_script` (reading mode)**

Ask: "把这个页面改成阅读模式". Confirm the amber confirmation card appears with a code preview, approving it applies the changes, and the undo bar appears afterward with "本轮已修改页面".

- [ ] **Step 3: Exercise `browser_set_style` and `browser_modify_dom`**

Ask: "把正文背景改成浅灰色" (expect `browser_set_style`) and, on a page with an obvious banner/ad element, "把这个广告去掉" (expect `browser_modify_dom` with `action: "remove"`). Confirm the confirmation card only appears once per message even though two different tools may run across the conversation's separate turns.

- [ ] **Step 4: Exercise `browser_click` + `browser_type` together in one turn**

On a page with a simple search box, ask: "在搜索框里输入 'test' 然后点击搜索按钮". Confirm the card appears before the *first* write action, and the second write action (a different tool) runs automatically with no further prompt — check the tool activity trail shows both steps as `done`, not `confirming`.

- [ ] **Step 5: Exercise `browser_scroll`, `browser_navigate`, `browser_set_storage`**

Ask to scroll to the bottom of the page (`browser_scroll`), then in a fresh turn ask to open a specific http(s) link (`browser_navigate`) and confirm the tab actually navigates. In a fresh turn on the new page, ask the agent to set a `localStorage` test key (`browser_set_storage`) and verify via devtools that the key was written.

- [ ] **Step 6: Exercise denial**

Ask for another page modification and click "拒绝" on the confirmation card. Confirm the assistant's final reply acknowledges the refusal instead of erroring or retrying forever, and that the tool activity shows `blocked`/`error` rather than `done`.

- [ ] **Step 7: Exercise undo, including the navigate case**

After a turn that only did in-page DOM/style edits, click "撤销本轮更改" and confirm the page visually reverts. Separately, do a turn that includes `browser_navigate`, then undo, and confirm the tab jumps back to the original URL.

- [ ] **Step 8: Exercise Stop during a pending confirmation**

Trigger a write action, and while the confirmation card is showing, click the Stop button in the composer. Confirm the card disappears immediately and no request hangs (check `read_console_messages`/devtools console for unhandled rejections).

- [ ] **Step 9: Exercise the hard navigate deny**

Ask the agent to navigate to a `javascript:` URL directly (e.g. "帮我跳转到 javascript:alert(1)"). Confirm this is rejected before any confirmation card appears (the tool activity trail should show `blocked`/`error` immediately, not `confirming`).

- [ ] **Step 10: Confirm the new-turn reset**

After approving one turn's writes, send a brand new message. Confirm the undo bar from the previous turn disappears once the new turn starts (per Task 10 Step 5's reset), and that a fresh confirmation card is required again for the new turn's first write action even though the previous turn was already approved.

- [ ] **Step 11: Final check**

Run `pnpm compile` and `pnpm test` one more time to confirm nothing regressed, then update `docs/PROGRESS.md`'s Agent Phase B row from "⬜ 未开始" to "✅ 完成" with a short changelog entry referencing `docs/specs/0001-agent-write-tools-and-permission-ui.md`, following the existing changelog table format in that file.

```bash
git add docs/PROGRESS.md
git commit -m "docs: mark Agent Phase B complete in PROGRESS.md"
```
