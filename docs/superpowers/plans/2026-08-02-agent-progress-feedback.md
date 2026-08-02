# Agent Progress Feedback Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users continuous visual feedback during long agent turns: a persistent per-turn history of completed/failed tool steps (not just "the current one"), a trailing "thinking" indicator during the silent gaps between tool calls, and a timeout escalation hint when a single tool call runs long.

**Architecture:** Replace the single-slot `currentActivity: ToolActivity | null` in the sidepanel Zustand store with an accumulating `activitySteps: ActivityStep[]` (never cleared mid-turn, only at turn boundaries). State transitions (upsert-on-start/update, flip-in-place-on-end, slow-flag-on-timeout) are extracted into a pure, independently-testable reducer module (`lib/agent/activity-steps.ts`) so the array-mutation logic has real unit test coverage — something the store layer itself can't get cheaply. `lib/agent/activity-description.ts` grows a `'done'` status (past-tense copy) alongside existing `'running'`/`'failed'`. The sidepanel renders the accumulated list via a new `ActivityStepList` component (replacing `CurrentActivityLine`), and `Message` grows a trailing typing-dots indicator that fires whenever the turn is busy with no tool currently running.

**Tech Stack:** TypeScript, React, Zustand, Vitest + Testing Library (jsdom), existing `lib/i18n` dictionary system.

## Global Constraints

- Slow-timeout threshold is exactly 6000ms (`SLOW_ACTIVITY_MS`), one-shot (no live seconds counter), generic suffix text (not per-tool).
- Failed/denied steps persist in the log for the rest of the turn — no auto-clear timer.
- The whole `activitySteps` array resets to `[]` at turn boundaries only (new turn start, `clear()`, `openConversation()`, natural turn end); it is never persisted to `ChatMessage`/IndexedDB.
- No new visual state for `stop()` — it keeps today's behavior of clearing immediately.
- Past-tense (`done`) copy is added per-tool (12 keys × 2 languages), not derived by string manipulation — every new i18n key pair must be added to both `lib/i18n/locales/zh.ts` and `lib/i18n/locales/en.ts`, keeping the two key sets identical (enforced by the existing `i18n.test.ts` key-parity test).
- Spec: `docs/superpowers/specs/2026-08-02-agent-progress-feedback-design.md`.

## Sequencing note (read before starting)

Task 3 changes the store's public state shape (`currentActivity` → `activitySteps`, `ToolActivity` → `ActivityStep`). `App.tsx` and `CurrentActivityLine.tsx` still reference the old shape until Task 5 finishes rewiring them. **`pnpm compile` and the full `pnpm test` will show failures between Task 3 and the end of Task 5 — this is expected**, not a regression to chase down mid-sequence. Each task's own verification step scopes to the specific test file(s) it touches; the full-repo gate (`pnpm compile`/`pnpm test`/`pnpm build`) is Task 6.

---

## File Structure

**Create:**
- `lib/agent/activity-steps.ts` — pure `ActivityStep` type + `upsertActivityStep`/`finishActivityStep`/`markActivityStepSlow` reducer functions (no side effects, no timers).
- `lib/agent/activity-steps.test.ts` — unit tests for the above.
- `entrypoints/sidepanel/components/ActivityStepList.tsx` — renders the accumulated per-turn step log (replaces `CurrentActivityLine.tsx`).

**Modify:**
- `lib/agent/activity-description.ts` — `ActivityStatus` gains `'done'`; `withTarget` gains a `doneKey` param.
- `lib/agent/activity-description.test.ts` — add `'done'` assertions.
- `lib/i18n/locales/zh.ts` / `lib/i18n/locales/en.ts` — 12 new `agentActivity.done.*` keys + 1 `agentActivity.slowSuffix` key, in both files.
- `entrypoints/sidepanel/store.ts` — state shape, timer bookkeeping, all event-handler wiring.
- `entrypoints/sidepanel/store-context.test.tsx` — adapt existing activity assertions, replace the obsolete auto-clear test, add accumulation + slow-timeout tests.
- `entrypoints/sidepanel/App.tsx` — `Message` gains a trailing thinking indicator; render swaps `CurrentActivityLine` for `ActivityStepList`.
- `entrypoints/sidepanel/components/workbench-components.test.tsx` — mock shape, new `ActivityStepList` tests, App-integration tests, removal of the obsolete `CurrentActivityLine` test block.

**Delete:**
- `entrypoints/sidepanel/components/CurrentActivityLine.tsx` (Task 5, once `ActivityStepList` replaces it).

---

### Task 1: `done` status + i18n copy for `describeToolActivity`

**Files:**
- Modify: `lib/agent/activity-description.ts`
- Modify: `lib/agent/activity-description.test.ts`
- Modify: `lib/i18n/locales/zh.ts:129-153`
- Modify: `lib/i18n/locales/en.ts:132-156`

**Interfaces:**
- Produces: `ActivityStatus = 'running' | 'done' | 'failed'`; `describeToolActivity(toolName: string, args: unknown, status: ActivityStatus): string` now accepts `'done'` and returns past-tense copy for the 12 tools that carry a target, and the existing tenseless label for parameterless tools.

- [ ] **Step 1: Add the i18n keys (both languages)**

In `lib/i18n/locales/zh.ts`, replace the block from `'agentActivity.actionFailed'` through the last `'agentActivity.failed.setStorage'` line (lines 129-153) with:

```ts
  'agentActivity.actionFailed': '{action}失败',
  'agentActivity.slowSuffix': '……时间较长，可能需要再等一下',
  'agentActivity.now.inspectFocus': '正在检查页面实现（聚焦 "{target}"）',
  'agentActivity.done.inspectFocus': '已检查页面实现（聚焦 "{target}"）',
  'agentActivity.failed.inspectFocus': '检查页面实现（聚焦 "{target}"）失败',
  'agentActivity.now.queryDom': '正在查询 "{target}"',
  'agentActivity.done.queryDom': '已查询 "{target}"',
  'agentActivity.failed.queryDom': '查询 "{target}" 失败',
  'agentActivity.now.getHtml': '正在读取 "{target}" 的 HTML',
  'agentActivity.done.getHtml': '已读取 "{target}" 的 HTML',
  'agentActivity.failed.getHtml': '读取 "{target}" 的 HTML 失败',
  'agentActivity.now.getComputedStyle': '正在读取 "{target}" 的计算样式',
  'agentActivity.done.getComputedStyle': '已读取 "{target}" 的计算样式',
  'agentActivity.failed.getComputedStyle': '读取 "{target}" 的计算样式失败',
  'agentActivity.now.setStyle': '正在修改 "{target}" 的样式',
  'agentActivity.done.setStyle': '已修改 "{target}" 的样式',
  'agentActivity.failed.setStyle': '修改 "{target}" 的样式失败',
  'agentActivity.now.modifyDom': '正在修改 "{target}"',
  'agentActivity.done.modifyDom': '已修改 "{target}"',
  'agentActivity.failed.modifyDom': '修改 "{target}" 失败',
  'agentActivity.now.click': '正在点击 "{target}"',
  'agentActivity.done.click': '已点击 "{target}"',
  'agentActivity.failed.click': '点击 "{target}" 失败',
  'agentActivity.now.type': '正在向 "{target}" 输入文本',
  'agentActivity.done.type': '已向 "{target}" 输入文本',
  'agentActivity.failed.type': '向 "{target}" 输入文本失败',
  'agentActivity.now.select': '正在设置 "{target}" 的选项',
  'agentActivity.done.select': '已设置 "{target}" 的选项',
  'agentActivity.failed.select': '设置 "{target}" 的选项失败',
  'agentActivity.now.scrollTo': '正在滚动到 "{target}"',
  'agentActivity.done.scrollTo': '已滚动到 "{target}"',
  'agentActivity.failed.scrollTo': '滚动到 "{target}" 失败',
  'agentActivity.now.navigate': '正在跳转到 "{target}"',
  'agentActivity.done.navigate': '已跳转到 "{target}"',
  'agentActivity.failed.navigate': '跳转到 "{target}" 失败',
  'agentActivity.now.setStorage': '正在写入存储 "{target}"',
  'agentActivity.done.setStorage': '已写入存储 "{target}"',
  'agentActivity.failed.setStorage': '写入存储 "{target}" 失败',
```

