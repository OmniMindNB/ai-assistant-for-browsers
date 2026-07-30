# Sidepanel Context Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Aluminum’s side panel as a context-first workbench for page Q&A and Agent tasks, while moving complete configuration into a grouped Options page.

**Architecture:** Keep the existing Zustand store, Agent loop, confirmation gate, undo behavior, Provider storage, shortcut storage, and Dexie conversation records. Split the 1,100-line sidepanel `App.tsx` into focused UI components, add small pure view-model helpers for grouping/filtering, and expose the already-returned active-tab title/URL as explicit store state. The Options page becomes the only full settings surface; the sidepanel opens it through `browser.runtime.openOptionsPage()`.

**Tech Stack:** React 19, TypeScript 5.9, Zustand 5, WXT 0.20, Tailwind CSS 4, Vitest 4, Testing Library, jsdom.

## Global Constraints

- Do not add a second Agent engine or change the Deny-First permission model.
- Do not change the persisted shapes for Providers, shortcuts, or Dexie conversations.
- Do not add cross-tab context, file upload, workspaces, cloud sync, or telemetry.
- Reuse `selectProviderAndModel`, `runShortcut`, confirmation, and revert actions from the existing store.
- Keep the existing Enter-to-send, Shift+Enter-newline, busy, stop, edit-message, auto-scroll, and per-tab conversation behavior.
- Support Chinese and English with identical translation-key sets.
- Support light, dark, and system themes.
- The sidepanel must remain usable from 320px wide without page-level horizontal scrolling.
- Use visible focus styles, accessible names, keyboard-operable menus/drawers, and text in addition to color for status.
- Every task follows red-green-refactor: failing focused test, minimal implementation, focused pass, then commit.

---

## File Structure

### New shared logic

- `lib/workbench/preferences.ts` — workbench mode/default-context persistence in a new storage key.
- `lib/workbench/presentation.ts` — pure grouping/filtering/status helpers used by components.
- `lib/workbench/preferences.test.ts` — storage parsing/default/error tests.
- `lib/workbench/presentation.test.ts` — conversation grouping, shortcut filtering, and tool-summary tests.
- `lib/test-setup-ui.ts` — jsdom-only Testing Library matchers and cleanup.

### New sidepanel components

- `entrypoints/sidepanel/components/WorkbenchHeader.tsx` — product identity and new/history/more actions.
- `entrypoints/sidepanel/components/PageContextBar.tsx` — active tab title, URL, availability, and context toggle.
- `entrypoints/sidepanel/components/ModeSwitch.tsx` — Q&A/Agent presentation mode.
- `entrypoints/sidepanel/components/HistoryDrawer.tsx` — overlay conversation search/group/select/delete UI.
- `entrypoints/sidepanel/components/AgentActivityCard.tsx` — aggregated tool progress and terminal state.
- `entrypoints/sidepanel/components/WorkbenchEmptyState.tsx` — mode-specific empty guidance.
- `entrypoints/sidepanel/components/WorkbenchComposer.tsx` — textarea, context chip, model picker, slash-command menu, send/stop.
- `entrypoints/sidepanel/components/workbench-components.test.tsx` — focused component interaction tests.

### New Options components

- `components/SettingsShell.tsx` — grouped Options navigation and responsive shell.
- `components/GeneralSettings.tsx` — persisted default mode and default page-context controls.
- `components/settings-components.test.tsx` — navigation and setting interaction tests.

### Modified files

- `entrypoints/sidepanel/App.tsx` — orchestration only; remove embedded settings and permanent sidebar.
- `entrypoints/sidepanel/store.ts` — active page context, workbench preferences, and context-aware `send`.
- `entrypoints/sidepanel/icons.tsx` — add only the icons required by the new components.
- `entrypoints/options/App.tsx` — use `SettingsShell` and add grouped sections.
- `components/ProviderSettings.tsx` — card-list landing state with separate add/edit form state.
- `components/ShortcutSettings.tsx` — compact management table/list with slash-command labels.
- `lib/messaging.ts` — export the existing `GET_ACTIVE_TAB` response shape as `ActiveTabInfo`.
- `lib/i18n/locales/zh.ts` and `lib/i18n/locales/en.ts` — all new labels, states, errors, and accessible names.
- `vitest.config.ts` — include `.tsx` component tests with jsdom.
- `lib/test-setup.ts` — install Testing Library cleanup/matchers and browser mocks.
- `package.json` and `pnpm-lock.yaml` — add Testing Library/jsdom dev dependencies.
- `docs/PROGRESS.md` — record the landed redesign and verification results.

