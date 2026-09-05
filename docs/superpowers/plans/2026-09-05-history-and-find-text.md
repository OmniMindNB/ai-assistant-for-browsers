# browser_go_back 与 browser_find_text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new browser agent tools — `browser_go_back` (history back navigation) and `browser_find_text` (locate elements by visible text, issuing `browser_click`-compatible fieldId handles) — following the existing message-protocol / pure-logic / injected-DOM-function architecture.

**Architecture:** `browser_go_back` triggers `browser.tabs.goBack` and waits for the tab to settle via a dependency-injected orchestrator (`lib/agent/history-nav.ts`) that is unit-testable without a real browser. `browser_find_text` broadcasts a self-contained injected function to every frame via the existing `executeInAllFrames` infrastructure (reusing the iframe-addressing work), keeps only the deepest-matching elements per frame, and merges the kept hits into the *same* `FormFieldTable` that `browser_get_form` uses — issuing `t*`-prefixed handles that coexist with `f*`/`s*` handles and are usable by the existing `browser_click`/`clickElementByFieldId` machinery with zero changes to that code path.

**Tech Stack:** TypeScript, WXT (Manifest V3), `browser.scripting.executeScript`, `browser.tabs`, Vitest (`unit`/`dom` projects).

**Spec:** `docs/superpowers/specs/2026-09-04-history-and-find-text-design.md` — the plan argues from this spec; read both together. Also relevant as prior art: `docs/superpowers/specs/2026-09-04-iframe-addressing-design.md` (implemented; `executeInAllFrames`, `mergeReadResultsByFrame`, `FormFieldHandle.frameId`/`frameOrigin` all already exist and are reused here unchanged).

## Global Constraints

