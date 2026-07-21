# Chrome Web Store Remote-Code Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `browser_inject_script`'s execution mechanism off `new Function()` (a Manifest V3 Remote Hosted Code policy violation when running LLM-generated code) onto `browser.userScripts.execute()`, Chrome's sanctioned API for this exact use case, so Aluminum can be submitted to the Chrome Web Store.

**Architecture:** Only `injectScript()` in `entrypoints/background.ts` changes its execution call. The message protocol (`InjectScriptPayload`/`InjectScriptResult` in `lib/messaging.ts`), the confirm-gate, `analyzeScript` pre-screening, and the turn-snapshot/undo flow are all untouched — this is a single-function swap plus a manifest permission and three doc updates.

**Tech Stack:** WXT (MV3) manifest config, `browser.userScripts` (typed via `@wxt-dev/browser`, bundled by WXT — confirmed present with an `execute()` method added in Chrome 135).

**Spec:** `docs/specs/0002-chrome-web-store-remote-code-compliance.md` — read it before starting; this plan implements it task by task and does not repeat its rationale.

## Global Constraints

- Minimum Chrome version must be `'135'`, not `'120'` — confirmed by reading `@wxt-dev/browser`'s type definitions: the `userScripts` namespace exists since Chrome 120, but its one-shot `execute()` method (which this plan uses) was added in Chrome 135. This corrects an approximate value in the spec's interface sketch.
- Do not call `eval()` or `new Function()` anywhere in the new code — the entire point of this migration is to stop doing that.
- `browser.userScripts.execute()`'s `js` field takes a raw script body (like `eval`), not a function (unlike the old `new Function(userCode)` + `fn()` call) — a bare top-level `return` statement in LLM-generated code would be a syntax error under raw execution. Preserve the old semantics by wrapping the user code in an IIFE string (`(function(){...})()`) before handing it to `execute()`. This is string concatenation on our side, not code execution — the actual execution happens inside Chrome's sanctioned API, so it does not reintroduce the policy violation.
- Keep `analyzeScript`'s pre-screening, the confirm-gate (`CONFIRM_TOOLS` in `lib/agent/permissions.ts`), and `ensureTurnSnapshot`/undo exactly as they are — none of them need to change for this migration.
- Don't write an explicit type annotation for the `browser.userScripts.execute()` result (e.g. `browser.userScripts.InjectionResult<unknown>[]`) — `browser` is a runtime value, not an exported type namespace, so using it as a type qualifier fails to compile. Let TypeScript infer the return type instead, the same way the pre-existing `browser.scripting.executeScript(...)` call above it in the file does.
- Chinese user-facing error strings must match the project's existing Chinese-language convention seen throughout `entrypoints/` and `lib/`.
- Run `pnpm compile` after every task that touches TypeScript; it must pass before moving to the next task.
- Only `git add` the files a task actually touches, then commit — never a blanket `git add -A`.
- This codebase's test setup (`vitest.config.ts`) only covers `lib/**/*.test.ts` — `entrypoints/background.ts` has no unit test coverage today (consistent with how the other 9 write-tool handlers in that file are already untested), so this plan does not introduce one either. Verification for the `background.ts` change is `pnpm compile` plus the manual browser check in Task 2.

---

### Task 1: Declare the `userScripts` permission and Chrome version floor

**Files:**
- Modify: `wxt.config.ts:14` (permissions array), add `minimum_chrome_version`

**Interfaces:**
- Produces: manifest with `permissions` including `'userScripts'` and top-level `minimum_chrome_version: '135'`, consumed by `browser.userScripts.execute()` in Task 2.

- [ ] **Step 1: Add the permission and version floor**

Current `wxt.config.ts` (relevant slice):

```ts
  manifest: {
    name: 'Aluminum',
    description: 'AI 助手侧边栏：总结、理解、改造与自动化当前网页',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs'],
    host_permissions: ['<all_urls>'],
```

Change it to:

```ts
  manifest: {
    name: 'Aluminum',
    description: 'AI 助手侧边栏：总结、理解、改造与自动化当前网页',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'userScripts'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '135',
```

- [ ] **Step 2: Build and inspect the generated manifest**

Run: `pnpm build`
Expected: build succeeds with no errors.

Then check the output:

Run (PowerShell): `Get-Content .output/chrome-mv3/manifest.json | Select-String "userScripts|minimum_chrome_version"`
Expected: both `"userScripts"` (inside the `permissions` array) and `"minimum_chrome_version": "135"` appear in the output.

- [ ] **Step 3: Commit**

```bash
git add wxt.config.ts
git commit -m "feat: declare userScripts permission and Chrome 135 floor for MV3 compliance"
```

---

### Task 2: Migrate `injectScript()` to `browser.userScripts.execute()`

