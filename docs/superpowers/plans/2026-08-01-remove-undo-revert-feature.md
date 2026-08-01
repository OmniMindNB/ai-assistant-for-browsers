# Remove Undo/Revert Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the per-turn page-change snapshot/undo feature (`browser_revert_changes` tool, turn snapshots, undo bar UI) end to end, since every write already requires a per-turn user confirmation and the extra safety net isn't worth its maintenance cost.

**Architecture:** Straight-line deletion across five layers (permission table → sidepanel UI/state → agent tool/system prompt → background message handlers/storage module → docs), each layer left compiling and passing tests before moving to the next, so the extension stays in a working, testable state after every task.

**Tech Stack:** WXT (Manifest V3), TypeScript, React, Zustand, Vitest, pnpm.

## Global Constraints

- Verify with `pnpm compile` (typecheck) and `pnpm test` (vitest run) after every task; run `pnpm build` at the end of the plan.
- Do not touch anything under `docs/superpowers/specs/` or `docs/superpowers/plans/` other than this plan file and its design spec — numbered/dated docs are immutable historical record.
- Do not touch Chrome Web Store submission docs (`docs/chrome-store-listing.en.md`, `docs/chrome-store-permission-justifications.md`, `docs/chrome-store-submission-guide.md`) or store screenshot assets (`screenshot-04-undo.png`, `demo/store-assets-frame.html`) — out of scope per the design spec.
- Do not touch `persistConversationSnapshot` / `store-context.test.tsx` "snapshot" tests in `entrypoints/sidepanel/store.ts` — that's chat-message persistence, an unrelated naming coincidence, not the page-change snapshot being removed.
- Design spec: `docs/superpowers/specs/2026-08-01-remove-undo-revert-feature-design.md`.

---

### Task 1: Remove the `auto_allow` permission level

**Files:**
- Modify: `lib/agent/permissions.ts`
- Test: `lib/agent/permissions.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `PermissionLevel` narrowed to `'always_allow' | 'confirm' | 'deny'` — Task 4's background/tool removal doesn't depend on this, but this task must land first so nothing else references `auto_allow` while it's being removed elsewhere.

- [ ] **Step 1: Remove the `auto_allow` test case**

In `lib/agent/permissions.test.ts`, delete this block (lines 20-22):

```ts
  it('auto-allows revert_changes', () => {
    expect(decideToolPermission('browser_revert_changes', {})).toEqual({ level: 'auto_allow' });
  });

```

- [ ] **Step 2: Run the test file to confirm it still passes**

Run: `pnpm vitest run lib/agent/permissions.test.ts`
Expected: PASS (the removed case is gone; nothing else changed yet).

- [ ] **Step 3: Remove `auto_allow` from the implementation**

In `lib/agent/permissions.ts`:

Delete:
```ts
export const AUTO_ALLOW_TOOL_NAMES = new Set(['browser_revert_changes']);

