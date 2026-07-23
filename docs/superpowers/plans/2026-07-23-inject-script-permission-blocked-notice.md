# Inject-Script Permission-Blocked Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `browser_inject_script` fails because the user hasn't enabled Chrome's per-extension
"Allow User Scripts" toggle, show a persistent, non-collapsible notice in the chat (with a one-click
button to jump to the extension's details page) instead of burying the (already-correct) error text
inside the collapsed "Agent 工具调用" log.

**Architecture:** A small pure-function module in `lib/agent/` detects the specific failure by
pattern-matching the tool name + a stable marker substring already present in the error text produced
by `entrypoints/background.ts`. The side panel's Zustand store (`entrypoints/sidepanel/store.ts`) calls
this detector inside its existing `tool_execution_end` handler and sets a boolean flag, reset at every
point `toolActivities` is already reset. `App.tsx` renders a new notice component when that flag is set,
styled like the existing `ConfirmationCard`/`UndoBar` cards.

**Tech Stack:** TypeScript, Zustand, React, Vitest, WXT (`browser` global auto-import).

## Global Constraints

- Do not modify `entrypoints/background.ts`, `lib/messaging.ts`, `lib/agent/tools.ts`, or
  `lib/agent/permissions.ts` — the existing error message and message protocol stay exactly as they are.
- Do not add a structured error code end-to-end (e.g. `{ code: 'user_scripts_disabled' }`). Detection is
  a string-marker match against the existing Chinese error text. This is the one deliberate exception to
  "avoid string matching" — the spec's design explicitly chose it over a protocol change for a
  single-error-type case (see `docs/superpowers/specs/2026-07-23-inject-script-permission-blocked-notice-design.md`).
- Never attempt to programmatically enable/toggle `chrome.userScripts` — Chrome exposes no API for this
  by design. The only allowed automation is navigating to the extension's own `chrome://extensions/?id=...`
  details page via `browser.tabs.create`; the user must still click the toggle themselves.
- New unit test goes in `lib/agent/` (the only directory `vitest.config.ts` currently covers). Do not
  expand `vitest.config.ts`'s `include` or add component/render tests — `entrypoints/` has no test
  infrastructure today and this feature doesn't need to be the one that adds it.
- Follow existing code style exactly: emoji-prefixed Chinese copy (no icon library), Tailwind classes
  matching the amber palette already used by `ConfirmationCard`.

---

### Task 1: Pure detector for the userScripts-disabled failure

**Files:**
- Create: `lib/agent/inject-script-blocked.ts`
- Test: `lib/agent/inject-script-blocked.test.ts`

**Interfaces:**
- Produces: `isUserScriptsToggleBlocked(toolName: string, result: unknown): boolean` — exported function
  that Task 2 imports and calls as `event.isError && isUserScriptsToggleBlocked(event.toolName, event.result)`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent/inject-script-blocked.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isUserScriptsToggleBlocked } from './inject-script-blocked';