In `lib/i18n/locales/en.ts`, replace the equivalent block (lines 132-156) with:

```ts
  'agentActivity.actionFailed': '{action} failed',
  'agentActivity.slowSuffix': '… this is taking longer than usual',
  'agentActivity.now.inspectFocus': 'Inspecting page implementation (focus: "{target}")',
  'agentActivity.done.inspectFocus': 'Inspected page implementation (focus: "{target}")',
  'agentActivity.failed.inspectFocus': 'Failed to inspect page implementation (focus: "{target}")',
  'agentActivity.now.queryDom': 'Querying "{target}"',
  'agentActivity.done.queryDom': 'Queried "{target}"',
  'agentActivity.failed.queryDom': 'Failed to query "{target}"',
  'agentActivity.now.getHtml': 'Reading HTML for "{target}"',
  'agentActivity.done.getHtml': 'Read HTML for "{target}"',
  'agentActivity.failed.getHtml': 'Failed to read HTML for "{target}"',
  'agentActivity.now.getComputedStyle': 'Reading computed style for "{target}"',
  'agentActivity.done.getComputedStyle': 'Read computed style for "{target}"',
  'agentActivity.failed.getComputedStyle': 'Failed to read computed style for "{target}"',
  'agentActivity.now.setStyle': 'Styling "{target}"',
  'agentActivity.done.setStyle': 'Styled "{target}"',
  'agentActivity.failed.setStyle': 'Failed to style "{target}"',
  'agentActivity.now.modifyDom': 'Modifying "{target}"',
  'agentActivity.done.modifyDom': 'Modified "{target}"',
  'agentActivity.failed.modifyDom': 'Failed to modify "{target}"',
  'agentActivity.now.click': 'Clicking "{target}"',
  'agentActivity.done.click': 'Clicked "{target}"',
  'agentActivity.failed.click': 'Failed to click "{target}"',
  'agentActivity.now.type': 'Typing into "{target}"',
  'agentActivity.done.type': 'Typed into "{target}"',
  'agentActivity.failed.type': 'Failed to type into "{target}"',
  'agentActivity.now.select': 'Selecting an option in "{target}"',
  'agentActivity.done.select': 'Selected an option in "{target}"',
  'agentActivity.failed.select': 'Failed to select an option in "{target}"',
  'agentActivity.now.scrollTo': 'Scrolling to "{target}"',
  'agentActivity.done.scrollTo': 'Scrolled to "{target}"',
  'agentActivity.failed.scrollTo': 'Failed to scroll to "{target}"',
  'agentActivity.now.navigate': 'Navigating to "{target}"',
  'agentActivity.done.navigate': 'Navigated to "{target}"',
  'agentActivity.failed.navigate': 'Failed to navigate to "{target}"',
  'agentActivity.now.setStorage': 'Writing storage key "{target}"',
  'agentActivity.done.setStorage': 'Wrote storage key "{target}"',
  'agentActivity.failed.setStorage': 'Failed to write storage key "{target}"',
```

- [ ] **Step 2: Write the failing tests in `activity-description.test.ts`**

Insert these new `it` blocks right before the file's final `});` (after the existing `'handles non-object args without throwing'` test):

```ts
  it('describes done click/type/select/setStyle/modifyDom/getHtml/getComputedStyle/queryDom by selector', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'done')).toBe('Clicked "button.buy"');
    expect(describeToolActivity('browser_type', { selector: 'input.name' }, 'done')).toBe('Typed into "input.name"');
    expect(describeToolActivity('browser_select', { selector: 'select.country' }, 'done')).toBe('Selected an option in "select.country"');
    expect(describeToolActivity('browser_set_style', { selector: '.ad' }, 'done')).toBe('Styled ".ad"');
    expect(describeToolActivity('browser_modify_dom', { selector: '.ad' }, 'done')).toBe('Modified ".ad"');
    expect(describeToolActivity('browser_get_html', { selector: 'main' }, 'done')).toBe('Read HTML for "main"');
    expect(describeToolActivity('browser_get_computed_style', { selector: 'main' }, 'done')).toBe('Read computed style for "main"');
    expect(describeToolActivity('browser_query_dom', { selector: 'main' }, 'done')).toBe('Queried "main"');
  });

  it('describes done navigate/set_storage/scroll/inspect_page_implementation', () => {
    expect(describeToolActivity('browser_navigate', { url: 'https://example.com' }, 'done')).toBe('Navigated to "https://example.com"');
    expect(describeToolActivity('browser_set_storage', { key: 'token' }, 'done')).toBe('Wrote storage key "token"');
    expect(describeToolActivity('browser_scroll', { selector: '#footer' }, 'done')).toBe('Scrolled to "#footer"');
    expect(describeToolActivity('browser_inspect_page_implementation', { focus: 'scroll' }, 'done')).toBe(
      'Inspected page implementation (focus: "scroll")',
    );
  });

  it('reuses the plain tool label for done no-arg tools (same as running, no tense change needed)', () => {
    expect(describeToolActivity('browser_get_active_tab', {}, 'done')).toBe('Get active tab');
    expect(describeToolActivity('browser_read_page', {}, 'done')).toBe('Read page');
    expect(describeToolActivity('browser_scroll', {}, 'done')).toBe('Scroll');
    expect(describeToolActivity('browser_something_new', {}, 'done')).toBe('Browser action');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run lib/agent/activity-description.test.ts`