```

Change:
```ts
export type PermissionLevel = 'always_allow' | 'auto_allow' | 'confirm' | 'deny';
```
to:
```ts
export type PermissionLevel = 'always_allow' | 'confirm' | 'deny';
```

Change:
```ts
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return { level: 'always_allow' };
  if (AUTO_ALLOW_TOOL_NAMES.has(toolName)) return { level: 'auto_allow' };
  if (CONFIRM_TOOL_NAMES.has(toolName)) {
```
to:
```ts
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return { level: 'always_allow' };
  if (CONFIRM_TOOL_NAMES.has(toolName)) {
```

Change:
```ts
  if (decision.level === 'always_allow' || decision.level === 'auto_allow') return undefined;
```
to:
```ts
  if (decision.level === 'always_allow') return undefined;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run lib/agent/permissions.test.ts && pnpm compile`
Expected: PASS with no errors. (`pnpm compile` will still fail at this point if other files reference `browser_revert_changes`/`auto_allow`/`RevertChangesResult`, etc. — those are removed in later tasks. If `pnpm compile` fails only on files this task doesn't touch, that's expected; re-run the full `pnpm compile` again at the end of Task 4.)

- [ ] **Step 5: Commit**

```bash
git add lib/agent/permissions.ts lib/agent/permissions.test.ts
git commit -m "refactor(permissions): remove auto_allow level (was only for browser_revert_changes)"
```

---

### Task 2: Remove the undo UI and turn-change tracking from the sidepanel

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/components/AgentActivityCard.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `store.ts`'s `ChatState` no longer exposes `turnHasChanges` or `revertTurnChanges`; the sidepanel no longer sends `'RESET_TURN_SNAPSHOT'` or `'REVERT_CHANGES'` messages. Task 3 and Task 4 do not depend on this — they can be done in any order relative to this task, but this one is sequenced first because it's the most visible slice of the removal.

- [ ] **Step 1: Trim the undo-bar test in `workbench-components.test.tsx`**

Replace the test (currently named `'places the activity card before confirmation and undo cards without changing callbacks'`, lines 580-613):

```tsx
  it('places the activity card before confirmation and undo cards without changing callbacks', async () => {
    const user = userEvent.setup();
    (chatStore as any).toolActivities = [activity('confirming')];
    (chatStore as any).pendingConfirmation = {
      toolName: 'browser_type',
      summary: 'AI wants to type a value.',
    };
    const { rerender } = render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const activityStatus = screen.getByText('Waiting for approval');
    const confirmationTitle = screen.getByText(/Please confirm before modifying the page/);
    expect(activityStatus.compareDocumentPosition(confirmationTitle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByRole('button', { name: 'Approve this turn' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(true);

    (chatStore as any).pendingConfirmation = null;
    chatStore.turnHasChanges = true;
    rerender(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const undoStatus = screen.getByText('● Page modified this turn');
    expect(activityStatus.compareDocumentPosition(undoStatus) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByRole('button', { name: 'Undo this turn' }));
    expect(chatStore.revertTurnChanges).toHaveBeenCalledOnce();
  });
```

with:

```tsx
  it('places the activity card before the confirmation card without changing callbacks', async () => {
    const user = userEvent.setup();
    (chatStore as any).toolActivities = [activity('confirming')];
    (chatStore as any).pendingConfirmation = {
      toolName: 'browser_type',
      summary: 'AI wants to type a value.',
    };
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    const activityStatus = screen.getByText('Waiting for approval');
    const confirmationTitle = screen.getByText(/Please confirm before modifying the page/);
    expect(activityStatus.compareDocumentPosition(confirmationTitle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.click(screen.getByRole('button', { name: 'Approve this turn' }));
    expect(chatStore.respondToConfirmation).toHaveBeenCalledWith(true);
  });
```

Also delete the two now-unused fields from the shared `chatStore` mock near the top of the file:

```ts
  turnHasChanges: false,
```
(line 26) and
```ts
  revertTurnChanges: vi.fn(),
```
(line 56).

- [ ] **Step 2: Run the test file — expect failures**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: FAIL — `App.tsx` still destructures `turnHasChanges`/`revertTurnChanges` from `useChat()`, which the trimmed mock no longer provides as those exact fields were deleted from the literal (TypeScript won't catch this at test-run time since the mock is untyped via `vi.mock`, but `App.tsx` still renders `<UndoBar>` referencing `t('confirm.undoBarStatus')`/`t('confirm.undoBarButton')`, so if any other test exercises that path with `turnHasChanges` truthy it will now read `undefined` instead of `true`). If nothing actually fails here, proceed — the point of this step is to confirm no leftover undo-bar assertion still passes silently; re-check by grepping the test file for `undoBar` / `Undo this turn` / `revertTurnChanges` and confirm zero remaining matches before continuing.

Run: `/opt/homebrew/bin/rg -n "undoBar|Undo this turn|revertTurnChanges|turnHasChanges" entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: no output.

- [ ] **Step 3: Remove undo state and the revert action from `store.ts`**

In `entrypoints/sidepanel/store.ts`:

Change the import from `@/lib/messaging` (remove `RevertChangesResult`):
```ts
import {
  sendMessage,
  type ActiveTabInfo,
  type MessageResponse,
  type PageSelection,
  type RevertChangesResult,
} from '@/lib/messaging';
```
to:
```ts
import {
  sendMessage,
  type ActiveTabInfo,
  type MessageResponse,
  type PageSelection,
} from '@/lib/messaging';
```

Remove `'RESET_TURN_SNAPSHOT'` and `'REVERT_CHANGES'` from `REQUIRED_AGENT_MESSAGE_TYPES`:
```ts
  'SET_STORAGE',
  'RESET_TURN_SNAPSHOT',
  'REVERT_CHANGES',
] as const;
```
to:
```ts
  'SET_STORAGE',
] as const;
```

Delete the `WRITE_TOOL_NAMES` constant and its comment:
```ts
/** 会改动页面/浏览器状态的工具 = 需要确认的工具，直接复用权限表，避免两处漂移。 */
const WRITE_TOOL_NAMES = CONFIRM_TOOL_NAMES;

```
(If `CONFIRM_TOOL_NAMES` becomes unused in this file after this deletion, also remove it from the `@/lib/agent/permissions` import — check with the grep in Step 4 below before removing the import line.)

Delete `turnHasChanges: boolean;` from the `ChatState` interface, and delete `revertTurnChanges: () => Promise<void>;` from the same interface.

Delete the comment and module-level variable:
```ts
/** 当前这一轮固定下来的目标 tabId；用于 revertTurnChanges 在轮次结束后仍能撤销正确的标签页。 */
let currentTurnTabId: number | null = null;
```

Delete the `revertTurnChanges` action entirely:
```ts
  revertTurnChanges: async () => {
    if (currentTurnTabId === null) {
      set({ error: t('store.noRevertTabInfo') });
      return;
    }
    try {
      const res = (await sendMessage('REVERT_CHANGES', undefined, currentTurnTabId)) as MessageResponse<RevertChangesResult>;
      if (!res.ok) throw new Error(res.error ?? t('store.revertFailed'));
      if (!res.data?.reverted) {
        set({ turnHasChanges: false, error: t('store.noChangesToRevert') });
        return;
      }
      set({ turnHasChanges: false });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

```

Remove the `turnHasChanges: false,` line from each of these four `set({ ... })` calls (in `clear`, `openConversation`, `removeConversation`, and the run-start block), leaving the rest of each object literal unchanged:
- In `clear()` (was line 516)
- In `openConversation()` (was line 551)
- In `removeConversation()` (was line 594)
- In the run-start `set({...})` block (was line 698)

Remove the initial `turnHasChanges: false,` from the store's initial state object (was line 277).

Remove the `currentTurnTabId = tabId;` line (was line 667) — leave the `const tabId = tab.id;` line above it untouched, since `tabId` is still used later in the same function for the browser agent tools.

Remove the line:
```ts
  await sendMessage('RESET_TURN_SNAPSHOT', undefined, tabId).catch(() => undefined);
```
(was line 700).

Simplify the tool-activity event handler branch (was lines 780-786):
```ts
      if (!event.isError) {
        if (event.toolName === 'browser_revert_changes') {
          set({ turnHasChanges: false });
        } else if (WRITE_TOOL_NAMES.has(event.toolName)) {
          set({ turnHasChanges: true });
        }
      }
```
to nothing — delete the whole `if (!event.isError) { ... }` block, since it existed solely to track `turnHasChanges`.

- [ ] **Step 4: Check whether `CONFIRM_TOOL_NAMES` import is still needed in `store.ts`**

Run: `/opt/homebrew/bin/rg -n "CONFIRM_TOOL_NAMES" entrypoints/sidepanel/store.ts`

If the only remaining match is the `import { CONFIRM_TOOL_NAMES } from '@/lib/agent/permissions';` line itself, delete that import line. If there are other usages, leave the import as-is.

- [ ] **Step 5: Remove the undo bar from `App.tsx`**

In `entrypoints/sidepanel/App.tsx`, remove `turnHasChanges,` and `revertTurnChanges,` from the destructured `useChat()` result (both currently present in the same destructuring block, e.g. `turnHasChanges` near line 39 and `revertTurnChanges` near line 64).

Delete the render line:
```tsx
                {!busy && !pendingConfirmation && turnHasChanges && <UndoBar onRevert={revertTurnChanges} />}
```

Delete the `UndoBar` component definition:
```tsx
function UndoBar({ onRevert }: { onRevert: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-emerald-600 dark:text-emerald-400">{t('confirm.undoBarStatus')}</span>
      <button
        onClick={onRevert}
        className="font-medium text-red-600 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-red-400"
      >
        {t('confirm.undoBarButton')}
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Remove the tool-name mapping in `AgentActivityCard.tsx`**

Delete this line from the tool-name-to-i18n-key map:
```ts
  browser_revert_changes: 'agentActivity.tool.revertChanges',
```

- [ ] **Step 7: Remove and reword i18n keys**

In `lib/i18n/locales/zh.ts`, delete these lines:
```ts
  'agentActivity.tool.revertChanges': '撤销更改',
```
```ts
  'confirm.undoBarStatus': '● 本轮已修改页面',
  'confirm.undoBarButton': '撤销本轮更改',
```
```ts
  'store.noRevertTabInfo': '没有可撤销的标签页信息。',
  'store.revertFailed': '撤销失败',
  'store.noChangesToRevert': '本轮没有可撤销的改动。',
```

And reword:
```ts
  'confirm.approveHint': '批准后，本轮内后续的写操作会自动执行，无需逐条确认；这轮做的所有改动之后都能一键撤销。',
```
to:
```ts
  'confirm.approveHint': '批准后，本轮内后续的写操作会自动执行，无需逐条确认。',
```

In `lib/i18n/locales/en.ts`, delete these lines:
```ts
  'agentActivity.tool.revertChanges': 'Revert changes',
```
```ts
  'confirm.undoBarStatus': '● Page modified this turn',
  'confirm.undoBarButton': 'Undo this turn',
```
```ts
  'store.noRevertTabInfo': 'No tab information available to undo.',
  'store.revertFailed': 'Undo failed',
  'store.noChangesToRevert': 'No changes to undo this turn.',
```

And reword:
```ts
  'confirm.approveHint':
    'Once approved, further write actions this turn run automatically without asking again; every change made this turn can be undone with one click.',
```
to:
```ts
  'confirm.approveHint':
    'Once approved, further write actions this turn run automatically without asking again.',
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/i18n.test.ts`
Expected: PASS. The `i18n.test.ts` test `'keeps the English and Chinese dictionaries on the same key set'` confirms the zh/en deletions stayed symmetric.

Run: `pnpm compile`
Expected: may still fail on files not yet touched (`lib/agent/tools.ts`, `entrypoints/background.ts`, `lib/messaging.ts` still reference `RevertChangesResult`/`browser_revert_changes` until Tasks 3-4). Confirm the only remaining errors are in those files, not in `store.ts`/`App.tsx`/`AgentActivityCard.tsx`.

- [ ] **Step 9: Run the full test suite**

Run: `pnpm test`
Expected: PASS (no other test file references the removed sidepanel fields/UI).

- [ ] **Step 10: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/AgentActivityCard.tsx entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "refactor(sidepanel): remove undo bar and turn-change tracking"
```

---

### Task 3: Remove the `browser_revert_changes` agent tool and its system-prompt mention

**Files:**
- Modify: `lib/agent/tools.ts`
- Modify: `lib/agent/system-prompt.ts`
- Modify: `lib/agent/system-prompt.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2. Depends on Task 1 having already removed `AUTO_ALLOW_TOOL_NAMES` from `lib/agent/permissions.ts` — this task removes the last two consumers of that name (discovered during Task 1's review: a case-sensitive repo grep for `auto_allow` during planning missed these because the constant name is upper-case).
- Produces: `createBrowserTools()` no longer registers `browser_revert_changes`; the LLM is no longer told this tool exists; `lib/agent/system-prompt.ts` and its test no longer reference `AUTO_ALLOW_TOOL_NAMES`. Task 4 removes the backend handler this tool used to call — safe to do in either order, but doing this first means Task 4 deletes purely-dead backend code.

- [ ] **Step 1: Remove the tool from `lib/agent/tools.ts`**

Remove `type RevertChangesResult,` from the `@/lib/messaging` import block.

Remove `makeRevertChangesTool(tabId),` from the array in `createBrowserTools`:
```ts
    makeSetStorageTool(tabId),
    makeRevertChangesTool(tabId),
  ];
```
to:
```ts
    makeSetStorageTool(tabId),
  ];
```

Delete the function:
```ts
function makeRevertChangesTool(tabId: number): BrowserAgentTool {
  return {
    name: 'browser_revert_changes',
    label: 'Revert Changes',
    description:
      'Undo every page modification made during this turn (DOM edits, style changes, storage writes, navigation), restoring the page to its state before this turn started. Safe to call whenever the user asks to undo.',
    parameters: Type.Object({}),
    execute: async () => {
      const response = (await sendMessage('REVERT_CHANGES', undefined, tabId)) as MessageResponse<RevertChangesResult>;
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
}

```

- [ ] **Step 2: Remove `AUTO_ALLOW_TOOL_NAMES` usage from `lib/agent/system-prompt.ts`**

Change the import:
```ts
import { AUTO_ALLOW_TOOL_NAMES, CONFIRM_TOOL_NAMES } from './permissions';
```
to:
```ts
import { CONFIRM_TOOL_NAMES } from './permissions';
```

Change the comment and constant:
```ts
/**
 * 提示词里列举的写入/交互工具名，直接由权限表推导，避免新增工具时提示词漏改
 * （ref: permissions.ts 的 CONFIRM_TOOL_NAMES / AUTO_ALLOW_TOOL_NAMES）。
 */
const WRITE_TOOL_LIST = [...CONFIRM_TOOL_NAMES, ...AUTO_ALLOW_TOOL_NAMES].join('、');
```
to:
```ts
/**
 * 提示词里列举的写入/交互工具名，直接由权限表推导，避免新增工具时提示词漏改
 * （ref: permissions.ts 的 CONFIRM_TOOL_NAMES）。
 */
const WRITE_TOOL_LIST = [...CONFIRM_TOOL_NAMES].join('、');
```

(`CONFIRM_TOOL_NAMES` is a `Set<string>`, which has no `.join()` method — it must be spread into an array first, same as the original `[...CONFIRM_TOOL_NAMES, ...AUTO_ALLOW_TOOL_NAMES]` did.)

- [ ] **Step 3: Remove `AUTO_ALLOW_TOOL_NAMES` usage from `lib/agent/system-prompt.test.ts`**

Change the import:
```ts
import {
  AUTO_ALLOW_TOOL_NAMES,
  CONFIRM_TOOL_NAMES,
  DENY_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from './permissions';

const KNOWN_TOOL_NAMES = new Set([
  ...READ_ONLY_TOOL_NAMES,
  ...AUTO_ALLOW_TOOL_NAMES,
  ...CONFIRM_TOOL_NAMES,
]);
```
to:
```ts
import {
  CONFIRM_TOOL_NAMES,
  DENY_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from './permissions';

const KNOWN_TOOL_NAMES = new Set([
  ...READ_ONLY_TOOL_NAMES,
  ...CONFIRM_TOOL_NAMES,
]);
```

Change the test:
```ts
describe('buildSystemPrompt tool listing', () => {
  it('lists every confirm-level and auto-allow tool', () => {
    for (const name of [...CONFIRM_TOOL_NAMES, ...AUTO_ALLOW_TOOL_NAMES]) {
      expect(SYSTEM_PROMPT).toContain(name);
    }
  });
```
to:
```ts
describe('buildSystemPrompt tool listing', () => {
  it('lists every confirm-level tool', () => {
    for (const name of CONFIRM_TOOL_NAMES) {
      expect(SYSTEM_PROMPT).toContain(name);
    }
  });
```

- [ ] **Step 4: Reword the write-tool guidance sentence**

In `lib/agent/system-prompt.ts`, find the write-tool guidance sentence and remove the clause about `browser_revert_changes`:

```ts
      '当用户要求修改或操作当前页面（例如去广告、切换阅读模式、改样式、移除元素、填写表单、点击、跳转、撤销更改等）时，请直接调用对应的写工具去完成，不需要先做完整的实现巡检；只有在必须先定位具体元素或选择器时，才用 browser_query_dom / browser_get_html 做少量确认。写工具首次调用会触发一次性用户确认——这些操作会逐一向用户展示并需要确认，且整轮改动可通过 browser_revert_changes 完整撤销，因此可以放心直接调用，用户批准后本轮内的同类调用会自动执行，不要因为担心权限而绕过工具去建议用户手动操作。',
```

to:

```ts
      '当用户要求修改或操作当前页面（例如去广告、切换阅读模式、改样式、移除元素、填写表单、点击、跳转等）时，请直接调用对应的写工具去完成，不需要先做完整的实现巡检；只有在必须先定位具体元素或选择器时，才用 browser_query_dom / browser_get_html 做少量确认。写工具首次调用会触发一次性用户确认——这些操作会逐一向用户展示并需要确认，因此可以放心直接调用，用户批准后本轮内的同类调用会自动执行，不要因为担心权限而绕过工具去建议用户手动操作。',
```

(Note: "撤销更改" was also removed from the example list of user requests, since undo is no longer a thing the agent can do.)

- [ ] **Step 5: Search for any other test asserting the old prompt/tool text**

Run: `/opt/homebrew/bin/rg -n "browser_revert_changes|撤销更改|AUTO_ALLOW_TOOL_NAMES" lib/agent/*.test.ts lib/final-review.test.ts`

If any match appears beyond what Steps 2-4 already handled, update or remove that assertion to match the new text (do not leave it asserting stale text).

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm compile`
Expected: may still fail only in `entrypoints/background.ts` / `lib/messaging.ts` (Task 4 not done yet); confirm `lib/agent/tools.ts`, `lib/agent/system-prompt.ts`, and `lib/agent/system-prompt.test.ts` are clean.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/tools.ts lib/agent/system-prompt.ts lib/agent/system-prompt.test.ts
git commit -m "refactor(agent): remove browser_revert_changes tool and AUTO_ALLOW_TOOL_NAMES from the system prompt"
```

---

### Task 4: Remove the backend snapshot machinery and messaging types

**Files:**
- Delete: `lib/agent/turn-snapshot.ts`
- Delete: `lib/agent/turn-snapshot.test.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/messaging.ts`

**Interfaces:**
- Consumes: nothing (this task's implementation was only reachable from the tool removed in Task 3 and the sidepanel calls removed in Task 2 — after Tasks 2-3, everything this task deletes is dead code).
- Produces: `MessageType` narrowed (no `'RESET_TURN_SNAPSHOT' | 'REVERT_CHANGES'`), `SetStorageResult` has only `{ area, key }`, `RevertChangesResult` type is gone. Nothing downstream depends on these — this is the last code task.

- [ ] **Step 1: Delete the turn-snapshot module and its test**

```bash
rm lib/agent/turn-snapshot.ts lib/agent/turn-snapshot.test.ts
```

- [ ] **Step 2: Remove message types from `lib/messaging.ts`**

Change:
```ts
  | 'NAVIGATE_TAB'
  | 'SET_STORAGE'
  | 'RESET_TURN_SNAPSHOT'
  | 'REVERT_CHANGES'
  | 'CHAT';
```
to:
```ts
  | 'NAVIGATE_TAB'
  | 'SET_STORAGE'
  | 'CHAT';
```

Delete:
```ts
export interface RevertChangesResult {
  reverted: boolean;
  navigatedBack?: boolean;
}

```

Change:
```ts
export interface SetStorageResult {
  area: 'local' | 'session';
  key: string;
  previousValue: string | null;
}
```
to:
```ts
export interface SetStorageResult {
  area: 'local' | 'session';
  key: string;
}
```

- [ ] **Step 3: Remove backend handlers and call sites in `entrypoints/background.ts`**

Remove `type RevertChangesResult,` from the `@/lib/messaging` import block.

Change the `turn-snapshot` import block:
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
to nothing — delete the whole block (the module no longer exists).

Remove `'RESET_TURN_SNAPSHOT'` and `'REVERT_CHANGES'` from `SUPPORTED_MESSAGE_TYPES`:
```ts
  'NAVIGATE_TAB',
  'SET_STORAGE',
  'RESET_TURN_SNAPSHOT',
  'REVERT_CHANGES',
  'CHAT',
] as const;
```
to:
```ts
  'NAVIGATE_TAB',
  'SET_STORAGE',
  'CHAT',
] as const;
```

Change the tab-close listener:
```ts
  // Tab 关闭后其"本轮"快照、以及"该 tab 上次展示的会话"记录都不再可能被用到，
  // 及时清理避免占用 storage.session 的共享配额。
  browser.tabs.onRemoved.addListener((tabId) => {
    clearSnapshot(tabId).catch((err: unknown) => console.error('[Aluminum] clearSnapshot on tab close:', err));
    clearConversationIdForTab(tabId).catch((err: unknown) =>
      console.error('[Aluminum] clearConversationIdForTab on tab close:', err),
    );
  });
```
to:
```ts
  // Tab 关闭后"该 tab 上次展示的会话"记录不再可能被用到，及时清理避免占用 storage 配额。
  browser.tabs.onRemoved.addListener((tabId) => {
    clearConversationIdForTab(tabId).catch((err: unknown) =>
      console.error('[Aluminum] clearConversationIdForTab on tab close:', err),
    );
  });
```

Remove the two switch cases:
```ts
    case 'RESET_TURN_SNAPSHOT':
      return resetTurnSnapshot(requireTabId(message));

    case 'REVERT_CHANGES':
      return revertChanges(requireTabId(message));

```

Delete the `ensureTurnSnapshot` function:
```ts
async function ensureTurnSnapshot(tabId: number): Promise<void> {
  if (await hasSnapshot(tabId)) return;
  const capture = await executeInTab(
    tabId,
    null,
    (): CapturePageState => ({
      url: location.href,
      headHTML: document.head.innerHTML,
      bodyHTML: document.body.innerHTML,
      htmlAttrs: Array.from(document.documentElement.attributes).map((attr) => [attr.name, attr.value]),
      bodyAttrs: Array.from(document.body.attributes).map((attr) => [attr.name, attr.value]),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  );
  await beginSnapshotIfNeeded(tabId, capture);
}

```

Remove the `await ensureTurnSnapshot(tabId);` call (and the blank line right after it) from the start of each of these eight functions: `setStyle`, `modifyDom`, `clickElement`, `typeText`, `selectOption`, `scrollPage`, `navigateTab`, `setStorage`. Example for `setStyle` — change:
```ts
async function setStyle(payload: SetStylePayload, tabId: number): Promise<SetStyleResult> {
  await ensureTurnSnapshot(tabId);

  return executeInTab(tabId, payload, (input): SetStyleResult => {
```
to:
```ts
async function setStyle(payload: SetStylePayload, tabId: number): Promise<SetStyleResult> {
  return executeInTab(tabId, payload, (input): SetStyleResult => {
```
Apply the same pattern (delete the `await ensureTurnSnapshot(tabId);` line and the blank line after it, leave everything else in each function unchanged) to `modifyDom`, `clickElement`, `typeText`, `selectOption`, `scrollPage`, `navigateTab`, and `setStorage`.

Delete the `revertChanges` and `resetTurnSnapshot` functions (including the comment above `revertChanges`):
```ts
// 撤销"本轮"全部改动：若本轮发生过跳转，直接跳回原 URL（跳转前的 DOM 已不可复原，
// 也没有意义）；否则依次恢复 storage、head.innerHTML、body.innerHTML、html/body 自身的属性
// （style、class 等）、滚动位置。撤销后清空该 tab 的快照。
async function revertChanges(tabId: number): Promise<RevertChangesResult> {
  const tab = await resolveTargetTab(tabId);

  const snapshot = await getSnapshot(tab.id);
  if (!snapshot) return { reverted: false };

  const currentUrl = await executeInTab(tab.id, null, (): string => location.href);
  if (currentUrl !== snapshot.url) {
    await browser.tabs.update(tab.id, { url: snapshot.url });
    await clearSnapshot(tab.id);
    return { reverted: true, navigatedBack: true };
  }

  await executeInTab(tab.id, snapshot, (snap): void => {
    for (const entry of snap.storageEntries) {
      const store = entry.area === 'session' ? sessionStorage : localStorage;
      if (entry.previousValue === null) store.removeItem(entry.key);
      else store.setItem(entry.key, entry.previousValue);
    }
    document.head.innerHTML = snap.headHTML;
    document.body.innerHTML = snap.bodyHTML;
    // body.innerHTML 只替换子节点，不会撤销直接打在 <html>/<body> 元素自身的改动
    // （护眼模式等页面级视觉改造常见做法：给 documentElement/body 加 style/class），
    // 所以要单独把这两个元素自身的属性也恢复到快照时的状态。
    const restoreAttrs = (el: Element, attrs: [string, string][]): void => {
      const keep = new Set(attrs.map(([name]) => name));
      for (const name of Array.from(el.attributes).map((attr) => attr.name)) {
        if (!keep.has(name)) el.removeAttribute(name);
      }
      for (const [name, value] of attrs) el.setAttribute(name, value);
    };
    restoreAttrs(document.documentElement, snap.htmlAttrs);
    restoreAttrs(document.body, snap.bodyAttrs);
    window.scrollTo(snap.scrollX, snap.scrollY);
  });
  await clearSnapshot(tab.id);
  return { reverted: true, navigatedBack: false };
}

async function resetTurnSnapshot(tabId: number): Promise<{ ok: true }> {
  await clearSnapshot(tabId);
  return { ok: true };
}

```

In `setStorage`, change:
```ts
async function setStorage(payload: SetStoragePayload, tabId: number): Promise<SetStorageResult> {
  return executeInTab(tabId, payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    const previousValue = store.getItem(key);
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key, previousValue };
  });

  await recordStorageEntryIfAbsent(tabId, { area: result.area, key: result.key, previousValue: result.previousValue });
  return result;
}
```
to:
```ts
async function setStorage(payload: SetStoragePayload, tabId: number): Promise<SetStorageResult> {
  return executeInTab(tabId, payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key };
  });
}
```

(This also removes the now-dead `const result = ...` / trailing `recordStorageEntryIfAbsent` shape from the version shown earlier in the design spec's file read — the function becomes a direct `return executeInTab(...)`, matching the pattern used by the other five write handlers like `setStyle`.)

- [ ] **Step 4: Search for any remaining references**

Run: `/opt/homebrew/bin/rg -n "revert|Revert|undo|Undo|ensureTurnSnapshot|turn-snapshot" entrypoints/background.ts lib/messaging.ts lib/agent/tools.ts`
Expected: no output.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `pnpm compile`
Expected: PASS with zero errors — this is the first point where the whole codebase should typecheck clean again.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A lib/agent/turn-snapshot.ts lib/agent/turn-snapshot.test.ts entrypoints/background.ts lib/messaging.ts
git commit -m "refactor(background): remove turn-snapshot module and REVERT_CHANGES/RESET_TURN_SNAPSHOT handlers"
```

(Use `git add -A` scoped to these paths since two of them are deletions; `git add <deleted-path>` also stages deletions, so an explicit path list works too — just make sure `git status` shows exactly these four paths staged before committing.)

---

### Task 5: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/privacy-policy.en.md`

**Interfaces:**
- Consumes: nothing (pure text; no code dependency on Tasks 1-4, but sequenced after them so the docs describe the actual post-removal codebase).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update `CLAUDE.md`**

Change:
```md
- **`tools.ts`** — every `browser_*` AgentTool. Read-only tools (`browser_read_page`, `browser_query_dom`, `browser_get_html`, `browser_get_scripts`, `browser_get_stylesheets`, `browser_get_computed_style`, `browser_get_page_meta`, `browser_screenshot`) vs. write/interactive tools (`browser_set_style`, `browser_modify_dom`, `browser_click`, `browser_type`, `browser_select`, `browser_scroll`, `browser_navigate`, `browser_set_storage`) vs. `browser_revert_changes`. `browser_inspect_page_implementation` is an aggregate tool that gathers meta/text/HTML/DOM/scripts/stylesheets/computed-styles in one call plus a keyword-matched `evidenceSummary`, meant to short-circuit the "how is this page implemented" class of question in a single round-trip.
- **`permissions.ts`** — Deny-First policy: `decideToolPermission` classifies every tool into `always_allow` (read-only) / `auto_allow` (`browser_revert_changes`) / `confirm` (all write/interactive tools) / `deny` (unknown tools, and tool-specific hard blocks like non-http(s) navigation or scripts that fail `analyzeScript`).
- **`confirm-gate.ts`** — implements "confirm once per turn": the first `confirm`-level tool call in a turn awaits the UI's `onConfirm`; the approve/deny decision is cached in `ConfirmGateState` and reused for the rest of that turn without re-prompting.
- **`turn-snapshot.ts`** — per-tab snapshot (URL, `body.innerHTML`, scroll position, storage entries touched) captured lazily on the first write in a turn; `browser_revert_changes` restores it (or navigates back if the turn included a navigation, since DOM state pre-navigation isn't recoverable).
```
to:
```md
- **`tools.ts`** — every `browser_*` AgentTool. Read-only tools (`browser_read_page`, `browser_query_dom`, `browser_get_html`, `browser_get_scripts`, `browser_get_stylesheets`, `browser_get_computed_style`, `browser_get_page_meta`, `browser_screenshot`) vs. write/interactive tools (`browser_set_style`, `browser_modify_dom`, `browser_click`, `browser_type`, `browser_select`, `browser_scroll`, `browser_navigate`, `browser_set_storage`). `browser_inspect_page_implementation` is an aggregate tool that gathers meta/text/HTML/DOM/scripts/stylesheets/computed-styles in one call plus a keyword-matched `evidenceSummary`, meant to short-circuit the "how is this page implemented" class of question in a single round-trip.
- **`permissions.ts`** — Deny-First policy: `decideToolPermission` classifies every tool into `always_allow` (read-only) / `confirm` (all write/interactive tools) / `deny` (unknown tools, and tool-specific hard blocks like non-http(s) navigation or scripts that fail `analyzeScript`).
- **`confirm-gate.ts`** — implements "confirm once per turn": the first `confirm`-level tool call in a turn awaits the UI's `onConfirm`; the approve/deny decision is cached in `ConfirmGateState` and reused for the rest of that turn without re-prompting.
```

Change:
```md
When adding a new write tool: register it in `tools.ts`, add it to `CONFIRM_TOOLS` (or another bucket) in `permissions.ts`, and call `ensureTurnSnapshot`/similar in its `background.ts` handler before mutating anything — the confirm gate and undo flow both depend on this being consistent.
```
to:
```md
When adding a new write tool: register it in `tools.ts` and add it to `CONFIRM_TOOL_NAMES` (or another bucket) in `permissions.ts` — the confirm gate depends on this being consistent.
```

- [ ] **Step 2: Update `README.md`**

Change:
```md
> 值得信赖的浏览器页面 Agent —— 修改页面前逐项征求你的确认、随时一键撤销，回答基于页面证据而非泛泛而谈；接入你自己选的、自己持有 Key 的模型，对话历史只留在本地、不上传云端。
```
to:
```md
> 值得信赖的浏览器页面 Agent —— 修改页面前逐项征求你的确认，回答基于页面证据而非泛泛而谈；接入你自己选的、自己持有 Key 的模型，对话历史只留在本地、不上传云端。
```

Delete the bullet:
```md
- ↩️ **一键撤销**：每轮写入前自动生成快照，改坏了随时撤销这一轮的全部改动
```

Change:
```md
  sidepanel/        # 侧边栏 React 应用（对话 UI、确认卡片、撤销栏）
```
to:
```md
  sidepanel/        # 侧边栏 React 应用（对话 UI、确认卡片）
```

Change:
```md
    tools.ts        # browser_* 工具定义（只读 / 写入 / 撤销）
```
to:
```md
    tools.ts        # browser_* 工具定义（只读 / 写入）
```

Delete the line:
```md
    turn-snapshot.ts# 写入前快照，供 browser_revert_changes 撤销
```

- [ ] **Step 3: Update `README.en.md`**

Change:
```md
> A trustworthy browser page agent — asks for your confirmation before every page change, with one-click undo at any time; answers are grounded in page evidence, not generic guesses. Bring your own model with your own API key; conversation history stays local and is never uploaded.
```
to:
```md
> A trustworthy browser page agent — asks for your confirmation before every page change; answers are grounded in page evidence, not generic guesses. Bring your own model with your own API key; conversation history stays local and is never uploaded.
```

Delete the bullet:
```md
- ↩️ **One-click undo**: a snapshot is captured automatically before each turn's first write, so you can always undo everything that turn changed
```

Change:
```md
  sidepanel/        # Side panel React app (chat UI, confirmation card, undo bar)
```
to:
```md
  sidepanel/        # Side panel React app (chat UI, confirmation card)
```

Change:
```md
    tools.ts        # browser_* tool definitions (read-only / write / undo)
```
to:
```md
    tools.ts        # browser_* tool definitions (read-only / write)
```

Delete the line:
```md
    turn-snapshot.ts# Snapshot before writes, used by browser_revert_changes to undo
```

- [ ] **Step 4: Update `docs/privacy-policy.en.md`**

Change the table row:
```md
| Session and undo state | The conversation associated with a tab and a temporary snapshot used to undo page changes, which can include page HTML, element attributes, page storage values changed during the turn, URL, and scroll position | Stored in `chrome.storage.session`, which is browser-session storage and is not synced by Aluminum | Not sent as session or undo records to the AI provider |
```
to:
```md
| Session state | The conversation associated with a tab, keyed by tab ID | Stored in `chrome.storage.session`, which is browser-session storage and is not synced by Aluminum | Not sent as session records to the AI provider |
```

Change:
```md
- Tab-to-conversation state and undo snapshots are stored temporarily in `chrome.storage.session`.
```
to:
```md
- Tab-to-conversation state is stored temporarily in `chrome.storage.session`.
```

Change the `scripting` permission row:
```md
| `scripting` | Runs packaged read and structured-write functions in the target page and captures undo state |
```
to:
```md
| `scripting` | Runs packaged read and structured-write functions in the target page |
```

Change the `storage` permission row:
```md
| `storage` | Stores local settings and consent plus temporary session and undo state |
```
to:
```md
| `storage` | Stores local settings and consent plus temporary session state |
```

- [ ] **Step 5: Confirm no more undo/revert/snapshot mentions remain in the four edited docs**

Run: `/opt/homebrew/bin/rg -n -i "undo|revert|turn-snapshot" CLAUDE.md README.md README.en.md docs/privacy-policy.en.md`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md README.en.md docs/privacy-policy.en.md
git commit -m "docs: remove undo/revert feature mentions from README, CLAUDE.md, and privacy policy"
```

---

### Task 6: Full-repo sweep and final verification

**Files:**
- None expected, unless the sweep in Step 1 turns up a stray reference — if so, fix it in its owning file (not a new file).

**Interfaces:**
- Consumes: the fully-updated codebase from Tasks 1-5.
- Produces: a verified, working extension build.

- [ ] **Step 1: Sweep for leftover references**

Run:
```bash
/opt/homebrew/bin/rg -n "revert|Revert|undo|Undo|Snapshot" \
  --glob '!docs/superpowers/specs/**' \
  --glob '!docs/superpowers/plans/**' \
  --glob '!docs/chrome-store-listing.en.md' \
  --glob '!docs/chrome-store-permission-justifications.md' \
  --glob '!docs/chrome-store-submission-guide.md' \
  --glob '!demo/**' \
  --glob '!node_modules/**' \
  --glob '!.output/**'
```

Expected matches: only `persistConversationSnapshot` and its call sites/comments in `entrypoints/sidepanel/store.ts`, and `store-context.test.tsx`'s "snapshot" test names — both are the unrelated chat-message-persistence feature (see Global Constraints) and must be left alone. If anything else shows up, remove/update it in its own file before proceeding — do not skip this.

- [ ] **Step 2: Full typecheck, test, and build**

Run: `pnpm compile`
Expected: PASS, zero errors.

Run: `pnpm test`
Expected: PASS, all files green.

Run: `pnpm build`
Expected: PASS, produces `.output/chrome-mv3` with no errors.

- [ ] **Step 3: Manual verification in the browser**

1. Run `pnpm dev`.
2. Load the unpacked extension from `.output/chrome-mv3` via `chrome://extensions` → Developer mode → Load unpacked (or reload it if already loaded).
3. Open the side panel on any regular `http(s)` page and ask the agent to make a visible page change (e.g. "give this page a red background").
4. Confirm the confirmation card still appears and approving it applies the change.
5. Confirm no undo bar / "Undo this turn" control appears after the change.
6. Start a new conversation (clear/new chat) and confirm no errors appear in the extension's service-worker console (`chrome://extensions` → Aluminum → "service worker" → Inspect).

- [ ] **Step 4: Update `docs/PROGRESS.md`**

Append a new row at the top of the changelog table (matching the existing table's format — date, description, doc link) describing this removal, e.g.:

```md
| 2026-08-01 | 删除撤销（Undo/Revert）功能：`browser_revert_changes` 工具、`turn-snapshot.ts` 快照模块、`REVERT_CHANGES`/`RESET_TURN_SNAPSHOT` 消息类型、`auto_allow` 权限档位、侧边栏撤销条 UI 及相关状态全部移除；同步更新 CLAUDE.md、README（中英）与隐私政策文字。起因：浏览器插件写操作本身轻量，且每轮首次写操作前已有用户确认闸门，撤销这层安全网的维护成本大于收益。验证：`pnpm test`、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-08-01-remove-undo-revert-feature-design.md) |
```

(Adjust the exact test-file/test-count phrasing if you want to match the surrounding rows' style — check the most recent 1-2 rows in `docs/PROGRESS.md` for the current convention before writing this one, since other entries sometimes include a `pnpm test` file/test count that will have shifted after Tasks 1-4's deletions.)

- [ ] **Step 5: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs: log undo/revert removal in PROGRESS.md"
```

## Self-Review Notes

- **Spec coverage:** every deletion/rewording listed in `docs/superpowers/specs/2026-08-01-remove-undo-revert-feature-design.md` sections 1-13 maps to a step above (permissions → Task 1; sidepanel/i18n → Task 2; tool/system-prompt → Task 3; background/messaging/turn-snapshot → Task 4; CLAUDE.md/README/privacy-policy → Task 5); the spec's "边界与异常" `AgentActivityCard.tsx` fallback-to-unknown behavior needs no explicit task since it's just the natural result of Task 2 Step 6's deletion (no separate code path to add).
- **Type consistency:** `SetStorageResult` is defined once in `lib/messaging.ts` (Task 4) and both of its consumers (`entrypoints/background.ts`'s `setStorage`, Task 4; `lib/agent/tools.ts`'s `makeSetStorageTool`, untouched — it only reads `response.data.area`/`.key`, never `.previousValue`) stay in sync automatically since neither references the removed field by name.
- **Ordering:** Tasks 1-3 are independent of each other and could be reordered or parallelized; Task 4 must come after Tasks 2 and 3 land (or at least conceptually after — nothing enforces this via a compiler dependency across the *task* boundary, but doing it last means Task 4 is deleting confirmed-dead code, not code some other still-active caller relies on); Task 5 (docs) and Task 6 (sweep) must be last.
