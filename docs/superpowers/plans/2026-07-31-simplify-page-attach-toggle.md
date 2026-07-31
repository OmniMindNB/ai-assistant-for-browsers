# Simplify Page-Attach Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the manual "attach current page" toggle from the sidepanel chat UI; whether a turn gets `browser_*` tools becomes a pure function of page-context status and the existing `attachPageByDefault` setting, with restricted/errored pages auto-degrading with no click required.

**Architecture:** Introduce one pure function, `resolvePageAttached(status, attachPageByDefault)`, in `lib/workbench/presentation.ts`. `App.tsx` calls it instead of holding a manual `pageAttached` state. `PageContextBar.tsx` is deleted outright. `WorkbenchComposer.tsx` loses its interactive pill and gains a read-only notice row that only renders for `restricted`/`error` statuses.

**Tech Stack:** React (function components), TypeScript, Zustand store (`entrypoints/sidepanel/store.ts`, untouched), Vitest + Testing Library, `lib/i18n`.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-31-simplify-page-attach-toggle-design.md` — every task implements a section of it; do not deviate without updating the spec first.
- Do not change `withoutBrowserTools` handling in `store.ts`, `lib/agent/permissions.ts`, or the confirm-gate — those are explicitly out of scope.
- `loading` status behaves like `available` (follows `attachPageByDefault`), not like `restricted`/`error`.
- No new i18n keys; only remove now-unused ones, and keep `en.ts`/`zh.ts` key sets identical (there's an existing test enforcing this).
- Run `pnpm compile` and `pnpm test` after every task; both must be green before committing.

---

### Task 1: `resolvePageAttached` pure function

**Files:**
- Modify: `lib/workbench/presentation.ts`
- Test: `lib/workbench/presentation.test.ts`

**Interfaces:**
- Produces: `export type PageAttachStatus = 'loading' | 'available' | 'restricted' | 'error';` and `export function resolvePageAttached(status: PageAttachStatus, attachPageByDefault: boolean): boolean`. `PageAttachStatus` intentionally duplicates the literal union of `PageContextState['status']` (defined in `entrypoints/sidepanel/store.ts`) rather than importing it — `lib/` does not import from `entrypoints/`, and the two are structurally identical so callers can pass `pageContext.status` directly.

- [ ] **Step 1: Write the failing tests**

Add to `lib/workbench/presentation.test.ts` (new `import` alongside the existing ones from `./presentation`, and a new `describe` block at the end of the file):

```ts
import {
  filterShortcutCommands,
  groupConversationsByDay,
  normalizeShortcutCommand,
  resolvePageAttached,
  summarizeToolActivities,
  type ResolvedShortcutCommand,
} from './presentation';
```

```ts
describe('resolvePageAttached', () => {
  it.each([
    ['available', true, true],
    ['available', false, false],
    ['loading', true, true],
    ['loading', false, false],
    ['restricted', true, false],
    ['restricted', false, false],
    ['error', true, false],
    ['error', false, false],
  ] as const)('status=%s, attachPageByDefault=%s -> %s', (status, attachPageByDefault, expected) => {
    expect(resolvePageAttached(status, attachPageByDefault)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `pnpm vitest run lib/workbench/presentation.test.ts`
Expected: FAIL — `resolvePageAttached` is not exported from `./presentation`.

- [ ] **Step 3: Implement the function**

Append to `lib/workbench/presentation.ts` (after the existing `summarizeToolActivities` at the end of the file):

```ts
export type PageAttachStatus = 'loading' | 'available' | 'restricted' | 'error';

export function resolvePageAttached(status: PageAttachStatus, attachPageByDefault: boolean): boolean {
  if (status === 'restricted' || status === 'error') return false;
  return attachPageByDefault;
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `pnpm vitest run lib/workbench/presentation.test.ts`
Expected: PASS (all `resolvePageAttached` cases plus the pre-existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/workbench/presentation.ts lib/workbench/presentation.test.ts
git commit -m "feat: add resolvePageAttached pure function for page-context derivation"
```

---

### Task 2: Read-only page-context notice in `WorkbenchComposer`, wired from `App.tsx`

This task touches both files together: `WorkbenchComposerProps` and `App.tsx`'s usage of it are two ends of the same interface, so they must land in one commit to keep `pnpm compile` green.

**Files:**
- Modify: `entrypoints/sidepanel/components/WorkbenchComposer.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Test: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: `resolvePageAttached` and `PageAttachStatus` from `lib/workbench/presentation.ts` (Task 1). `PageContextState` from `entrypoints/sidepanel/store.ts` (unchanged, already imported by both files).
- Produces: `WorkbenchComposerProps` drops `pageAttached: boolean` and `onTogglePageAttached(): void`; gains `onRetryPageContext(): void`. `App.tsx` no longer holds `pageAttached` as component state — it's computed inline where needed.

- [ ] **Step 1: Update the shared composer fixture and rewrite the page-context-states test**

In `entrypoints/sidepanel/components/workbench-components.test.tsx`, replace the `composerProps` fixture (currently lines 231-246):

```ts
const composerProps: WorkbenchComposerProps = {
  input: '',
  busy: false,
  pageContext: availableContext,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  shortcuts: [readingShortcut],
  onInput: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onRetryPageContext: vi.fn(),
  onRunShortcut: vi.fn(),
  onSelectProviderModel: vi.fn(),
};
```

Replace the `'shows localized, accurate page-context states'` test (currently lines 456-475) with:

```ts
  it('only shows a page-context notice for restricted or errored tabs', () => {
    const { rerender } = render(<ComposerHarness pageContext={availableContext} />);
    expect(screen.queryByText('This page cannot be read.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry page context' })).not.toBeInTheDocument();

    rerender(<ComposerHarness pageContext={{ status: 'loading' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(<ComposerHarness pageContext={{ status: 'restricted', tabId: 2, title: 'Extensions', url: 'chrome://extensions/' }} />);
    expect(screen.getByText('This page cannot be read.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry page context' })).not.toBeInTheDocument();

    const onRetryPageContext = vi.fn();
    rerender(<ComposerHarness pageContext={{ status: 'error', message: 'Offline' }} onRetryPageContext={onRetryPageContext} />);
    expect(screen.getByText('Page context unavailable: Offline')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry page context' }));
    expect(onRetryPageContext).toHaveBeenCalledOnce();
  });
```

(`fireEvent` is already imported at the top of this test file.)

- [ ] **Step 2: Run the test file to verify it fails**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: FAIL (multiple failures) — `composerProps` no longer matches `WorkbenchComposerProps`, the notice text/retry button don't exist yet, and other tests in this describe block that reference `pageAttached`/`onTogglePageAttached` will also fail. That's expected; Task 3 cleans up the remaining `PageContextBar`-only tests. For this step, focus on confirming the new `'only shows a page-context notice...'` test fails against the current component.

- [ ] **Step 3: Rewrite `WorkbenchComposer.tsx`**

Replace the props interface (lines 9-24):

```ts
export interface WorkbenchComposerProps {
  input: string;
  busy: boolean;
  pageContext: PageContextState;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  onInput(value: string): void;
  onSend(): void;
  onStop(): void;
  onRetryPageContext(): void;
  onRunShortcut(shortcut: ShortcutConfig): void;
  onSelectProviderModel(providerId: string, model: string): void;
}
```

Update the function signature (lines 32-47) to drop `pageAttached` and `onTogglePageAttached`, add `onRetryPageContext`:

```ts
export function WorkbenchComposer({
  input,
  busy,
  pageContext,
  providers,
  selectedProviderId,
  selectedModel,
  shortcuts,
  onInput,
  onSend,
  onStop,
  onRetryPageContext,
  onRunShortcut,
  onSelectProviderModel,
}: WorkbenchComposerProps) {
```

Replace the computed `pageIsAvailable`/`pageContextStatus` block (lines 61, 67-74) with a single notice object:

```ts
  const pageContextNotice =
    pageContext.status === 'restricted'
      ? { message: t('workbench.restrictedPage'), retryable: false }
      : pageContext.status === 'error'
        ? { message: t('workbench.pageContextUnavailable', { message: pageContext.message }), retryable: true }
        : null;
```

(Remove the now-unused `pageIsAvailable` line and the old `pageContextStatus` ternary chain entirely.)

In the JSX, make two surgical edits:

1. Delete the pill `<button>...</button>` block entirely (currently lines 234-247 — the one whose `aria-label` reads `` `${t('workbench.pageContext')}: ${pageContextStatus}` ``). Leave the `/` button before it and the `{providers.length > 0 && (...)}` model-selector block after it untouched, exactly where they are.

2. Immediately before the line `<div className="mb-2 flex flex-wrap items-center gap-2">` (the toolbar row that used to contain the pill), insert this new sibling block, still inside the `<div className="mx-auto max-w-3xl">` wrapper:

```tsx
        {pageContextNotice && (
          <div role="status" aria-live="polite" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
            <span className="min-w-0 break-words">{pageContextNotice.message}</span>
            {pageContextNotice.retryable && (
              <button
                type="button"
                onClick={onRetryPageContext}
                className="shrink-0 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {t('workbench.retryPageContext')}
              </button>
            )}
          </div>
        )}
```

- [ ] **Step 4: Update `App.tsx`**

Remove the `PageContextBar` import (line 19):

```ts
import { PageContextBar } from './components/PageContextBar';
```

Change the `presentation` import (line 26) to a value import:

```ts
import { resolvePageAttached, type ResolvedShortcutCommand } from '@/lib/workbench/presentation';
```

Remove the `pageAttached` state (line 74):

```ts
  const [pageAttached, setPageAttached] = useState(true);
```

Remove the effect that reset it on a new empty conversation (lines 103-108):

```ts
  useEffect(() => {
    const isNewEmptyConversation =
      messages.length === 0 && input.trim().length === 0 && !busy && !pendingConfirmation && toolActivities.length === 0;
    if (!isNewEmptyConversation) return;
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }, [busy, input, messages.length, pendingConfirmation, toolActivities.length, workbenchPreferences]);
```

Replace `submitMessage` (lines 173-177):

```ts
  async function submitMessage() {
    resetToFollowing();
    const attached = resolvePageAttached(pageContext.status, workbenchPreferences.attachPageByDefault);
    await send(undefined, { withoutBrowserTools: !attached });
  }
```

Replace `newChat` (lines 206-210):

```ts
  function newChat() {
    clear();
    setHistoryOpen(false);
  }
```

Replace `pickConversation` (lines 212-218):

```ts
  async function pickConversation(id: string) {
    if (await openConversation(id)) {
      setHistoryOpen(false);
    }
  }
```

Remove the `<PageContextBar ... />` block (lines 254-259):

```tsx
          <PageContextBar
            context={pageContext}
            attached={pageAttached}
            onToggleAttached={() => setPageAttached((attached) => !attached)}
            onRetry={refreshPageContext}
          />
```

Update the `<WorkbenchComposer>` usage (lines 323-338) to drop `pageAttached`/`onTogglePageAttached` and add `onRetryPageContext`:

```tsx
          <WorkbenchComposer
            input={input}
            busy={busy}
            pageContext={pageContext}
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            onInput={setInput}
            onSend={submitMessage}
            onStop={stop}
            shortcuts={resolvedShortcuts}
            onRetryPageContext={refreshPageContext}
            onRunShortcut={executeShortcut}
            onSelectProviderModel={selectProviderAndModel}
          />
```

- [ ] **Step 5: Run the test file and the type checker**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: The new `'only shows a page-context notice...'` test now PASSes. Tests still referencing `PageContextBar`/`onToggleAttached`/`'Remove page context'`/`'Continue without page context'` button roles will still FAIL — that's expected, Task 3 removes/replaces them.

Run: `pnpm compile`
Expected: PASS — no leftover references to the removed props anywhere in `entrypoints/sidepanel/`.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/components/WorkbenchComposer.tsx entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "refactor: replace the composer's interactive page-attach pill with a read-only notice"
```

---

### Task 3: Delete `PageContextBar` and replace its tests with App-level auto-degrade tests

**Files:**
- Delete: `entrypoints/sidepanel/components/PageContextBar.tsx`
- Test: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: nothing new — this task only removes dead code and swaps test coverage from the deleted component onto `App.tsx`'s integration behavior (already wired in Task 2).

- [ ] **Step 1: Remove the `PageContextBar` import and its dedicated tests**

In `entrypoints/sidepanel/components/workbench-components.test.tsx`, remove the import (line 15):

```ts
import { PageContextBar } from './PageContextBar';
```

Remove these five tests from the `'workbench context controls'` describe block (they exercise a component that no longer exists):
- `'shows the active page title and allows one-turn detachment'`
- `'shows a retry action for context errors'`
- `'offers a restricted tab an accessible no-page-context action'`
- `'uses a wrapping narrow-screen structure for restricted page context'`
- `'keeps loading and retryable context states shrinkable on narrow screens'`

Also remove these two tests from the same describe block (they assert the old manual one-turn-detachment mechanism, which no longer exists now that `pageAttached` is fully derived):
- `'does not consume one-turn detachment when an empty normal send does not start'`
- `'runs a restricted-page message without browser tools and then resets detachment'`

- [ ] **Step 2: Add replacement App-level integration tests**

Add these three tests to the `'workbench context controls'` describe block, in place of the ones removed above:

```ts
  it('sends with browser tools on an available page by default', async () => {
    const user = userEvent.setup();
    chatStore.input = 'Summarize this';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: false }));
  });

  it('sends without browser tools when attachPageByDefault is off', async () => {
    const user = userEvent.setup();
    chatStore.workbenchPreferences = { attachPageByDefault: false };
    chatStore.input = 'Summarize this';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
  });

  it('automatically sends restricted-page messages without browser tools, with no click required', async () => {
    const user = userEvent.setup();
    chatStore.pageContext = {
      status: 'restricted',
      tabId: 4,
      title: 'Extensions',
      url: 'chrome://extensions/',
    };
    chatStore.input = 'Open settings';
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('This page cannot be read.')).toBeVisible();

    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
  });
```

- [ ] **Step 3: Delete the component file**

Delete `entrypoints/sidepanel/components/PageContextBar.tsx`.

- [ ] **Step 4: Run the full test file and the type checker**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS — all tests in the file, including the three new ones.

Run: `pnpm compile`
Expected: PASS — no remaining import of `./PageContextBar` anywhere.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/components/PageContextBar.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "refactor: delete PageContextBar, cover auto-degrade behavior at the App level"
```

---

### Task 4: Remove unused i18n keys

**Files:**
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`

**Interfaces:**
- Consumes: nothing — by this point (after Task 3), no code references the keys being removed.

- [ ] **Step 1: Remove the unused keys from `zh.ts`**

Delete these lines from `lib/i18n/locales/zh.ts` (currently around lines 103, 105, 109-113):

```ts
  'workbench.pageContext': '页面上下文',
  'workbench.pageContextLoading': '正在检查页面上下文…',
  'workbench.continueWithoutPageContext': '不使用页面上下文继续',
  'workbench.removePageContext': '移除页面上下文',
  'workbench.addPageContext': '添加页面上下文',
  'workbench.pageContextAttached': '已附加',
  'workbench.pageContextDetached': '未附加',
```

Keep `workbench.pageContextUnavailable`, `workbench.retryPageContext`, `workbench.restrictedPage` — they're still used by the new composer notice.

- [ ] **Step 2: Remove the matching keys from `en.ts`**

Delete the corresponding lines from `lib/i18n/locales/en.ts` (currently around lines 106, 108, 112-116):

```ts
  'workbench.pageContext': 'Page context',
  'workbench.pageContextLoading': 'Checking page context…',
  'workbench.continueWithoutPageContext': 'Continue without page context',
  'workbench.removePageContext': 'Remove page context',
  'workbench.addPageContext': 'Add page context',
  'workbench.pageContextAttached': 'Attached',
  'workbench.pageContextDetached': 'Not attached',
```

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: PASS — including the `'keeps English and Chinese composer labels in sync'` test, which checks that `Object.keys(en)` and `Object.keys(zh)` are identical sets.

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "chore: remove i18n keys for the deleted page-attach toggle"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite, type check, and build**

Run: `pnpm compile`
Expected: PASS.

Run: `pnpm test`
Expected: PASS, all files.

Run: `pnpm build`
Expected: Successful production build to `.output/chrome-mv3`.

- [ ] **Step 2: Manual smoke test**

Load `.output/chrome-mv3` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked) and verify:
1. On a normal `https://` page, the composer shows no page-context notice or pill, and a sent message reaches the agent with browser tools available (default `attachPageByDefault: true`).
2. Navigate to `chrome://extensions`: the composer immediately shows "This page cannot be read." with no click required; sending a message runs without any `browser_*` tool calls.
3. In the options page (General settings), turn off "默认附加当前网页" / "Attach current page by default", return to a normal page, and confirm a sent message does **not** trigger any `browser_*` tool calls, with no notice shown in the composer.
4. Confirm there is no page-context toggle/pill anywhere in the chat UI — only the read-only notice on restricted/errored pages.

- [ ] **Step 3: Update `docs/PROGRESS.md`**

Add an entry documenting this change (follow the existing table format used for the 2026-07-31 mode-switch removal entry), linking to
`docs/superpowers/specs/2026-07-31-simplify-page-attach-toggle-design.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs: log the page-attach toggle simplification in PROGRESS.md"
```
