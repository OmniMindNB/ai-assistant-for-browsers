# 划词提问悬浮气泡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在任意网页选中文字后出现一个悬浮气泡，点击后打开该 tab 的侧边栏并把选中文字预填进聊天输入框，用户输入具体问题、走现有 agent 对话流程发送。

**Architecture:** 新增一条从 content script 主动发起的消息（`ASK_SELECTION`），background 收到后把选区文字写入 `browser.storage.session`（按 tabId 隔离，仿 `lib/agent/tab-conversation.ts`）并同步打开侧边栏；侧边栏挂载时读取这条 pending 数据、消费并清空，预填进现有输入框、聚焦。气泡本身是 content script 里挂载的 Shadow DOM UI，受一个全局开关控制。

**Tech Stack:** TypeScript、WXT（Manifest V3）、React + Zustand（侧边栏）、`browser.storage.session`/`browser.storage.local`、Vitest + Testing Library、`wxt/testing` 的 `fakeBrowser`。

**Spec:** `docs/superpowers/specs/2026-08-20-selection-ask-bubble-design.md`

## Global Constraints

- `sidePanel.open()`/`sidePanel.setOptions()` 必须在触发它们的用户手势同一个事件循环 tick 内同步调用，中间不能有 `await`/`.then()`——否则 Chrome 抛 `"sidePanel.open() may only be called in response to a user gesture."`（已在 `entrypoints/background.ts:87-90` 验证过的坑）。
- 选区文字截断长度统一复用 `MAX_SHORTCUT_SELECTION_CHARS = 4000`（`lib/chat/shortcut-prompts.ts`），不要新定义一个不同的常量。
- 新增的 i18n key 必须在 `lib/i18n/locales/en.ts` 和 `lib/i18n/locales/zh.ts` 成对添加，插值占位符用单花括号 `{name}` 语法（`interpolate()` 约定）。
- `entrypoints/content.ts`、`entrypoints/background.ts` 是纯 `.ts`（非 `.tsx`）文件，`vitest.config.ts` 的两个 project（`include: ['lib/**/*.test.ts']` 和 `include: ['entrypoints/**/*.test.tsx', ...]`）都不会捕获它们——这两个文件里的改动不写自动化测试，靠 `pnpm compile` + `pnpm build` + 手动冒烟验证。
- 绝不能在 content script 里调用 `lib/i18n` 的 `applyLocale()`——它会写 `document.documentElement.lang`，在内容脚本里调用会**篡改被访问网页本身的 `lang` 属性**，这是一个真实的副作用 bug，不是风格问题。content script 需要的界面文案改为直接解析 locale 后从 `en`/`zh` 字典取值（见 Task 5）。
- 收尾统一跑：`pnpm compile`、`pnpm test`、`pnpm build`。

---

### Task 1: 消息协议新增 `ASK_SELECTION`

**Files:**
- Modify: `lib/messaging.ts:4-24`（`MessageType` 联合类型）、`lib/messaging.ts:68-71`（紧接 `PageSelection` 之后新增 payload 类型）

**Interfaces:**
- Produces: `MessageType` 新增成员 `'ASK_SELECTION'`；新增 `export interface AskSelectionPayload { text: string }`。后续所有任务都从 `@/lib/messaging` import 这两者。

这是纯类型声明，没有运行时行为可断言，`lib/messaging.ts` 也没有配套测试文件，因此本任务不写测试，靠 `pnpm compile` 验证。

- [ ] **Step 1: 在 `MessageType` 联合类型里插入新成员**

在 `lib/messaging.ts` 里，把：

```ts
export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'GET_ACTIVE_TAB'
```

改为：

```ts
export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'ASK_SELECTION'
  | 'GET_ACTIVE_TAB'
```

- [ ] **Step 2: 新增 `AskSelectionPayload`**

在 `lib/messaging.ts` 里，紧接 `PageSelection` 接口之后（原第 68-71 行）：

```ts
/** GET_SELECTION 返回的页面选区数据 */
export interface PageSelection {
  text: string;
}

/** ASK_SELECTION：content script 主动上报"用户点击了划词提问气泡"，携带选中的文本。 */
export interface AskSelectionPayload {
  text: string;
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 无新增类型错误（此时还没有任何代码消费这两个新类型，只是声明）。

- [ ] **Step 4: Commit**

```bash
git add lib/messaging.ts
git commit -m "feat: add ASK_SELECTION message type for selection-ask bubble"
```

---

### Task 2: `lib/agent/tab-pending-ask.ts`——按 tab 暂存待提问的选区文字

**Files:**
- Create: `lib/agent/tab-pending-ask.ts`
- Test: `lib/agent/tab-pending-ask.test.ts`

**Interfaces:**
- Consumes: 无（只用 `browser.storage.session`，全局 ambient `browser`）。
- Produces:
  - `getPendingAskForTab(tabId: number): Promise<string | undefined>`
  - `setPendingAskForTab(tabId: number, text: string): Promise<void>`
  - `clearPendingAskForTab(tabId: number): Promise<void>`

  Task 4（background.ts）用 `setPendingAskForTab`/`clearPendingAskForTab`（tab 关闭清理）；Task 6（store.ts）用 `getPendingAskForTab`/`clearPendingAskForTab`。

完全仿照 `lib/agent/tab-conversation.ts` 的实现和测试结构（同一种"按 tabId 隔离、存 `storage.session`、写入失败静默降级"的模式）。

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/tab-pending-ask.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { clearPendingAskForTab, getPendingAskForTab, setPendingAskForTab } from './tab-pending-ask';

(globalThis as any).browser = fakeBrowser;

describe('tab-pending-ask', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no pending ask for an untouched tab', async () => {
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('stores and reads back a pending ask', async () => {
    await setPendingAskForTab(TAB_ID, 'selected text');
    expect(await getPendingAskForTab(TAB_ID)).toBe('selected text');
  });

  it('overwrites the previous pending ask when set again', async () => {
    await setPendingAskForTab(TAB_ID, 'first');
    await setPendingAskForTab(TAB_ID, 'second');
    expect(await getPendingAskForTab(TAB_ID)).toBe('second');
  });

  it('clears the pending ask', async () => {
    await setPendingAskForTab(TAB_ID, 'selected text');
    await clearPendingAskForTab(TAB_ID);
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('isolates pending asks between different tabs', async () => {
    await setPendingAskForTab(1, 'for tab 1');
    await setPendingAskForTab(2, 'for tab 2');
    expect(await getPendingAskForTab(1)).toBe('for tab 1');
    expect(await getPendingAskForTab(2)).toBe('for tab 2');
  });

  it('degrades silently when persisting fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await setPendingAskForTab(TAB_ID, 'selected text');
    expect(await getPendingAskForTab(TAB_ID)).toBeUndefined();
  });

  it('does not throw when clearing a pending ask that was never set', async () => {
    await expect(clearPendingAskForTab(TAB_ID)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/tab-pending-ask.test.ts`
