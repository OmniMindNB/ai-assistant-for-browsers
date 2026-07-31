# 去掉 ask/agent 模式切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除侧边栏顶部的 ask/agent 模式切换（`ModeSwitch`）及其贯穿状态管理、设置页、i18n 的所有相关代码，把 composer 收敛成单一输入体验；真正生效的「是否附加页面上下文」开关（`pageAttached`）保持不变。

**Architecture:** 这是一次纯粹的删除式重构，不引入新状态或新组件。按耦合关系分四个任务：(1) 数据层 `lib/workbench/preferences.ts` 去掉 `defaultMode` 字段；(2) 侧边栏 UI 层（`ModeSwitch` 删除、`App.tsx`/`WorkbenchComposer`/`WorkbenchEmptyState`/i18n 词条）一起改，因为它们必须同时改完才能重新编译通过；(3) 设置页 `GeneralSettings.tsx` 去掉模式单选组；(4) `store-context.test.tsx` 里残留的 `defaultMode` 测试夹具清理。最后一个任务做全量验证。

**Tech Stack:** React 19 + TypeScript + Zustand（`entrypoints/sidepanel/store.ts`）+ Vitest + Testing Library，既有代码风格沿用（Tailwind、`useTranslation`/`t()` i18n）。

## Global Constraints

- 不改变 `pageAttached` / `withoutBrowserTools` / `lib/agent/permissions.ts` 确认门逻辑——回归验证要确认这套行为与改动前完全一致。
- 已存储的旧版 `WorkbenchPreferences`（带 `defaultMode` 字段）读取时不能报错，多余字段直接忽略，不做迁移/清理。
- 新增的统一文案 key：`workbench.composerPlaceholder`、`workbench.emptyTitle`、`workbench.emptyDescription`（中英文都要有，见各任务的具体文案）。
- 删除的 key：`settings.defaultMode`、`settings.modeAsk`、`settings.modeAgent`、`workbench.modeSwitch`、`workbench.modeAsk`、`workbench.modeAgent`、`workbench.composerAskPlaceholder`、`workbench.composerAgentPlaceholder`、`workbench.emptyAskTitle`、`workbench.emptyAskDescription`、`workbench.emptyAgentTitle`、`workbench.emptyAgentDescription`。
- 参考设计文档：`docs/superpowers/specs/2026-07-31-remove-ask-agent-mode-design.md`。

---

### Task 1: 数据层 — `lib/workbench/preferences.ts`

**Files:**
- Modify: `lib/workbench/preferences.ts`
- Test: `lib/workbench/preferences.test.ts`

**Interfaces:**
- Produces: `export interface WorkbenchPreferences { attachPageByDefault: boolean }`（不再有 `defaultMode`/`WorkbenchMode`），`DEFAULT_WORKBENCH_PREFERENCES = { attachPageByDefault: true }`，`loadWorkbenchPreferences(): Promise<WorkbenchPreferences>`、`saveWorkbenchPreferences(value: WorkbenchPreferences): Promise<void>` 签名不变。后续所有任务都依赖这个精简后的类型。

- [ ] **Step 1: 改写测试，反映新的校验规则**

把 `lib/workbench/preferences.test.ts` 整个替换为：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  WORKBENCH_PREFERENCES_KEY,
} from './preferences';

const originalBrowser = (globalThis as any).browser;