---

### Task 1: Add the React UI Test Harness

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`
- Create: `lib/test-setup-ui.ts`
- Create: `entrypoints/sidepanel/components/test-harness.test.tsx`

**Interfaces:**
- Consumes: existing Vitest config and global `browser` test mock.
- Produces: jsdom-backed `.test.tsx` execution with Testing Library cleanup and DOM matchers.

- [ ] **Step 1: Add a failing component smoke test**

```tsx
// entrypoints/sidepanel/components/test-harness.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('sidepanel component test harness', () => {
  it('renders accessible React content', () => {
    render(<button type="button">New chat</button>);
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the smoke test and verify the harness is missing**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/test-harness.test.tsx
```

Expected: FAIL because the file is outside the current Vitest project and Testing Library/jsdom are not installed.

- [ ] **Step 3: Install the minimum UI test dependencies**

Run:

```bash
pnpm add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

Expected: `package.json` and `pnpm-lock.yaml` contain only these new dev dependencies.

- [ ] **Step 4: Extend Vitest without changing existing Node tests**

Vitest 4 removed `environmentMatchGlobs`; use two test projects:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['lib/**/*.test.ts'],
          setupFiles: ['lib/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['entrypoints/**/*.test.tsx', 'components/**/*.test.tsx'],
          setupFiles: ['lib/test-setup.ts', 'lib/test-setup-ui.ts'],
        },
      },
    ],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
});
```

Create the jsdom-only setup:

```ts
// lib/test-setup-ui.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
```

Keep the existing browser mock in `lib/test-setup.ts` intact.

- [ ] **Step 5: Run focused and existing tests**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/test-harness.test.tsx
pnpm vitest run lib/i18n/i18n.test.ts
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts lib/test-setup-ui.ts entrypoints/sidepanel/components/test-harness.test.tsx
git commit -m "test: add sidepanel component harness"
```

---

### Task 2: Add Workbench Preferences and Pure Presentation Helpers

**Files:**
- Create: `lib/workbench/preferences.ts`
- Create: `lib/workbench/preferences.test.ts`
- Create: `lib/workbench/presentation.ts`
- Create: `lib/workbench/presentation.test.ts`

**Interfaces:**
- Produces:
  - `type WorkbenchMode = 'ask' | 'agent'`
  - `interface WorkbenchPreferences { defaultMode: WorkbenchMode; attachPageByDefault: boolean }`
  - `loadWorkbenchPreferences(): Promise<WorkbenchPreferences>`
  - `saveWorkbenchPreferences(value: WorkbenchPreferences): Promise<void>`
  - `groupConversationsByDay(records, now): ConversationGroup[]`
  - `type ResolvedShortcutCommand = { config: ShortcutConfig; resolved: ResolvedShortcut }`
  - `filterShortcutCommands(shortcuts: ResolvedShortcutCommand[], query: string): ResolvedShortcutCommand[]`
  - `summarizeToolActivities(activities): ToolActivitySummary`
- Consumes: `chrome.storage.local`, `ConversationRecord`, `ResolvedShortcut`, and the structural fields of `ToolActivity`.

- [ ] **Step 1: Write failing preference tests**

```ts
it('returns safe defaults when the key is absent', async () => {
  expect(await loadWorkbenchPreferences()).toEqual({
    defaultMode: 'ask',
    attachPageByDefault: true,
  });
});

it('rejects invalid persisted values without rewriting storage', async () => {
  browser.storage.local.get.mockResolvedValue({
    workbenchPreferences: { defaultMode: 'unsafe', attachPageByDefault: 'yes' },
  });
  await expect(loadWorkbenchPreferences()).rejects.toThrow('Invalid workbench preferences');
  expect(browser.storage.local.set).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm vitest run lib/workbench/preferences.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement exact preference parsing**

```ts
export const WORKBENCH_PREFERENCES_KEY = 'workbenchPreferences';
export type WorkbenchMode = 'ask' | 'agent';