Expected: FAIL——`Cannot find module './tab-pending-ask'`（文件还不存在）。

- [ ] **Step 3: 实现**

创建 `lib/agent/tab-pending-ask.ts`：

```ts
// 每个标签页暂存"划词提问气泡刚提交的选中文字"，供侧边栏面板挂载时消费一次并预填输入框。
// 持久化到 browser.storage.session（而非模块级变量）：面板打开时 Chrome 可能刚把面板文档
// 重新加载，模块级变量活不过这次重建，只有 storage.session 能跨文档重建存活（同时不落盘，
// 浏览器重启后自动清空）。写法仿 lib/agent/tab-conversation.ts。

function storageKey(tabId: number): string {
  return `runi:tab-pending-ask:${tabId}`;
}

export async function getPendingAskForTab(tabId: number): Promise<string | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as string | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住。 */
export async function setPendingAskForTab(tabId: number, text: string): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: text });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearPendingAskForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/tab-pending-ask.test.ts`
Expected: PASS（7 个用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/tab-pending-ask.ts lib/agent/tab-pending-ask.test.ts
git commit -m "feat: add per-tab pending-ask storage for selection-ask bubble"
```

---

### Task 3: `lib/selection-ask.ts`——共享逻辑 + i18n

**Files:**
- Create: `lib/selection-ask.ts`
- Test: `lib/selection-ask.test.ts`
- Modify: `lib/i18n/locales/zh.ts`（新增 3 个 key）、`lib/i18n/locales/en.ts`（新增同样 3 个 key）

**Interfaces:**
- Consumes: `MAX_SHORTCUT_SELECTION_CHARS`（`@/lib/chat/shortcut-prompts`）、`Translate`/`TranslationKey`（`@/lib/i18n`）。
- Produces:
  - `SELECTION_ASK_ENABLED_KEY = 'runi:selection-ask-enabled'`
  - `loadSelectionAskEnabled(): Promise<boolean>`（默认 `true`）
  - `saveSelectionAskEnabled(enabled: boolean): Promise<void>`
  - `buildSelectionAskTemplate(text: string, translate: Translate): string`
  - `clampBubblePosition(rect: {top,left,right,bottom}, viewport: {width,height}, bubbleSize: {width,height}): {top: number, left: number}`

  Task 5（content.ts）用 `SELECTION_ASK_ENABLED_KEY`/`loadSelectionAskEnabled`/`clampBubblePosition`；Task 6（store.ts）用 `buildSelectionAskTemplate`；Task 8（ShortcutSettings.tsx）用 `loadSelectionAskEnabled`/`saveSelectionAskEnabled`。

新增 i18n key（三个都在这一个任务里成对加入，后续任务直接引用）：

| key | zh | en |
|---|---|---|
| `store.selectionAskTemplate` | `引用选中内容：\n> {selection}\n\n我的问题：` | `Regarding the selected text:\n> {selection}\n\nMy question: ` |
| `shortcut.selectionAskBubbleLabel` | `问 Runi` | `Ask Runi` |
| `shortcut.selectionAskToggleLabel` | `启用划词提问气泡` | `Enable selection-ask bubble` |

（`shortcut.*` 前缀是为了和 `components/ShortcutSettings.tsx` 里其余 `shortcut.heading`/`shortcut.description` 等既有 key 保持同一命名空间——这个开关就加在那个设置区块里，见 Task 8。）

- [ ] **Step 1: 先加 i18n key**

在 `lib/i18n/locales/zh.ts`，紧接 `'store.explainPrompt'` 那一项之后（原第 227 行之后）插入：

```ts
  'store.selectionAskTemplate': '引用选中内容：\n> {selection}\n\n我的问题：',
```

在 `lib/i18n/locales/zh.ts` 里找到 `shortcut.builtinTranslatePrompt`（或任意一个 `shortcut.*` key）附近，插入：

```ts
  'shortcut.selectionAskBubbleLabel': '问 Runi',
  'shortcut.selectionAskToggleLabel': '启用划词提问气泡',
```

在 `lib/i18n/locales/en.ts`，紧接对应的 `'store.explainPrompt'` 之后（原第 233-234 行之后）插入：

```ts
  'store.selectionAskTemplate': 'Regarding the selected text:\n> {selection}\n\nMy question: ',
```

同样在 en.ts 的 `shortcut.*` 区域插入：

```ts
  'shortcut.selectionAskBubbleLabel': 'Ask Runi',
  'shortcut.selectionAskToggleLabel': 'Enable selection-ask bubble',
```

- [ ] **Step 2: 写失败的测试**

创建 `lib/selection-ask.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/locales/en';
import type { Translate, TranslationKey } from '@/lib/i18n';
import {
  SELECTION_ASK_ENABLED_KEY,
  buildSelectionAskTemplate,
  clampBubblePosition,
  loadSelectionAskEnabled,
  saveSelectionAskEnabled,
} from './selection-ask';

const t = ((key: TranslationKey, vars?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    vars && name in vars ? String(vars[name]) : match,
  )) as Translate;

describe('buildSelectionAskTemplate', () => {
  it('interpolates the trimmed selection into the template', () => {
    expect(buildSelectionAskTemplate('  hello world  ', t)).toBe(
      'Regarding the selected text:\n> hello world\n\nMy question: ',
    );
  });

  it('truncates selections longer than the shared shortcut selection limit', () => {
    const long = 'x'.repeat(5000);
    const result = buildSelectionAskTemplate(long, t);
    expect(result).toContain('x'.repeat(4000));
    expect(result).not.toContain('x'.repeat(4001));
  });
});