function installStorage(value: Record<string, unknown> = {}) {
  const get = vi.fn(async (key: string) => (key in value ? { [key]: value[key] } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(value, items));
  (globalThis as any).browser = {
    storage: { local: { get, set } },
  };
  return { get, set, value };
}

afterEach(() => {
  (globalThis as any).browser = originalBrowser;
  vi.restoreAllMocks();
});

describe('workbench preferences', () => {
  it('returns safe defaults when the key is absent', async () => {
    installStorage();

    await expect(loadWorkbenchPreferences()).resolves.toEqual({
      attachPageByDefault: true,
    });
  });

  it('rejects invalid persisted values without rewriting storage', async () => {
    const { set } = installStorage({
      workbenchPreferences: { attachPageByDefault: 'yes' },
    });

    await expect(loadWorkbenchPreferences()).rejects.toThrow('Invalid workbench preferences');
    expect(set).not.toHaveBeenCalled();
  });

  it('returns a valid stored preference record unchanged', async () => {
    const stored = { attachPageByDefault: false };
    installStorage({ [WORKBENCH_PREFERENCES_KEY]: stored });

    await expect(loadWorkbenchPreferences()).resolves.toEqual(stored);
  });

  it('ignores a leftover defaultMode field from a pre-upgrade stored record', async () => {
    installStorage({
      [WORKBENCH_PREFERENCES_KEY]: { defaultMode: 'agent', attachPageByDefault: false },
    });

    await expect(loadWorkbenchPreferences()).resolves.toEqual({
      defaultMode: 'agent',
      attachPageByDefault: false,
    });
  });

  it('persists a complete preference record under the dedicated key', async () => {
    const { set } = installStorage();
    const preferences = { ...DEFAULT_WORKBENCH_PREFERENCES, attachPageByDefault: false };

    await saveWorkbenchPreferences(preferences);

    expect(set).toHaveBeenCalledWith({ [WORKBENCH_PREFERENCES_KEY]: preferences });
  });
});
```

注意第四个用例：升级场景下旧对象仍带着 `defaultMode`，校验只看 `attachPageByDefault`，所以整个原始对象会原样透传返回（不做字段裁剪），这是本任务刻意的行为——不迁移、不清理，只是不再依赖那个字段。

- [ ] **Step 2: 运行测试，确认按当前实现会失败**

Run: `pnpm vitest run lib/workbench/preferences.test.ts`
Expected: FAIL — 第一个用例 `resolves.toEqual({ attachPageByDefault: true })` 会因为当前实现返回值多了 `defaultMode: 'ask'` 而失败；第二个用例的 `attachPageByDefault: 'yes'` 之前会因为 `defaultMode` 缺失被判无效，报错文案不变但原因不同，属于巧合通过，不用管；第四个新用例会因为当前实现对 `defaultMode` 值域做校验（`'agent'` 合法，实际能通过）——重点看第一个用例确实是 FAIL。

- [ ] **Step 3: 精简实现**

```ts
export const WORKBENCH_PREFERENCES_KEY = 'workbenchPreferences';

export interface WorkbenchPreferences {
  attachPageByDefault: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  attachPageByDefault: true,
};

export async function loadWorkbenchPreferences(): Promise<WorkbenchPreferences> {
  const stored = (await browser.storage.local.get(WORKBENCH_PREFERENCES_KEY))[WORKBENCH_PREFERENCES_KEY];
  if (stored === undefined) return DEFAULT_WORKBENCH_PREFERENCES;
  if (
    typeof stored !== 'object' ||
    stored === null ||
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

这是对 `lib/workbench/preferences.ts` 全文件的替换（去掉 `WorkbenchMode` 类型、`defaultMode` 字段、以及对它的校验分支）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/workbench/preferences.test.ts`
Expected: PASS（5 个用例全部通过）

- [ ] **Step 5: Commit**

```bash
git add lib/workbench/preferences.ts lib/workbench/preferences.test.ts
git commit -m "refactor: drop defaultMode from workbench preferences"
```

---

### Task 2: 侧边栏 UI — 删除 `ModeSwitch`、统一 composer/空状态文案

**Files:**
- Delete: `entrypoints/sidepanel/components/ModeSwitch.tsx`
- Modify: `entrypoints/sidepanel/components/WorkbenchEmptyState.tsx`
- Modify: `entrypoints/sidepanel/components/WorkbenchComposer.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/i18n.test.ts`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: `WorkbenchPreferences`（无 `defaultMode`）来自 Task 1。
- Produces: `WorkbenchEmptyStateProps` 不再含 `mode`；`WorkbenchComposerProps` 不再含 `mode`；`App.tsx` 不再有 `mode`/`setMode` 状态。Task 3、4 不依赖本任务产出的具体符号，只是同属一次编译单元。

这个任务把所有必须同时改完才能让 `pnpm compile` 重新通过的文件放在一起，按「先改 i18n 词条 → 删组件 → 改消费方 → 改测试」的顺序执行，最后统一跑测试。

- [ ] **Step 1: 更新中文词条 `lib/i18n/locales/zh.ts`**

删除这几行（settings 分组内）：

```ts
  'settings.defaultMode': '默认工作模式',
  'settings.modeAsk': '问答',
  'settings.modeAgent': 'Agent 任务',
```

保留紧随其后的 `settings.attachPageByDefault` / `settings.attachPageDescription` 两行不动。

删除 workbench 分组内这几行：

```ts
  'workbench.modeSwitch': '工作模式',
  'workbench.modeAsk': '问答',
  'workbench.modeAgent': 'Agent 任务',
  'workbench.composerAskPlaceholder': '询问当前网页… Enter 发送，Shift+Enter 换行',
  'workbench.composerAgentPlaceholder': '描述要执行的浏览器任务… Enter 发送，Shift+Enter 换行',
  'workbench.emptyAskTitle': '询问这个页面',
  'workbench.emptyAskDescription': '获取理解当前页面的帮助。',
  'workbench.emptyAgentTitle': '描述浏览器任务',
  'workbench.emptyAgentDescription': '我可以逐步协助完成浏览器任务。',
```

原地替换为：

```ts
  'workbench.composerPlaceholder': '输入你的问题，或描述要执行的浏览器任务… Enter 发送，Shift+Enter 换行',
  'workbench.emptyTitle': '可以开始了',
  'workbench.emptyDescription': '问我关于当前页面的问题，或者描述一个想让我在浏览器里完成的任务。',
```

- [ ] **Step 2: 更新英文词条 `lib/i18n/locales/en.ts`**

删除 settings 分组内：

```ts
  'settings.defaultMode': 'Default work mode',
  'settings.modeAsk': 'Ask questions',
  'settings.modeAgent': 'Agent tasks',
```

删除 workbench 分组内：

```ts
  'workbench.modeSwitch': 'Workbench mode',
  'workbench.modeAsk': 'Ask',
  'workbench.modeAgent': 'Agent',
  'workbench.composerAskPlaceholder': 'Ask about this page… Enter to send, Shift+Enter for a new line',
  'workbench.composerAgentPlaceholder': 'Describe a browser task… Enter to send, Shift+Enter for a new line',
  'workbench.emptyAskTitle': 'Ask about this page',
  'workbench.emptyAskDescription': 'Get help understanding the current page.',
  'workbench.emptyAgentTitle': 'Describe a browser task',
  'workbench.emptyAgentDescription': 'I can help carry out browser tasks step by step.',
```

替换为：

```ts
  'workbench.composerPlaceholder': 'Ask a question, or describe a browser task… Enter to send, Shift+Enter for a new line',
  'workbench.emptyTitle': 'Ready when you are',
  'workbench.emptyDescription': 'Ask about the current page, or describe a browser task you want me to complete.',
```

- [ ] **Step 3: 删除 `ModeSwitch.tsx`**

```bash
git rm entrypoints/sidepanel/components/ModeSwitch.tsx
```

- [ ] **Step 4: 简化 `WorkbenchEmptyState.tsx`**

整个文件替换为：

```tsx
import type { ShortcutConfig } from '@/lib/shortcuts';
import type { ResolvedShortcutCommand } from '@/lib/workbench/presentation';
import { IconSparkles } from '../icons';
import { useTranslation } from '@/lib/i18n';

export interface WorkbenchEmptyStateProps {
  shortcuts: readonly ResolvedShortcutCommand[];
  busy: boolean;
  onRunShortcut(shortcut: ShortcutConfig): void;
}

function isUsableShortcut(command: ResolvedShortcutCommand): boolean {
  return Boolean(command.config.id && command.resolved.id && command.resolved.name.trim() && command.resolved.prompt.trim());
}

export function WorkbenchEmptyState({ shortcuts, busy, onRunShortcut }: WorkbenchEmptyStateProps) {
  const { t } = useTranslation();
  const suggestions = shortcuts.filter(isUsableShortcut).slice(0, 4);

  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-white dark:bg-neutral-800">
        <IconSparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('workbench.emptyTitle')}
      </h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {t('workbench.emptyDescription')}
      </p>
      {suggestions.length > 0 && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {suggestions.map(({ config, resolved }) => (
            <button
              key={config.id}
              type="button"
              disabled={busy}
              onClick={() => onRunShortcut(config)}
              aria-label={resolved.name}
              title={resolved.name}
              className="inline-flex max-w-48 items-center rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <span className="truncate">{resolved.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 简化 `WorkbenchComposer.tsx`**

删除 `mode` 相关的类型导入和 prop：

```ts
import type { WorkbenchMode } from '@/lib/workbench/preferences';
```
→ 整行删除。

```ts
  mode?: WorkbenchMode;
```
→ 从 `WorkbenchComposerProps` 接口整行删除。

```ts
  mode = 'ask',
```
→ 从解构参数列表整行删除。

```tsx
            placeholder={mode === 'agent' ? t('workbench.composerAgentPlaceholder') : t('workbench.composerAskPlaceholder')}
```
→ 替换为：

```tsx
            placeholder={t('workbench.composerPlaceholder')}
```

- [ ] **Step 6: 简化 `App.tsx`**

删除 import：

```ts
import { ModeSwitch } from './components/ModeSwitch';
```

把：

```ts
import { WORKBENCH_PREFERENCES_KEY, type WorkbenchMode } from '@/lib/workbench/preferences';
```

改为：

```ts
import { WORKBENCH_PREFERENCES_KEY } from '@/lib/workbench/preferences';
```

删除 mode 状态：

```ts
  const [mode, setMode] = useState<WorkbenchMode>('ask');
```

在“新空会话时恢复默认偏好”的 effect 里去掉 `setMode` 调用：

```ts
  useEffect(() => {
    const isNewEmptyConversation =
      messages.length === 0 && input.trim().length === 0 && !busy && !pendingConfirmation && toolActivities.length === 0;
    if (!isNewEmptyConversation) return;
    setMode(workbenchPreferences.defaultMode);
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }, [busy, input, messages.length, pendingConfirmation, toolActivities.length, workbenchPreferences]);
```

改为：

```ts
  useEffect(() => {
    const isNewEmptyConversation =
      messages.length === 0 && input.trim().length === 0 && !busy && !pendingConfirmation && toolActivities.length === 0;
    if (!isNewEmptyConversation) return;
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }, [busy, input, messages.length, pendingConfirmation, toolActivities.length, workbenchPreferences]);
```

`newChat()` 里去掉 `setMode`：

```ts
  function newChat() {
    clear();
    setHistoryOpen(false);
    setMode(workbenchPreferences.defaultMode);
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }
```

改为：

```ts
  function newChat() {
    clear();
    setHistoryOpen(false);
    setPageAttached(workbenchPreferences.attachPageByDefault);
  }
```

`pickConversation()` 里去掉 `setMode`：

```ts
  async function pickConversation(id: string) {
    if (await openConversation(id)) {
      const currentPreferences = useChat.getState().workbenchPreferences;
      setMode(currentPreferences.defaultMode);
      setPageAttached(currentPreferences.attachPageByDefault);
      setHistoryOpen(false);
    }
  }
```

改为：

```ts
  async function pickConversation(id: string) {
    if (await openConversation(id)) {
      const currentPreferences = useChat.getState().workbenchPreferences;
      setPageAttached(currentPreferences.attachPageByDefault);
      setHistoryOpen(false);
    }
  }
```

删除渲染 `ModeSwitch` 的整个 div：

```tsx
          <div className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
            <ModeSwitch mode={mode} onChange={setMode} />
          </div>

```

（连同它前后多余的空行一起删，紧接着的 `<div className="relative flex-1 overflow-hidden">` 保持原位。）

删除传给 `WorkbenchEmptyState` 的 `mode` prop：

```tsx
                  <WorkbenchEmptyState
                    mode={mode}
                    shortcuts={resolvedShortcuts}
```

改为：

```tsx
                  <WorkbenchEmptyState
                    shortcuts={resolvedShortcuts}
```

删除传给 `WorkbenchComposer` 的 `mode` prop：

```tsx
            selectedModel={selectedModel}
            mode={mode}
            onInput={setInput}
```

改为：

```tsx
            selectedModel={selectedModel}
            onInput={setInput}
```

- [ ] **Step 7: 更新 `lib/i18n/i18n.test.ts` 里的 key 清单**

把：

```ts
const contextWorkbenchKeys = [
  'workbench.modeSwitch',
  'workbench.modeAsk',
  'workbench.modeAgent',
  'workbench.emptyAskTitle',
  'workbench.emptyAskDescription',
  'workbench.emptyAgentTitle',
  'workbench.emptyAgentDescription',
  'workbench.untitledPage',
  'agentActivity.cardLabel',
  'agentActivity.liveStatus',
  'provider.setActiveAria',
  'provider.editAria',
  'provider.deleteAria',
  'shortcut.editAria',
  'shortcut.deleteAria',
] as const;
```

改为：

```ts
const contextWorkbenchKeys = [
  'workbench.composerPlaceholder',
  'workbench.emptyTitle',
  'workbench.emptyDescription',
  'workbench.untitledPage',
  'agentActivity.cardLabel',
  'agentActivity.liveStatus',
  'provider.setActiveAria',
  'provider.editAria',
  'provider.deleteAria',
  'shortcut.editAria',
  'shortcut.deleteAria',
] as const;
```

- [ ] **Step 8: 更新 `entrypoints/sidepanel/components/workbench-components.test.tsx`**

删除 `ModeSwitch` 的 import：

```ts
import { ModeSwitch } from './ModeSwitch';
```

两处 `workbenchPreferences` 测试夹具都去掉 `defaultMode`。第一处（顶层 `chatStore` 对象字面量）：

```ts
  workbenchPreferences: { defaultMode: 'ask' as const, attachPageByDefault: true },
```

改为：

```ts
  workbenchPreferences: { attachPageByDefault: true },
```

第二处（`beforeEach` 里的 `Object.assign(chatStore, {...})`）同样的一行做同样的替换。

把「切换空状态文案」的用例：

```ts
  it('changes empty suggestions between ask and agent modes', () => {
    const { rerender } = render(
      <LocaleProvider>
        <WorkbenchEmptyState mode="ask" shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );
    expect(screen.getByText('Ask about this page')).toBeVisible();

    rerender(
      <LocaleProvider>
        <WorkbenchEmptyState mode="agent" shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );
    expect(screen.getByText('Describe a browser task')).toBeVisible();
  });
```

替换为验证统一文案的用例：

```ts
  it('shows a single unified empty-state message regardless of intent', () => {
    render(
      <LocaleProvider>
        <WorkbenchEmptyState shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText('Ready when you are')).toBeVisible();
    expect(
      screen.getByText('Ask about the current page, or describe a browser task you want me to complete.'),
    ).toBeVisible();
  });
```

删除「暴露当前模式的 pressed 状态」这个整条用例（`ModeSwitch` 已不存在）：

```ts
  it('exposes pressed state for the active mode', () => {
    render(
      <LocaleProvider>
        <ModeSwitch mode="agent" onChange={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'true');
  });

```

「空状态快捷指令最多四条」用例去掉 `mode="ask"`：

```ts
        <WorkbenchEmptyState mode="ask" shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
```

改为：

```ts
        <WorkbenchEmptyState shortcuts={emptyStateShortcuts} busy={false} onRunShortcut={vi.fn()} />
```

「Agent 模式下受限页面消息」用例改名并去掉点击 `Agent` 按钮那一步（`ModeSwitch` 按钮已不存在）：

```ts
  it('runs an Agent-mode restricted-page message without browser tools and then resets detachment', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Agent' }));
    await user.click(screen.getByRole('button', { name: 'Continue without page context' }));
    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
    expect(screen.getByRole('button', { name: 'Continue without page context' })).toBeEnabled();
  });
```

改为：

```ts
  it('runs a restricted-page message without browser tools and then resets detachment', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Continue without page context' }));
    await user.click(screen.getByRole('textbox', { name: 'Message input' }));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith(undefined, { withoutBrowserTools: true }));
    expect(screen.getByRole('button', { name: 'Continue without page context' })).toBeEnabled();
  });
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/i18n.test.ts`
Expected: PASS（全部用例通过；不应再出现任何按 `mode` 分支的断言）

- [ ] **Step 10: Commit**

`ModeSwitch.tsx` 的删除在 Step 3 已经用 `git rm` 暂存过，这里只需要把其余改动加入暂存区再一起提交：

```bash
git add entrypoints/sidepanel/App.tsx \
  entrypoints/sidepanel/components/WorkbenchComposer.tsx \
  entrypoints/sidepanel/components/WorkbenchEmptyState.tsx \
  entrypoints/sidepanel/components/workbench-components.test.tsx \
  lib/i18n/locales/zh.ts lib/i18n/locales/en.ts lib/i18n/i18n.test.ts
git commit -m "refactor: remove the ask/agent mode switch from the workbench UI"
```

---

### Task 3: 设置页 — 简化 `GeneralSettings.tsx`

**Files:**
- Modify: `components/GeneralSettings.tsx`
- Test: `components/settings-components.test.tsx`

**Interfaces:**
- Consumes: Task 1 产出的 `WorkbenchPreferences`（无 `defaultMode`）。

- [ ] **Step 1: 更新测试夹具与用例**

在 `components/settings-components.test.tsx` 里，把 `beforeEach` 里的：

```ts
    preferencesMocks.load.mockResolvedValue({ defaultMode: 'ask', attachPageByDefault: true });
```

改为：

```ts
    preferencesMocks.load.mockResolvedValue({ attachPageByDefault: true });
```

把「加载完成前控件保持禁用」用例：

```ts
  it('keeps preference controls disabled until the initial preferences load', async () => {
    const loading = deferred<{ defaultMode: 'ask' | 'agent'; attachPageByDefault: boolean }>();
    preferencesMocks.load.mockReturnValue(loading.promise);
    renderWithLocale(<GeneralSettings />);

    expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    loading.resolve({ defaultMode: 'agent', attachPageByDefault: false });

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).not.toBeChecked();
  });
```

改为：

```ts
  it('keeps preference controls disabled until the initial preferences load', async () => {
    const loading = deferred<{ attachPageByDefault: boolean }>();
    preferencesMocks.load.mockReturnValue(loading.promise);
    renderWithLocale(<GeneralSettings />);

    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    loading.resolve({ attachPageByDefault: false });

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).not.toBeChecked();
  });
```

把「保存期间锁定草稿并报告成功」用例：

```ts
  it('locks the preference draft while saving and reports success for the saved value', async () => {
    const user = userEvent.setup();
    const saving = deferred<void>();
    preferencesMocks.save.mockReturnValue(saving.promise);
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: 'Agent tasks' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Ask questions' }));
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();

    saving.resolve();

    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();
  });
```

改为（改用「附加当前网页」勾选框来验证同样的 loading/saving/saved 生命周期）：

```ts
  it('locks the preference draft while saving and reports success for the saved value', async () => {
    const user = userEvent.setup();
    const saving = deferred<void>();
    preferencesMocks.save.mockReturnValue(saving.promise);
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: 'Attach current page by default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();

    saving.resolve();

    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).not.toBeChecked();
  });
```

把「保存失败后恢复控件并保留草稿」用例：

```ts
  it('restores controls and preserves the draft after a save failure', async () => {
    const user = userEvent.setup();
    const saving = deferred<void>();
    preferencesMocks.save.mockReturnValue(saving.promise);
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: 'Agent tasks' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeDisabled();

    saving.reject(new Error('storage failed'));

    expect(await screen.findByRole('alert')).toHaveTextContent('storage failed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();
  });
```

改为：

```ts
  it('restores controls and preserves the draft after a save failure', async () => {
    const user = userEvent.setup();
    const saving = deferred<void>();
    preferencesMocks.save.mockReturnValue(saving.promise);
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: 'Attach current page by default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();

    saving.reject(new Error('storage failed'));

    expect(await screen.findByRole('alert')).toHaveTextContent('storage failed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).not.toBeChecked();
  });
```

- [ ] **Step 2: 运行测试，确认按当前实现会失败**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: FAIL — 新用例里找不到 `checkbox`/找到多余的 `radio`，或者 `preferencesMocks.load` 的返回值缺少 `defaultMode` 导致 `GeneralSettings` 当前实现里 `draft.defaultMode` 相关 UI 渲染异常。

- [ ] **Step 3: 精简 `GeneralSettings.tsx`**

去掉 `WorkbenchMode` 类型导入：

```ts
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchMode,
  type WorkbenchPreferences,
} from '@/lib/workbench/preferences';
```

改为：

```ts
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchPreferences,
} from '@/lib/workbench/preferences';
```

删除 `updateMode` 函数：

```ts
  function updateMode(defaultMode: WorkbenchMode) {
    setDraft((current) => ({ ...current, defaultMode }));
    setSaved(false);
    setError(null);
  }

```

删除「默认工作模式」`fieldset`：

```tsx
      <fieldset className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <legend className="px-1 text-sm font-medium">{t('settings.defaultMode')}</legend>
        <div className="mt-2 space-y-2">
          <Radio
            checked={draft.defaultMode === 'ask'}
            disabled={loading || saving}
            label={t('settings.modeAsk')}
            onChange={() => updateMode('ask')}
            value="ask"
          />
          <Radio
            checked={draft.defaultMode === 'agent'}
            disabled={loading || saving}
            label={t('settings.modeAgent')}
            onChange={() => updateMode('agent')}
            value="agent"
          />
        </div>
      </fieldset>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
```

改为（附加页面的 `label` 紧接说明段落，`mt-4` 改成 `mt-6` 保持原有的间距节奏）：

```tsx
      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
```

删除文件末尾的 `Radio` 子组件（已无消费方）：

```tsx
function Radio({ checked, disabled, label, onChange, value }: { checked: boolean; disabled: boolean; label: string; onChange(): void; value: WorkbenchMode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800">
      <input type="radio" name="default-mode" value={value} checked={checked} disabled={disabled} onChange={onChange} className="h-4 w-4 accent-indigo-600" />
      {label}
    </label>
  );
}

```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/GeneralSettings.tsx components/settings-components.test.tsx
git commit -m "refactor: remove the default-mode radio group from general settings"
```

---

### Task 4: 清理 `store-context.test.tsx` 里残留的 `defaultMode` 测试夹具

**Files:**
- Modify: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: Task 1 产出的 `WorkbenchPreferences`（无 `defaultMode`）。这些是类型化的测试夹具，`defaultMode` 字段留着会在 `pnpm compile` 时报「对象字面量多余属性」错误，必须清理才能让全仓库编译通过。

`store.ts` 本身不引用 `defaultMode`（已用 `DEFAULT_WORKBENCH_PREFERENCES`/`WorkbenchPreferences` 间接依赖 Task 1 的改动），本任务只动测试文件。

- [ ] **Step 1: 更新「加载工作台偏好设置进 store」用例**

```ts
  it('loads workbench preferences into store state', async () => {
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState().workbenchPreferences).toEqual({
      defaultMode: 'agent',
      attachPageByDefault: false,
    });
  });
```

改为：

```ts
  it('loads workbench preferences into store state', async () => {
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState().workbenchPreferences).toEqual({
      attachPageByDefault: false,
    });
  });
```

- [ ] **Step 2: 更新「新旧并发刷新取最新值」用例里的两处 `workbenchPreferences`**

```ts
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(newest)
      .mockResolvedValue({ workbenchPreferences: { defaultMode: 'ask', attachPageByDefault: true } });
```

改为：

```ts
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(newest)
      .mockResolvedValue({ workbenchPreferences: { attachPageByDefault: true } });
```

```ts
    const oldPrefs = Promise.reject(new Error('old failure'));
    const newPrefs = Promise.resolve({ workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false } });
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(oldPrefs).mockReturnValueOnce(newPrefs);
    await Promise.all([useChat.getState().refreshWorkbenchPreferences(), useChat.getState().refreshWorkbenchPreferences()]);
    expect(useChat.getState().workbenchPreferences).toEqual({ defaultMode: 'agent', attachPageByDefault: false });
```

改为：

```ts
    const oldPrefs = Promise.reject(new Error('old failure'));
    const newPrefs = Promise.resolve({ workbenchPreferences: { attachPageByDefault: false } });
    (globalThis as any).browser.storage.local.get = vi.fn().mockReturnValueOnce(oldPrefs).mockReturnValueOnce(newPrefs);
    await Promise.all([useChat.getState().refreshWorkbenchPreferences(), useChat.getState().refreshWorkbenchPreferences()]);
    expect(useChat.getState().workbenchPreferences).toEqual({ attachPageByDefault: false });
```

- [ ] **Step 3: 更新「加载成功时保留既有聊天错误」用例**

```ts
  it('preserves an existing chat error when workbench preferences load successfully', async () => {
    useChat.setState({ error: 'The provider request failed.' });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The provider request failed.',
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });
  });
```

改为：

```ts
  it('preserves an existing chat error when workbench preferences load successfully', async () => {
    useChat.setState({ error: 'The provider request failed.' });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The provider request failed.',
      workbenchPreferences: { attachPageByDefault: false },
    });
  });