export interface WorkbenchPreferences {
  defaultMode: WorkbenchMode;
  attachPageByDefault: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  defaultMode: 'ask',
  attachPageByDefault: true,
};

export async function loadWorkbenchPreferences(): Promise<WorkbenchPreferences> {
  const stored = (await browser.storage.local.get(WORKBENCH_PREFERENCES_KEY))[
    WORKBENCH_PREFERENCES_KEY
  ];
  if (stored === undefined) return DEFAULT_WORKBENCH_PREFERENCES;
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !['ask', 'agent'].includes((stored as { defaultMode?: string }).defaultMode ?? '') ||
    typeof (stored as { attachPageByDefault?: unknown }).attachPageByDefault !== 'boolean'
  ) {
    throw new Error('Invalid workbench preferences');
  }
  return stored as WorkbenchPreferences;
}

export async function saveWorkbenchPreferences(value: WorkbenchPreferences): Promise<void> {
  await browser.storage.local.set({ [WORKBENCH_PREFERENCES_KEY]: value });
}
```

- [ ] **Step 4: Write failing presentation-helper tests**

Cover exact cases:

```ts
it('groups conversations into today, yesterday, and earlier', () => {
  const groups = groupConversationsByDay(records, new Date('2026-07-30T12:00:00+08:00'));
  expect(groups.map((group) => group.key)).toEqual(['today', 'yesterday', 'earlier']);
});

it('matches slash commands by localized name without changing order', () => {
  expect(filterShortcutCommands(shortcuts, '/阅').map((item) => item.config.id))
    .toEqual(['reading-mode']);
});

it('summarizes the active tool and completed count', () => {
  expect(summarizeToolActivities([
    { id: '1', name: 'browser_read_page', status: 'done' },
    { id: '2', name: 'browser_set_style', status: 'running' },
  ])).toMatchObject({ completed: 1, total: 2, status: 'running', activeId: '2' });
});
```

- [ ] **Step 5: Implement pure helpers**

Use calendar-day boundaries derived from the supplied `now`; do not use module-level `Date.now()`. Normalize slash queries by removing one leading `/`, trimming, and lowercasing. Tool status precedence is `confirming`, `running`, `error`, `blocked`, `done`; the summary must preserve original activity order.

- [ ] **Step 6: Run both focused suites**

Run:

```bash
pnpm vitest run lib/workbench/preferences.test.ts lib/workbench/presentation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/workbench
git commit -m "feat: add workbench presentation models"
```

---

### Task 3: Expose Active Page Context in the Chat Store

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `lib/messaging.test.ts`
- Create: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface ActiveTabInfo {
  id: number;
  title?: string;
  url?: string;
}

export type PageContextState =
  | { status: 'loading' }
  | { status: 'available'; tabId: number; title: string; url: string }
  | { status: 'restricted'; tabId: number; title: string; url: string }
  | { status: 'error'; message: string };
```

- Extends `ChatState` with:
  - `pageContext: PageContextState`
  - `workbenchPreferences: WorkbenchPreferences`
  - `refreshPageContext(): Promise<void>`
  - `refreshWorkbenchPreferences(): Promise<void>`
  - `send(text?: string, options?: { withoutBrowserTools?: boolean }): Promise<void>`

- [ ] **Step 1: Write failing store tests**

Mock `GET_ACTIVE_TAB` and assert:

```ts
it('publishes an available http tab', async () => {
  sendMessageMock.mockResolvedValue({
    ok: true,
    data: { id: 7, title: 'Example', url: 'https://example.com/' },
  });
  await useChat.getState().refreshPageContext();
  expect(useChat.getState().pageContext).toEqual({
    status: 'available',
    tabId: 7,
    title: 'Example',
    url: 'https://example.com/',
  });
});

it('marks chrome pages as restricted', async () => {
  sendMessageMock.mockResolvedValue({
    ok: true,
    data: { id: 8, title: 'Extensions', url: 'chrome://extensions/' },
  });
  await useChat.getState().refreshPageContext();
  expect(useChat.getState().pageContext.status).toBe('restricted');
});
```