describe('clampBubblePosition', () => {
  const viewport = { width: 800, height: 600 };
  const bubbleSize = { width: 88, height: 32 };

  it('places the bubble above the selection when there is room', () => {
    const rect = { top: 200, left: 100, right: 200, bottom: 220 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.top).toBe(200 - 32 - 8);
  });

  it('falls back to below the selection when there is no room above', () => {
    const rect = { top: 10, left: 100, right: 200, bottom: 30 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.top).toBe(30 + 8);
  });

  it('clamps the left edge so the bubble never runs off the left of the viewport', () => {
    const rect = { top: 200, left: -50, right: 10, bottom: 220 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.left).toBeGreaterThanOrEqual(4);
  });

  it('clamps the right edge so the bubble never runs off the right of the viewport', () => {
    const rect = { top: 200, left: 780, right: 830, bottom: 220 };
    const pos = clampBubblePosition(rect, viewport, bubbleSize);
    expect(pos.left).toBeLessThanOrEqual(viewport.width - bubbleSize.width - 4);
  });
});

describe('selection-ask enabled toggle', () => {
  beforeEach(() => {
    (globalThis as any).browser.storage.local = {
      get: async () => ({}),
      set: async () => undefined,
    };
  });

  it('defaults to enabled when nothing has been saved', async () => {
    expect(await loadSelectionAskEnabled()).toBe(true);
  });

  it('reads back a saved value', async () => {
    (globalThis as any).browser.storage.local.get = async () => ({ [SELECTION_ASK_ENABLED_KEY]: false });
    expect(await loadSelectionAskEnabled()).toBe(false);
  });

  it('persists the value under the expected storage key', async () => {
    let saved: Record<string, unknown> = {};
    (globalThis as any).browser.storage.local.set = async (next: Record<string, unknown>) => {
      saved = next;
    };
    await saveSelectionAskEnabled(false);
    expect(saved).toEqual({ [SELECTION_ASK_ENABLED_KEY]: false });
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm vitest run lib/selection-ask.test.ts`
Expected: FAIL——`Cannot find module './selection-ask'`。

- [ ] **Step 4: 实现**

创建 `lib/selection-ask.ts`：

```ts
// 划词提问气泡的共享纯逻辑：气泡定位裁剪、预填模板拼装、全局开关的读写。
// content script（气泡 UI）、侧边栏 store（消费 pending ask）、设置页（开关）三处共用。
import type { Translate } from './i18n';
import { MAX_SHORTCUT_SELECTION_CHARS } from './chat/shortcut-prompts';

export const SELECTION_ASK_ENABLED_KEY = 'runi:selection-ask-enabled';

export async function loadSelectionAskEnabled(): Promise<boolean> {
  const res = await browser.storage.local.get(SELECTION_ASK_ENABLED_KEY);
  return (res[SELECTION_ASK_ENABLED_KEY] as boolean | undefined) ?? true;
}

export async function saveSelectionAskEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [SELECTION_ASK_ENABLED_KEY]: enabled });
}

/** 把 pending 选区文字拼成预填到聊天输入框的引用文本；截断长度与划词快捷指令保持一致。 */
export function buildSelectionAskTemplate(text: string, translate: Translate): string {
  const truncated = text.trim().slice(0, MAX_SHORTCUT_SELECTION_CHARS);
  return translate('store.selectionAskTemplate', { selection: truncated });
}

export interface BubbleRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface BubbleSize {
  width: number;
  height: number;
}

/**
 * 计算气泡的 fixed 定位坐标：默认贴在选区上方，选区太靠近视口顶部（放不下）时改贴下方；
 * 左右方向裁剪进视口内，避免气泡跑出屏幕。
 */
export function clampBubblePosition(
  rect: BubbleRect,
  viewport: { width: number; height: number },
  bubbleSize: BubbleSize,
): { top: number; left: number } {
  const margin = 8;
  const edgeGap = 4;
  const above = rect.top - bubbleSize.height - margin;
  const top = above >= edgeGap ? above : rect.bottom + margin;
  const rawLeft = rect.left + (rect.right - rect.left) / 2 - bubbleSize.width / 2;
  const maxLeft = Math.max(edgeGap, viewport.width - bubbleSize.width - edgeGap);
  const left = Math.min(Math.max(edgeGap, rawLeft), maxLeft);
  return { top, left };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run lib/selection-ask.test.ts`
Expected: PASS（全部用例通过）。

- [ ] **Step 6: 类型检查（确认 i18n key 联动没有遗漏）**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add lib/selection-ask.ts lib/selection-ask.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat: add selection-ask shared logic (template, bubble positioning, toggle)"
```

---

### Task 4: `entrypoints/background.ts`——处理 `ASK_SELECTION`

**Files:**
- Modify: `entrypoints/background.ts:1-37`（导入块）、`:44-65`（`SUPPORTED_MESSAGE_TYPES`）、`:102-124`（消息监听器 + `tabs.onRemoved`）、`:134-196`（`handleMessage` switch）

**Interfaces:**
- Consumes: `AskSelectionPayload`（Task 1，`@/lib/messaging`）、`setPendingAskForTab`/`clearPendingAskForTab`（Task 2，`@/lib/agent/tab-pending-ask`）。
- Produces: 无新导出——这是消息路由的终端处理逻辑。

没有自动化测试（`entrypoints/` 下的纯 `.ts` 文件不在任何 vitest project 的 `include` 里），用 `pnpm compile` + 下面的手动冒烟步骤验证。

- [ ] **Step 1: 导入新增的类型和函数**

在 `entrypoints/background.ts` 顶部的导入块（原第 1-37 行），把：

```ts
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
```

改为：

```ts
  type AskSelectionPayload,
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
```

并在文件顶部导入区新增一行（紧接 `clearConversationIdForTab` 那一行之后）：

```ts
import { clearConversationIdForTab } from '@/lib/agent/tab-conversation';
import { clearPendingAskForTab, setPendingAskForTab } from '@/lib/agent/tab-pending-ask';
```

- [ ] **Step 2: 登记到 `SUPPORTED_MESSAGE_TYPES`**

把（原第 44-48 行）：

```ts
const SUPPORTED_MESSAGE_TYPES = [
  'PING',
  'EXTRACT_PAGE',
  'GET_SELECTION',
  'GET_ACTIVE_TAB',
```

改为：

```ts
const SUPPORTED_MESSAGE_TYPES = [
  'PING',
  'EXTRACT_PAGE',
  'GET_SELECTION',
  'ASK_SELECTION',
  'GET_ACTIVE_TAB',
```

- [ ] **Step 3: 消息监听器把 `sender` 传给 `handleMessage`**

把（原第 102-116 行）：

```ts
  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
      handleMessage(message)
        .then((data) => sendResponse({ id: message.id, ok: true, data }))
        .catch((error: unknown) =>
          sendResponse({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // 返回 true 以保持 sendResponse 异步可用
      return true;
    },
  );
```

改为：

```ts
  browser.runtime.onMessage.addListener(
    (message: Message, sender, sendResponse: (r: MessageResponse) => void) => {
      handleMessage(message, sender)
        .then((data) => sendResponse({ id: message.id, ok: true, data }))
        .catch((error: unknown) =>
          sendResponse({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // 返回 true 以保持 sendResponse 异步可用
      return true;
    },
  );
```

- [ ] **Step 4: `tabs.onRemoved` 顺带清理 pending ask**

把（原第 119-123 行）：

```ts
  browser.tabs.onRemoved.addListener((tabId) => {
    clearConversationIdForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] clearConversationIdForTab on tab close:', err),
    );
  });
```

改为：

```ts
  browser.tabs.onRemoved.addListener((tabId) => {
    clearConversationIdForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] clearConversationIdForTab on tab close:', err),
    );
    clearPendingAskForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] clearPendingAskForTab on tab close:', err),
    );
  });
```

- [ ] **Step 5: 定义 `sender` 的类型别名，并声明 `handleAskSelection`**

在 `handleMessage` 函数定义之前（原 `requireTabId` 函数之后，第 132-133 行附近）新增：

```ts
/** 从 addListener 的回调签名里提取 sender 参数的类型，不依赖猜测具体的 polyfill 类型名。 */
type MessageSender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

/**
 * ASK_SELECTION 是唯一一个由 content script 主动发起、不携带 tabId 的消息——它的语义就是
 * "当前这个 tab 的用户点了划词提问气泡"，tab 身份直接来自 sender.tab.id，不走其它消息类型
 * 依赖的"侧边栏在回合开始时解析并透传 tabId"那套逻辑。
 */
async function handleAskSelection(sender: MessageSender | undefined, payload: AskSelectionPayload | undefined): Promise<void> {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return;
  const text = payload?.text?.trim();
  if (!text) return;

  // 两次 sidePanel 调用必须在这里同步发起、不经过任何 await/.then 链，否则 Chrome 会认为已经
  // 脱离了触发本次消息的用户手势，抛出
  // "sidePanel.open() may only be called in response to a user gesture."
  // ——与上方 action.onClicked 监听器（第 91-100 行）的写法保持一致。
  browser.sidePanel
    ?.setOptions?.({ tabId, path: 'sidepanel.html', enabled: true })
    .catch((err: unknown) => console.error('[Runi] sidePanel setOptions (ask-selection):', err));
  browser.sidePanel
    ?.open?.({ tabId })
    .catch((err: unknown) => console.error('[Runi] sidePanel open (ask-selection):', err));

  await setPendingAskForTab(tabId, text);
}
```

- [ ] **Step 6: `handleMessage` 接收 `sender`，新增 `ASK_SELECTION` 分支**

把（原第 134-146 行）：

```ts
async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { pong: true, ts: Date.now(), agentProtocol: 1, supportedTypes: SUPPORTED_MESSAGE_TYPES };

    case 'GET_ACTIVE_TAB':
      return getActiveTab();

    case 'EXTRACT_PAGE':
      return extractActivePage(requireTabId(message));

    case 'GET_SELECTION':
      return getActiveSelection(requireTabId(message));
```

改为：

```ts
async function handleMessage(message: Message, sender?: MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { pong: true, ts: Date.now(), agentProtocol: 1, supportedTypes: SUPPORTED_MESSAGE_TYPES };

    case 'GET_ACTIVE_TAB':
      return getActiveTab();

    case 'EXTRACT_PAGE':
      return extractActivePage(requireTabId(message));

    case 'GET_SELECTION':
      return getActiveSelection(requireTabId(message));

    case 'ASK_SELECTION':
      return handleAskSelection(sender, message.payload as AskSelectionPayload | undefined);
```

- [ ] **Step 7: 类型检查**

Run: `pnpm compile`
Expected: 无错误。若 `MessageSender` 类型推导失败（比如 `browser.runtime.onMessage.addListener` 的环境类型和预期不一致），报错信息会指出具体不匹配的类型，据此调整（不要用 `any` 绕过）。

- [ ] **Step 8: 手动冒烟验证（无自动化测试覆盖，必须手动过一遍）**

```bash
pnpm build
```

在 `chrome://extensions` 里重新加载 `.output/chrome-mv3`（若已加载过）。用浏览器 DevTools 打开扩展的 background service worker 控制台，临时执行：

```js
browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) =>
  browser.runtime.sendMessage({ id: 'manual-1', type: 'ASK_SELECTION', payload: { text: 'manual smoke test' } })
);
```

（这一步会因为不是从 content script 真实用户手势触发而可能报 user-gesture 错误——这是预期的，Step 8 只是确认 `handleAskSelection` 分支能被路由到、不抛出类型/引用错误；真正的端到端验证放在 Task 5 完成后。）

- [ ] **Step 9: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: handle ASK_SELECTION by opening the tab's side panel with pending text"
```

---

### Task 5: `entrypoints/content.ts`——划词提问悬浮气泡

**Files:**
- Modify: `entrypoints/content.ts`（新增气泡子系统；不改动现有 `EXTRACT_PAGE`/`GET_SELECTION` 处理逻辑）

**Interfaces:**
- Consumes: `SELECTION_ASK_ENABLED_KEY`/`loadSelectionAskEnabled`/`clampBubblePosition`（Task 3，`@/lib/selection-ask`）、`sendMessage`/`type AskSelectionPayload`（Task 1，`@/lib/messaging`）、`loadLocale`/`resolveLocale`（`@/lib/i18n`）、`en`/`zh` 字典（`@/lib/i18n/locales/{en,zh}`）。
- Produces: 无新导出——`main()` 里注册的事件监听器是这个任务的全部产出。

无自动化测试（同 Task 4 的理由）。用 `pnpm compile` + `pnpm build` + 手动冒烟验证。

- [ ] **Step 1: 新增导入**

在 `entrypoints/content.ts` 顶部的导入块，把：

```ts
import { Readability } from '@mozilla/readability';
import {
  type Message,
  type MessageResponse,
  type PageContent,
  type PageSelection,
} from '@/lib/messaging';
```

改为：

```ts
import { Readability } from '@mozilla/readability';
import {
  sendMessage,
  type AskSelectionPayload,
  type Message,
  type MessageResponse,
  type PageContent,
  type PageSelection,
} from '@/lib/messaging';
import { loadLocale, resolveLocale } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import {
  SELECTION_ASK_ENABLED_KEY,
  clampBubblePosition,
  loadSelectionAskEnabled,
} from '@/lib/selection-ask';
```

- [ ] **Step 2: 在 `main()` 里启动气泡子系统**

把（原第 10-27 行）：

```ts
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
        if (message.type === 'EXTRACT_PAGE') {
          respond(message.id, sendResponse, extractPage);
          return true;
        }
        if (message.type === 'GET_SELECTION') {
          respond(message.id, sendResponse, getSelection);
          return true;
        }
        return false;
      },
    );
  },
});
```

改为：

```ts
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
        if (message.type === 'EXTRACT_PAGE') {
          respond(message.id, sendResponse, extractPage);
          return true;
        }
        if (message.type === 'GET_SELECTION') {
          respond(message.id, sendResponse, getSelection);
          return true;
        }
        return false;
      },
    );

    initSelectionAskBubble();
  },
});
```

- [ ] **Step 3: 实现气泡子系统**

在 `entrypoints/content.ts` 文件末尾（`getSelection` 函数之后）追加：

```ts
// ---- 划词提问悬浮气泡 ----
// 不能用 lib/i18n 的 t()/applyLocale()：applyLocale() 会写 document.documentElement.lang，
// 在内容脚本里调用会篡改被访问网页本身的 lang 属性。这里只解析一次 locale，
// 直接从字典取用到的这一个文案。
let bubbleLabel = 'Ask Runi';
let bubbleHost: HTMLElement | null = null;
let bubbleSelectionText = '';
let selectionAskEnabled = false;