Expected: FAIL — `describeToolActivity` returns the `'failed'`-shaped string for a `'done'` status (falls through the `status === 'running' ? ... : ...` branches), since the implementation doesn't understand `'done'` yet.

- [ ] **Step 4: Implement `done` support in `activity-description.ts`**

Replace the full contents of `lib/agent/activity-description.ts` with:

```ts
import { t, type TranslationKey } from '@/lib/i18n';

export type ActivityStatus = 'running' | 'done' | 'failed';

const MAX_TARGET_LENGTH = 60;

function truncate(value: string, max = MAX_TARGET_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function withTarget(
  status: ActivityStatus,
  nowKey: TranslationKey,
  doneKey: TranslationKey,
  failedKey: TranslationKey,
  target: string,
): string {
  const key = status === 'running' ? nowKey : status === 'done' ? doneKey : failedKey;
  return t(key, { target: truncate(target) });
}

function plain(status: ActivityStatus, labelKey: TranslationKey): string {
  const label = t(labelKey);
  return status === 'failed' ? t('agentActivity.actionFailed', { action: label }) : label;
}

export function describeToolActivity(toolName: string, args: unknown, status: ActivityStatus): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');

  switch (toolName) {
    case 'browser_get_active_tab':
      return plain(status, 'agentActivity.tool.getActiveTab');
    case 'browser_read_page':
      return plain(status, 'agentActivity.tool.readPage');
    case 'browser_get_page_meta':
      return plain(status, 'agentActivity.tool.getPageMeta');
    case 'browser_inspect_page_implementation': {
      const focus = str('focus');
      return focus
        ? withTarget(status, 'agentActivity.now.inspectFocus', 'agentActivity.done.inspectFocus', 'agentActivity.failed.inspectFocus', focus)
        : plain(status, 'agentActivity.tool.inspectPageImplementation');
    }
    case 'browser_query_dom':
      return withTarget(status, 'agentActivity.now.queryDom', 'agentActivity.done.queryDom', 'agentActivity.failed.queryDom', str('selector'));
    case 'browser_get_html':
      return withTarget(status, 'agentActivity.now.getHtml', 'agentActivity.done.getHtml', 'agentActivity.failed.getHtml', str('selector') || 'html');
    case 'browser_get_scripts':
      return plain(status, 'agentActivity.tool.getScripts');
    case 'browser_get_stylesheets':
      return plain(status, 'agentActivity.tool.getStylesheets');
    case 'browser_get_computed_style':
      return withTarget(status, 'agentActivity.now.getComputedStyle', 'agentActivity.done.getComputedStyle', 'agentActivity.failed.getComputedStyle', str('selector'));
    case 'browser_screenshot':
      return plain(status, 'agentActivity.tool.screenshot');
    case 'browser_set_style':
      return withTarget(status, 'agentActivity.now.setStyle', 'agentActivity.done.setStyle', 'agentActivity.failed.setStyle', str('selector'));
    case 'browser_modify_dom':
      return withTarget(status, 'agentActivity.now.modifyDom', 'agentActivity.done.modifyDom', 'agentActivity.failed.modifyDom', str('selector'));
    case 'browser_click':
      return withTarget(status, 'agentActivity.now.click', 'agentActivity.done.click', 'agentActivity.failed.click', str('selector'));
    case 'browser_type':
      return withTarget(status, 'agentActivity.now.type', 'agentActivity.done.type', 'agentActivity.failed.type', str('selector'));
    case 'browser_select':
      return withTarget(status, 'agentActivity.now.select', 'agentActivity.done.select', 'agentActivity.failed.select', str('selector'));
    case 'browser_scroll': {
      const selector = str('selector');
      return selector
        ? withTarget(status, 'agentActivity.now.scrollTo', 'agentActivity.done.scrollTo', 'agentActivity.failed.scrollTo', selector)
        : plain(status, 'agentActivity.tool.scroll');
    }
    case 'browser_navigate':
      return withTarget(status, 'agentActivity.now.navigate', 'agentActivity.done.navigate', 'agentActivity.failed.navigate', str('url'));
    case 'browser_set_storage':
      return withTarget(status, 'agentActivity.now.setStorage', 'agentActivity.done.setStorage', 'agentActivity.failed.setStorage', str('key'));
    default:
      return plain(status, 'agentActivity.tool.unknown');
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run lib/agent/activity-description.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 6: Run the i18n key-parity test**

Run: `pnpm vitest run lib/i18n/i18n.test.ts`
Expected: PASS — confirms `zh.ts`/`en.ts` still have identical key sets after adding the 25 new keys to both.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/activity-description.ts lib/agent/activity-description.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(agent): add done-status copy and slow-timeout suffix to activity descriptions"
```

---

### Task 2: Pure `ActivityStep` reducer module

**Files:**
- Create: `lib/agent/activity-steps.ts`
- Create: `lib/agent/activity-steps.test.ts`

**Interfaces:**
- Produces: `ActivityStep { id: string; description: string; status: 'running' | 'done' | 'failed'; slow?: boolean }`, `upsertActivityStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[]`, `finishActivityStep(steps: ActivityStep[], id: string, status: 'done' | 'failed', description: string): ActivityStep[]`, `markActivityStepSlow(steps: ActivityStep[], id: string): ActivityStep[]`. Task 3 consumes all four names exactly as declared here.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/activity-steps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { finishActivityStep, markActivityStepSlow, upsertActivityStep, type ActivityStep } from './activity-steps';

describe('upsertActivityStep', () => {
  it('appends a new step when the id is not already present', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = upsertActivityStep(steps, { id: 'b', description: 'B', status: 'running' });
    expect(next).toEqual([
      { id: 'a', description: 'A', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ]);
    expect(steps).toEqual([{ id: 'a', description: 'A', status: 'running' }]);
  });

  it('replaces the step in place when the id already exists, preserving position', () => {
    const steps: ActivityStep[] = [
      { id: 'a', description: 'A', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ];
    const next = upsertActivityStep(steps, { id: 'a', description: 'A updated', status: 'running' });
    expect(next).toEqual([
      { id: 'a', description: 'A updated', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ]);
    expect(next).toHaveLength(2);
  });
});

describe('finishActivityStep', () => {
  it('flips a running step to done, replacing its description and clearing slow', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'Clicking X', status: 'running', slow: true }];
    const next = finishActivityStep(steps, 'a', 'done', 'Clicked X');
    expect(next).toEqual([{ id: 'a', description: 'Clicked X', status: 'done', slow: false }]);
  });

  it('flips a running step to failed', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'Clicking X', status: 'running' }];
    const next = finishActivityStep(steps, 'a', 'failed', 'Failed to click X');
    expect(next).toEqual([{ id: 'a', description: 'Failed to click X', status: 'failed', slow: false }]);
  });

  it('is a no-op (same array reference) when the id is not found', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = finishActivityStep(steps, 'missing', 'done', 'irrelevant');
    expect(next).toBe(steps);
  });

  it('does not mutate steps for entries other than the target id', () => {
    const steps: ActivityStep[] = [
      { id: 'a', description: 'A', status: 'done' },
      { id: 'b', description: 'B', status: 'running' },
    ];
    const next = finishActivityStep(steps, 'b', 'done', 'B done');
    expect(next[0]).toBe(steps[0]);
    expect(next[1]).toEqual({ id: 'b', description: 'B done', status: 'done', slow: false });
  });
});