```

- [ ] **Step 4: 更新两个「非法偏好值」用例，改用 `attachPageByDefault` 触发校验失败**

这两个用例原本靠一个非法的 `defaultMode: 'invalid'` 触发 `loadWorkbenchPreferences` 的校验错误；Task 1 之后校验只看 `attachPageByDefault`，所以要改成用一个非布尔的 `attachPageByDefault` 值来触发同样的失败路径。

```ts
  it('preserves an existing chat error when workbench preference loading fails', async () => {
    useChat.setState({
      error: 'The agent request failed.',
      workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false },
    });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'invalid', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The agent request failed.',
      workbenchPreferences: { defaultMode: 'ask', attachPageByDefault: true },
    });
  });
```

改为：

```ts
  it('preserves an existing chat error when workbench preference loading fails', async () => {
    useChat.setState({
      error: 'The agent request failed.',
      workbenchPreferences: { attachPageByDefault: false },
    });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: 'not-a-boolean' },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'The agent request failed.',
      workbenchPreferences: { attachPageByDefault: true },
    });
  });
```

```ts
  it('restores safe defaults and publishes invalid preference errors when no chat error exists', async () => {
    useChat.setState({ workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: false } });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { defaultMode: 'invalid', attachPageByDefault: false },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'Invalid workbench preferences',
      workbenchPreferences: { defaultMode: 'ask', attachPageByDefault: true },
    });
  });