describe('isUserScriptsToggleBlocked', () => {
  it('detects the userScripts-disabled error from browser_inject_script', () => {
    const result = {
      content: [
        {
          type: 'text',
          text:
            '脚本注入失败：Cannot read properties of undefined (reading \'execute\')。请在 chrome://extensions ' +
            '打开本扩展详情页，开启「允许用户脚本」（Allow User Scripts）开关后重试。',
        },
      ],
      details: {},
    };
    expect(isUserScriptsToggleBlocked('browser_inject_script', result)).toBe(true);
  });

  it('ignores other browser_inject_script failures (e.g. empty script)', () => {
    const result = { content: [{ type: 'text', text: '脚本为空' }], details: {} };
    expect(isUserScriptsToggleBlocked('browser_inject_script', result)).toBe(false);
  });

  it('ignores failures from other tools even if the text happens to match', () => {
    const result = {
      content: [{ type: 'text', text: '开启「允许用户脚本」（Allow User Scripts）开关后重试。' }],
      details: {},
    };
    expect(isUserScriptsToggleBlocked('browser_set_style', result)).toBe(false);
  });

  it('handles non-JSON-serializable result without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => isUserScriptsToggleBlocked('browser_inject_script', circular)).not.toThrow();
    expect(isUserScriptsToggleBlocked('browser_inject_script', circular)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/agent/inject-script-blocked.test.ts`
Expected: FAIL — `Cannot find module './inject-script-blocked'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/agent/inject-script-blocked.ts`:

```ts
const INJECT_SCRIPT_TOOL_NAME = 'browser_inject_script';
const USER_SCRIPTS_TOGGLE_MARKER = '允许用户脚本';

/**
 * Detects whether a `browser_inject_script` failure was caused by the user not having enabled
 * Chrome's per-extension "Allow User Scripts" toggle. `entrypoints/background.ts`'s `injectScript()`
 * always appends the `USER_SCRIPTS_TOGGLE_MARKER` phrase when `browser.userScripts.execute()` throws,
 * so a substring match against the stringified tool result is sufficient — see the design doc for why
 * this doesn't need a structured error code.
 */
export function isUserScriptsToggleBlocked(toolName: string, result: unknown): boolean {
  if (toolName !== INJECT_SCRIPT_TOOL_NAME) return false;
  let text: string;
  try {
    text = JSON.stringify(result) ?? '';
  } catch {
    return false;
  }
  return text.includes(USER_SCRIPTS_TOGGLE_MARKER);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/agent/inject-script-blocked.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/inject-script-blocked.ts lib/agent/inject-script-blocked.test.ts
git commit -m "feat: detect userScripts-toggle-disabled inject_script failures"
```

---

### Task 2: Wire detection into the side panel store

**Files:**
- Modify: `entrypoints/sidepanel/store.ts:91-123` (interface), `:132-146` (initial state), `:242-288`
  (three reset points), `:317-325` (turn-start reset), `:370-386` (`tool_execution_end` handler)

**Interfaces:**
- Consumes: `isUserScriptsToggleBlocked(toolName: string, result: unknown): boolean` from Task 1
  (`lib/agent/inject-script-blocked.ts`).
- Produces: `ChatState.userScriptsBlockedNotice: boolean`, read by Task 3's `App.tsx`.

- [ ] **Step 1: Add the field to `ChatState` and initial state**

In `entrypoints/sidepanel/store.ts`, add the import near the top (after the existing
`confirm-summary` import at line 25):

```ts
import { isUserScriptsToggleBlocked } from '@/lib/agent/inject-script-blocked';
```

In the `ChatState` interface (around line 98, right after `turnHasChanges: boolean;`):

```ts
  turnHasChanges: boolean;
  userScriptsBlockedNotice: boolean;
```

In the store's initial state object (around line 139, right after `turnHasChanges: false,`):

```ts
  turnHasChanges: false,
  userScriptsBlockedNotice: false,
```

- [ ] **Step 2: Reset the flag everywhere `toolActivities` is already reset**

There are four such places. Add `userScriptsBlockedNotice: false,` right next to each existing
`toolActivities: [],` line:

In `runAgent` (around line 317-325, the `set({...})` right before `RESET_TURN_SNAPSHOT`):

```ts
  set({
    messages: [...history, display, { role: 'assistant', content: '' }],
    toolActivities: [],
    userScriptsBlockedNotice: false,
    input: '',
    busy: true,
    error: null,
    pendingConfirmation: null,
    turnHasChanges: false,
  });
```

In `clear` (around line 245-252):

```ts
  clear: () => {
    activeAgent?.abort();
    pendingConfirmResolve = null;
    set({
      messages: [],
      toolActivities: [],
      userScriptsBlockedNotice: false,
      error: null,
      conversationId: genConversationId(),
      turnHasChanges: false,
      pendingConfirmation: null,
    });
  },
```

In `openConversation` (around line 266-273):

```ts
    set({
      messages,
      toolActivities: [],
      userScriptsBlockedNotice: false,
      conversationId: id,
      error: null,
      turnHasChanges: false,
      pendingConfirmation: null,
    });
```

In `removeConversation` (around line 280-286):

```ts
      set({
        messages: [],
        toolActivities: [],
        userScriptsBlockedNotice: false,
        conversationId: genConversationId(),
        turnHasChanges: false,
        pendingConfirmation: null,
      });
```

- [ ] **Step 3: Set the flag when the detector matches, in `tool_execution_end`**

Replace the `tool_execution_end` block (around line 370-385):

```ts
    if (event.type === 'tool_execution_end') {
      const blocked = event.isError && isToolGuardBlockResult(event.result);
      upsertToolActivity(set, {
        id: event.toolCallId,
        name: event.toolName,
        status: blocked ? 'blocked' : event.isError ? 'error' : 'done',
        detail: event.isError ? compactJson(event.result) : undefined,
      });
      if (event.isError && isUserScriptsToggleBlocked(event.toolName, event.result)) {
        set({ userScriptsBlockedNotice: true });
      }
      if (!event.isError) {
        if (event.toolName === 'browser_revert_changes') {
          set({ turnHasChanges: false });
        } else if (WRITE_TOOL_NAMES.has(event.toolName)) {
          set({ turnHasChanges: true });
        }
      }
    }
```

- [ ] **Step 4: Type-check the whole project**

Run: `pnpm compile`
Expected: no errors (this task only adds a boolean field and a few `set()` calls with matching shapes —
if TypeScript complains about a missing property in one of the four reset-point `set()` calls, it means
one was missed; add it there).

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/store.ts
git commit -m "feat: track userScripts-toggle-blocked state in the chat store"
```

---

### Task 3: Render the notice and verify manually

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx:35-60` (destructure new field), `:174-182` (render), add a new
  component near `ConfirmationCard` (after line 636, before `UndoBar`)

**Interfaces:**
- Consumes: `userScriptsBlockedNotice: boolean` from Task 2's store.

- [ ] **Step 1: Destructure the new field from the store**

In `App.tsx`, add `userScriptsBlockedNotice` to the destructured fields from `useChat()` (around
line 42, right after `turnHasChanges,`):

```ts
    turnHasChanges,
    userScriptsBlockedNotice,
```

- [ ] **Step 2: Add the notice component**

Add this new component in `App.tsx`, directly after the closing brace of `ConfirmationCard` (after
line 636, before `function UndoBar(...)`):

```tsx
function UserScriptsBlockedNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-1 font-medium text-amber-900 dark:text-amber-200">
        ⚠️ 有一项更强的页面改造能力被挡住了
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">
        注入脚本需要先在本扩展详情页开启「允许用户脚本」开关。
      </p>
      <button
        onClick={onOpenSettings}
        className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        🔧 前往开启
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Render it in the message flow**

In the `<main>` render block (around line 174), add the notice right after `ToolActivityList` and
before `ConfirmationCard`:

```tsx
              {toolActivities.length > 0 && <ToolActivityList activities={toolActivities} />}
              {userScriptsBlockedNotice && (
                <UserScriptsBlockedNotice
                  onOpenSettings={() =>
                    browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` })
                  }
                />
              )}
              {pendingConfirmation && (
```

`browser` is WXT's auto-imported global (already used the same way in `entrypoints/background.ts`) —
no new import needed.

- [ ] **Step 4: Type-check and run the existing test suite**

Run: `pnpm compile && pnpm test`
Expected: both pass — `pnpm compile` reports no errors, `pnpm test` still shows all existing suites
passing plus the 4 new tests from Task 1 (55 → 59 total).

- [ ] **Step 5: Build and manually verify in real Chrome**

This reproduces the exact scenario found during Spec-0002's manual verification, so the fix must be
checked against real Chrome, not just compiled:

```bash
pnpm build
```

Then:
1. `chrome://extensions` → reload the unpacked Aluminum extension from `.output/chrome-mv3` (or load it
   fresh if not already loaded).
2. Confirm on the extension's details page that "Allow User Scripts" is **off**.
3. Open a new tab on any page, open the Aluminum side panel, start a **new** conversation, and ask:
   "帮我把这个页面切换成阅读模式。"
4. Approve the confirmation card.
5. Expected: the new amber "⚠️ 有一项更强的页面改造能力被挡住了" card appears in the chat, not just
   inside the collapsed "Agent 工具调用" log (which should still separately show the `browser_inject_script`
   entry as "失败", unchanged).
6. Click "🔧 前往开启" — expected: a new tab opens directly on this extension's `chrome://extensions`
   details page.
7. Turn "Allow User Scripts" on, start **another new conversation**, repeat the same request — expected:
   this time no notice card appears (the tool should succeed via `browser_inject_script` directly).
8. Start a fresh conversation once more with the toggle back off, to confirm the notice reappears (i.e.
   it isn't stuck permanently on or off) — then leave the toggle in whichever state you actually want for
   normal use afterward.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/App.tsx
git commit -m "feat: show a persistent notice when the userScripts toggle blocks inject_script"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Detection (Task 1) ✅, state + lifecycle reset (Task 2) ✅, UI + jump button
  (Task 3) ✅, testing plan's "lightweight unit test, no component test" resolution ✅ (Task 1's test +
  Global Constraints explicitly closing the design doc's open question). Manual verification against
  the real Spec-0002 repro scenario ✅ (Task 3 Step 5).
- **Placeholder scan:** none — every step has complete, runnable code.
- **Type consistency:** `isUserScriptsToggleBlocked(toolName: string, result: unknown): boolean` is
  defined once in Task 1 and called with the same signature in Task 2. `userScriptsBlockedNotice: boolean`
  is named identically across the interface, initial state, all four reset points, and `App.tsx`'s
  destructuring/render.