const BUBBLE_SIZE = { width: 88, height: 32 };
const BUBBLE_BUTTON_STYLE =
  'all: initial; display: inline-flex; align-items: center; justify-content: center; ' +
  'width: 88px; height: 32px; border-radius: 9999px; border: none; cursor: pointer; ' +
  'background: #4f46e5; color: #ffffff; ' +
  'font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
  'box-shadow: 0 2px 8px rgba(0,0,0,0.24);';

async function initSelectionAskBubble(): Promise<void> {
  const locale = resolveLocale(await loadLocale());
  bubbleLabel = (locale === 'zh' ? zh : en)['shortcut.selectionAskBubbleLabel'];

  selectionAskEnabled = await loadSelectionAskEnabled();
  if (selectionAskEnabled) attachSelectionAskListeners();

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SELECTION_ASK_ENABLED_KEY in changes)) return;
    const next = (changes[SELECTION_ASK_ENABLED_KEY].newValue as boolean | undefined) ?? true;
    if (next === selectionAskEnabled) return;
    selectionAskEnabled = next;
    if (selectionAskEnabled) {
      attachSelectionAskListeners();
    } else {
      detachSelectionAskListeners();
      removeBubble();
    }
  });
}

function attachSelectionAskListeners(): void {
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('mousedown', handleOutsideMouseDown, true);
  document.addEventListener('scroll', handleScrollAway, true);
  document.addEventListener('keydown', handleEscapeKey);
}