```

改为：

```ts
  it('restores safe defaults and publishes invalid preference errors when no chat error exists', async () => {
    useChat.setState({ workbenchPreferences: { attachPageByDefault: false } });
    (globalThis as typeof globalThis & { browser: any }).browser.storage.local.get = vi.fn().mockResolvedValue({
      workbenchPreferences: { attachPageByDefault: 'not-a-boolean' },
    });

    await useChat.getState().refreshWorkbenchPreferences();

    expect(useChat.getState()).toMatchObject({
      error: 'Invalid workbench preferences',
      workbenchPreferences: { attachPageByDefault: true },
    });
  });
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/store-context.test.tsx
git commit -m "test: drop defaultMode fixtures from store workbench-preference tests"
```

---

### Task 5: 全量验证

**Files:** 无新增/修改文件，仅验证。

**Interfaces:** 无。

- [ ] **Step 1: 全量类型检查**

Run: `pnpm compile`
Expected: 无 TypeScript 报错——特别确认没有任何文件还在引用已删除的 `WorkbenchMode` 类型或 `defaultMode` 字段。

- [ ] **Step 2: 全量单测**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 3: 生产构建**

Run: `pnpm build`
Expected: 构建成功，产物落在 `.output/chrome-mv3`。

- [ ] **Step 4: 手动验证（`chrome://extensions` 加载 `.output/chrome-mv3`）**