describe('markActivityStepSlow', () => {
  it('flips slow to true for a running step', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = markActivityStepSlow(steps, 'a');
    expect(next).toEqual([{ id: 'a', description: 'A', status: 'running', slow: true }]);
  });

  it('is a no-op when the id is not found', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    expect(markActivityStepSlow(steps, 'missing')).toBe(steps);
  });

  it('is a no-op once the step has finished (done or failed)', () => {
    const done: ActivityStep[] = [{ id: 'a', description: 'A', status: 'done' }];
    const failed: ActivityStep[] = [{ id: 'a', description: 'A', status: 'failed' }];
    expect(markActivityStepSlow(done, 'a')).toBe(done);
    expect(markActivityStepSlow(failed, 'a')).toBe(failed);
  });

  it('is idempotent once already marked slow', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running', slow: true }];
    expect(markActivityStepSlow(steps, 'a')).toBe(steps);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/agent/activity-steps.test.ts`
Expected: FAIL with a module-not-found error (`./activity-steps` doesn't exist yet).

- [ ] **Step 3: Implement `lib/agent/activity-steps.ts`**

```ts
export interface ActivityStep {
  id: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  slow?: boolean;
}

export function upsertActivityStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === step.id);
  if (index === -1) return [...steps, step];
  const next = steps.slice();
  next[index] = step;
  return next;
}

export function finishActivityStep(
  steps: ActivityStep[],
  id: string,
  status: 'done' | 'failed',
  description: string,
): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1) return steps;
  const next = steps.slice();
  next[index] = { ...next[index], status, description, slow: false };
  return next;
}

export function markActivityStepSlow(steps: ActivityStep[], id: string): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1 || steps[index].status !== 'running' || steps[index].slow) return steps;
  const next = steps.slice();
  next[index] = { ...next[index], slow: true };
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/agent/activity-steps.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/activity-steps.ts lib/agent/activity-steps.test.ts
git commit -m "feat(agent): add pure ActivityStep reducer for the per-turn activity log"
```

---

### Task 3: Wire `activitySteps` into the store

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: `ActivityStep`, `upsertActivityStep`, `finishActivityStep`, `markActivityStepSlow` from `@/lib/agent/activity-steps` (Task 2); `describeToolActivity` from `@/lib/agent/activity-description` (Task 1, now accepting `'done'`).
- Produces: `ChatState.activitySteps: ActivityStep[]` (replaces `currentActivity: ToolActivity | null`); `export type { ActivityStep }` from `store.ts` (replaces the old exported `ToolActivity` interface) — Tasks 4/5 import `ActivityStep` from `'../store'` exactly as `ToolActivity` was imported before.

This task intentionally leaves `App.tsx` and `CurrentActivityLine.tsx` referencing the old `currentActivity`/`ToolActivity` names — see "Sequencing note" above. Do not attempt to fix those files in this task.

- [ ] **Step 1: Update the failing/changed tests in `store-context.test.tsx` first**

1a. Update the `afterEach` comment (it currently references the old timer, which no longer exists) — replace:

```ts
  // clear() cancels the module-level failureClearTimer (a real setTimeout) and resets
  // currentActivity. Without this, a real timer armed by one test (e.g. via
  // respondToConfirmation(false), which schedules a failure auto-clear) can outlive that
  // test and fire during a later, unrelated test — mutating the shared store singleton out
  // from under it. Runs after every test, not just timer-related ones, since any test could
  // leave a pending failure activity behind.
  afterEach(() => {
    useChat.getState().clear();
  });
```

with:

```ts
  // clear() cancels any module-level slow-activity timers (real setTimeouts) and resets
  // activitySteps. Without this, a real timer armed by one test (e.g. via
  // tool_execution_start, which schedules a 6s slow-escalation timer) can outlive that
  // test and fire during a later, unrelated test — mutating the shared store singleton out
  // from under it. Runs after every test, not just timer-related ones, since any test could
  // leave a pending running step behind.
  afterEach(() => {
    useChat.getState().clear();
  });
```

1b. In `'keeps a newly opened conversation and its record untouched when a previous agent settles late'`, change:

```ts
    expect(useChat.getState()).toMatchObject({
      conversationId: 'B',
      messages: [{ role: 'user', content: 'Message for B' }],
      currentActivity: null,
      busy: false,
    });
```

to:

```ts
    expect(useChat.getState()).toMatchObject({
      conversationId: 'B',
      messages: [{ role: 'user', content: 'Message for B' }],
      activitySteps: [],
      busy: false,
    });
```

1c. In the `it.each(['clear', 'delete'])` test, change:

```ts
    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], currentActivity: null, busy: false });
```

to:

```ts
    expect(useChat.getState()).toMatchObject({ conversationId: replacementId, messages: [], activitySteps: [], busy: false });
```

1d. Replace the whole `'marks a rejected confirmation as a failed activity and ignores a late error event for it'` test body's assertions (keep the setup identical) — change:

```ts
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'button.buy' } });
    const decision = confirm('call-1', 'browser_click', { selector: 'button.buy' }, 'confirm');
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'running' });
    expect(useChat.getState().currentActivity?.description).toContain('button.buy');
    useChat.getState().respondToConfirmation(false);
    await expect(decision).resolves.toBe(false);
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
    expect(useChat.getState().currentActivity?.description).toContain('button.buy');
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'late error' });
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
    expect(useChat.getState().currentActivity?.description).toContain('button.buy');
    resolvePrompt();
    await send;
```

to:

```ts
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'button.buy' } });
    const decision = confirm('call-1', 'browser_click', { selector: 'button.buy' }, 'confirm');
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running' }]);
    expect(useChat.getState().activitySteps[0]?.description).toContain('button.buy');
    useChat.getState().respondToConfirmation(false);
    await expect(decision).resolves.toBe(false);
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
    expect(useChat.getState().activitySteps[0]?.description).toContain('button.buy');
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'late error' });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
    expect(useChat.getState().activitySteps[0]?.description).toContain('button.buy');
    resolvePrompt();
    await send;
```

1e. In `'logs a failed tool call to the console without exposing the raw result in the activity description'`, change:

```ts
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
    expect(useChat.getState().currentActivity?.description).not.toContain('Could not establish connection');
```

to:

```ts
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);
    expect(useChat.getState().activitySteps[0]?.description).not.toContain('Could not establish connection');