Also assert that `send('hello', { withoutBrowserTools: true })` forwards
`withoutBrowserTools: true` into `runAgent`.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/store-context.test.tsx
```

Expected: FAIL because the state and actions are missing.

- [ ] **Step 3: Export and use `ActiveTabInfo`**

Replace the inline `GET_ACTIVE_TAB` cast with `MessageResponse<ActiveTabInfo>`. A tab is available only for `http:` or `https:` URLs. Missing title falls back to the hostname for available URLs and to the localized untitled-page label otherwise.

- [ ] **Step 4: Add preference refresh and context-aware send**

Initialize:

```ts
pageContext: { status: 'loading' },
workbenchPreferences: DEFAULT_WORKBENCH_PREFERENCES,
```

Implement `refreshWorkbenchPreferences()` by loading the new key and putting load failures in `error` while retaining safe defaults. Implement:

```ts
send: async (text, options) => {
  const content = (text ?? get().input).trim();
  if (!content || get().busy) return;
  await runAgent(set, get, makeMessage('user', content, 'input'), content, {
    withoutBrowserTools: options?.withoutBrowserTools,
  });
},
```

- [ ] **Step 5: Run focused store and messaging tests**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/store-context.test.tsx lib/messaging.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/messaging.ts lib/messaging.test.ts entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "feat: expose active page context"
```

---

### Task 4: Replace the Permanent Sidebar with Header and History Drawer

**Files:**
- Create: `entrypoints/sidepanel/components/WorkbenchHeader.tsx`
- Create: `entrypoints/sidepanel/components/HistoryDrawer.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/icons.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- `WorkbenchHeader` props:

```ts
interface WorkbenchHeaderProps {
  historyOpen: boolean;
  onToggleHistory(): void;
  onNewChat(): void;
  onOpenSettings(): void;
  onToggleTheme(): void;
}
```

- `HistoryDrawer` props:

```ts
interface HistoryDrawerProps {
  open: boolean;
  conversations: ConversationRecord[];
  activeConversationId: string;
  now?: Date;
  onClose(): void;
  onNewChat(): void;
  onPick(id: string): void;
  onRemove(id: string): void;
}
```

- [ ] **Step 1: Write failing interaction tests**

```tsx
it('opens and closes history with accessible state', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Conversation history' }));
  expect(screen.getByRole('dialog', { name: 'Conversation history' })).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Conversation history' })).not.toBeInTheDocument();
});