- No new manifest permissions — `tabs` and `scripting` are already granted (`wxt.config.ts:37`). Verified: `browser.tabs.goBack(tabId?: number): Promise<void>` exists in the installed `@types/webextension-polyfill` (`namespaces/tabs.d.ts:1404`).
- `browser_go_forward` is explicitly out of scope (spec §3.1). No `steps`/direction parameter on `browser_go_back` — spec §3.2 only ever calls `browser.tabs.goBack(tabId)`, no argument.
- `browser_find_text` supports only `mode: 'contains' | 'exact'`, case-insensitive, whitespace-normalized. No regex, no XPath (spec §2, §4.2).
- Any function passed as the `func` argument to `browser.scripting.executeScript` (i.e. injected into the page) **must not reference any module-scope binding** — not constants, not other functions in the same file, not imported *values* (only `import type` is safe, it's erased at compile time). This is why `find-text-dom.ts`'s injected function inlines its own copies of normalization/matching/path-building logic instead of calling `find-text.ts`. This is an existing, established constraint — see the warning comments at the top of `lib/agent/form-dom.ts` and `lib/agent/wait-dom.ts`.
- `browser_click`(fieldId) resolves handles via `planFieldClick` (`lib/agent/fill-form-request.ts:226`), which only rejects `handle.kind === 'scrollable'` — any other `kind` value is accepted and routes to `applyFormFill`'s submit branch, which reads only `path`/`expect`, never `kind`. This means `browser_find_text` handles work with `browser_click` today with **no changes** to `fill-form-request.ts` or `form-dom.ts`. `browser_scroll`(fieldId) requires `handle.kind === 'scrollable'` (a different code path, `scrollContainerInPage`, which scrolls a container's *own* overflow, not "scroll into view") — `browser_find_text` handles will correctly report `wrong_kind` there, which is expected: clicking a handle already scrolls it into view as a side effect (`form-dom.ts`'s `spotlight()`/submit-branch `scrollIntoView` calls), and `browser_find_text`'s own `context` field already covers the "just want to read it" case per spec §4.3. This plan does not touch `browser_scroll`'s gating.
- `FormFieldHandle.expect` for a `find_text`-issued handle must include `type`/`name`/`href` (not just `tag`) — `applyFormFill`'s `matchesExpect` (`form-dom.ts`) compares all four; leaving `type`/`name` as `undefined` while the real element *has* an explicit `type`/`name` attribute would make every click on that handle fail with `mismatch`.
- `FormFieldHandle.frameOrigin` is **always** stored (even for main-frame handles, `frameId === 0`) — gating on whether to forward it at write time happens later, in `resolveExpectOrigin`/`isChildFrameHandle` (`fill-form-request.ts`). Do not conditionally omit it when building the handle table (that bug class is called out in `fill-form-request.ts`'s own comments, "2026-09-05 final review Important #1"). The **model-facing** `FindTextMatch.frameOrigin`, by contrast, *is* `undefined` for main-frame matches — same convention as `FormFieldDescriptor.frameOrigin`.
- `browser_get_form` keeps its existing full-table-overwrite semantics unchanged (spec §4.4) — a fresh `browser_get_form` call drops any previously-issued `t*` handles along with everything else. `browser_find_text` itself only replaces its own `t*` entries, keeping existing `f*`/`s*` entries, **unless** the page has navigated (existing table's `url` differs from the current page), in which case it discards everything and starts fresh (those old entries would fail with `fieldsTableStale` on write anyway; keeping them serves no purpose).
- Page-controlled text (titles, matched text, surrounding context) is untrusted: title text goes through `sanitizePageText`, matched/context text goes through `sanitizeFieldText` (both from `lib/agent/form-schema.ts`), and the tool's final JSON output goes through the redaction pipeline (`lib/redaction.ts`) before reaching the model — same as every other page-reading tool.
- Test file naming follows the established `<module-file-name>.dom.test.ts` convention (`form-dom.ts` → `form-dom.dom.test.ts`, `wait-dom.ts` → `wait-dom.dom.test.ts`) — so the injected-function test file is `find-text-dom.dom.test.ts`, not the spec's literal `find-text.dom.test.ts`.
- `describeGoBackResult` lives in `lib/agent/action-result-text.ts` and is tested in `lib/agent/action-result-text.test.ts`, matching where every other `describe*Result` function (`describeNavigateResult`, `describeScrollResult`, etc.) already lives and is tested — this is a deliberate, documented deviation from the spec's test-table row that names `history-nav.test.ts` for the "非 http(s) 落地" text-copy test; `history-nav.test.ts` covers only `performGoBack`'s `{url, title, moved}` decision logic, not prose rendering.

---

## Task 1: `history-nav.ts` — browser_go_back's wait/decide orchestration

**Files:**
- Create: `lib/agent/history-nav.ts`
- Test: `lib/agent/history-nav.test.ts`

**Interfaces:**
- Consumes: `sanitizePageText` from `lib/agent/form-schema.ts` (already exists: `export function sanitizePageText(text: string, maxChars: number): string`).
- Produces: `export const NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS = 10_000`, `export interface GoBackDeps { goBack(): Promise<void>; getTab(): Promise<{url?: string; title?: string} | undefined>; onceLoadComplete(): Promise<void>; }`, `export async function performGoBack(deps: GoBackDeps): Promise<NavigateHistoryResult>` (return type from `@/lib/messaging`, added in Task 3), `export async function waitForTabLoadComplete(tabId: number, timeoutMs: number): Promise<void>`.

`browser.tabs.onUpdated` is a tab-level browser event — it cannot be injected into a page like `wait-dom.ts` does, so this task uses dependency injection instead of the pure-function/injected-function split used elsewhere: `performGoBack` takes its browser interactions as an injected `GoBackDeps` object, making its "did it move, what do we report" decision logic fully unit-testable with plain mock functions (no `fakeBrowser`, no fake timers).

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/history-nav.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { performGoBack, type GoBackDeps } from './history-nav';

function deps(overrides: Partial<GoBackDeps> = {}): GoBackDeps {
  return {
    goBack: vi.fn().mockResolvedValue(undefined),
    getTab: vi.fn().mockResolvedValue({ url: 'https://a.test/list', title: '列表页' }),
    onceLoadComplete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('performGoBack', () => {
  it('reports the new URL once the page settles', async () => {
    let call = 0;
    const getTab = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { url: 'https://a.test/detail/1', title: '详情页' }
        : { url: 'https://a.test/list', title: '列表页' };
    });
    const result = await performGoBack(deps({ getTab }));
    expect(result).toEqual({ url: 'https://a.test/list', title: '列表页', moved: true });
  });

  it('reports moved:false without guessing when goBack rejects (no history to go back to)', async () => {
    const getTab = vi.fn().mockResolvedValue({ url: 'https://a.test/only-page', title: '唯一页面' });
    const goBack = vi.fn().mockRejectedValue(new Error('Cannot go back'));
    const onceLoadComplete = vi.fn();
    const result = await performGoBack(deps({ getTab, goBack, onceLoadComplete }));
    expect(result).toEqual({ url: 'https://a.test/only-page', title: '唯一页面', moved: false });
    // goBack 都没成功触发导航，就不该去等一次不存在的加载。
    expect(onceLoadComplete).not.toHaveBeenCalled();
  });

  it('reports moved:false when goBack resolves but the URL never changes (e.g. it timed out)', async () => {
    const getTab = vi.fn().mockResolvedValue({ url: 'https://a.test/stuck', title: '卡住的页面' });
    const result = await performGoBack(deps({ getTab }));
    expect(result).toEqual({ url: 'https://a.test/stuck', title: '卡住的页面', moved: false });
  });

  it('sanitizes a page-controlled title', async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ url: 'https://a.test/1' })
      .mockResolvedValueOnce({ url: 'https://a.test/2', title: `x${'y'.repeat(200)}` });
    const result = await performGoBack(deps({ getTab }));
    expect(result.title!.length).toBeLessThan(130);
    expect(result.title!.endsWith('…')).toBe(true);
  });

  it('falls back to the before-state URL when the tab is gone after going back', async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ url: 'https://a.test/1', title: 'A' })
      .mockResolvedValueOnce(undefined);
    const result = await performGoBack(deps({ getTab }));
    expect(result).toEqual({ url: 'https://a.test/1', title: undefined, moved: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/history-nav.test.ts`
Expected: FAIL — `Cannot find module './history-nav'` (file doesn't exist yet).

- [ ] **Step 3: Add `NavigateHistoryResult` to `lib/messaging.ts`**

In `lib/messaging.ts`, add after `NavigateTabResult` (after line 388):

```ts
export interface NavigateHistoryResult {
  /** 落地后的地址；已在历史起点、或后退未在预期时间内生效时等于后退前的地址。 */
  url: string;
  /** 落地页标题，页面可控，已净化截断。 */
  title?: string;
  /** 后退是否真的发生了（URL 有变化）。false 时模型不该假设页面已经变化。 */
  moved: boolean;
}
```

(This type is not yet wired into `MessageType`/the message switch — that happens in Task 3. Adding it here now lets `history-nav.ts` import it in this task.)

- [ ] **Step 4: Write `lib/agent/history-nav.ts`**

```ts
// browser_go_back 的等待编排：entrypoints/background.ts 只做原始 I/O 调用
// （browser.tabs.goBack / browser.tabs.get），"怎么判断退没退、退到哪、标题怎么净化"
// 这套决策逻辑放在这里。
//
// browser.tabs.onUpdated 是 tab 级事件，不能像 wait-dom.ts 那样注入进页面执行，因此这里
// 不用 wait-condition.ts/wait-dom.ts 的"纯函数 + 注入函数"二分，改用依赖注入：
// performGoBack 把浏览器交互作为 GoBackDeps 传入，让"是否移动、报什么"这套判断能用
// 普通 mock 函数测试，不需要 fakeBrowser 或假定时器。
import { sanitizePageText } from './form-schema';
import type { NavigateHistoryResult } from '@/lib/messaging';

/**
 * 等待跳转落地的上限。与 entrypoints/background.ts 的 navigateTab 用的
 * NAVIGATE_SETTLE_TIMEOUT_MS 同值——两处独立定义（history-nav.ts 不从 entrypoints
 * 反向 import），改一处要同步另一处。
 */
export const NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS = 10_000;
const MAX_PAGE_TITLE_CHARS = 120;

export interface GoBackDeps {
  /** 触发后退。无历史可退时部分实现会 reject——见下方 performGoBack 的处理方式。 */
  goBack: () => Promise<void>;
  /** 读取标签页当前状态；标签页已关闭等情况下解析为 undefined，不抛异常。 */
  getTab: () => Promise<{ url?: string; title?: string } | undefined>;
  /** 等到页面加载完成或超时；超时不是错误，恒 resolve，不抛异常。 */
  onceLoadComplete: () => Promise<void>;
}

/**
 * 后退的决策逻辑：触发 → （若触发成功）等待落定 → 比较前后 URL 判定是否真的移动了。
 *
 * webextension-polyfill 对 tabs.goBack 的类型声明只说"if available"，没有明确它在无历史
 * 可退时是 reject 还是静默 resolve 且不做任何事——这里两条路径都处理，且都不解析具体的
 * 错误文案（ref: 设计文档 §3.4："不要按猜测的字符串匹配"）：reject 时直接跳过等待（导航
 * 都没触发，没什么好等的）；resolve 时正常等待落定。两条路径最终都只看"前后 URL 是否
 * 不同"来决定 moved，因此哪种实现都能得出正确结论。
 */
export async function performGoBack(deps: GoBackDeps): Promise<NavigateHistoryResult> {
  const before = await deps.getTab();

  try {
    await deps.goBack();
    await deps.onceLoadComplete();
  } catch {
    // 见上方函数注释：无历史可退时的拒绝，统一收敛成"没有移动"，不解析错误文案。
  }

  const after = await deps.getTab();
  const moved = after?.url !== undefined && after.url !== before?.url;
  const url = after?.url ?? before?.url ?? '';
  const title = after?.title ? sanitizePageText(after.title, MAX_PAGE_TITLE_CHARS) : undefined;

  return { url, title, moved };
}

/**
 * onceLoadComplete 的生产实现：等 tabs.onUpdated 报告这个 tab 变成 complete，或超时静默返回。
 * 与 entrypoints/background.ts 的 navigateTab 用的 waitForTabLoad 是同一个模式，独立定义在
 * 这里（不从 entrypoints 反向 import）。
 */
export async function waitForTabLoadComplete(tabId: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/history-nav.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Type-check**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/history-nav.ts lib/agent/history-nav.test.ts lib/messaging.ts
git commit -m "$(cat <<'EOF'
feat: add history-nav.ts orchestrating browser_go_back's wait/decide logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```

---

## Task 2: `describeGoBackResult` in `action-result-text.ts`

**Files:**
- Modify: `lib/agent/action-result-text.ts`
- Modify: `lib/agent/action-result-text.test.ts`

**Interfaces:**
- Consumes: `NavigateHistoryResult` from `@/lib/messaging` (added in Task 1).
- Produces: `export function describeGoBackResult(result: NavigateHistoryResult): string`.

- [ ] **Step 1: Write the failing tests**

In `lib/agent/action-result-text.test.ts`, add to the import list at the top:

```ts
import type { ClickElementResult, FormFieldDescriptor, NavigateHistoryResult, NavigateTabResult, ScrollPageResult } from '@/lib/messaging';
import { describeClickResult, describeGoBackResult, describeNavigateResult, describeNewFields, describeScrollResult } from './action-result-text';
```

Then append at the end of the file (after the `describeNewFields` `describe` block):

```ts
describe('describeGoBackResult', () => {
  it('reports the page it landed on', () => {
    expect(describeGoBackResult({ url: 'https://a.com/list', title: '列表页', moved: true })).toBe(
      '已后退到 "https://a.com/list"，页面标题 "列表页"。',
    );
  });

  it('warns when nothing moved (no earlier history, or it never settled)', () => {
    expect(describeGoBackResult({ url: 'https://a.com/only', moved: false })).toBe(
      '⚠️ 未能后退：当前标签页没有更早的历史记录，或后退操作未在预期时间内生效。',
    );
  });

  it('warns when it landed on a page the extension cannot operate on', () => {
    expect(describeGoBackResult({ url: 'chrome://extensions/', moved: true })).toBe(
      '已后退到 "chrome://extensions/"。⚠️ 已退回到扩展无法操作的页面，后续的读取或写入工具会持续失败，请改用其它方式继续任务。',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/action-result-text.test.ts`
Expected: FAIL — `describeGoBackResult` is not exported from `./action-result-text`.

- [ ] **Step 3: Implement `describeGoBackResult`**

In `lib/agent/action-result-text.ts`, add `NavigateHistoryResult` to the type import at the top:

```ts
import type { ClickElementResult, FormFieldDescriptor, NavigateHistoryResult, NavigateTabResult, PressKeyResult, ScrollPageResult } from '@/lib/messaging';
```

Then append this function after `describeNavigateResult`:

```ts
export function describeGoBackResult(result: NavigateHistoryResult): string {
  if (!result.moved) {
    return '⚠️ 未能后退：当前标签页没有更早的历史记录，或后退操作未在预期时间内生效。';
  }

  const title = result.title ? `，页面标题 "${result.title}"` : '';
  let isHttpUrl = false;
  try {
    isHttpUrl = /^https?:$/.test(new URL(result.url).protocol);
  } catch {
    isHttpUrl = false;
  }
  if (!isHttpUrl) {
    return `已后退到 "${result.url}"${title}。⚠️ 已退回到扩展无法操作的页面，后续的读取或写入工具会持续失败，请改用其它方式继续任务。`;
  }
  return `已后退到 "${result.url}"${title}。`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/action-result-text.test.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/action-result-text.ts lib/agent/action-result-text.test.ts
git commit -m "$(cat <<'EOF'
feat: add describeGoBackResult for browser_go_back's model-facing result text

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```

---

## Task 3: Wire `browser_go_back` end-to-end

**Files:**
- Modify: `lib/messaging.ts` (add `MessageType` entry)
- Modify: `entrypoints/background.ts` (message type list, switch case, handler)
- Modify: `lib/agent/permissions.ts` (`AUTO_APPROVE_TOOL_NAMES`)
- Modify: `lib/agent/tools.ts` (register the tool)
- Modify: `lib/agent/system-prompt.ts` (tool-strategy guidance)

**Interfaces:**
- Consumes: `performGoBack`, `waitForTabLoadComplete`, `NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS` from `lib/agent/history-nav.ts` (Task 1); `describeGoBackResult` from `lib/agent/action-result-text.ts` (Task 2); `NavigateHistoryResult` from `lib/messaging.ts` (Task 1); `resolveTargetTab` from `lib/agent/tab-target.ts` (existing).
- Produces: a working `browser_go_back` tool, no consumers outside this task.

This task has no dedicated unit test of its own — `entrypoints/background.ts` matches no vitest project (see `CLAUDE.md`'s note on `vitest.config.ts`), and `tools.ts`'s tool wiring is a thin wrapper already covered indirectly by the `history-nav.test.ts`/`action-result-text.test.ts` tests on the logic it delegates to. Verification is `pnpm compile` plus the full `pnpm test` regression, per Global Constraints.

- [ ] **Step 1: Add `'NAVIGATE_HISTORY'` to `MessageType`**

In `lib/messaging.ts`, add to the `MessageType` union (after `'NAVIGATE_TAB'`, line 31):

```ts
  | 'NAVIGATE_TAB'
  | 'NAVIGATE_HISTORY'
  | 'OPEN_NEW_TAB'
```

- [ ] **Step 2: Register the message type and handler in `entrypoints/background.ts`**

Add to the `SUPPORTED_MESSAGE_TYPES` array (after `'NAVIGATE_TAB'`, around line 165):

```ts
  'NAVIGATE_TAB',
  'NAVIGATE_HISTORY',
  'OPEN_NEW_TAB',
```

Add the import (in the big `@/lib/messaging` type-import block, after `type NavigateTabResult,`):

```ts
  type NavigateHistoryResult,
```

Add a new import line (near the other `@/lib/agent/*` imports, e.g. right after the `tab-target` import):

```ts
import { performGoBack, waitForTabLoadComplete, NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS } from '@/lib/agent/history-nav';
```

Add the switch case in `handleMessage` (after the `NAVIGATE_TAB` case, around line 507):

```ts
    case 'NAVIGATE_TAB':
      return navigateTab(message.payload as NavigateTabPayload, requireTabId(message));

    case 'NAVIGATE_HISTORY':
      return navigateHistory(requireTabId(message));

    case 'OPEN_NEW_TAB':
```

Add the handler function right after `navigateTab` (after line 1584, before `async function openNewTab`):

```ts
async function navigateHistory(tabId: number): Promise<NavigateHistoryResult> {
  const tab = await resolveTargetTab(tabId);
  return performGoBack({
    goBack: () => browser.tabs.goBack(tab.id),
    getTab: () => browser.tabs.get(tab.id).catch(() => undefined),
    onceLoadComplete: () => waitForTabLoadComplete(tab.id, NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS),
  });
}
```

- [ ] **Step 3: Add `browser_go_back` to `AUTO_APPROVE_TOOL_NAMES`**

In `lib/agent/permissions.ts`, add `'browser_go_back'` to the `AUTO_APPROVE_TOOL_NAMES` set (it changes browser state, so it is a write tool per spec §3.3):

```ts
export const AUTO_APPROVE_TOOL_NAMES = new Set([
  'browser_set_style',
  'browser_modify_dom',
  'browser_click',
  'browser_fill_form',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_select',
  'browser_open_tab',
  'browser_navigate',
  'browser_go_back',
  'browser_set_storage',
  'browser_close_tab',
]);
```

- [ ] **Step 4: Register the tool in `lib/agent/tools.ts`**

Add `NavigateHistoryResult` to the `@/lib/messaging` type import list, and add `describeGoBackResult` to the `./action-result-text` import:

```ts
import { describeClickResult, describeGoBackResult, describeNavigateResult, describeNewFields, describePressKeyResult, describeScrollResult } from './action-result-text';
```

```ts
  type NavigateHistoryResult,
```

(both alongside their existing `NavigateTab*` neighbors in the respective import lists).

Add the tool factory function right after `makeNavigateTool` (after line 913):

```ts
function makeGoBackTool(session: TabSessionController): BrowserAgentTool {
  return {
    name: 'browser_go_back',
    label: 'Go Back',
    description:
      "Navigate the active tab back to the previous page in its history, like pressing the browser's Back button. Prefer this over browser_navigate to return to a list or search page you came from — it preserves scroll position, expanded filters, and in-progress form state that a fresh navigate would lose, and you usually do not know or remember that page's exact URL anyway. Reports moved:false (via the result text) when there is no earlier page in this tab's history — that is a normal outcome, not an error.",
    parameters: Type.Object({}),
    execute: async () => {
      const response = (await sendMessage<undefined, NavigateHistoryResult>(
        'NAVIGATE_HISTORY',
        undefined,
        session.currentTabId,
      )) as MessageResponse<NavigateHistoryResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '后退失败');
      // 跳转没有切换"当前操作 tab"，但标题/URL 变了——复用 openAndSwitch 只是为了刷新
      // tracked 列表里这条记录，与 makeNavigateTool 是同一个既有惯例。
      session.openAndSwitch({ id: session.currentTabId, title: response.data.title, url: response.data.url });
      return textResult(describeGoBackResult(response.data), response.data as unknown as Record<string, unknown>);
    },
  };
}
```

Register it in the tools array, right after `makeNavigateTool(session),` (around line 105):

```ts
    makeNavigateTool(session),
    makeGoBackTool(session),
```

- [ ] **Step 5: Add tool-strategy guidance in `lib/agent/system-prompt.ts`**

In `buildToolStrategy`'s `lines` array, add a bullet after the form-fields line (after the `browser_get_form`/`browser_fill_form` bullet, before the `browser_query_dom` bullet):

```ts
    '- 需要回到刚才来的那个页面（例如看完一条详情想回列表页继续看下一条）：用 browser_go_back，而不是凭记忆拼一个 URL 用 browser_navigate 跳回去——后者会丢失滚动位置、已展开的筛选和未提交的表单状态，而且你往往根本不知道那个页面的准确地址。',
```

- [ ] **Step 6: Type-check**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 7: Run full test suite (regression)**

Run: `pnpm test`
Expected: all existing tests still pass; no new failures.

- [ ] **Step 8: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/permissions.ts lib/agent/tools.ts lib/agent/system-prompt.ts
git commit -m "$(cat <<'EOF'
feat: wire browser_go_back tool end-to-end

Adds NAVIGATE_HISTORY message type, background handler, auto-approve
permission, tool registration, and system-prompt guidance for the new
history-back tool.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```

---

## Task 4: `find-text.ts` — pure matching, normalization, and handle-table merge

**Files:**
- Create: `lib/agent/find-text.ts`
- Test: `lib/agent/find-text.test.ts`

**Interfaces:**
- Consumes: `FormFieldPathStep` (type-only) from `lib/agent/form-schema.ts`; `FormFieldHandle`, `FormFieldTable` (type-only) from `lib/agent/tab-form-fields.ts`.
- Produces:
  - `export type FindTextMode = 'contains' | 'exact'`
  - `export const DEFAULT_FIND_TEXT_LIMIT = 10`
  - `export const MAX_FIND_TEXT_LIMIT = 20`
  - `export interface FindTextParams { text: string; mode: FindTextMode; limit: number }`
  - `export function parseFindTextParams(params: unknown): { ok: true; params: FindTextParams } | { ok: false; error: string }`
  - `export function normalizeFindText(text: string): string`
  - `export function matchesFindText(candidateNormalized: string, queryNormalized: string, mode: FindTextMode): boolean`
  - `export interface FindTextHandleInput { path: FormFieldPathStep[]; tag: string; type?: string; name?: string; href?: string; frameId: number; frameOrigin: string }`
  - `export function mergeFindTextHandles(existing: FormFieldTable | undefined, currentUrl: string, hits: FindTextHandleInput[]): FormFieldTable`

Consumed by: `lib/agent/tools.ts` (Task 6, for `parseFindTextParams`/limit constants) and `entrypoints/background.ts` (Task 6, for `mergeFindTextHandles`). `find-text-dom.ts` (Task 5) does **not** import the runtime values from this file — see Global Constraints on the `executeScript` serialization boundary — it duplicates the normalize/match logic inline.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/find-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIND_TEXT_LIMIT,
  MAX_FIND_TEXT_LIMIT,
  matchesFindText,
  mergeFindTextHandles,
  normalizeFindText,
  parseFindTextParams,
} from './find-text';
import type { FormFieldTable } from './tab-form-fields';

describe('parseFindTextParams', () => {
  it('rejects missing or blank text', () => {
    expect(parseFindTextParams({}).ok).toBe(false);
    expect(parseFindTextParams({ text: '   ' }).ok).toBe(false);
  });

  it('defaults mode to contains and limit to the default', () => {
    const parsed = parseFindTextParams({ text: '总计' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params).toEqual({ text: '总计', mode: 'contains', limit: DEFAULT_FIND_TEXT_LIMIT });
  });

  it('accepts mode: exact', () => {
    const parsed = parseFindTextParams({ text: '已发货', mode: 'exact' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.mode).toBe('exact');
  });

  it('treats an unknown mode string as contains', () => {
    const parsed = parseFindTextParams({ text: 'x', mode: 'regex' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.mode).toBe('contains');
  });

  it('clamps limit to [1, MAX_FIND_TEXT_LIMIT]', () => {
    expect((parseFindTextParams({ text: 'x', limit: 0 }) as any).params.limit).toBe(1);
    expect((parseFindTextParams({ text: 'x', limit: 999 }) as any).params.limit).toBe(MAX_FIND_TEXT_LIMIT);
    expect((parseFindTextParams({ text: 'x', limit: 'many' }) as any).params.limit).toBe(DEFAULT_FIND_TEXT_LIMIT);
  });

  it('trims surrounding whitespace from text', () => {
    const parsed = parseFindTextParams({ text: '  总计  ' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.text).toBe('总计');
  });
});

describe('normalizeFindText', () => {
  it('collapses runs of whitespace to a single space and trims', () => {
    expect(normalizeFindText('  总计  \n ¥1,280.00  ')).toBe('总计 ¥1,280.00');
  });
});

describe('matchesFindText', () => {
  it('contains mode is case-insensitive substring match', () => {
    expect(matchesFindText('总计 ¥1,280.00', '总计', 'contains')).toBe(true);
    expect(matchesFindText('Shipped', 'shipped', 'contains')).toBe(true);
    expect(matchesFindText('总计 ¥1,280.00', '优惠', 'contains')).toBe(false);
  });

  it('exact mode requires the whole normalized text to match', () => {
    expect(matchesFindText('已发货', '已发货', 'exact')).toBe(true);
    expect(matchesFindText('已发货了', '已发货', 'exact')).toBe(false);
  });

  it('never matches an empty candidate or empty query', () => {
    expect(matchesFindText('', '总计', 'contains')).toBe(false);
    expect(matchesFindText('总计', '', 'contains')).toBe(false);
  });
});

function table(overrides: Partial<FormFieldTable> = {}): FormFieldTable {
  return {
    url: 'https://a.test/orders',
    fields: {
      f1: {
        path: [{ kind: 'selector', selector: 'input', index: 0 }],
        expect: { tag: 'input', type: 'email', name: 'email' },
        sensitive: false,
        kind: 'text',
      },
      s1: {
        path: [{ kind: 'selector', selector: 'div', index: 2 }],
        expect: { tag: 'div' },
        sensitive: false,
        kind: 'scrollable',
      },
    },
    ...overrides,
  };
}

function hit(overrides: Partial<Parameters<typeof mergeFindTextHandles>[2][number]> = {}) {
  return {
    path: [{ kind: 'selector' as const, selector: 'span', index: 0 }],
    tag: 'span',
    frameId: 0,
    frameOrigin: 'https://a.test',
    ...overrides,
  };
}

describe('mergeFindTextHandles', () => {
  it('assigns sequential t* fieldIds starting at t1', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit(), hit(), hit()]);
    expect(Object.keys(merged.fields).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('keeps existing f*/s* entries from browser_get_form when the page is unchanged', () => {
    const merged = mergeFindTextHandles(table(), 'https://a.test/orders', [hit()]);
    expect(merged.fields.f1).toBeDefined();
    expect(merged.fields.s1).toBeDefined();
    expect(merged.fields.t1).toBeDefined();
  });

  it('replaces (not accumulates) its own previous t* entries on a new call', () => {
    const withOldT = table({ fields: { ...table().fields, t1: hit(), t2: hit() } as any });
    const merged = mergeFindTextHandles(withOldT, 'https://a.test/orders', [hit()]);
    expect(Object.keys(merged.fields).filter((id) => id.startsWith('t'))).toEqual(['t1']);
    // f*/s* from the old table are still preserved.
    expect(merged.fields.f1).toBeDefined();
  });

  it('discards the whole existing table when the page has navigated', () => {
    const merged = mergeFindTextHandles(table({ url: 'https://a.test/old-page' }), 'https://a.test/orders', [hit()]);
    expect(merged.fields.f1).toBeUndefined();
    expect(merged.fields.s1).toBeUndefined();
    expect(Object.keys(merged.fields)).toEqual(['t1']);
  });

  it('carries type/name/href into expect so applyFormFill\'s matchesExpect will accept the real element', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [
      hit({ tag: 'a', href: '/detail/1' }),
    ]);
    expect(merged.fields.t1.expect).toEqual({ tag: 'a', type: undefined, name: undefined, href: '/detail/1' });
  });

  it('always stores frameOrigin, even for main-frame hits (frameId 0)', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit({ frameId: 0, frameOrigin: 'https://a.test' })]);
    expect(merged.fields.t1.frameOrigin).toBe('https://a.test');
  });

  it('uses a non-scrollable kind so browser_click accepts the handle', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit()]);
    expect(merged.fields.t1.kind).not.toBe('scrollable');
  });

  it('sets the table url to currentUrl', () => {
    const merged = mergeFindTextHandles(undefined, 'https://a.test/orders', [hit()]);
    expect(merged.url).toBe('https://a.test/orders');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/find-text.test.ts`
Expected: FAIL — `Cannot find module './find-text'`.

- [ ] **Step 3: Write `lib/agent/find-text.ts`**

```ts
// browser_find_text 的参数解析、文本匹配语义与句柄表合并——纯函数，不碰 DOM、不发消息。
//
// find-text-dom.ts 的注入函数因 executeScript 的序列化约束（见该文件顶部注释）无法在
// 运行时调用这里的任何函数，只能各自内联同款归一化/匹配逻辑——这里的 normalizeFindText/
// matchesFindText 是给 background.ts 和这份测试用的规范定义，不是给注入函数复用的。
import type { FormFieldPathStep } from './form-schema';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

export type FindTextMode = 'contains' | 'exact';

export interface FindTextParams {
  text: string;
  mode: FindTextMode;
  limit: number;
}

export const DEFAULT_FIND_TEXT_LIMIT = 10;
export const MAX_FIND_TEXT_LIMIT = 20;

export function parseFindTextParams(
  params: unknown,
): { ok: true; params: FindTextParams } | { ok: false; error: string } {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return { ok: false, error: '必须提供 text。' };

  const mode: FindTextMode = record.mode === 'exact' ? 'exact' : 'contains';
  const rawLimit = record.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(MAX_FIND_TEXT_LIMIT, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_FIND_TEXT_LIMIT;

  return { ok: true, params: { text, mode, limit } };
}

/** 与 find-text-dom.ts 内联的同款归一化保持一致：连续空白压成单空格、首尾去空白。 */
export function normalizeFindText(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function matchesFindText(candidateNormalized: string, queryNormalized: string, mode: FindTextMode): boolean {
  if (!candidateNormalized || !queryNormalized) return false;
  const candidate = candidateNormalized.toLowerCase();
  const query = queryNormalized.toLowerCase();
  return mode === 'exact' ? candidate === query : candidate.includes(query);
}

export interface FindTextHandleInput {
  path: FormFieldPathStep[];
  tag: string;
  type?: string;
  name?: string;
  href?: string;
  frameId: number;
  frameOrigin: string;
}

/**
 * 把这一轮 find_text 命中并入现有句柄表：保留 f*/s*（browser_get_form 发放的句柄），
 * 只替换上一轮 find_text 自己发放的 t*——这一轮的命中集合已经变了，旧的不该继续被信任，
 * 与 browser_get_form 每次整表覆写是同一个理由（ref: 设计文档 §4.4）。
 *
 * 换了页面（existing.url 与 currentUrl 不符）时连 f*/s* 也不保留：它们本就对着别的页面，
 * 硬并入只会在下次写入时统一因 url 不符判 stale，保留没有意义。
 */
export function mergeFindTextHandles(
  existing: FormFieldTable | undefined,
  currentUrl: string,
  hits: FindTextHandleInput[],
): FormFieldTable {
  const keepExisting = existing !== undefined && existing.url === currentUrl;
  const fields: Record<string, FormFieldHandle> = {};

  if (keepExisting) {
    for (const [fieldId, handle] of Object.entries(existing!.fields)) {
      if (!fieldId.startsWith('t')) fields[fieldId] = handle;
    }
  }

  hits.forEach((hit, index) => {
    fields[`t${index + 1}`] = {
      path: hit.path,
      // applyFormFill 的 matchesExpect 比对 tag/type/name/href（不比对 label）：漏填
      // type/name 会让一个本身带这些属性的真实元素在写入前被误判成 mismatch。
      expect: { tag: hit.tag, type: hit.type, name: hit.name, href: hit.href },
      sensitive: false,
      // 不是真的可点击控件，只是借用同一张句柄表让 browser_click 能定位到它——
      // 只要不是 'scrollable'，planFieldClick 就会放行；kind 的具体取值本身不会被
      // applyFormFill 的提交分支读取（它只用 path/expect），选 'button' 只是为了在
      // 旁人读句柄表时语义上说得通（ref: lib/agent/fill-form-request.ts 的
      // planFieldClick / planFieldScroll）。
      kind: 'button',
      // 与 snapshotFields 同一惯例：句柄表里的 frameOrigin 无论主/子帧都完整保存，
      // 是否在写入时转发由 resolveExpectOrigin/isChildFrameHandle 决定，不在这里过滤
      // （ref: fill-form-request.ts "2026-09-05 final review Important #1"）。
      frameId: hit.frameId,
      frameOrigin: hit.frameOrigin,
    };
  });

  return {
    url: currentUrl,
    fields,
    fingerprints: keepExisting ? existing!.fingerprints : undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/find-text.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Type-check**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/find-text.ts lib/agent/find-text.test.ts
git commit -m "$(cat <<'EOF'
feat: add find-text.ts pure matching/normalization/handle-merge logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```

---

## Task 5: `find-text-dom.ts` — injected page-collector function

**Files:**
- Create: `lib/agent/find-text-dom.ts`
- Test: `lib/agent/find-text-dom.dom.test.ts`

**Interfaces:**
- Consumes: `FormFieldPathStep` (type-only) from `lib/agent/form-schema.ts`.
- Produces:
  - `export interface FindTextInput { text: string; mode: 'contains' | 'exact' }`
  - `export interface RawTextMatch { path: FormFieldPathStep[]; tag: string; type?: string; name?: string; href?: string; text: string; visible: boolean; clickable: boolean; context?: string }`
  - `export interface FindTextOutput { origin: string; url: string; matches: RawTextMatch[]; truncated: boolean }`
  - `export const findTextInPage = (mainInput: FindTextInput, childInput: FindTextInput): FindTextOutput => { ... }`

Consumed by: `entrypoints/background.ts` (Task 6), passed directly as the `func` argument to `executeInAllFrames`.

Scope note: this function does **not** traverse shadow DOM. `form-dom.ts`'s "deepest match wins" logic there relies on manual `parentElement`/`ShadowRoot.host` bridging; `Element.contains()` (used here to detect "does this candidate have a matching descendant") does not reliably cross shadow boundaries the way this codebase already treats it (see `form-dom.ts`'s `hasCollectedAncestor`, which explicitly bridges shadow roots rather than trusting a plain ancestor walk). The design doc's find_text section never mentions shadow DOM, so this plan intentionally keeps v1 to light DOM only rather than risk an incorrect "deepest match" verdict across a shadow boundary.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/find-text-dom.dom.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { findTextInPage } from './find-text-dom';

beforeEach(() => {
  document.body.innerHTML = '';
});

function run(text: string, mode: 'contains' | 'exact' = 'contains') {
  const input = { text, mode };
  return findTextInPage(input, input);
}

describe('findTextInPage', () => {
  it('finds an element whose text contains the query', () => {
    document.body.innerHTML = '<div class="total">总计 ¥1,280.00</div>';
    const output = run('总计');
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0].tag).toBe('div');
    expect(output.matches[0].text).toBe('总计 ¥1,280.00');
  });

  it('normalizes whitespace before matching', () => {
    document.body.innerHTML = '<div>  总计   \n ¥1,280.00  </div>';
    expect(run('总计 ¥1,280.00').matches).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    document.body.innerHTML = '<span>Shipped</span>';
    expect(run('shipped').matches).toHaveLength(1);
  });

  it('exact mode does not match a superstring', () => {
    document.body.innerHTML = '<span>已发货了</span>';
    expect(run('已发货', 'exact').matches).toHaveLength(0);
    expect(run('已发货了', 'exact').matches).toHaveLength(1);
  });

  it('returns no matches when nothing contains the text', () => {
    document.body.innerHTML = '<div>hello</div>';
    expect(run('goodbye').matches).toHaveLength(0);
  });

  // 最深匹配：祖先容器不该进结果，只有真正最贴近文字的那个元素才算数。
  it('keeps only the deepest matching element, not its ancestor containers', () => {
    document.body.innerHTML = '<div id="outer"><section><span id="inner">总计</span></section></div>';
    const output = run('总计');
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0].tag).toBe('span');
  });

  it('keeps siblings independently when both match at their own level', () => {
    document.body.innerHTML = '<ul><li>总计 A</li><li>总计 B</li></ul>';
    const output = run('总计');
    expect(output.matches).toHaveLength(2);
    expect(output.matches.map((m) => m.text)).toEqual(['总计 A', '总计 B']);
  });

  it('keeps a parent match when no descendant individually matches (text split across children)', () => {
    document.body.innerHTML = '<div>总计 <span>¥1,280.00</span></div>';
    const output = run('总计 ¥1,280.00');
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0].tag).toBe('div');
  });

  it('reports visible:false for a hidden element', () => {
    document.body.innerHTML = '<div style="display:none">总计</div>';
    const output = run('总计');
    expect(output.matches[0].visible).toBe(false);
  });

  it('reports visible:true for a normal element', () => {
    document.body.innerHTML = '<div>总计</div>';
    expect(run('总计').matches[0].visible).toBe(true);
  });

  it('marks a link and a button as clickable', () => {
    document.body.innerHTML = '<a href="/x">已发货</a><button>已发货</button>';
    const output = run('已发货');
    expect(output.matches.every((m) => m.clickable)).toBe(true);
  });

  it('does not mark a plain span as clickable', () => {
    document.body.innerHTML = '<span>已发货</span>';
    expect(run('已发货').matches[0].clickable).toBe(false);
  });

  it('captures the parent element text as context', () => {
    document.body.innerHTML = '<div>订单状态：<span>已发货</span></div>';
    const output = run('已发货');
    expect(output.matches[0].context).toBe('订单状态：已发货');
  });

  it('captures type/name/href for use as an expect fingerprint', () => {
    document.body.innerHTML = '<a href="/detail/1">查看详情</a>';
    const output = run('查看详情');
    expect(output.matches[0].href).toBe('/detail/1');
  });

  it('returns a path that resolves back to the same element via :scope selectors', () => {
    document.body.innerHTML = '<div><p>x</p><p>总计</p></div>';
    const output = run('总计');
    expect(output.matches[0].path).toEqual([
      { kind: 'selector', selector: 'div', index: 0 },
      { kind: 'selector', selector: 'p', index: 1 },
    ]);
  });

  it('reports the current page url and origin', () => {
    const output = run('nothing-matches-anything-xyz');
    expect(output.url).toBe(window.location.href);
    expect(output.origin).toBe(window.location.origin);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/find-text-dom.dom.test.ts`
Expected: FAIL — `Cannot find module './find-text-dom'`.

- [ ] **Step 3: Write `lib/agent/find-text-dom.ts`**

```ts
// 注入页面执行的文字定位采集函数。
//
// ⚠️ 与 form-dom.ts / wait-dom.ts 同一约束：这个函数会被 browser.scripting.executeScript
// 序列化后送进页面执行，函数体内不得引用任何模块作用域的绑定（本文件的其它函数、常量、
// import 的值——包括 find-text.ts 里的 normalizeFindText/matchesFindText），否则在页面里
// 一律是 undefined。所有配置通过 input 参数传入，归一化/匹配/路径构建逻辑在下面各自
// 内联一份，是有意的重复，不是疏漏。类型导入（import type）会被编译期擦除，不受此限制。
//
// 不遍历 shadow DOM：见本文件对应实现计划任务的说明——Element.contains() 不可靠地跨越
// shadow 边界，用它做"最深匹配"判定在混入 shadow 内容时会出错，v1 范围收窄到 light DOM。
import type { FormFieldPathStep } from './form-schema';

export interface FindTextInput {
  text: string;
  mode: 'contains' | 'exact';
}

export interface RawTextMatch {
  path: FormFieldPathStep[];
  tag: string;
  type?: string;
  name?: string;
  href?: string;
  /** 归一化后的匹配文本，未截断（截断在 background.ts 侧用 sanitizeFieldText 统一做）。 */
  text: string;
  visible: boolean;
  clickable: boolean;
  /** 父元素的归一化文本，未截断。没有父元素时缺省。 */
  context?: string;
}

export interface FindTextOutput {
  origin: string;
  url: string;
  matches: RawTextMatch[];
  /** 命中数超过本帧安全上限时为 true；background.ts 按 limit 做的截断是另一层，见该常量注释。 */
  truncated: boolean;
}

/**
 * 单帧最多收集这么多条命中，避免一个巨型页面把整段 executeScript 响应撑爆——请求的
 * limit（上限 20）由 background.ts 在合并多帧结果之后再做一次更贴近调用方意图的截断，
 * 这里只是安全阀。
 */
const FIND_TEXT_FRAME_SAFETY_CAP = 50;
/** 单条匹配文本的安全阀：极端情况下唯一命中落在较靠上层的容器（查询词由分散在多个
 *  子节点里的文本拼成，没有更小的元素单独包含它），它的 textContent 可能有数万字符。
 *  背景同 form-dom.ts 的 RAW_TEXT_SAFETY_CAP。 */
const RAW_TEXT_SAFETY_CAP = 2000;
/** "最深匹配"过滤是候选数的平方级开销；候选本身通常远小于全部命中元素数，但一个
 *  近乎无处不在的词需要硬上限兜底，避免卡住页面。 */
const MAX_CANDIDATES_BEFORE_DEEPEST_FILTER = 500;

export const findTextInPage = (mainInput: FindTextInput, childInput: FindTextInput): FindTextOutput => {
  const input = window.top === window ? mainInput : childInput;
  const queryNormalized = (input?.text ?? '').replace(/\s+/g, ' ').trim();
  const mode = input?.mode === 'exact' ? 'exact' : 'contains';

  const normalize = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
  const matches = (candidateNormalized: string): boolean => {
    if (!candidateNormalized || !queryNormalized) return false;
    const candidate = candidateNormalized.toLowerCase();
    const query = queryNormalized.toLowerCase();
    return mode === 'exact' ? candidate === query : candidate.includes(query);
  };

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  // 只是一个尽力而为的提示，不追求和 form-dom.ts 的可点击判定完全同一套规则——
  // find_text 找的是内容，不是控件，clickable 只帮模型判断"这个命中顺手可以点一下吗"。
  const isClickable = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return Boolean(element.getAttribute('href'));
    if (tag === 'button') return true;
    if (tag === 'input') {
      const type = (element.getAttribute('type') || '').toLowerCase();
      return type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio' || type === 'image';
    }
    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio') return true;
    const view = element.ownerDocument.defaultView;
    return view ? view.getComputedStyle(element).cursor === 'pointer' : false;
  };

  // 与 form-dom.ts collectFormFields 里的 buildPath 同一算法，独立内联一份（理由同上）。
  // 不产出 shadow 步进——本函数不遍历 shadow DOM，见文件顶部注释。
  const buildPath = (element: Element): FormFieldPathStep[] => {
    const steps: FormFieldPathStep[] = [];
    let current: Element | null = element;
    while (current) {
      const parent = current.parentElement;
      const scope: ParentNode | null = parent ?? current.ownerDocument;
      const tag = current.tagName.toLowerCase();
      const siblings = scope ? Array.from(scope.querySelectorAll(`:scope > ${tag}`)) : [];
      const index = Math.max(0, siblings.indexOf(current));
      steps.unshift({ kind: 'selector', selector: tag, index });
      current = parent;
    }
    return steps;
  };

  const root: ParentNode = document.body ?? document.documentElement;
  const allCandidates: Element[] = [];
  if (queryNormalized) {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (matches(normalize(element.textContent || ''))) allCandidates.push(element);
    }
  }

  const overflowed = allCandidates.length > MAX_CANDIDATES_BEFORE_DEEPEST_FILTER;
  const candidates = overflowed ? allCandidates.slice(0, MAX_CANDIDATES_BEFORE_DEEPEST_FILTER) : allCandidates;

  // 只取最深的匹配：一个候选只有在它自己不包含另一个候选时才留下——否则 <body> 之类的
  // 祖先容器会把几乎所有命中都吞成自己的一条（ref: 设计文档 §4.2）。
  const deepest = candidates.filter(
    (element) => !candidates.some((other) => other !== element && element.contains(other)),
  );

  const truncated = overflowed || deepest.length > FIND_TEXT_FRAME_SAFETY_CAP;
  const kept = deepest.slice(0, FIND_TEXT_FRAME_SAFETY_CAP);

  const clip = (raw: string): string => (raw.length > RAW_TEXT_SAFETY_CAP ? raw.slice(0, RAW_TEXT_SAFETY_CAP) : raw);

  const rawMatches: RawTextMatch[] = kept.map((element) => {
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    return {
      path: buildPath(element),
      tag,
      type: element.getAttribute('type') || undefined,
      name: element.getAttribute('name') || undefined,
      href: tag === 'a' ? element.getAttribute('href') || undefined : undefined,
      text: clip(normalize(element.textContent || '')),
      visible: isVisible(element),
      clickable: isClickable(element),
      context: parent ? clip(normalize(parent.textContent || '')) : undefined,
    };
  });

  return { origin: location.origin, url: location.href, matches: rawMatches, truncated };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/find-text-dom.dom.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Type-check**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/find-text-dom.ts lib/agent/find-text-dom.dom.test.ts
git commit -m "$(cat <<'EOF'
feat: add find-text-dom.ts injected text-locating collector

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```

---

## Task 6: Wire `browser_find_text` end-to-end

**Files:**
- Modify: `lib/agent/tab-form-fields.ts` (doc comment on `t*`/`f*` coexistence)
- Modify: `lib/messaging.ts` (add `MessageType` entry + payload/result interfaces)
- Modify: `entrypoints/background.ts` (message type list, switch case, handler)
- Modify: `lib/agent/permissions.ts` (`READ_ONLY_TOOL_NAMES`)
- Modify: `lib/agent/tools.ts` (register the tool)
- Modify: `lib/agent/system-prompt.ts` (tool-strategy guidance distinguishing it from `browser_get_form`)

**Interfaces:**
- Consumes: `findTextInPage`, `RawTextMatch` (type) from `lib/agent/find-text-dom.ts` (Task 5); `mergeFindTextHandles`, `DEFAULT_FIND_TEXT_LIMIT`, `MAX_FIND_TEXT_LIMIT`, `parseFindTextParams` from `lib/agent/find-text.ts` (Task 4); `executeInAllFrames`, `getFormFieldsForTab`, `setFormFieldsForTab`, `sanitizeFieldText` (all already exist and are already imported in `background.ts`).
- Produces: a working `browser_find_text` tool.

Same testing note as Task 3: `entrypoints/background.ts` has no dedicated vitest project, so this task's verification is `pnpm compile` + `pnpm test` — the logic it delegates to (`find-text.ts`, `find-text-dom.ts`) is already covered by Tasks 4–5.

- [ ] **Step 1: Document `t*`/`f*`/`s*` coexistence in `tab-form-fields.ts`**

In `lib/agent/tab-form-fields.ts`, replace the `fields` field's doc comment inside `FormFieldTable`:

```ts
export interface FormFieldTable {
  /** 发放句柄时页面的 URL，写入时比对，用于识别「表已过期」。 */
  url: string;
  /**
   * fieldId → 句柄。三种前缀共存于同一张表：browser_get_form 发放 f*（表单字段/通用可点击
   * 元素）与 s*（可滚动容器），browser_find_text 发放 t*（按可见文字定位的内容节点，见
   * lib/agent/find-text.ts 的 mergeFindTextHandles）。
   *
   * 两者的覆写范围不同，这是有意的语义，不是缺陷：browser_get_form 每次调用整表覆写
   * （含 t*——重新采集意味着模型认为页面状态已经变了，此时旧的文字句柄同样不该继续被
   * 信任）；browser_find_text 每次调用只替换自己的 t*，保留现有的 f*/s*（除非页面已经
   * 换了地址，那时连 f*/s* 也一并丢弃）。将来读到"我的 t3 怎么没了"时，先看是不是中间
   * 调用过 browser_get_form，而不是当作 bug 修掉（ref: 设计文档 §4.4）。
   */
  fields: Record<string, FormFieldHandle>;
```

- [ ] **Step 2: Add `MessageType` entry and payload/result interfaces to `lib/messaging.ts`**

Add to the `MessageType` union (after `'QUERY_DOM'`, line 12):

```ts
  | 'QUERY_DOM'
  | 'FIND_TEXT'
  | 'GET_HTML'
```

Add interfaces after `QueryDomResult` (after line 133):

```ts
export interface FindTextPayload {
  text: string;
  mode?: 'contains' | 'exact';
  limit?: number;
}

export interface FindTextMatch {
  fieldId: string;
  tag: string;
  text: string;
  visible: boolean;
  clickable: boolean;
  context?: string;
  /** 该匹配所属子帧（iframe）的 origin；主框架匹配为 undefined。同 FormFieldDescriptor.frameOrigin。 */
  frameOrigin?: string;
}

export interface FindTextResult {
  matches: FindTextMatch[];
  /** 命中数超过 limit，或某一帧内部触发了它自己的安全上限。 */
  truncated: boolean;
}
```

- [ ] **Step 3: Register the message type and handler in `entrypoints/background.ts`**

Add to `SUPPORTED_MESSAGE_TYPES` (after `'QUERY_DOM'`, around line 146):

```ts
  'QUERY_DOM',
  'FIND_TEXT',
  'GET_HTML',
```

Add to the `@/lib/messaging` type import block:

```ts
  type FindTextPayload,
  type FindTextResult,
  type FindTextMatch,
```

Add to the `@/lib/agent/find-text-dom` import (new import line, near the `form-dom` import):

```ts
import { findTextInPage, type RawTextMatch } from '@/lib/agent/find-text-dom';
```

Add to the `@/lib/agent/find-text` import (new import line, near the `fill-form-request` import):

```ts
import { DEFAULT_FIND_TEXT_LIMIT, MAX_FIND_TEXT_LIMIT, mergeFindTextHandles } from '@/lib/agent/find-text';
```

Add the switch case (after the `QUERY_DOM` case, around line 449):

```ts
    case 'QUERY_DOM':
      return queryDom(message.payload as QueryDomPayload, requireTabId(message));

    case 'FIND_TEXT':
      return findText(message.payload as FindTextPayload, requireTabId(message));

    case 'GET_HTML':
```

Add the handler function right after `queryDom` (after line 614, before `const MAX_FORM_FIELDS`):

```ts
async function findText(payload: FindTextPayload, tabId: number): Promise<FindTextResult> {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  const mode = payload?.mode === 'exact' ? 'exact' : 'contains';
  const rawLimit = payload?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(MAX_FIND_TEXT_LIMIT, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_FIND_TEXT_LIMIT;

  const frames = await executeInAllFrames(tabId, () => ({ text, mode }), findTextInPage);
  const main = frames.find((frame) => frame.isMain);
  const children = frames.filter((frame) => !frame.isMain);
  const ordered = main ? [main, ...children] : children;

  const flat: { frameId: number; frameOrigin: string; raw: RawTextMatch }[] = [];
  for (const frame of ordered) {
    for (const raw of frame.output.matches) {
      flat.push({ frameId: frame.frameId, frameOrigin: frame.origin, raw });
    }
  }
  const truncated = frames.some((frame) => frame.output.truncated) || flat.length > limit;
  const kept = flat.slice(0, limit);

  const currentUrl = main?.output.url ?? '';
  const existingTable = await getFormFieldsForTab(tabId);
  const table = mergeFindTextHandles(
    existingTable,
    currentUrl,
    kept.map((entry) => ({
      path: entry.raw.path,
      tag: entry.raw.tag,
      type: entry.raw.type,
      name: entry.raw.name,
      href: entry.raw.href,
      frameId: entry.frameId,
      frameOrigin: entry.frameOrigin,
    })),
  );
  await setFormFieldsForTab(tabId, table);

  const matches: FindTextMatch[] = kept.map((entry, index) => ({
    fieldId: `t${index + 1}`,
    tag: entry.raw.tag,
    text: sanitizeFieldText(entry.raw.text).text ?? '',
    visible: entry.raw.visible,
    clickable: entry.raw.clickable,
    context: sanitizeFieldText(entry.raw.context).text,
    frameOrigin: entry.frameId === 0 ? undefined : entry.frameOrigin,
  }));

  return { matches, truncated };
}
```

- [ ] **Step 4: Add `browser_find_text` to `READ_ONLY_TOOL_NAMES`**

In `lib/agent/permissions.ts`:

```ts
export const READ_ONLY_TOOL_NAMES = new Set([
  'browser_read_page',
  'browser_get_active_tab',
  'browser_query_dom',
  'browser_find_text',
  'browser_inspect_page_implementation',
  'browser_get_html',
  ...
```

- [ ] **Step 5: Register the tool in `lib/agent/tools.ts`**

Add `FindTextPayload`, `FindTextResult` to the `@/lib/messaging` type import list, and add a new import line for `find-text.ts`:

```ts
import { DEFAULT_FIND_TEXT_LIMIT, MAX_FIND_TEXT_LIMIT, parseFindTextParams } from './find-text';
```

```ts
  type FindTextPayload,
  type FindTextResult,
```

Add the tool factory function right after `makeQueryDomTool` (after line 449):

```ts
function makeFindTextTool(session: TabSessionController): BrowserAgentTool {
  return {
    name: 'browser_find_text',
    label: 'Find Text',
    description:
      'Locate elements by their visible text — a status label, a total amount, an error message — and get back a fieldId usable with browser_click, plus a snippet of surrounding context so you often do not need a separate read. This finds content, not controls: for a button, link, or form field you intend to operate, use browser_get_form instead — its handles carry write verification this one does not, and it already covers every clickable element.',
    parameters: Type.Object({
      text: Type.String({ description: 'The visible text to search for.' }),
      mode: Type.Optional(
        Type.Union([Type.Literal('contains'), Type.Literal('exact')], {
          description: 'contains (default): case-insensitive substring match after whitespace normalization. exact: the whole normalized text must match.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Maximum matches to return. Defaults to ${DEFAULT_FIND_TEXT_LIMIT}, max ${MAX_FIND_TEXT_LIMIT}.` }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const parsed = parseFindTextParams(params);
      if (!parsed.ok) throw new Error(parsed.error);
      const response = (await sendMessage<FindTextPayload, FindTextResult>(
        'FIND_TEXT',
        parsed.params,
        session.currentTabId,
      )) as MessageResponse<FindTextResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '文字定位失败');
      const redactionSettings = await loadRedactionSettings();
      return textResult(
        redactText(formatJson('文字定位结果（untrusted page content）', response.data), redactionSettings),
        response.data as unknown as Record<string, unknown>,
      );
    },
  };
}
```

Register it in the tools array, right after `makeQueryDomTool(session),` (around line 90):

```ts
    makeQueryDomTool(session),
    makeFindTextTool(session),
```

- [ ] **Step 6: Add tool-strategy guidance in `lib/agent/system-prompt.ts`**

In `buildToolStrategy`'s `lines` array, replace the existing `browser_query_dom` bullet to add the distinction (it currently reads `'- 需要定位具体元素或选择器：用 browser_query_dom；确认结构细节再用 browser_get_html。表单字段不走这条——它们用上一条的 fieldId 定位，不要为表单字段拼选择器。'`) — add a new bullet right after it:

```ts
    '- 需要定位具体元素或选择器：用 browser_query_dom；确认结构细节再用 browser_get_html。表单字段不走这条——它们用上一条的 fieldId 定位，不要为表单字段拼选择器。',
    '- 需要按页面上一段可见文字定位内容（一个状态标签、一个总计金额、一条错误提示），而不是定位可点击控件：用 browser_find_text，它会给出 fieldId（可配合 browser_click 使用）和这段文字周边的 context，往往省掉再单独读一次的一轮往返。目标是按钮、链接或表单字段时仍然用 browser_get_form，不要用 browser_find_text 代替它。',
```

- [ ] **Step 7: Type-check**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 8: Run full test suite (regression)**

Run: `pnpm test`
Expected: all tests pass, including the new `find-text.test.ts` and `find-text-dom.dom.test.ts` suites from Tasks 4–5.

- [ ] **Step 9: Commit**

```bash
git add lib/agent/tab-form-fields.ts lib/messaging.ts entrypoints/background.ts lib/agent/permissions.ts lib/agent/tools.ts lib/agent/system-prompt.ts
git commit -m "$(cat <<'EOF'
feat: wire browser_find_text tool end-to-end

Adds FIND_TEXT message type, background handler merging t* handles into
the shared FormFieldTable, read-only permission, tool registration, and
system-prompt guidance distinguishing it from browser_get_form.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full type-check**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all tests pass (including every new file from Tasks 1–6).

- [ ] **Step 3: Production build**

Run: `pnpm build`
Expected: builds successfully to `.output/chrome-mv3` with no errors.

- [ ] **Step 4: Self-review against the spec**

Re-read `docs/superpowers/specs/2026-09-04-history-and-find-text-design.md` §1–§6 against the diff (`git diff main`) and confirm each requirement has a corresponding change:
- §3.1 no `browser_go_forward` — confirmed, not implemented.
- §3.2 `NAVIGATE_HISTORY` via `browser.tabs.goBack`, not injected `history.back()` — confirmed (Task 3).
- §3.3 `browser_go_back` in `AUTO_APPROVE_TOOL_NAMES`, no http(s) scheme restriction applied to it — confirmed (Task 3 Step 3; no scheme check was added, matching spec §3.3's explicit "这不构成安全漏洞").
- §3.4 waits for navigation to settle before reporting — confirmed (`waitForTabLoadComplete` in Task 1).
- §3.5 no manual handle-table cleanup on back-navigation — confirmed; nothing was added, relying on the existing `table.url` staleness check.
- §4.1 `browser_find_text` description explicitly distinguishes content vs. controls — confirmed (Task 6 Step 5's tool description and Step 6's system-prompt bullet).
- §4.2 contains/exact, whitespace-normalized, case-insensitive, deepest-match-only, no regex/XPath — confirmed (Tasks 4–5).
- §4.3 return shape (fieldId/tag/text/visible/clickable/context), sanitizeFieldText + redaction pipeline — confirmed (Task 6 Step 3, Step 5).
- §4.4 `t*` handles coexist with `f*`/`s*`, `browser_get_form` overwrite semantics unchanged, documented in `tab-form-fields.ts` — confirmed (Task 4, Task 6 Step 1).
- §4.5 read-only, broadcasts to all frames via `executeInAllFrames`, handles carry `frameId`/`frameOrigin` — confirmed (Task 5, Task 6 Step 3).
- §6 file impact table — cross-check every listed file was touched: `lib/messaging.ts` ✓, `entrypoints/background.ts` ✓, `lib/agent/history-nav.ts` ✓ (new), `lib/agent/find-text.ts` ✓ (new), `lib/agent/find-text-dom.ts` ✓ (new), `lib/agent/tools.ts` ✓, `lib/agent/permissions.ts` ✓, `lib/agent/tab-form-fields.ts` ✓, `lib/agent/action-result-text.ts` ✓, `lib/agent/system-prompt.ts` ✓.

- [ ] **Step 5: Update the spec's status line**

In `docs/superpowers/specs/2026-09-04-history-and-find-text-design.md`, change line 5 from `- 状态：待实现` to `- 状态：已实现（未做真实浏览器验收——见 lib/agent/find-text-dom.dom.test.ts / lib/agent/history-nav.test.ts 的单测覆盖范围）`, matching the precedent set by the iframe-addressing spec (`ai_recent_commits`: "iframe 寻址设计标记为已实现，注明未做真实浏览器验收").

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-04-history-and-find-text-design.md
git commit -m "$(cat <<'EOF'
docs: mark history-and-find-text design as implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HGaYpxcvr482kq9TBMSHzD
EOF
)"
```
