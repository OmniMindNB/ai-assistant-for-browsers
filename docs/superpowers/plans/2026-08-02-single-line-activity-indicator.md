# Single-Line Activity Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidepanel's collapsible "Agent activity" card (tool-name list + completed/total count) with a single line of live, parameter-rich text describing the agent's current step (e.g. `Clicking "button.buy"`), per `docs/superpowers/specs/2026-08-02-single-line-activity-indicator-design.md`.

**Architecture:** A new pure function `describeToolActivity(toolName, args, status)` in `lib/agent/activity-description.ts` turns a tool call into one localized sentence. `entrypoints/sidepanel/store.ts` collapses its `toolActivities: ToolActivity[]` array into a single `currentActivity: ToolActivity | null`, calling `describeToolActivity` at each `tool_execution_*` event and running a short auto-clear timer on failure. A new `CurrentActivityLine` component renders that single value, replacing `AgentActivityCard`. A final cleanup task removes the now-dead list/count code and i18n keys.

**Tech Stack:** TypeScript, React (WXT sidepanel), Zustand store, Vitest (`unit` project = `lib/**/*.test.ts` in node env; `ui` project = `entrypoints/**/*.test.tsx` + `components/**/*.test.tsx` in jsdom env — both run under `pnpm test`), the project's hand-rolled `t()`/`TranslationKey` i18n system (`lib/i18n`).

## Global Constraints

- Chinese and English locale dictionaries (`lib/i18n/locales/{zh,en}.ts`) must always keep the exact same key set — `lib/i18n/i18n.test.ts` asserts `Object.keys(en).sort()` equals `Object.keys(zh).sort()`. Add/remove keys in both files in the same step.
- No new UI element may render the raw tool `result`/error payload — only the bounded, known-safe fields (`selector`/`url`/`text`/`key`/`focus`, truncated) may reach displayed text. This mirrors the existing rule in `store.ts` (tool failures are logged via `console.error`, never shown raw in the UI).
- `pnpm compile`, `pnpm test`, and `pnpm build` must pass at the end of every task.

---

## Task 1: `describeToolActivity` + new i18n keys

**Files:**
- Create: `lib/agent/activity-description.ts`
- Create: `lib/agent/activity-description.test.ts`
- Modify: `lib/i18n/locales/zh.ts:156` (insert after `'agentActivity.tool.unknown'`)
- Modify: `lib/i18n/locales/en.ts:159` (insert after `'agentActivity.tool.unknown'`)

**Interfaces:**
- Produces: `export type ActivityStatus = 'running' | 'failed'` and `export function describeToolActivity(toolName: string, args: unknown, status: ActivityStatus): string` from `lib/agent/activity-description.ts`. Task 2 imports both.

- [ ] **Step 1: Add the new i18n keys (additive only) to `lib/i18n/locales/zh.ts`**

Insert immediately after line 156 (`'agentActivity.tool.unknown': '浏览器操作',`), before `'status.running': '运行中',`:

```ts
  'agentActivity.actionFailed': '{action}失败',
  'agentActivity.now.inspectFocus': '正在检查页面实现（聚焦 "{target}"）',
  'agentActivity.failed.inspectFocus': '检查页面实现（聚焦 "{target}"）失败',
  'agentActivity.now.queryDom': '正在查询 "{target}"',
  'agentActivity.failed.queryDom': '查询 "{target}" 失败',
  'agentActivity.now.getHtml': '正在读取 "{target}" 的 HTML',
  'agentActivity.failed.getHtml': '读取 "{target}" 的 HTML 失败',
  'agentActivity.now.getComputedStyle': '正在读取 "{target}" 的计算样式',
  'agentActivity.failed.getComputedStyle': '读取 "{target}" 的计算样式失败',
  'agentActivity.now.setStyle': '正在修改 "{target}" 的样式',
  'agentActivity.failed.setStyle': '修改 "{target}" 的样式失败',
  'agentActivity.now.modifyDom': '正在修改 "{target}"',
  'agentActivity.failed.modifyDom': '修改 "{target}" 失败',
  'agentActivity.now.click': '正在点击 "{target}"',
  'agentActivity.failed.click': '点击 "{target}" 失败',
  'agentActivity.now.type': '正在向 "{target}" 输入文本',
  'agentActivity.failed.type': '向 "{target}" 输入文本失败',
  'agentActivity.now.select': '正在设置 "{target}" 的选项',
  'agentActivity.failed.select': '设置 "{target}" 的选项失败',
  'agentActivity.now.scrollTo': '正在滚动到 "{target}"',
  'agentActivity.failed.scrollTo': '滚动到 "{target}" 失败',
  'agentActivity.now.navigate': '正在跳转到 "{target}"',
  'agentActivity.failed.navigate': '跳转到 "{target}" 失败',
  'agentActivity.now.setStorage': '正在写入存储 "{target}"',
  'agentActivity.failed.setStorage': '写入存储 "{target}" 失败',
```