it('filters local conversation titles and preserves date groups', async () => {
  render(<HistoryDrawer open conversations={records} {...callbacks} />);
  await userEvent.setup().type(screen.getByRole('searchbox'), 'Google');
  expect(screen.getByText('Google page summary')).toBeVisible();
  expect(screen.queryByText('Shopping comparison')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx
```

Expected: FAIL because both components are missing.

- [ ] **Step 3: Implement the header**

Use visible Aluminum identity plus icon buttons for new chat, history, and more. The more menu contains Settings and theme toggle. Settings calls the provided callback; it does not render settings inside the sidepanel.

- [ ] **Step 4: Implement the overlay drawer**

Use `role="dialog"`, `aria-modal="true"` on narrow layouts, an explicit close button, a search input, `groupConversationsByDay`, Escape handling, and focus return to the history trigger. Deletion must call `window.confirm(t('sidebar.confirmDeleteConversation'))` before `onRemove`.

- [ ] **Step 5: Rewire `App.tsx`**

Delete `View`, `SettingsView`, `Sidebar`, `TopBar`, and `SIDEBAR_BREAKPOINT`. Replace `sidebarOpen` with `historyOpen`. Implement:

```ts
function openSettings() {
  browser.runtime.openOptionsPage();
}
```

Call `refreshConversations()` when the drawer opens. Preserve `newChat()` and `pickConversation()` behavior, closing the drawer after either action.

- [ ] **Step 6: Run focused tests and compile**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx
pnpm compile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/icons.tsx entrypoints/sidepanel/components/WorkbenchHeader.tsx entrypoints/sidepanel/components/HistoryDrawer.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat: add workbench history drawer"
```

---

### Task 5: Add Page Context, Mode Switch, and Mode-Specific Empty State

**Files:**
- Create: `entrypoints/sidepanel/components/PageContextBar.tsx`
- Create: `entrypoints/sidepanel/components/ModeSwitch.tsx`
- Create: `entrypoints/sidepanel/components/WorkbenchEmptyState.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- `PageContextBar` consumes `PageContextState`, `attached: boolean`, `onToggleAttached()`, and `onRetry()`.
- `ModeSwitch` consumes `mode: WorkbenchMode` and `onChange(mode)`.
- `WorkbenchEmptyState` consumes `mode`, the first four resolved shortcuts, `busy`, and `onRunShortcut`.

- [ ] **Step 1: Write failing state tests**

Cover:

```tsx
it('shows the active page title and allows one-turn detachment', async () => {
  render(<PageContextBar context={availableContext} attached onToggleAttached={toggle} onRetry={retry} />);
  expect(screen.getByText('Example article')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Remove page context' }));
  expect(toggle).toHaveBeenCalledOnce();
});

it('shows a retry action for context errors', async () => {
  render(<PageContextBar context={{ status: 'error', message: 'Unavailable' }} {...props} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry page context' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('changes empty suggestions between ask and agent modes', () => {
  const { rerender } = render(<WorkbenchEmptyState mode="ask" {...props} />);
  expect(screen.getByText('Ask about this page')).toBeVisible();
  rerender(<WorkbenchEmptyState mode="agent" {...props} />);
  expect(screen.getByText('Describe a browser task')).toBeVisible();
});
```

- [ ] **Step 2: Run and verify failure**

Run the component test file and expect missing-component failures.

- [ ] **Step 3: Implement the three focused components**

Rules:

- `PageContextBar` never claims a restricted tab is readable.
- Mode buttons use `aria-pressed`.
- Empty state shows at most four valid shortcuts and does not duplicate model controls.
- Long titles use CSS truncation plus the full title as `aria-label`.

- [ ] **Step 4: Integrate with `App.tsx`**

On mount call `refreshPageContext()` and `refreshWorkbenchPreferences()`. Initialize local state after preference load:

```ts
const [mode, setMode] = useState<WorkbenchMode>('ask');
const [pageAttached, setPageAttached] = useState(true);
```

When refreshed preferences change, update mode/page attachment only for a new empty conversation; do not switch an in-progress conversation unexpectedly. Reset to defaults in `newChat()`.

- [ ] **Step 5: Run focused tests and compile**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx entrypoints/sidepanel/store-context.test.tsx
pnpm compile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/PageContextBar.tsx entrypoints/sidepanel/components/ModeSwitch.tsx entrypoints/sidepanel/components/WorkbenchEmptyState.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat: add page context workbench modes"
```

---

### Task 6: Aggregate Tool Activity into an Agent Timeline Card

**Files:**
- Create: `entrypoints/sidepanel/components/AgentActivityCard.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- `AgentActivityCard` consumes `activities: ToolActivity[]`.
- It uses `summarizeToolActivities()` and renders ordered detail rows.
- `ConfirmationCard` and `UndoBar` remain separate existing components but are placed directly after the activity card in the timeline.

- [ ] **Step 1: Write failing state-rendering tests**

```tsx
it.each([
  ['running', 'Running browser task'],
  ['confirming', 'Waiting for approval'],
  ['blocked', 'Blocked'],
  ['error', 'Task failed'],
  ['done', 'Task complete'],
])('renders %s tool state with text', (status, label) => {
  render(<AgentActivityCard activities={[activity(status)]} />);
  expect(screen.getByText(label)).toBeVisible();
});

it('expands ordered tool details', async () => {
  render(<AgentActivityCard activities={activities} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show task details' }));
  expect(screen.getAllByRole('listitem').map((item) => item.textContent))
    .toEqual(expect.arrayContaining(['Read pageDone', 'Set styleRunning']));
});
```

- [ ] **Step 2: Run and verify failure**

Run the focused component suite; expect the missing component to fail.

- [ ] **Step 3: Implement `AgentActivityCard`**

Collapsed state shows one text status plus `completed / total`. Expanded state shows each tool’s localized label, detail, and status. Preserve activity order. Never render raw tool arguments or code in this card; confirmation retains its existing safe summary/code preview.

- [ ] **Step 4: Replace `ToolActivityList` in `App.tsx`**

Remove the old function from `App.tsx`, render one `AgentActivityCard`, then the existing confirmation card, then the undo bar. Do not alter `respondToConfirmation` or `revertTurnChanges`.

- [ ] **Step 5: Run focused tests, Agent permission tests, and compile**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx lib/agent/permissions.test.ts lib/agent/confirm-gate.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/AgentActivityCard.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat: unify agent activity timeline"
```

---

### Task 7: Build the Unified Composer and Slash-Command Menu

**Files:**
- Create: `entrypoints/sidepanel/components/WorkbenchComposer.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- `WorkbenchComposer` props:

```ts
interface WorkbenchComposerProps {
  input: string;
  busy: boolean;
  pageAttached: boolean;
  pageContext: PageContextState;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  onInput(value: string): void;
  onSend(): void;
  onStop(): void;
  onTogglePageAttached(): void;
  onRunShortcut(shortcut: ShortcutConfig): void;
  onSelectProviderModel(providerId: string, model: string): void;
}
```

- [ ] **Step 1: Write failing keyboard and command tests**

Cover:

```tsx
it('opens slash commands, filters, and runs the selected command', async () => {
  const user = userEvent.setup();
  render(<WorkbenchComposer {...props} />);
  await user.type(screen.getByRole('textbox'), '/阅读');
  expect(screen.getByRole('menu')).toBeVisible();
  await user.keyboard('{ArrowDown}{Enter}');
  expect(props.onRunShortcut).toHaveBeenCalledWith(readingShortcut.config);
});

it('sends on Enter and inserts a newline on Shift+Enter', async () => {
  const user = userEvent.setup();
  render(<WorkbenchComposer {...props} input="hello" />);
  await user.click(screen.getByRole('textbox'));
  await user.keyboard('{Enter}');
  expect(props.onSend).toHaveBeenCalledOnce();
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(props.onSend).toHaveBeenCalledOnce();
});

it('shows stop instead of send while busy', () => {
  render(<WorkbenchComposer {...props} busy />);
  expect(screen.getByRole('button', { name: 'Stop generating' })).toBeVisible();
});
```

- [ ] **Step 2: Run and verify failure**

Run the focused component suite and expect missing-component failures.

- [ ] **Step 3: Implement the composer**

Move `ModelPicker` and textarea auto-height behavior out of `App.tsx`. Use a single popover at a time. Slash menu rules:

- open when trimmed input starts with `/`;
- filter with `filterShortcutCommands`;
- ArrowUp/ArrowDown/Home/End navigate;
- Enter runs the highlighted command;
- Escape closes without clearing text;
- running a command clears the slash query only after the callback begins.

Page context chip is disabled for loading/error/restricted states. Model picker only lists already-configured Provider models.

- [ ] **Step 4: Integrate context-aware sending**

In `App.tsx`:

```ts
function submitMessage() {
  resetToFollowing();
  send(undefined, { withoutBrowserTools: !pageAttached });
}
```

Keep `runShortcut` scope semantics unchanged; a shortcut’s configured scope wins over the ordinary composer context chip.

- [ ] **Step 5: Delete old composer helpers from `App.tsx`**

Remove `Composer`, `ShortcutBar`, `ModelPicker`, and `Chip` after the new component is wired. Keep `onKeyDown` only if editing components still use it; otherwise remove it and its now-unused `KeyboardEvent` import.

- [ ] **Step 6: Run focused tests, shortcut tests, and compile**

Run:

```bash
pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx lib/chat/shortcut-prompts.test.ts lib/shortcuts.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/WorkbenchComposer.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat: add unified workbench composer"
```

---

### Task 8: Build the Grouped Options Shell and General Settings

**Files:**
- Create: `components/SettingsShell.tsx`
- Create: `components/GeneralSettings.tsx`
- Create: `components/settings-components.test.tsx`
- Modify: `entrypoints/options/App.tsx`

**Interfaces:**
- `type SettingsSection = 'general' | 'appearance' | 'language' | 'providers' | 'shortcuts' | 'privacy' | 'about'`
- `SettingsShell` consumes grouped section descriptors, active section, `onSelect`, and children.
- `GeneralSettings` loads/saves `WorkbenchPreferences`.

- [ ] **Step 1: Write failing navigation tests**

```tsx
it('navigates between grouped settings sections', async () => {
  render(<OptionsApp />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Model providers' }));
  expect(screen.getByRole('heading', { name: 'Model providers' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Model providers' }))
    .toHaveAttribute('aria-current', 'page');
});

it('saves workbench defaults and preserves input on failure', async () => {
  saveWorkbenchPreferencesMock.mockRejectedValue(new Error('storage failed'));
  render(<GeneralSettings />);
  await userEvent.setup().click(screen.getByRole('radio', { name: 'Agent tasks' }));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('alert')).toHaveTextContent('storage failed');
  expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm vitest run components/settings-components.test.tsx
```

Expected: FAIL because the new shell/components do not exist.

- [ ] **Step 3: Implement `SettingsShell`**

Desktop: fixed grouped left navigation and one right content region. Narrow layout: horizontally scrollable section navigation with no body horizontal overflow. Use `aria-current="page"` for the active item and a real `<main>`.

- [ ] **Step 4: Implement `GeneralSettings`**

Render only backed settings:

- default mode (`ask` or `agent`);
- attach current page by default.

Do not render unimplemented confirmation-frequency, remember-tab, or undo-duration controls. Load once on mount, keep draft state, disable repeated save while saving, retain draft on error, and show a localized saved message on success.

- [ ] **Step 5: Rebuild `entrypoints/options/App.tsx`**

Use section groups:

```ts
const groups = [
  { label: t('settings.groupPreferences'), sections: ['general', 'appearance', 'language'] },
  { label: t('settings.groupAiTools'), sections: ['providers', 'shortcuts'] },
  { label: t('settings.groupSafety'), sections: ['privacy', 'about'] },
];
```

Reuse existing `AppearanceSettings`, `LanguageSettings`, `ProviderSettings`, and `ShortcutSettings`. The privacy section renders existing local-first/page-data copy; About renders version from `browser.runtime.getManifest().version`.

- [ ] **Step 6: Run settings tests and compile**

Run:

```bash
pnpm vitest run components/settings-components.test.tsx lib/privacy-consent-gate.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/SettingsShell.tsx components/GeneralSettings.tsx components/settings-components.test.tsx entrypoints/options/App.tsx
git commit -m "feat: add grouped options settings"
```

---

### Task 9: Reshape Provider and Shortcut Management

**Files:**
- Modify: `components/ProviderSettings.tsx`
- Modify: `components/ShortcutSettings.tsx`
- Modify: `components/settings-components.test.tsx`

**Interfaces:**
- Preserve current exported default components and storage callbacks.
- Preserve Provider CRUD, active Provider selection, custom preset, removed-elsewhere handling, and field validation.
- Preserve shortcut CRUD, validation, restore defaults, keyboard reorder, drag reorder, and storage-change handling.

- [ ] **Step 1: Add failing Provider landing-state tests**

```tsx
it('shows providers as compact cards before opening an editor', () => {
  render(<ProviderSettings />);
  expect(screen.getByRole('list', { name: 'Configured providers' })).toBeVisible();
  expect(screen.queryByRole('form', { name: 'Provider editor' })).not.toBeInTheDocument();
});

it('opens the existing editor without losing Provider values', async () => {
  render(<ProviderSettings />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Edit DeepSeek' }));
  expect(screen.getByRole('form', { name: 'Provider editor' })).toBeVisible();
  expect(screen.getByLabelText('Name')).toHaveValue('DeepSeek');
});
```

- [ ] **Step 2: Add failing shortcut management tests**

```tsx
it('shows slash labels and keeps keyboard reorder actions', () => {
  render(<ShortcutSettings />);
  expect(screen.getByText('/总结')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Move Summarize page up' })).toBeEnabled();
});

it('opens one shortcut editor at a time', async () => {
  render(<ShortcutSettings />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Edit Summarize page' }));
  expect(screen.getAllByRole('form')).toHaveLength(1);
});
```

- [ ] **Step 3: Run and verify failure**

Run:

```bash
pnpm vitest run components/settings-components.test.tsx
```

Expected: FAIL against the current always-visible forms/list styling.

- [ ] **Step 4: Restructure Provider presentation only**

Keep current state and handlers. Change the landing view to a semantic list of cards with name, connection/key state, model count, active badge, set-active, edit, and delete. Show the add/edit form only after the user chooses Add or Edit. On save, return to the list; on save error, remain in the form.

- [ ] **Step 5: Restructure shortcut presentation only**

Keep current state and handlers. Render compact rows with name, localized slash label, scope, reorder actions, edit, and delete. Generate the display command from the localized name by removing whitespace and prefixing `/`; it is presentation-only and does not change `ShortcutConfig`.

- [ ] **Step 6: Run focused settings and storage tests**

Run:

```bash
pnpm vitest run components/settings-components.test.tsx lib/settings.test.ts lib/shortcuts.test.ts lib/chat/shortcut-prompts.test.ts
pnpm compile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/ProviderSettings.tsx components/ShortcutSettings.tsx components/settings-components.test.tsx
git commit -m "feat: streamline provider and shortcut settings"
```

---

### Task 10: Complete Localization, Accessibility, and Integration Verification

**Files:**
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `entrypoints/sidepanel/icons.tsx`
- Modify: `assets/tailwind.css`
- Modify: `docs/PROGRESS.md`
- Delete: `entrypoints/sidepanel/components/test-harness.test.tsx` if its coverage is fully superseded.

**Interfaces:**
- All new components consume translations through `useTranslation()`.
- Chinese and English dictionaries keep identical keys.
- Shared CSS additions are limited to Markdown or reusable accessibility behavior; component geometry remains in Tailwind classes.

- [ ] **Step 1: Add failing i18n-key coverage**

Extend the existing dictionary equality test and add exact required keys for:

- workbench modes and empty-state copy;
- page context states/actions;
- history drawer/search/date groups/delete confirmation;
- Agent activity terminal states/details toggle;
- slash-command menu;
- grouped settings navigation;
- General settings save/error states;
- Provider/shortcut accessible action names.

Run:

```bash
pnpm vitest run lib/i18n/i18n.test.ts
```

Expected: FAIL listing keys missing from one or both dictionaries.

- [ ] **Step 2: Add complete Chinese and English copy**

Do not leave English product copy in Chinese components or vice versa. Avoid claims that restricted pages can be read, that all writes are reversible, or that API traffic stays on-device.

- [ ] **Step 3: Run the full automated suite**

Run:

```bash
pnpm test
```

Expected: all tests PASS with zero failures.

- [ ] **Step 4: Run static and production verification**

Run:

```bash
pnpm compile
pnpm build
```

Expected:

- TypeScript exits 0;
- WXT Chrome MV3 production build exits 0;
- no remote-code or CSP regressions are introduced.

- [ ] **Step 5: Perform manual responsive and workflow QA**

Load `.output/chrome-mv3` and verify:

1. 320px, 360px, and wider sidepanel widths have no horizontal page overflow.
2. Empty Q&A and Agent modes show different guidance.
3. Current http(s) page, restricted page, and failed-context states are truthful.
4. History drawer opens, searches, switches, deletes with confirmation, and closes with Escape.
5. Enter sends; Shift+Enter inserts a newline; `/` filters and runs a shortcut.
6. Page context can be removed for one ordinary message; shortcut scope still wins for shortcuts.
7. Agent running, confirming, approved, denied, stopped, failed, complete, and undo states remain usable.
8. Settings opens as a separate Options page.
9. General, appearance, language, model, shortcut, privacy, and about sections work.
10. Provider and shortcut add/edit errors retain the user’s draft.
11. Light, dark, system, Chinese, English, keyboard-only, and visible-focus paths work.

- [ ] **Step 6: Update progress documentation**

Add one dated entry to `docs/PROGRESS.md` listing:

- context workbench sidepanel;
- history drawer;
- unified composer and slash commands;
- aggregated Agent activity;
- grouped Options page;
- Provider/shortcut management refresh;
- exact verification commands and their passing results.

- [ ] **Step 7: Review the final diff for scope**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only files named in this plan are changed; no `.superpowers/`, build output, API keys, or unrelated refactors appear.

- [ ] **Step 8: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/sidepanel/icons.tsx entrypoints/sidepanel/components/test-harness.test.tsx assets/tailwind.css docs/PROGRESS.md
git commit -m "feat: finish context workbench redesign"
```