- 侧边栏顶部不再出现模式切换；空状态标题/描述、composer placeholder 均为统一文案。
- 点击「附加页面」chip 关闭后发消息：确认 agent 不发起任何 `browser_*` 工具调用；重新打开后可以正常发起（写操作仍需确认弹窗）。
- 打开设置页「通用」分组：只剩「默认附加当前网页」一项，没有模式单选组。
- 升级场景：在扩展的 DevTools Console 里执行
  `chrome.storage.local.set({ workbenchPreferences: { defaultMode: 'agent', attachPageByDefault: true } })`，
  刷新侧边栏和设置页，确认两者都正常加载、不报错。

- [ ] **Step 5: Commit（如手动验证阶段有微调）**

若手动验证发现需要修补的小问题，按正常流程改代码 → 补/改测试 → commit；若一切通过则本任务无需额外 commit。

---

## 验收标准（对齐设计文档）

- [ ] `ModeSwitch.tsx` 已删除，`App.tsx`/`WorkbenchComposer.tsx`/`WorkbenchEmptyState.tsx` 中不再有 `mode` 相关 state/prop。
- [ ] `WorkbenchMode` 类型和 `WorkbenchPreferences.defaultMode` 字段已从 `lib/workbench/preferences.ts` 移除；`loadWorkbenchPreferences` 对携带旧 `defaultMode` 字段的存储对象不报错。
- [ ] `GeneralSettings.tsx` 只保留「默认附加当前网页」一项。
- [ ] i18n 中旧的 ask/agent 相关 key 已移除，新的统一 key 中英文均已补齐。
- [ ] `pageAttached` / `withoutBrowserTools` / 确认门行为与改动前完全一致（回归验证）。
- [ ] `pnpm compile` 与 `pnpm test` 通过。