- [ ] **Step 2: Add the mirrored English keys to `lib/i18n/locales/en.ts`**

Insert immediately after line 159 (`'agentActivity.tool.unknown': 'Browser action',`), before `'status.running': 'Running',`:

```ts
  'agentActivity.actionFailed': '{action} failed',
  'agentActivity.now.inspectFocus': 'Inspecting page implementation (focus: "{target}")',
  'agentActivity.failed.inspectFocus': 'Failed to inspect page implementation (focus: "{target}")',
  'agentActivity.now.queryDom': 'Querying "{target}"',
  'agentActivity.failed.queryDom': 'Failed to query "{target}"',
  'agentActivity.now.getHtml': 'Reading HTML for "{target}"',
  'agentActivity.failed.getHtml': 'Failed to read HTML for "{target}"',
  'agentActivity.now.getComputedStyle': 'Reading computed style for "{target}"',
  'agentActivity.failed.getComputedStyle': 'Failed to read computed style for "{target}"',
  'agentActivity.now.setStyle': 'Styling "{target}"',
  'agentActivity.failed.setStyle': 'Failed to style "{target}"',
  'agentActivity.now.modifyDom': 'Modifying "{target}"',
  'agentActivity.failed.modifyDom': 'Failed to modify "{target}"',
  'agentActivity.now.click': 'Clicking "{target}"',
  'agentActivity.failed.click': 'Failed to click "{target}"',
  'agentActivity.now.type': 'Typing into "{target}"',
  'agentActivity.failed.type': 'Failed to type into "{target}"',
  'agentActivity.now.select': 'Selecting an option in "{target}"',
  'agentActivity.failed.select': 'Failed to select an option in "{target}"',
  'agentActivity.now.scrollTo': 'Scrolling to "{target}"',
  'agentActivity.failed.scrollTo': 'Failed to scroll to "{target}"',
  'agentActivity.now.navigate': 'Navigating to "{target}"',
  'agentActivity.failed.navigate': 'Failed to navigate to "{target}"',
  'agentActivity.now.setStorage': 'Writing storage key "{target}"',
  'agentActivity.failed.setStorage': 'Failed to write storage key "{target}"',
```