function detachSelectionAskListeners(): void {
  document.removeEventListener('mouseup', handleMouseUp);
  document.removeEventListener('mousedown', handleOutsideMouseDown, true);
  document.removeEventListener('scroll', handleScrollAway, true);
  document.removeEventListener('keydown', handleEscapeKey);
}

function handleMouseUp(): void {
  removeBubble();
  const selection = window.getSelection();
  const text = (selection?.toString() ?? '').trim();
  if (!text || !selection || selection.rangeCount === 0) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  bubbleSelectionText = text;
  showBubble(rect);
}

function showBubble(rect: DOMRect): void {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  const { top, left } = clampBubblePosition(
    { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    { width: window.innerWidth, height: window.innerHeight },
    BUBBLE_SIZE,
  );
  host.style.top = `${top}px`;
  host.style.left = `${left}px`;

  const shadow = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = bubbleLabel;
  button.style.cssText = BUBBLE_BUTTON_STYLE;
  button.addEventListener('click', handleBubbleClick);
  shadow.appendChild(button);

  document.documentElement.appendChild(host);
  bubbleHost = host;
}

async function handleBubbleClick(): Promise<void> {
  const text = bubbleSelectionText;
  removeBubble();
  if (!text) return;
  await sendMessage('ASK_SELECTION', { text } satisfies AskSelectionPayload);
}

function handleOutsideMouseDown(event: MouseEvent): void {
  if (!bubbleHost) return;
  if (event.composedPath().includes(bubbleHost)) return;
  removeBubble();
}

function handleScrollAway(): void {
  removeBubble();
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') removeBubble();
}

function removeBubble(): void {
  bubbleHost?.remove();
  bubbleHost = null;
  bubbleSelectionText = '';
}
```

> `event.composedPath()` 对 `mousedown` 这类 composed+bubbling 的 UI 事件，即使 shadow root 是 `mode: 'closed'`，也会包含穿过 shadow 边界前的路径节点（这是 DOM 事件重定向规范的行为，不依赖 JS 能否访问 `shadowRoot` 属性），所以 `path.includes(bubbleHost)` 能正确识别"这次 mousedown 发生在气泡内部"，不需要在按钮上额外 `stopPropagation`。

- [ ] **Step 4: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 5: 手动冒烟验证**

```bash
pnpm build
```

在 `chrome://extensions` 重新加载 `.output/chrome-mv3`。打开任意普通网页（如 `https://example.com`）：

1. 用鼠标选中一段文字，松开鼠标——确认气泡出现在选区附近。
2. 点击页面空白处——确认气泡消失。
3. 重新选中文字，滚动页面——确认气泡消失。
4. 重新选中文字，按 `Escape`——确认气泡消失。
5. 重新选中文字，点击气泡——确认侧边栏被打开（或已打开的侧边栏被激活），且聊天输入框里出现引用格式的选中文字，光标聚焦在文本末尾（Task 6/7 完成前，`store.ts`/`WorkbenchComposer.tsx` 尚未接入预填逻辑，这一步预期只会看到面板打开，输入框还不会预填——先记录"面板已打开"这一半的结果，预填效果留到 Task 7 完成后一并验证）。
6. 打开设置页，把新增的开关（Task 8 完成前该开关还不存在，此步骤留到 Task 8 之后一并验证）关闭，刷新网页后确认气泡不再出现；重新打开开关，不刷新页面，确认气泡（借助 `storage.onChanged`）重新可用。

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: add selection-ask floating bubble to content script"
```

---

### Task 6: `entrypoints/sidepanel/store.ts`——消费 pending ask

**Files:**
- Modify: `entrypoints/sidepanel/store.ts:86-124`（`ChatState` 接口）、`:276-293`（初始状态）、`:533-544`（`restoreTabConversation`）
- Test: `entrypoints/sidepanel/store-context.test.tsx`（新增 `describe` 块）

**Interfaces:**
- Consumes: `getPendingAskForTab`/`clearPendingAskForTab`（Task 2）、`buildSelectionAskTemplate`（Task 3）。
- Produces: `ChatState` 新增字段 `pendingFocusToken: number`（初值 `0`，每次消费一条 pending ask 后设为 `Date.now()`）。Task 7（`WorkbenchComposer.tsx`）依赖这个字段名和"非 0 即代表一次新的聚焦请求"的约定。

- [ ] **Step 1: 写失败的测试**

在 `entrypoints/sidepanel/store-context.test.tsx` 文件末尾（最后一个 `it(...)` 之后、`});` 收尾大括号之前）新增一个 `describe` 块：

```ts
describe('restoreTabConversation pending ask', () => {
  beforeEach(() => {
    (globalThis as any).browser.tabs = { query: vi.fn().mockResolvedValue([{ id: 42 }]) };
    (globalThis as any).browser.storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    useChat.setState({ input: '', pendingFocusToken: 0 });
  });

  it('prefills the composer and bumps the focus token when a pending ask exists for this tab', async () => {
    const key = 'runi:tab-pending-ask:42';
    (globalThis as any).browser.storage.session.get = vi.fn().mockResolvedValue({ [key]: 'selected text' });

    await useChat.getState().restoreTabConversation();

    expect(useChat.getState().input).toContain('selected text');
    expect(useChat.getState().pendingFocusToken).toBeGreaterThan(0);
    expect((globalThis as any).browser.storage.session.remove).toHaveBeenCalledWith(key);
  });

  it('leaves the composer untouched when there is no pending ask for this tab', async () => {
    await useChat.getState().restoreTabConversation();

    expect(useChat.getState().input).toBe('');
    expect(useChat.getState().pendingFocusToken).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx -t "pending ask"`
Expected: FAIL——`pendingFocusToken` 目前不存在于 `ChatState`，`input` 不会被预填（`restoreTabConversation` 还没有消费 pending ask 的逻辑）。

- [ ] **Step 3: `ChatState` 接口新增字段**

在 `entrypoints/sidepanel/store.ts` 里，把（原第 89 行附近）：

```ts
interface ChatState {
  messages: UIMessage[];
  activitySteps: ActivityStep[];
  input: string;
  busy: boolean;
```

改为：

```ts
interface ChatState {
  messages: UIMessage[];
  activitySteps: ActivityStep[];
  input: string;
  /** 每次消费一条划词提问 pending ask 后设为 Date.now()；WorkbenchComposer 据此判断"该聚焦输入框了"。 */
  pendingFocusToken: number;
  busy: boolean;
```

- [ ] **Step 4: 初始状态新增字段**

把（原第 276-279 行）：

```ts
export const useChat = create<ChatState>((set, get) => ({
  messages: [],
  activitySteps: [],
  input: '',
  busy: false,
```

改为：

```ts
export const useChat = create<ChatState>((set, get) => ({
  messages: [],
  activitySteps: [],
  input: '',
  pendingFocusToken: 0,
  busy: false,
```

- [ ] **Step 5: 新增导入**

在 `entrypoints/sidepanel/store.ts` 顶部导入块，把：

```ts
import { getConversationIdForTab, setConversationIdForTab } from '@/lib/agent/tab-conversation';
```

改为：

```ts
import { getConversationIdForTab, setConversationIdForTab } from '@/lib/agent/tab-conversation';
import { clearPendingAskForTab, getPendingAskForTab } from '@/lib/agent/tab-pending-ask';
import { buildSelectionAskTemplate } from '@/lib/selection-ask';
```

- [ ] **Step 6: `restoreTabConversation` 消费 pending ask**

把（原第 533-544 行）：

```ts
  restoreTabConversation: async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') return;
    panelTabId = tabId;
    const savedId = await getConversationIdForTab(tabId);
    if (savedId) {
      await get().openConversation(savedId);
    } else {
      await setConversationIdForTab(tabId, get().conversationId);
    }
  },
```

改为：

```ts
  restoreTabConversation: async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') return;
    panelTabId = tabId;
    const savedId = await getConversationIdForTab(tabId);
    if (savedId) {
      await get().openConversation(savedId);
    } else {
      await setConversationIdForTab(tabId, get().conversationId);
    }

    const pendingAsk = await getPendingAskForTab(tabId);
    if (pendingAsk) {
      await clearPendingAskForTab(tabId);
      set({ input: buildSelectionAskTemplate(pendingAsk, t), pendingFocusToken: Date.now() });
    }
  },
```

（`t` 已经在文件顶部 `import { getCurrentLocale, t } from '@/lib/i18n';` 里导入，不用新增。）

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx -t "pending ask"`
Expected: PASS（2 个新用例通过）。

- [ ] **Step 8: 跑一遍这个文件的全部既有用例，确认没有回归**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS（含新增的在内全部通过）。

- [ ] **Step 9: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "feat: consume pending selection-ask text on side panel mount"
```

---

### Task 7: `WorkbenchComposer.tsx` + `App.tsx`——预填后自动聚焦

**Files:**
- Modify: `entrypoints/sidepanel/components/WorkbenchComposer.tsx:9-23`（props 接口）、`:31-75`（组件体）
- Modify: `entrypoints/sidepanel/App.tsx:30-61`（解构 `pendingFocusToken`）、`:301-315`（`<WorkbenchComposer>` 调用）
- Test: `entrypoints/sidepanel/components/workbench-components.test.tsx:211-225`（`composerProps` 补字段）、新增一条测试

**Interfaces:**
- Consumes: `pendingFocusToken: number`（Task 6，来自 `useChat()`）。
- Produces: 无新导出，纯 UI 行为——`pendingFocusToken` 变为非零值（且和上一次渲染的值不同）时，聚焦 textarea 并把光标移到文本末尾。`pendingFocusToken` 初值为 `0`，`0` 是"从未有过 pending ask"的哨兵值，不会触发聚焦。

- [ ] **Step 1: 写失败的测试**

在 `entrypoints/sidepanel/components/workbench-components.test.tsx`，把 `composerProps` 对象（原第 211-225 行）：

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

改为（新增 `pendingFocusToken: 0`）：

```ts
const composerProps: WorkbenchComposerProps = {
  input: '',
  busy: false,
  pageContext: availableContext,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  shortcuts: [readingShortcut],
  pendingFocusToken: 0,
  onInput: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onRetryPageContext: vi.fn(),
  onRunShortcut: vi.fn(),
  onSelectProviderModel: vi.fn(),
};
```

紧接 `describe('workbench composer', ...)` 块内的第一个 `it(...)` 之前（或任意位置，同一个 `describe` 内），新增：

```ts
it('focuses the textarea and moves the cursor to the end when pendingFocusToken advances', async () => {
  const { rerender } = render(
    <LocaleProvider>
      <WorkbenchComposer {...composerProps} input="quoted selection" pendingFocusToken={0} />
    </LocaleProvider>,
  );
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  textarea.blur();
  expect(textarea).not.toHaveFocus();

  rerender(
    <LocaleProvider>
      <WorkbenchComposer {...composerProps} input="quoted selection" pendingFocusToken={12345} />
    </LocaleProvider>,
  );

  await waitFor(() => expect(textarea).toHaveFocus());
  expect(textarea.selectionStart).toBe('quoted selection'.length);
  expect(textarea.selectionEnd).toBe('quoted selection'.length);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx -t "pendingFocusToken"`
Expected: FAIL——`WorkbenchComposerProps` 上还没有 `pendingFocusToken`，`pnpm compile` 也会报类型错误（`composerProps` 缺少必需属性会先报错，测试跑不起来）。

- [ ] **Step 3: `WorkbenchComposerProps` 新增字段**

在 `entrypoints/sidepanel/components/WorkbenchComposer.tsx`，把（原第 9-23 行）：

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
```

改为：

```ts
export interface WorkbenchComposerProps {
  input: string;
  busy: boolean;
  pageContext: PageContextState;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  /** 每次划词提问预填输入框后变为一个新的非零值；0 表示"从未发生过"，不触发聚焦。 */
  pendingFocusToken: number;
  onInput(value: string): void;
```

- [ ] **Step 4: 组件签名解构新增字段 + 聚焦 effect**

把（原第 31-46 行）：

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
  const { t } = useTranslation();
```

改为：

```ts
export function WorkbenchComposer({
  input,
  busy,
  pageContext,
  providers,
  selectedProviderId,
  selectedModel,
  shortcuts,
  pendingFocusToken,
  onInput,
  onSend,
  onStop,
  onRetryPageContext,
  onRunShortcut,
  onSelectProviderModel,
}: WorkbenchComposerProps) {
  const { t } = useTranslation();
```

再把（原第 70-75 行，紧跟在 props 解构之后的第一个 `useEffect`）：

```ts
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);
```

改为（在这个既有 effect 之后新增一个 effect，不改动原有的）：

```ts
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    if (pendingFocusToken === 0) return;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [pendingFocusToken]);
```

- [ ] **Step 5: `App.tsx` 透传 `pendingFocusToken`**

在 `entrypoints/sidepanel/App.tsx`，把解构 `useChat()` 的那一块（原第 31-61 行）里的：

```ts
    messages,
    activitySteps,
    input,
    busy,
```

改为：

```ts
    messages,
    activitySteps,
    input,
    pendingFocusToken,
    busy,
```

再把 `<WorkbenchComposer>` 调用（原第 301-315 行）：

```tsx
          <WorkbenchComposer
            input={input}
            busy={busy}
            pageContext={pageContext}
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            onInput={setInput}
```

改为：

```tsx
          <WorkbenchComposer
            input={input}
            busy={busy}
            pageContext={pageContext}
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            pendingFocusToken={pendingFocusToken}
            onInput={setInput}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS（含新用例在内，这个文件里的全部用例都通过——顺带确认没有破坏既有的斜杠指令/模型选择等测试）。

- [ ] **Step 7: 类型检查**

Run: `pnpm compile`
Expected: 无错误（`App.tsx`、`store-context.test.tsx`、`workbench-components.test.tsx` 里对 `pendingFocusToken` 的使用互相一致）。

- [ ] **Step 8: Commit**

```bash
git add entrypoints/sidepanel/components/WorkbenchComposer.tsx entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat: focus and move cursor to end when a pending selection ask is prefilled"
```

---

### Task 8: `components/ShortcutSettings.tsx`——全局开关

**Files:**
- Modify: `components/ShortcutSettings.tsx`（顶部新增 state + effect + checkbox）
- Test: `components/settings-components.test.tsx`（新增用例）

**Interfaces:**
- Consumes: `SELECTION_ASK_ENABLED_KEY`/`loadSelectionAskEnabled`/`saveSelectionAskEnabled`（Task 3，`@/lib/selection-ask`）。
- Produces: 无新导出——纯 UI。

- [ ] **Step 1: 写失败的测试**

在 `components/settings-components.test.tsx`，找到现有的 `describe('grouped options settings', ...)` 块内、`ShortcutSettings` 相关的测试群（原第 341 行附近），在其中新增两条：

```ts
  it('defaults the selection-ask toggle to checked and persists a change', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ShortcutSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable selection-ask bubble' });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(set).toHaveBeenCalledWith({ 'runi:selection-ask-enabled': false });
  });

  it('reflects a previously saved disabled state for the selection-ask toggle', async () => {
    storageData['runi:selection-ask-enabled'] = false;
    renderWithLocale(<ShortcutSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable selection-ask bubble' });
    expect(toggle).not.toBeChecked();
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run components/settings-components.test.tsx -t "selection-ask toggle"`
Expected: FAIL——找不到 `role: 'checkbox'`、`name: 'Enable selection-ask bubble'` 的元素（UI 还没实现）。

- [ ] **Step 3: 实现**

在 `components/ShortcutSettings.tsx` 顶部导入块，把：

```ts
import {
  SHORTCUTS_STORAGE_KEY,
  loadShortcutConfigs,
  moveShortcut,
  newShortcutId,
  repairShortcutConfigs,
  resolveShortcut,
  restoreDefaultShortcuts,
  updateShortcutConfigs,
  validateShortcutConfigs,
  type MoveDirection,
  type ShortcutConfig,
  type ShortcutScope,
} from '@/lib/shortcuts';
```

改为：

```ts
import {
  SHORTCUTS_STORAGE_KEY,
  loadShortcutConfigs,
  moveShortcut,
  newShortcutId,
  repairShortcutConfigs,
  resolveShortcut,
  restoreDefaultShortcuts,
  updateShortcutConfigs,
  validateShortcutConfigs,
  type MoveDirection,
  type ShortcutConfig,
  type ShortcutScope,
} from '@/lib/shortcuts';
import {
  SELECTION_ASK_ENABLED_KEY,
  loadSelectionAskEnabled,
  saveSelectionAskEnabled,
} from '@/lib/selection-ask';
```

在组件内新增 state（紧接 `const [draggedId, setDraggedId] = useState<string | null>(null);` 之后，原第 60 行）：

```ts
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [selectionAskEnabled, setSelectionAskEnabled] = useState(true);
```

在现有的 `useEffect`（原第 64-94 行，加载快捷指令 + 监听 `SHORTCUTS_STORAGE_KEY` 变化）里追加加载与监听逻辑。把：

```ts
  useEffect(() => {
    let active = true;
    loadShortcutConfigs()
      .then((result) => {
        if (!active) return;
        setItems(result.shortcuts);
        showValidationErrors(result.errors);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setErrors([storageErrorMessage(error)]);
      });

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[SHORTCUTS_STORAGE_KEY];
      if (!change) return;
      const result = validateShortcutConfigs(change.newValue);
      setItems(result.shortcuts);
      showValidationErrors(result.errors);
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [t]);
```

改为：

```ts
  useEffect(() => {
    let active = true;
    loadShortcutConfigs()
      .then((result) => {
        if (!active) return;
        setItems(result.shortcuts);
        showValidationErrors(result.errors);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setErrors([storageErrorMessage(error)]);
      });
    loadSelectionAskEnabled().then((enabled) => {
      if (active) setSelectionAskEnabled(enabled);
    });

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const shortcutsChange = changes[SHORTCUTS_STORAGE_KEY];
      if (shortcutsChange) {
        const result = validateShortcutConfigs(shortcutsChange.newValue);
        setItems(result.shortcuts);
        showValidationErrors(result.errors);
      }
      const toggleChange = changes[SELECTION_ASK_ENABLED_KEY];
      if (toggleChange) setSelectionAskEnabled((toggleChange.newValue as boolean | undefined) ?? true);
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [t]);

  async function toggleSelectionAsk() {
    const next = !selectionAskEnabled;
    setSelectionAskEnabled(next);
    await saveSelectionAskEnabled(next);
  }
```

最后在 JSX 里，紧接 `<section className="mb-6">` 开始标签之后、标题行 `<div className="mb-3 flex flex-wrap items-start justify-between gap-3">` 之前（原第 300-301 行之间）插入开关：

```tsx
    <section className="mb-6">
      <label className="mb-4 flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={selectionAskEnabled}
          onChange={() => void toggleSelectionAsk()}
          className="h-4 w-4 rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-700"
        />
        {t('shortcut.selectionAskToggleLabel')}
      </label>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run components/settings-components.test.tsx -t "selection-ask toggle"`
Expected: PASS（2 个新用例通过）。

- [ ] **Step 5: 跑一遍这个文件的全部既有用例，确认没有回归**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add components/ShortcutSettings.tsx components/settings-components.test.tsx
git commit -m "feat: add global toggle for the selection-ask bubble"
```

---

### 收尾

- [ ] **全量验证**

```bash
pnpm compile
pnpm test
pnpm build
```

Expected: 三者全部通过；`pnpm build` 产出 `.output/chrome-mv3` 无报错。

- [ ] **端到端手动验证（覆盖 Task 5 里被推迟的两步）**

在 `chrome://extensions` 重新加载扩展。打开任意网页：

1. 选中一段文字，点击悬浮气泡——确认侧边栏打开，聊天输入框已预填引用格式的选中文字，光标在文本末尾，可以直接继续打字提问。
2. 打开设置页（Options）的"划词快捷指令"区块，关闭"启用划词提问气泡"开关，回到网页刷新——确认气泡不再出现；重新打开开关（不刷新页面）——确认气泡恢复可用。
3. 在两个不同标签页分别选中文字点击气泡，确认各自面板互不串扰（各自预填各自选中的文字）。