**Files:**
- Modify: `entrypoints/background.ts:643-680` (`injectScript` function body)
- Modify: `lib/agent/tools.ts:509-524` (`browserInjectScriptTool` description text only)

**Interfaces:**
- Consumes: `InjectScriptPayload { code: string }`, `InjectScriptResult { result?: string; snapshotSaved: boolean }` (both from `lib/messaging.ts`, unchanged), `analyzeScript` from `lib/security.ts` (unchanged), `ensureTurnSnapshot(tabId: number): Promise<void>` (unchanged, defined earlier in `background.ts`).
- Produces: same `injectScript(): Promise<InjectScriptResult>` signature as before — no caller (`lib/agent/tools.ts`, `lib/messaging.ts`) needs to change beyond the description string in this task.

- [ ] **Step 1: Replace the execution block in `background.ts`**

Current code (`entrypoints/background.ts:643-680`):

```ts
async function injectScript(
  payload: InjectScriptPayload,
): Promise<InjectScriptResult> {
  const code = payload?.code ?? '';
  if (!code.trim()) throw new Error('脚本为空');

  // 后端二次校验：语法非法直接拒绝（安全纵深）
  const report = analyzeScript(code);
  if (!report.valid) {
    throw new Error(`脚本语法错误：${report.syntaxError ?? '未知'}`);
  }

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
        const ret = fn();
        return { ok: true, result: ret === undefined ? '' : String(ret) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const out = frame?.result as { ok: boolean; result?: string; error?: string } | undefined;
  if (!out?.ok) {
    throw new Error(out?.error ?? '脚本执行失败');
  }
  return { result: out.result, snapshotSaved: true };
}
```

Replace with:

```ts
// 脚本注入（ref: technical-plan.md §4.2、Spec-0002）。
// 使用 chrome.userScripts.execute（Chrome MV3 官方认可的动态脚本执行通道）而非 eval/new Function，
// 满足 Remote Hosted Code 政策；用 IIFE 包裹以保留旧版 new Function 的 return 语义。
async function injectScript(
  payload: InjectScriptPayload,
): Promise<InjectScriptResult> {
  const code = payload?.code ?? '';
  if (!code.trim()) throw new Error('脚本为空');

  // 后端二次校验：语法非法直接拒绝（安全纵深）
  const report = analyzeScript(code);
  if (!report.valid) {
    throw new Error(`脚本语法错误：${report.syntaxError ?? '未知'}`);
  }

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const wrapped = `(function(){\n${code}\n})()`;
  let results;
  try {
    results = await browser.userScripts.execute({
      target: { tabId: tab.id },
      world: 'MAIN',
      js: [{ code: wrapped }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `脚本注入失败：${message}。若从未见过此提示，请确认已在 chrome://extensions 打开本扩展详情页并开启「允许用户脚本」（Allow User Scripts）开关。`,
    );
  }

  const out = results[0];
  if (out?.error) {
    throw new Error(out.error);
  }
  return {
    result: out?.result === undefined ? '' : String(out.result),
    snapshotSaved: true,
  };
}
```

- [ ] **Step 2: Update the tool description in `tools.ts`**

Current code (`lib/agent/tools.ts:509-516`):

```ts
const browserInjectScriptTool: BrowserAgentTool = {
  name: 'browser_inject_script',
  label: 'Inject Script',
  description:
    'Inject and execute a JavaScript snippet in the current page (MAIN world) for page modifications not covered by the other structured tools — e.g. reading mode, dark theme, or complex layout changes. The script is statically scanned for dangerous APIs before execution.',
  parameters: Type.Object({
    code: Type.String({ description: 'JavaScript source to execute in the page.' }),
  }),
```

Replace the `description` field with:

```ts
const browserInjectScriptTool: BrowserAgentTool = {
  name: 'browser_inject_script',
  label: 'Inject Script',
  description:
    "Inject and execute a JavaScript snippet in the current page (MAIN world) via Chrome's userScripts API for page modifications not covered by the other structured tools — e.g. reading mode, dark theme, or complex layout changes. The script is statically scanned for dangerous APIs before execution.",
  parameters: Type.Object({
    code: Type.String({ description: 'JavaScript source to execute in the page.' }),
  }),
```

- [ ] **Step 3: Type-check and run the unit test suite**

Run: `pnpm compile`
Expected: no errors. If `browser.userScripts` reports a type error, run `pnpm wxt prepare` first to regenerate `.wxt/types` (the userScripts types ship inside the `@wxt-dev/browser` package WXT already depends on — no new dependency needed) and re-run `pnpm compile`.

Run: `pnpm test`
Expected: all existing tests still pass, including `lib/agent/permissions.test.ts`'s `browser_inject_script` cases — this task doesn't touch permission-gating logic, so they should be unaffected.

- [ ] **Step 4: Manual verification — toggle OFF (error path)**

1. Run `pnpm dev`, load `.output/chrome-mv3` as an unpacked extension via `chrome://extensions` (Developer mode → Load unpacked) if not already loaded.
2. Go to `chrome://extensions`, open Aluminum's details page, confirm "Allow User Scripts" is **off**.
3. Open the side panel on any page, ask the AI to do something that requires `browser_inject_script` (e.g. "给页面加个阅读模式" / "toggle dark mode on this page using a custom script").
4. Approve the confirmation card.
5. Expected: the tool call fails and the chat shows an error message containing "允许用户脚本" (Allow User Scripts) guidance — not a silent failure or an unrelated stack trace.

- [ ] **Step 5: Manual verification — toggle ON (happy path + undo)**

1. On the same extension details page, switch "Allow User Scripts" **on**.
2. Repeat the same chat request from Step 4.
3. Expected: the confirmation card appears once, approving it applies the visible page change (e.g. dark background), and the tool result is not an error.
4. Ask the AI to undo, or trigger `browser_revert_changes` — expected: the page reverts to its prior state, same as before this migration.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/background.ts lib/agent/tools.ts
git commit -m "fix: execute browser_inject_script via chrome.userScripts instead of new Function"
```

---

### Task 3: Update documentation

**Files:**
- Modify: `docs/chrome-store-permission-justifications.md` (add a `userScripts` section)
- Modify: `docs/PROGRESS.md` (append one changelog row)
- Modify: `CLAUDE.md` (update the `entrypoints/background.ts` bullet in "Three-context messaging model")

**Interfaces:**
- None — this task only touches Markdown.

- [ ] **Step 1: Add the `userScripts` entry to the permission-justifications doc**

In `docs/chrome-store-permission-justifications.md`, insert a new section directly after the existing `## scripting` section (before `## storage`):

```markdown
## userScripts

**中文**：用于在用户明确要求且确认后，将 AI 生成的 JavaScript 代码通过 Chrome 官方的
`chrome.userScripts.execute()` API（而非 `eval`/`new Function`）注入并执行到当前页面，实现
阅读模式、深色主题等没有对应结构化工具覆盖的页面改造。该 API 是 Manifest V3 官方认可的动态
脚本执行通道，用户需在扩展详情页手动开启「允许用户脚本」开关后才能生效；未开启时该功能会
明确报错并提示用户开启，不会静默失败或绕过该同意步骤。

**English**: Used to inject and execute AI-generated JavaScript into the current page via
Chrome's official `chrome.userScripts.execute()` API (not `eval`/`new Function`), only after
explicit user confirmation, for page transformations not covered by the other structured tools
(e.g. reading mode, dark theme). This is the Manifest-V3-sanctioned channel for dynamic script
execution; the user must separately enable the "Allow User Scripts" toggle on the extension's
details page before it takes effect — if not enabled, the feature fails with a clear message
telling the user to enable it, rather than silently failing or bypassing that consent step.
```

- [ ] **Step 2: Append a changelog row to `PROGRESS.md`**

In `docs/PROGRESS.md`, add a new row at the top of the "变更日志" table (directly under the `| 日期 | 内容 | 关联 |` header and its separator row):

```markdown
| 2026-07-21 | Chrome 应用商店合规修复：`browser_inject_script` 从 `new Function` 迁移到 `chrome.userScripts.execute`，消除 Remote Hosted Code 政策违规；新增 `userScripts` manifest 权限与 Chrome 135 版本下限 | Spec-0002 |
```

- [ ] **Step 3: Update the `CLAUDE.md` architecture description**

In `CLAUDE.md`, under "### Three-context messaging model", find:

```markdown
- **`entrypoints/background.ts`** (service worker) — the message router and the only context with `browser.tabs`/`browser.scripting` access. Every DOM-touching action funnels through `executeInActiveTab`, which runs a function in the page's MAIN world via `browser.scripting.executeScript` and returns the result.
```

Replace with:

```markdown
- **`entrypoints/background.ts`** (service worker) — the message router and the only context with `browser.tabs`/`browser.scripting`/`browser.userScripts` access. Every DOM-touching action funnels through `executeInActiveTab`, which runs a function in the page's MAIN world via `browser.scripting.executeScript` and returns the result — except `browser_inject_script`, which hands the LLM-generated code string to `browser.userScripts.execute()` (Chrome's MV3-sanctioned dynamic-script API) instead of `eval`/`new Function`, per the Chrome Web Store Remote Hosted Code policy (ref: Spec-0002).
```

- [ ] **Step 4: Commit**

```bash
git add docs/chrome-store-permission-justifications.md docs/PROGRESS.md CLAUDE.md
git commit -m "docs: document userScripts migration in permission justifications, PROGRESS, and CLAUDE.md"
```