- [ ] **Step 3: Write the failing test file `lib/agent/activity-description.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { describeToolActivity } from './activity-description';

describe('describeToolActivity', () => {
  it('describes a running click with the selector as target', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'running')).toBe('Clicking "button.buy"');
  });

  it('describes a failed click with the same target', () => {
    expect(describeToolActivity('browser_click', { selector: 'button.buy' }, 'failed')).toBe('Failed to click "button.buy"');
  });

  it('describes running type/select/setStyle/modifyDom/getHtml/getComputedStyle/queryDom by selector', () => {
    expect(describeToolActivity('browser_type', { selector: 'input.name' }, 'running')).toBe('Typing into "input.name"');
    expect(describeToolActivity('browser_select', { selector: 'select.country' }, 'running')).toBe('Selecting an option in "select.country"');
    expect(describeToolActivity('browser_set_style', { selector: '.ad' }, 'running')).toBe('Styling ".ad"');
    expect(describeToolActivity('browser_modify_dom', { selector: '.ad' }, 'running')).toBe('Modifying ".ad"');
    expect(describeToolActivity('browser_get_html', { selector: 'main' }, 'running')).toBe('Reading HTML for "main"');
    expect(describeToolActivity('browser_get_computed_style', { selector: 'main' }, 'running')).toBe('Reading computed style for "main"');
    expect(describeToolActivity('browser_query_dom', { selector: 'main' }, 'running')).toBe('Querying "main"');
  });

  it('falls back to "html" for get_html with no selector', () => {
    expect(describeToolActivity('browser_get_html', {}, 'running')).toBe('Reading HTML for "html"');
  });

  it('describes navigate by URL and set_storage by key', () => {
    expect(describeToolActivity('browser_navigate', { url: 'https://example.com' }, 'running')).toBe('Navigating to "https://example.com"');
    expect(describeToolActivity('browser_set_storage', { key: 'token' }, 'running')).toBe('Writing storage key "token"');
  });

  it('describes scroll with and without a target selector', () => {
    expect(describeToolActivity('browser_scroll', { selector: '#footer' }, 'running')).toBe('Scrolling to "#footer"');
    expect(describeToolActivity('browser_scroll', {}, 'running')).toBe('Scroll');
  });

  it('describes inspect_page_implementation with and without a focus', () => {
    expect(describeToolActivity('browser_inspect_page_implementation', { focus: 'scroll' }, 'running')).toBe(
      'Inspecting page implementation (focus: "scroll")',
    );
    expect(describeToolActivity('browser_inspect_page_implementation', {}, 'running')).toBe('Inspect page implementation');
  });

  it('falls back to the plain tool label for no-arg tools, appending a failure suffix when failed', () => {
    expect(describeToolActivity('browser_get_active_tab', {}, 'running')).toBe('Get active tab');
    expect(describeToolActivity('browser_get_active_tab', {}, 'failed')).toBe('Get active tab failed');
    expect(describeToolActivity('browser_read_page', {}, 'running')).toBe('Read page');
    expect(describeToolActivity('browser_get_page_meta', {}, 'running')).toBe('Get page metadata');
    expect(describeToolActivity('browser_get_scripts', {}, 'running')).toBe('Get scripts');
    expect(describeToolActivity('browser_get_stylesheets', {}, 'running')).toBe('Get stylesheets');
    expect(describeToolActivity('browser_screenshot', {}, 'running')).toBe('Take screenshot');
  });

  it('falls back to a generic label for an unknown tool', () => {
    expect(describeToolActivity('browser_something_new', {}, 'running')).toBe('Browser action');
    expect(describeToolActivity('browser_something_new', {}, 'failed')).toBe('Browser action failed');
  });

  it('truncates a very long target', () => {
    const longSelector = `.${'x'.repeat(200)}`;
    const result = describeToolActivity('browser_click', { selector: longSelector }, 'running');
    expect(result.length).toBeLessThan(100);
    expect(result).toContain('…');
  });

  it('handles non-object args without throwing', () => {
    expect(() => describeToolActivity('browser_click', undefined, 'running')).not.toThrow();
    expect(() => describeToolActivity('browser_click', 'not an object', 'running')).not.toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run lib/agent/activity-description.test.ts`