```

1f. Rename and rewrite `'clears the current activity on stop and ignores late events for the stopped call'` — replace the whole test with:

```ts
  it('clears activity steps on stop and ignores late events for the stopped call', async () => {
    let rejectAbort!: (reason: Error) => void;
    const agent = makeAgent();
    agent.abort.mockImplementation(() => rejectAbort(new Error('aborted')));
    agent.prompt.mockImplementation(() => new Promise<never>((_resolve, reject) => { rejectAbort = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'running', toolName: 'browser_click', args: { selector: 'button' } });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'running', status: 'running' }]);
    useChat.getState().stop();
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(useChat.getState().activitySteps).toEqual([]);
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'running', toolName: 'browser_click', isError: false, result: 'late' });
    expect(useChat.getState().activitySteps).toEqual([]);
    await send;
  });
```

1g. Replace the entire obsolete `'auto-clears a failed activity after the display timeout, and a later activity is unaffected'` test (this behavior no longer exists — failed steps persist for the turn now) with three new tests:

```ts
  it('accumulates completed and failed steps in the activity log instead of overwriting them', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'boom' });
    expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'failed' }]);

    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'browser_click', args: { selector: 'b' } });
    expect(useChat.getState().activitySteps).toMatchObject([
      { id: 'call-1', status: 'failed' },
      { id: 'call-2', status: 'running' },
    ]);

    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'browser_click', isError: false, result: 'ok' });
    expect(useChat.getState().activitySteps).toMatchObject([
      { id: 'call-1', status: 'failed' },
      { id: 'call-2', status: 'done' },
    ]);

    resolvePrompt();
    await send;
    expect(useChat.getState().activitySteps).toEqual([]);
  });

  it('marks a running step slow after 6s and clears the timer once it ends', async () => {
    vi.useFakeTimers();
    try {
      let resolvePrompt!: () => void;
      const agent = makeAgent();
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
      mocks.createBrowserAgent.mockReturnValue(agent);
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      const send = useChat.getState().send('write');
      await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

      agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running' }]);
      expect(useChat.getState().activitySteps[0]?.slow).toBeFalsy();

      await vi.advanceTimersByTimeAsync(6000);
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'running', slow: true }]);

      agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: false, result: 'ok' });
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'done', slow: false }]);

      resolvePrompt();
      await send;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mark a step slow if it finishes before the 6s threshold', async () => {
    vi.useFakeTimers();
    try {
      let resolvePrompt!: () => void;
      const agent = makeAgent();
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
      mocks.createBrowserAgent.mockReturnValue(agent);
      mocks.sendMessage.mockImplementation((type: string) => {
        if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: ['GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE', 'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION', 'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE'] } });
        return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
      });
      const send = useChat.getState().send('write');
      await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());

      agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_click', args: { selector: 'a' } });
      agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: false, result: 'ok' });
      await vi.advanceTimersByTimeAsync(6000);
      expect(useChat.getState().activitySteps).toMatchObject([{ id: 'call-1', status: 'done', slow: false }]);

      resolvePrompt();
      await send;
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: FAIL — `useChat.getState().activitySteps` is `undefined` (the store doesn't have this field yet), and/or a TypeScript error on `.activitySteps`.

- [ ] **Step 3: Implement the store changes**

3a. Update the import block (around line 39) — change:

```ts
import { describeToolActivity, type ActivityStatus } from '@/lib/agent/activity-description';
```

to:

```ts
import { describeToolActivity } from '@/lib/agent/activity-description';
import { finishActivityStep, markActivityStepSlow, upsertActivityStep, type ActivityStep } from '@/lib/agent/activity-steps';
```

3b. Replace the `ToolActivity` interface (currently `export interface ToolActivity { id: string; description: string; status: ActivityStatus; }`) with a re-export:

```ts
export type { ActivityStep } from '@/lib/agent/activity-steps';
```

3c. In the `ChatState` interface, change:

```ts
  currentActivity: ToolActivity | null;
```

to:

```ts
  activitySteps: ActivityStep[];
```

3d. Replace the constant `const FAILURE_DISPLAY_MS = 2500;` with:

```ts
const SLOW_ACTIVITY_MS = 6000;
```

3e. In `invalidateActiveRun`, change:

```ts
  if (isCurrentOrigin(run.origin, get)) {
    clearFailureTimer();
    set({ busy: false, pendingConfirmation: null, currentActivity: null });
  }
```

to:

```ts
  if (isCurrentOrigin(run.origin, get)) {
    clearAllSlowActivityTimers();
    set({ busy: false, pendingConfirmation: null, activitySteps: [] });
  }
```

3f. Replace the entire `setCurrentActivity` function (and the `failureClearTimer`/`clearFailureTimer` it depends on) with:

```ts
const slowActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearSlowActivityTimer(id: string): void {
  const timer = slowActivityTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    slowActivityTimers.delete(id);
  }
}

function clearAllSlowActivityTimers(): void {
  for (const timer of slowActivityTimers.values()) clearTimeout(timer);
  slowActivityTimers.clear();
}

function scheduleSlowActivityTimer(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  id: string,
): void {
  if (slowActivityTimers.has(id)) return;
  const timer = setTimeout(() => {
    slowActivityTimers.delete(id);
    set((s) => ({ activitySteps: markActivityStepSlow(s.activitySteps, id) }));
  }, SLOW_ACTIVITY_MS);
  slowActivityTimers.set(id, timer);
}
```

3g. In the store's initial state object, change:

```ts
  currentActivity: null,
```

to:

```ts
  activitySteps: [],
```

3h. In `stop()`, change:

```ts
  stop: () => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(false);
    run.resolveConfirmation = null;
    run.agent?.abort();
    const active = get().currentActivity;
    if (active) run.terminatedToolCallIds.add(active.id);
    const pendingId = get().pendingConfirmation?.toolCallId;
    if (pendingId) run.terminatedToolCallIds.add(pendingId);
    set({ pendingConfirmation: null });
    setCurrentActivity(set, null);
  },
```

to:

```ts
  stop: () => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(false);
    run.resolveConfirmation = null;
    run.agent?.abort();
    for (const step of get().activitySteps) run.terminatedToolCallIds.add(step.id);
    const pendingId = get().pendingConfirmation?.toolCallId;
    if (pendingId) run.terminatedToolCallIds.add(pendingId);
    clearAllSlowActivityTimers();
    set({ pendingConfirmation: null, activitySteps: [] });
  },
```

3i. In `respondToConfirmation`, change:

```ts
    if (!approved && pending) {
      run.terminatedToolCallIds.add(pending.toolCallId);
      const info = run.pendingToolArgs.get(pending.toolCallId);
      setCurrentActivity(set, {
        id: pending.toolCallId,
        description: describeToolActivity(pending.toolName, info?.args, 'failed'),
        status: 'failed',
      });
    }
```

to:

```ts
    if (!approved && pending) {
      run.terminatedToolCallIds.add(pending.toolCallId);
      const info = run.pendingToolArgs.get(pending.toolCallId);
      const description = describeToolActivity(pending.toolName, info?.args, 'failed');
      set((s) => ({
        activitySteps: upsertActivityStep(s.activitySteps, {
          id: pending.toolCallId,
          description,
          status: 'failed',
        }),
      }));
    }
```

3j. In `clear()`, change:

```ts
  clear: () => {
    clearFailureTimer();
    ++conversationOpenRequestId;
    invalidateActiveRun(set, get);
    conversationEpoch += 1;
    set({
      messages: [],
      currentActivity: null,
      error: null,
      busy: false,
      conversationId: genConversationId(),
      pendingConfirmation: null,
    });
  },
```

to:

```ts
  clear: () => {
    clearAllSlowActivityTimers();
    ++conversationOpenRequestId;
    invalidateActiveRun(set, get);
    conversationEpoch += 1;
    set({
      messages: [],
      activitySteps: [],
      error: null,
      busy: false,
      conversationId: genConversationId(),
      pendingConfirmation: null,
    });
  },
```

3k. In `openConversation()`, change:

```ts
    clearFailureTimer();
    set({
      messages,
      currentActivity: null,
      conversationId: id,
      error: null,
      busy: false,
      pendingConfirmation: null,
    });
    return true;
```

to:

```ts
    clearAllSlowActivityTimers();
    set({
      messages,
      activitySteps: [],
      conversationId: id,
      error: null,
      busy: false,
      pendingConfirmation: null,
    });
    return true;
```

3l. In the run-start reset (inside `send`/`editMessage`'s shared body), change:

```ts
  clearFailureTimer();
  set({
    messages: [...history, display, makeMessage('assistant', '')],
    currentActivity: null,
    input: '',
    busy: true,
    error: null,
    pendingConfirmation: null,
  });
```

to:

```ts
  clearAllSlowActivityTimers();
  set({
    messages: [...history, display, makeMessage('assistant', '')],
    activitySteps: [],
    input: '',
    busy: true,
    error: null,
    pendingConfirmation: null,
  });
```

3m. In the agent event subscription, change the three `tool_execution_*` handlers from:

```ts
    if (event.type === 'tool_execution_start' && !run.terminatedToolCallIds.has(event.toolCallId)) {
      run.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      setCurrentActivity(set, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
      });
    }

    if (event.type === 'tool_execution_update' && !run.terminatedToolCallIds.has(event.toolCallId)) {
      run.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      setCurrentActivity(set, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
      });
    }

    if (event.type === 'tool_execution_end') {
      const blocked = event.isError && isToolGuardBlockResult(event.result);
      // 聊天界面里的活动提示刻意不展示原始 tool result（可能带用户输入的敏感值，见下方
      // "does not expose raw tool payloads" 一类用例），所以失败原因只打到控制台，方便
      // 打开 DevTools 排查，不在 UI 上泄露。
      if (event.isError && !blocked) {
        // event.result 通常是 { content: [{type:'text', text}], details } 这样的对象——
        // console.error 直接打对象在 chrome://extensions 的错误面板里会被字符串化成
        // "[object Object]"（该面板不支持对象展开，只有普通 DevTools 控制台才行），
        // 所以这里尽量把文本消息拆出来打，保证错误面板里也能看到实际原因。
        const result = event.result as unknown;
        const message =
          typeof result === 'string'
            ? result
            : ((result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content?.find(
                (c) => c.type === 'text',
              )?.text ?? result);
        console.error('[Aluminum] tool execution failed', event.toolName, message);
      }
      const info = run.pendingToolArgs.get(event.toolCallId);
      run.pendingToolArgs.delete(event.toolCallId);
      if (!run.terminatedToolCallIds.has(event.toolCallId)) {
        if (blocked || event.isError) {
          setCurrentActivity(set, {
            id: event.toolCallId,
            description: describeToolActivity(event.toolName, info?.args, 'failed'),
            status: 'failed',
          });
        } else {
          setCurrentActivity(set, null);
        }
      }
    }
```

to:

```ts
    if (event.type === 'tool_execution_start' && !run.terminatedToolCallIds.has(event.toolCallId)) {
      run.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      set((s) => ({
        activitySteps: upsertActivityStep(s.activitySteps, {
          id: event.toolCallId,
          description: describeToolActivity(event.toolName, event.args, 'running'),
          status: 'running',
        }),
      }));
      scheduleSlowActivityTimer(set, event.toolCallId);
    }

    if (event.type === 'tool_execution_update' && !run.terminatedToolCallIds.has(event.toolCallId)) {
      run.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      set((s) => ({
        activitySteps: upsertActivityStep(s.activitySteps, {
          id: event.toolCallId,
          description: describeToolActivity(event.toolName, event.args, 'running'),
          status: 'running',
        }),
      }));
    }

    if (event.type === 'tool_execution_end') {
      const blocked = event.isError && isToolGuardBlockResult(event.result);
      // 聊天界面里的活动提示刻意不展示原始 tool result（可能带用户输入的敏感值，见下方
      // "does not expose raw tool payloads" 一类用例），所以失败原因只打到控制台，方便
      // 打开 DevTools 排查，不在 UI 上泄露。
      if (event.isError && !blocked) {
        // event.result 通常是 { content: [{type:'text', text}], details } 这样的对象——
        // console.error 直接打对象在 chrome://extensions 的错误面板里会被字符串化成
        // "[object Object]"（该面板不支持对象展开，只有普通 DevTools 控制台才行），
        // 所以这里尽量把文本消息拆出来打，保证错误面板里也能看到实际原因。
        const result = event.result as unknown;
        const message =
          typeof result === 'string'
            ? result
            : ((result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content?.find(
                (c) => c.type === 'text',
              )?.text ?? result);
        console.error('[Aluminum] tool execution failed', event.toolName, message);
      }
      const info = run.pendingToolArgs.get(event.toolCallId);
      run.pendingToolArgs.delete(event.toolCallId);
      clearSlowActivityTimer(event.toolCallId);
      if (!run.terminatedToolCallIds.has(event.toolCallId)) {
        const finalStatus = blocked || event.isError ? 'failed' : 'done';
        const description = describeToolActivity(event.toolName, info?.args, finalStatus);
        set((s) => ({
          activitySteps: finishActivityStep(s.activitySteps, event.toolCallId, finalStatus, description),
        }));
      }
    }
```

Note: the `console.error(...)` block between the `blocked` computation and `run.pendingToolArgs.delete(...)` is unchanged from today's code — it's reproduced above verbatim so the old_string match is exact; only the activity-state lines around it actually change.

3n. In the run's `finally` block, change:

```ts
  } finally {
    unsubscribe();
    if (isCurrentRun(run, get)) {
      const messages = get().messages;
      settleRun(run);
      set({ busy: false });
      setCurrentActivity(set, null);
      await persistConversationSnapshot(run.origin.conversationId, messages);
    }
```

to:

```ts
  } finally {
    unsubscribe();
    if (isCurrentRun(run, get)) {
      const messages = get().messages;
      settleRun(run);
      clearAllSlowActivityTimers();
      set({ busy: false, activitySteps: [] });
      await persistConversationSnapshot(run.origin.conversationId, messages);
    }
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS (all tests, including the 3 new ones from Step 1g).

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "feat(sidepanel): replace single-slot activity with an accumulating per-turn step log"
```

---

### Task 4: `ActivityStepList` component

**Files:**
- Create: `entrypoints/sidepanel/components/ActivityStepList.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: `ActivityStep` from `../store` (Task 3); `useTranslation` from `@/lib/i18n`; `IconCheck`, `IconClose` from `../icons`.
- Produces: `ActivityStepList({ steps: ActivityStep[] })` — Task 5 renders this in place of `CurrentActivityLine`.

This task is purely additive — it does not touch `App.tsx` or delete `CurrentActivityLine.tsx` yet, so the existing `'current activity line'` test block keeps passing untouched.

- [ ] **Step 1: Write the failing component tests**

In `entrypoints/sidepanel/components/workbench-components.test.tsx`, add `ActivityStepList` to the store-type import (change `import type { PageContextState, ToolActivity } from '../store';` to `import type { ActivityStep, PageContextState, ToolActivity } from '../store';`) and add an import for the new component right after the existing `CurrentActivityLine` import:

```ts
import { CurrentActivityLine } from './CurrentActivityLine';
import { ActivityStepList } from './ActivityStepList';
```

Then add a new describe block right after the existing `describe('current activity line', ...)` block (i.e., after its closing `});`):

```ts
describe('activity step list', () => {
  const steps: ActivityStep[] = [
    { id: 'call-1', description: 'Clicked "button.buy"', status: 'done' },
    { id: 'call-2', description: 'Failed to click "button.confirm"', status: 'failed' },
    { id: 'call-3', description: 'Typing into "input.name"', status: 'running' },
  ];

  it('renders one row per step with a shared status container', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toBeVisible();
    expect(screen.getByText('Clicked "button.buy"')).toBeVisible();
    expect(screen.getByText('Failed to click "button.confirm"')).toBeVisible();
    expect(screen.getByText('Typing into "input.name"')).toBeVisible();
  });

  it('gives the failed row distinct (red) styling', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={steps} />
      </LocaleProvider>,
    );
    const failedText = screen.getByText('Failed to click "button.confirm"');
    expect(failedText.closest('div')?.className).toContain('text-red-700');
  });

  it('appends the slow suffix to a running step marked slow', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={[{ id: 'call-1', description: 'Reading page', status: 'running', slow: true }]} />
      </LocaleProvider>,
    );
    expect(screen.getByText('Reading page… this is taking longer than usual')).toBeVisible();
  });

  it('does not append the slow suffix to a running step that is not slow', () => {
    render(
      <LocaleProvider>
        <ActivityStepList steps={[{ id: 'call-1', description: 'Reading page', status: 'running' }]} />
      </LocaleProvider>,
    );
    expect(screen.getByText('Reading page')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx -t "activity step list"`
Expected: FAIL — `./ActivityStepList` module doesn't exist yet.

- [ ] **Step 3: Implement `ActivityStepList.tsx`**

```tsx
import { useTranslation } from '@/lib/i18n';
import { IconCheck, IconClose } from '../icons';
import type { ActivityStep } from '../store';

export function ActivityStepList({ steps }: { steps: ActivityStep[] }) {
  const { t } = useTranslation();
  const slowSuffix = t('agentActivity.slowSuffix');

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex max-h-32 flex-col gap-1 overflow-y-auto px-1 text-xs"
    >
      {steps.map((step) => (
        <ActivityStepRow key={step.id} step={step} slowSuffix={slowSuffix} />
      ))}
    </div>
  );
}

function ActivityStepRow({ step, slowSuffix }: { step: ActivityStep; slowSuffix: string }) {
  const text = step.status === 'running' && step.slow ? `${step.description}${slowSuffix}` : step.description;

  if (step.status === 'running') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
      </div>
    );
  }

  if (step.status === 'failed') {
    return (
      <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
        <IconClose className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-neutral-400 dark:text-neutral-500">
      <IconCheck className="h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx -t "activity step list"`
Expected: PASS (all 4 new tests). Note: the full file will still show failures from the untouched, soon-to-be-obsolete `'current activity line'` block only if `CurrentActivityLine.tsx` itself is broken — it isn't yet, so `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx` (without `-t`) should also be fully green at this point.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/components/ActivityStepList.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat(sidepanel): add ActivityStepList component for the per-turn activity log"
```

---

### Task 5: Wire `App.tsx` to the new state, add the thinking-gap indicator, retire `CurrentActivityLine`

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx`
- Delete: `entrypoints/sidepanel/components/CurrentActivityLine.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: `ActivityStepList` (Task 4), `activitySteps: ActivityStep[]` from the store (Task 3).

This task resolves the transient compile breakage noted in the "Sequencing note" — after this task, `pnpm compile` should pass again.

- [ ] **Step 1: Update the mock store shape and remove the obsolete test block**

In `entrypoints/sidepanel/components/workbench-components.test.tsx`:

1a. Change the store-type import from:

```ts
import type { ActivityStep, PageContextState, ToolActivity } from '../store';
```

to:

```ts
import type { ActivityStep, PageContextState } from '../store';
```

1b. Remove the now-unused `CurrentActivityLine` import line:

```ts
import { CurrentActivityLine } from './CurrentActivityLine';
```

1c. In the `chatStore` object literal, change:

```ts
  currentActivity: null,
```

to:

```ts
  activitySteps: [],
```

1d. In the `beforeEach` block's `Object.assign(chatStore, {...})`, change:

```ts
    currentActivity: null,
```

to:

```ts
    activitySteps: [],
```

1e. Delete the entire `describe('current activity line', ...)` block (the three tests that directly render `<CurrentActivityLine ... />` and the App-integration confirmation test) and replace it with two tests appended to the `describe('activity step list', ...)` block added in Task 4:

```ts
  it('hides the activity step list while a confirmation is pending, but keeps approval working', async () => {
    const user = userEvent.setup();
    (chatStore as any).activitySteps = [{ id: 'call-1', description: 'Clicking "button.buy"', status: 'running' }];
    (chatStore as any).pendingConfirmation = {
      toolCallId: 'call-1',
      toolName: 'browser_type',
      summary: 'AI wants to type a value.',
    };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByText('Clicking "button.buy"')).toBeNull();
    expect(screen.getByText(/Please confirm before modifying the page/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve this turn' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(true);
  });

  it('shows a trailing thinking indicator on the last message while busy with no running step', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it', createdAt: 2 },
    ];
    (chatStore as any).busy = true;
    (chatStore as any).activitySteps = [];
    (chatStore as any).pendingConfirmation = null;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByLabelText('Generating')).toBeVisible();
  });

  it('does not show the trailing thinking indicator while a tool step is running', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it', createdAt: 2 },
    ];
    (chatStore as any).busy = true;
    (chatStore as any).activitySteps = [{ id: 'call-1', description: 'Clicking "button.buy"', status: 'running' }];
    (chatStore as any).pendingConfirmation = null;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByLabelText('Generating')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx -t "activity step list"`
Expected: FAIL — `App` still destructures `currentActivity` (not present on the mock anymore) and still renders `CurrentActivityLine`, so the confirmation-hiding and thinking-indicator assertions don't hold yet.

- [ ] **Step 3: Update `App.tsx`**

3a. Change the component import from:

```ts
import { CurrentActivityLine } from './components/CurrentActivityLine';
```

to:

```ts
import { ActivityStepList } from './components/ActivityStepList';
```

3b. In the `useChat()` destructuring, change:

```ts
    currentActivity,
```

to:

```ts
    activitySteps,
```

3c. Immediately before the component's `return (` statement, add a derived value:

```ts
  const hasRunningActivityStep = activitySteps.some((step) => step.status === 'running');
```

3d. Replace the messages-rendering block:

```tsx
                  messages.map((m) => (
                    <Message
                      key={m.id}
                      message={m}
                      busy={busy}
                      editing={editingId === m.id}
                      discardCount={editingId === m.id ? discardedCount(messages, m.id) : 0}
                      onBeginEdit={() => setEditingId(m.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onSubmitEdit={(content) => submitEdit(m.id, content)}
                    />
                  ))
                )}
                {currentActivity && !pendingConfirmation && (
                  <CurrentActivityLine activity={currentActivity} />
                )}
```

with:

```tsx
                  messages.map((m, i) => (
                    <Message
                      key={m.id}
                      message={m}
                      busy={busy}
                      showThinkingIndicator={
                        i === messages.length - 1 && busy && !pendingConfirmation && !hasRunningActivityStep
                      }
                      editing={editingId === m.id}
                      discardCount={editingId === m.id ? discardedCount(messages, m.id) : 0}
                      onBeginEdit={() => setEditingId(m.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onSubmitEdit={(content) => submitEdit(m.id, content)}
                    />
                  ))
                )}
                {activitySteps.length > 0 && !pendingConfirmation && (
                  <ActivityStepList steps={activitySteps} />
                )}
```

3e. Update the `Message` function's props type and body — change:

```tsx
function Message({
  message,
  busy,
  editing,
  discardCount,
  onBeginEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UIMessage;
  busy: boolean;
  editing: boolean;
  discardCount: number;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (content: string) => void;
}) {
```

to:

```tsx
function Message({
  message,
  busy,
  showThinkingIndicator,
  editing,
  discardCount,
  onBeginEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UIMessage;
  busy: boolean;
  showThinkingIndicator: boolean;
  editing: boolean;
  discardCount: number;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (content: string) => void;
}) {
```

3f. In the same function, change the assistant-bubble body from:

```tsx
        {content ? (
          <Suspense fallback={<span className="whitespace-pre-wrap">{content}</span>}>
            <Markdown content={content} />
          </Suspense>
        ) : busy ? (
          <TypingDots />
        ) : null}
      </div>
    </div>
  );
}
```

to:

```tsx
        {content ? (
          <Suspense fallback={<span className="whitespace-pre-wrap">{content}</span>}>
            <Markdown content={content} />
          </Suspense>
        ) : busy ? (
          <TypingDots />
        ) : null}
        {content && showThinkingIndicator && (
          <div className="mt-1">
            <TypingDots />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Delete the retired component**

```bash
rm entrypoints/sidepanel/components/CurrentActivityLine.tsx
```

- [ ] **Step 5: Run the full sidepanel UI test suite to verify it passes**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS (no references to `CurrentActivityLine`, `ToolActivity`, or `currentActivity` remain).

- [ ] **Step 6: Type-check**

Run: `pnpm compile`
Expected: PASS — this is the point where the transient breakage from Task 3 is resolved.

- [ ] **Step 7: Commit**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git rm entrypoints/sidepanel/components/CurrentActivityLine.tsx
git commit -m "feat(sidepanel): render the activity step log and a thinking-gap indicator in App"
```

---

### Task 6: Full verification and manual pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated test suite**

Run: `pnpm test`
Expected: PASS, all test files (including `lib/agent/activity-steps.test.ts`, `lib/agent/activity-description.test.ts`, `lib/i18n/i18n.test.ts`, `entrypoints/sidepanel/store-context.test.tsx`, `entrypoints/sidepanel/components/workbench-components.test.tsx`).

- [ ] **Step 2: Type-check**

Run: `pnpm compile`
Expected: PASS with zero errors.

- [ ] **Step 3: Production build**

Run: `pnpm build`
Expected: Succeeds, `.output/chrome-mv3` produced.

- [ ] **Step 4: Manual verification via `pnpm dev`**

Run: `pnpm dev`, load the unpacked extension from `.output/chrome-mv3` via `chrome://extensions` → Developer mode → Load unpacked (or reload if already loaded), then in the side panel:

1. Ask the agent to do something that triggers several tool calls in one turn (e.g. a multi-step page edit). Confirm the step list accumulates: each completed step shows a checkmark + past-tense text, the current step keeps the blue pulsing dot, and the list scrolls if it grows past ~5 rows.
2. Trigger a write action and deny the confirmation. Confirm the denial shows up as a permanent red failed row in the list (not a flash that disappears after ~2.5s).
3. Force a slow tool call (e.g. ask it to read a very large page) and confirm that after ~6 seconds the running row's text gains the "this is taking longer than usual"-style suffix, and that the suffix does not appear for calls that finish quickly.
4. Watch for a gap between two tool calls (or right after the last tool call, while the agent composes its final answer): confirm the small trailing typing-dots indicator appears at the end of the assistant bubble, and disappears again once a new tool starts or the turn ends.
5. Let a turn finish normally: confirm the step list and any trailing indicator both disappear with no residue, and the final assistant message remains.
6. Click Stop mid-turn: confirm the step list clears immediately (unchanged from current behavior).

Document the outcome of this manual pass in the PR/commit description or `docs/PROGRESS.md` changelog entry, since it's not covered by the automated suite.

- [ ] **Step 5: Update `docs/PROGRESS.md`**

Add a changelog entry (Chinese, matching the file's existing style) summarizing: replaced the single-slot activity indicator with an accumulating per-turn step log (past-tense done rows, permanent failed rows, 6s slow-timeout suffix), and added a trailing thinking-gap indicator between tool calls. Link to `docs/superpowers/specs/2026-08-02-agent-progress-feedback-design.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs: log the agent progress feedback enhancements in PROGRESS.md"
```