Expected: FAIL with "Cannot find module './activity-description'" (or similar — the module doesn't exist yet).

- [ ] **Step 5: Implement `lib/agent/activity-description.ts`**

```ts
import { t, type TranslationKey } from '@/lib/i18n';

export type ActivityStatus = 'running' | 'failed';

const MAX_TARGET_LENGTH = 60;

function truncate(value: string, max = MAX_TARGET_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function withTarget(status: ActivityStatus, nowKey: TranslationKey, failedKey: TranslationKey, target: string): string {
  return t(status === 'running' ? nowKey : failedKey, { target: truncate(target) });
}

function plain(status: ActivityStatus, labelKey: TranslationKey): string {
  const label = t(labelKey);
  return status === 'running' ? label : t('agentActivity.actionFailed', { action: label });
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
        ? withTarget(status, 'agentActivity.now.inspectFocus', 'agentActivity.failed.inspectFocus', focus)
        : plain(status, 'agentActivity.tool.inspectPageImplementation');
    }
    case 'browser_query_dom':
      return withTarget(status, 'agentActivity.now.queryDom', 'agentActivity.failed.queryDom', str('selector'));
    case 'browser_get_html':
      return withTarget(status, 'agentActivity.now.getHtml', 'agentActivity.failed.getHtml', str('selector') || 'html');
    case 'browser_get_scripts':
      return plain(status, 'agentActivity.tool.getScripts');
    case 'browser_get_stylesheets':
      return plain(status, 'agentActivity.tool.getStylesheets');
    case 'browser_get_computed_style':
      return withTarget(status, 'agentActivity.now.getComputedStyle', 'agentActivity.failed.getComputedStyle', str('selector'));
    case 'browser_screenshot':
      return plain(status, 'agentActivity.tool.screenshot');
    case 'browser_set_style':
      return withTarget(status, 'agentActivity.now.setStyle', 'agentActivity.failed.setStyle', str('selector'));
    case 'browser_modify_dom':
      return withTarget(status, 'agentActivity.now.modifyDom', 'agentActivity.failed.modifyDom', str('selector'));
    case 'browser_click':
      return withTarget(status, 'agentActivity.now.click', 'agentActivity.failed.click', str('selector'));
    case 'browser_type':
      return withTarget(status, 'agentActivity.now.type', 'agentActivity.failed.type', str('selector'));
    case 'browser_select':
      return withTarget(status, 'agentActivity.now.select', 'agentActivity.failed.select', str('selector'));
    case 'browser_scroll': {
      const selector = str('selector');
      return selector
        ? withTarget(status, 'agentActivity.now.scrollTo', 'agentActivity.failed.scrollTo', selector)
        : plain(status, 'agentActivity.tool.scroll');
    }
    case 'browser_navigate':
      return withTarget(status, 'agentActivity.now.navigate', 'agentActivity.failed.navigate', str('url'));
    case 'browser_set_storage':
      return withTarget(status, 'agentActivity.now.setStorage', 'agentActivity.failed.setStorage', str('key'));
    default:
      return plain(status, 'agentActivity.tool.unknown');
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run lib/agent/activity-description.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 7: Run the full i18n test file to confirm key parity still holds**

Run: `pnpm vitest run lib/i18n/i18n.test.ts`
Expected: PASS — `keeps the English and Chinese dictionaries on the same key set` still passes since Steps 1-2 added identical keys to both files.

- [ ] **Step 8: Commit**

```bash
git add lib/agent/activity-description.ts lib/agent/activity-description.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(agent): add describeToolActivity for parameter-rich activity text"
```

---

## Task 2: Replace the tool-activity list with a single-line indicator (store + component)

This task rewrites `store.ts`'s tool-activity tracking end to end, swaps `AgentActivityCard` for a new `CurrentActivityLine`, and updates both test files that exercise this behavior (`entrypoints/sidepanel/store-context.test.tsx` and `entrypoints/sidepanel/components/workbench-components.test.tsx`). These pieces are compiled together — the store's field name and the component's props change atomically, so the task is one unit even though it spans several files.

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`
- Create: `entrypoints/sidepanel/components/CurrentActivityLine.tsx`
- Delete: `entrypoints/sidepanel/components/AgentActivityCard.tsx`
- Modify: `entrypoints/sidepanel/App.tsx:21,25,34,149,262`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: `describeToolActivity(toolName, args, status)` and `type ActivityStatus` from `@/lib/agent/activity-description` (Task 1).
- Produces: `entrypoints/sidepanel/store.ts` exports `export interface ToolActivity { id: string; description: string; status: ActivityStatus }`, `currentActivity: ToolActivity | null` on `ChatState`, and `export interface PendingConfirmation { toolCallId: string; toolName: string; summary: string; codePreview?: string }` (added `toolCallId`). `entrypoints/sidepanel/components/CurrentActivityLine.tsx` exports `export function CurrentActivityLine({ activity }: { activity: ToolActivity }): JSX.Element`.

- [ ] **Step 1: Update `entrypoints/sidepanel/store-context.test.tsx` to the new `currentActivity` shape (failing until Step 5)**

Replace line 295 (inside the "keeps a newly opened conversation..." test's `toMatchObject`):

```ts
      currentActivity: null,
```

Replace line 613 (inside another test's `toMatchObject`) — change the fragment `toolActivities: []` to `currentActivity: null` in that object literal.

Replace the three tests spanning lines 735-829 (`'marks a rejected confirmation denied...'`, `'logs a failed tool call to the console...'`, `'stops running and confirming agent activities...'`) with:

```ts
  it('marks a rejected confirmation as a failed activity and ignores a late error event for it', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const send = useChat.getState().send('write');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    const confirm = mocks.createBrowserAgent.mock.calls[0][0].onConfirm as (id: string, name: string, args: unknown, reason: string) => Promise<boolean>;
    const decision = confirm('call-1', 'browser_click', { selector: 'button.buy' }, 'confirm');
    expect(useChat.getState().currentActivity).toBeNull();
    useChat.getState().respondToConfirmation(false);
    await expect(decision).resolves.toBe(false);
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
    expect(useChat.getState().currentActivity?.description).toContain('button.buy');
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'late error' });
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
    expect(useChat.getState().currentActivity?.description).toContain('button.buy');
    resolvePrompt();
    await send;
  });

  it('logs a failed tool call to the console without exposing the raw result in the activity description', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = useChat.getState().send('read the page');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    agentEventListener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'browser_read_page', args: {} });
    agentEventListener?.({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'browser_read_page',
      isError: true,
      result: 'Could not establish connection. Receiving end does not exist.',
    });
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
    expect(useChat.getState().currentActivity?.description).not.toContain('Could not establish connection');
    expect(consoleError).toHaveBeenCalledWith(
      '[Aluminum] tool execution failed',
      'browser_read_page',
      'Could not establish connection. Receiving end does not exist.',
    );
    consoleError.mockRestore();
    resolvePrompt();
    await send;
  });

  it('clears the current activity on stop and ignores late events for the stopped call', async () => {
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
    expect(useChat.getState().currentActivity).toMatchObject({ id: 'running', status: 'running' });
    useChat.getState().stop();
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(useChat.getState().currentActivity).toBeNull();
    agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'running', toolName: 'browser_click', isError: false, result: 'late' });
    expect(useChat.getState().currentActivity).toBeNull();
    await send;
  });

  it('auto-clears a failed activity after the display timeout, and a later activity is unaffected', async () => {
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
      agentEventListener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_click', isError: true, result: 'boom' });
      expect(useChat.getState().currentActivity).toMatchObject({ id: 'call-1', status: 'failed' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(useChat.getState().currentActivity).toBeNull();
      resolvePrompt();
      await send;
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Update `entrypoints/sidepanel/components/workbench-components.test.tsx` to the new component/store shape (failing until Step 5)**

Change the import block (lines 11-13):

```ts
import type { PageContextState, ToolActivity } from '../store';
import App from '../App';
import { CurrentActivityLine } from './CurrentActivityLine';
```

Change `chatStore`'s default field (line 21): `toolActivities: []` → `currentActivity: null,`

Change the `beforeEach` reset (line 150): `toolActivities: [],` → `currentActivity: null,`

Delete the `activity()` helper and `activities` const (lines 195-206) — no longer needed, replaced below.

Replace the entire `describe('agent activity timeline', ...)` block (lines 467-597) with:

```ts
describe('current activity line', () => {
  it('renders the running activity description with a status role', () => {
    render(
      <LocaleProvider>
        <CurrentActivityLine activity={{ id: 'call-1', description: 'Clicking "button.buy"', status: 'running' }} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Clicking "button.buy"');
  });

  it('renders a failed activity with distinct (red) styling', () => {
    render(
      <LocaleProvider>
        <CurrentActivityLine activity={{ id: 'call-1', description: 'Failed to click "button.buy"', status: 'failed' }} />
      </LocaleProvider>,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Failed to click "button.buy"');
    expect(status.className).toContain('text-red-700');
  });

  it('places the current activity line before the confirmation card without changing callbacks', async () => {
    const user = userEvent.setup();
    (chatStore as any).currentActivity = { id: 'call-1', description: 'Clicking "button.buy"', status: 'running' };
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

    const activityLine = screen.getByText('Clicking "button.buy"');
    const confirmationTitle = screen.getByText(/Please confirm before modifying the page/);
    expect(activityLine.compareDocumentPosition(confirmationTitle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByRole('button', { name: 'Approve this turn' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(true);
  });
});
```

Replace the `it.each([['denied', ...], ['stopped', ...]])` test (lines 692-701, inside `describe('workbench context controls', ...)`) — delete it entirely. It tested `AgentActivityCard`'s persistent "denied"/"stopped" terminal states, which no longer exist: denial now shows a transient failure line (covered by the new store-level auto-clear test in Task 2 Step 1) and `stop()` now clears the line immediately (covered by the new store-level "clears the current activity on stop" test in Task 2 Step 1).

- [ ] **Step 3: Run both test files to verify they fail**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: FAIL — `store.ts` has no `currentActivity` field yet, `CurrentActivityLine` module doesn't exist yet, `AgentActivityCard` import in the test file is now removed but `App.tsx` still renders it (type/module errors).

- [ ] **Step 4: Rewrite `entrypoints/sidepanel/store.ts`**

Import the new module near the top, alongside the existing `confirm-summary` import (find `summarizeToolCallForConfirmation` import and add next to it):

```ts
import { describeToolActivity, type ActivityStatus } from '@/lib/agent/activity-description';
```

Replace the `MAX_TOOL_ACTIVITY_ITEMS` constant (line 53) with:

```ts
const FAILURE_DISPLAY_MS = 2500;
```

Replace the `ToolActivity` interface (lines 74-78):

```ts
export interface ToolActivity {
  id: string;
  description: string;
  status: ActivityStatus;
}
```

Replace the `PendingConfirmation` interface (lines 80-84):

```ts
export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  summary: string;
  codePreview?: string;
}
```

In the `ChatState` interface, replace `toolActivities: ToolActivity[];` (line 94) with `currentActivity: ToolActivity | null;`.

Replace the `ActiveRun` interface (lines 138-143):

```ts
interface ActiveRun {
  id: number;
  origin: ConversationOrigin;
  agent: Agent | null;
  resolveConfirmation: ((approved: boolean) => void) | null;
  pendingToolArgs: Map<string, { toolName: string; args: unknown }>;
  terminatedToolCallIds: Set<string>;
}
```

In `invalidateActiveRun` (lines 204-230), replace the body of the `if (isCurrentOrigin(run.origin, get))` block:

```ts
  if (isCurrentOrigin(run.origin, get)) {
    clearFailureTimer();
    set({ busy: false, pendingConfirmation: null, currentActivity: null });
  }
```

Add the failure-timer helpers right after the `settleRun`/`invalidateActiveRun` functions (after line 230, before `resolveActiveTab`):

```ts
let failureClearTimer: ReturnType<typeof setTimeout> | null = null;

function clearFailureTimer(): void {
  if (failureClearTimer !== null) {
    clearTimeout(failureClearTimer);
    failureClearTimer = null;
  }
}

function setCurrentActivity(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  activity: ToolActivity | null,
): void {
  clearFailureTimer();
  set({ currentActivity: activity });
  if (activity?.status === 'failed') {
    failureClearTimer = setTimeout(() => {
      failureClearTimer = null;
      set({ currentActivity: null });
    }, FAILURE_DISPLAY_MS);
  }
}
```

In the store creator's initial state (around line 265), replace `toolActivities: [],` with `currentActivity: null,`.

In `stop()` (lines 451-465), replace the body:

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

Replace `respondToConfirmation` (lines 467-478):

```ts
  respondToConfirmation: (approved) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(approved);
    run.resolveConfirmation = null;
    const pending = get().pendingConfirmation;
    set({ pendingConfirmation: null });
    if (!approved && pending) {
      run.terminatedToolCallIds.add(pending.toolCallId);
      const info = run.pendingToolArgs.get(pending.toolCallId);
      setCurrentActivity(set, {
        id: pending.toolCallId,
        description: describeToolActivity(pending.toolName, info?.args, 'failed'),
        status: 'failed',
      });
    }
  },
```

In `clear()` (lines 480-491), replace `toolActivities: [],` with `currentActivity: null,` in the `set({...})` object, and add `clearFailureTimer();` as the first line of the function body (before `++conversationOpenRequestId;`).

In `openConversation()` (lines 498-527), replace `toolActivities: [],` with `currentActivity: null,` in the `set({...})` object (around line 520), and add `clearFailureTimer();` right before that `set({...})` call.

In `removeConversation()` (around line 561-567), replace `toolActivities: [],` with `currentActivity: null,`, and add `clearFailureTimer();` right before that `set({...})` call.

In the `ActiveRun` construction inside `runAgent` (lines 599-604):

```ts
  const run: ActiveRun = {
    id: ++runEpoch,
    origin,
    agent: null,
    resolveConfirmation: null,
    pendingToolArgs: new Map(),
    terminatedToolCallIds: new Set(),
  };
```

In the `set({...})` call that starts a new run (around lines 661-668), replace `toolActivities: [],` with `currentActivity: null,`, and add `clearFailureTimer();` as the line immediately before that `set({...})` call.

Replace the `onConfirm` implementation (lines 671-679):

```ts
  const onConfirm = async (toolCallId: string, toolName: string, args: unknown, _reason: string): Promise<boolean> => {
    if (!isCurrentRun(run, get)) return false;
    const { summary, codePreview } = summarizeToolCallForConfirmation(toolName, args);
    run.pendingToolArgs.set(toolCallId, { toolName, args });
    set({ pendingConfirmation: { toolCallId, toolName, summary, codePreview } });
    return new Promise<boolean>((resolve) => {
      run.resolveConfirmation = resolve;
    });
  };
```

Replace the three `tool_execution_*` handlers inside `agent.subscribe(...)` (lines 710-750):

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

Delete the now-unused `upsertToolActivity` function (lines 899-916).

- [ ] **Step 5: Create `entrypoints/sidepanel/components/CurrentActivityLine.tsx`**

```tsx
import type { ToolActivity } from '../store';

export function CurrentActivityLine({ activity }: { activity: ToolActivity }) {
  const isFailed = activity.status === 'failed';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 px-1 text-xs ${
        isFailed ? 'text-red-700 dark:text-red-300' : 'text-neutral-500 dark:text-neutral-400'
      }`}
    >
      {!isFailed && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{activity.description}</span>
    </div>
  );
}
```

- [ ] **Step 6: Delete `entrypoints/sidepanel/components/AgentActivityCard.tsx`**

```bash
rm entrypoints/sidepanel/components/AgentActivityCard.tsx
```

- [ ] **Step 7: Update `entrypoints/sidepanel/App.tsx`**

Replace the import (line 21): `import { AgentActivityCard } from './components/AgentActivityCard';` → `import { CurrentActivityLine } from './components/CurrentActivityLine';`

In the `useChat()` destructure (line 34), replace `toolActivities,` with `currentActivity,`.

In the scroll-follow `useEffect` dependency array (line 149), replace `[messages, toolActivities]` with `[messages, currentActivity]`.

Replace the render line (line 262): `{toolActivities.length > 0 && <AgentActivityCard activities={toolActivities} />}` → `{currentActivity && <CurrentActivityLine activity={currentActivity} />}`

- [ ] **Step 8: Run both test files to verify they pass**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the full test suite and type check**

Run: `pnpm test && pnpm compile`
Expected: PASS. (`lib/workbench/presentation.test.ts` will still reference the now-dead `summarizeToolActivities` export at this point — that's expected and cleaned up in Task 3; it still compiles and passes because Task 2 didn't touch `presentation.ts`.)

- [ ] **Step 10: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/App.tsx entrypoints/sidepanel/store-context.test.tsx \
  entrypoints/sidepanel/components/CurrentActivityLine.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git rm entrypoints/sidepanel/components/AgentActivityCard.tsx
git commit -m "feat(sidepanel): replace tool activity list with single-line indicator"
```

---

## Task 3: Remove dead code and obsolete i18n keys, final verification

**Files:**
- Modify: `lib/workbench/presentation.ts:16-31,79-104`
- Modify: `lib/workbench/presentation.test.ts:1-11,76-124`
- Modify: `lib/i18n/locales/zh.ts` (delete obsolete `agentActivity.*`/`status.*` keys)
- Modify: `lib/i18n/locales/en.ts` (delete the same keys)
- Modify: `lib/i18n/i18n.test.ts:15-27`

**Interfaces:**
- Consumes: nothing new — this task only removes code no longer referenced after Task 2.

- [ ] **Step 1: Remove the dead `summarizeToolActivities` tests from `lib/workbench/presentation.test.ts`**

Delete the entire `describe('summarizeToolActivities', ...)` block (lines 76-124, ending right before the closing of the file — check the line after 124 to confirm where the block actually ends and stop there without deleting unrelated code).

Update the import block (lines 4-11) to drop the now-unused symbols:

```ts
import {
  filterShortcutCommands,
  groupConversationsByDay,
  normalizeShortcutCommand,
  resolvePageAttached,
  type ResolvedShortcutCommand,
} from './presentation';
```

- [ ] **Step 2: Remove the dead exports from `lib/workbench/presentation.ts`**

Delete the `ToolActivityStatus` type, `ToolActivityLike` interface, and `ToolActivitySummary` interface (lines 16-31).

Delete the `TOOL_STATUS_PRECEDENCE` constant and `summarizeToolActivities` function (lines 79-104).

- [ ] **Step 3: Run the presentation test file to verify it still passes**

Run: `pnpm vitest run lib/workbench/presentation.test.ts`
Expected: PASS.

- [ ] **Step 4: Remove `agentActivity.cardLabel`/`agentActivity.liveStatus` from the required-key list in `lib/i18n/i18n.test.ts`**

In `contextWorkbenchKeys` (lines 15-27), delete the two lines:

```ts
  'agentActivity.cardLabel',
  'agentActivity.liveStatus',
```

- [ ] **Step 5: Delete the obsolete keys from `lib/i18n/locales/zh.ts`**

Delete these lines (originally 120-137, 142-143, 146, 148-152, 154-155, 157-163 — re-locate by content since Task 1 inserted new lines above/around this region, shifting numbers):

```
'agentActivity.showDetails': '显示任务详情',
'agentActivity.hideDetails': '隐藏任务详情',
'agentActivity.cardLabel': 'Agent 活动',
'agentActivity.liveStatus': 'Agent 状态：{status}',
'agentActivity.status.running': '正在执行浏览器任务',
'agentActivity.status.confirming': '等待批准',
'agentActivity.status.denied': '操作已拒绝',
'agentActivity.status.stopped': '任务已停止',
'agentActivity.status.blocked': '已拦截',
'agentActivity.status.error': '任务失败',
'agentActivity.status.done': '任务完成',
'agentActivity.detail.running': '正在执行',
'agentActivity.detail.confirming': '需要批准',
'agentActivity.detail.denied': '你拒绝了这项操作',
'agentActivity.detail.stopped': '已停止',
'agentActivity.detail.blocked': '操作已拦截',
'agentActivity.detail.error': '执行失败',
'agentActivity.detail.done': '已完成',
'agentActivity.tool.queryDom': '查询 DOM',
'agentActivity.tool.getHtml': '获取 HTML',
'agentActivity.tool.getComputedStyle': '获取计算样式',
'agentActivity.tool.setStyle': '设置样式',
'agentActivity.tool.modifyDom': '修改 DOM',
'agentActivity.tool.click': '点击',
'agentActivity.tool.type': '输入',
'agentActivity.tool.select': '选择',
'agentActivity.tool.navigate': '导航',
'agentActivity.tool.setStorage': '设置存储',
'status.running': '运行中',
'status.confirming': '待确认',
'status.denied': '已拒绝',
'status.stopped': '已停止',
'status.blocked': '已拦截',
'status.error': '失败',
'status.done': '完成',
```

Keep `agentActivity.tool.getActiveTab`, `agentActivity.tool.readPage`, `agentActivity.tool.getPageMeta`, `agentActivity.tool.inspectPageImplementation`, `agentActivity.tool.getScripts`, `agentActivity.tool.getStylesheets`, `agentActivity.tool.screenshot`, `agentActivity.tool.scroll`, `agentActivity.tool.unknown` — these are still used by `describeToolActivity`'s `plain()` fallback (Task 1).

- [ ] **Step 6: Delete the mirrored obsolete keys from `lib/i18n/locales/en.ts`**

Delete the English counterparts of every key removed in Step 5 (same keys, English values — `'Show task details'`, `'Hide task details'`, `'Agent activity'`, `'Agent status: {status}'`, all `agentActivity.status.*`, all `agentActivity.detail.*`, `agentActivity.tool.{queryDom,getHtml,getComputedStyle,setStyle,modifyDom,click,type,select,navigate,setStorage}`, and all top-level `status.*`), keeping the same 9 `agentActivity.tool.*` keys as Step 5.

- [ ] **Step 7: Run the i18n test to verify key parity and required-key coverage still hold**

Run: `pnpm vitest run lib/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full verification suite**

Run: `pnpm compile && pnpm test && pnpm build`
Expected: All three pass.

- [ ] **Step 9: Manually verify in the dev build**

Run: `pnpm dev`, load the unpacked extension from `.output/chrome-mv3` via `chrome://extensions`, and confirm:
- A multi-step browser task (e.g. "click the search box, then type 'hello'") shows one line of text that updates per step, with no residual list/count UI.
- A write action that gets denied shows a brief failure line that disappears after ~2.5s.
- A non-http(s) `browser_navigate` (blocked by policy) shows a brief failure line that disappears.
- After the turn completes, no activity line remains.

- [ ] **Step 10: Commit**

```bash
git add lib/workbench/presentation.ts lib/workbench/presentation.test.ts lib/i18n/i18n.test.ts \
  lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "chore: remove dead tool-activity-list code and i18n keys"
```

---

## Self-Review Notes

- **Spec coverage:** dynamic parameter-rich descriptions (Task 1), single-line replacing card+count (Task 2), failure auto-clear (Task 2 store + tests), turn-end no residue (Task 2, existing reset sites route through `currentActivity: null` / `setCurrentActivity(set, null)`), dead-code removal (Task 3) — all five spec goals map to a task.
- **Type consistency:** `ActivityStatus` is defined once in `lib/agent/activity-description.ts` and imported into `store.ts` for `ToolActivity['status']` — no duplicate/divergent union. `PendingConfirmation.toolCallId` is threaded from `onConfirm` through `respondToConfirmation` and the new test's `pendingConfirmation` mock consistently.
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact `pnpm` command.
