# 侧边栏按 tab 绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让扩展的侧边栏面板与打开它的那个浏览器 tab 强绑定——切到别的 tab 时面板自动关闭，切回原 tab 时自动重新打开并恢复该 tab 上一次的对话历史。

**Architecture:** 用 Chrome 原生的按-tab `sidePanel` API（`sidePanel.setOptions({tabId, ...})` + `sidePanel.open({tabId})`）替换现有的全局 `setPanelBehavior({openPanelOnActionClick: true})`；新增一个 `lib/agent/tab-conversation.ts` 模块，把 `tabId → conversationId` 的映射存进 `browser.storage.session`（跨面板文档销毁/重建存活，不跨浏览器重启），侧边栏挂载时用它恢复该 tab 上次展示的会话（现有 IndexedDB 持久化已经保存了会话内容本身）。

**Tech Stack:** TypeScript, WXT (Manifest V3), React + Zustand（`entrypoints/sidepanel`），vitest + `wxt/testing` 的 `fakeBrowser`。

## Global Constraints

- `sidePanel` 权限已在 `wxt.config.ts` 声明，本次改动不需要修改 manifest 权限。
- 构建产物中 `side_panel.default_path` 固定为 `'sidepanel.html'`（已通过读取 `.output/chrome-mv3/manifest.json` 确认）——所有 `sidePanel.setOptions({ path: ... })` 调用必须使用这个字符串。
- 涉及 `browser.storage.session` 的写入必须遵循项目里 `lib/agent/turn-snapshot.ts` 已建立的约定：写入失败（配额超限等）时静默降级（try/catch 吞掉错误，不抛出、不阻塞调用方）。
- 按 CLAUDE.md 现状，只有 `lib/**/*.test.ts` 被 `vitest.config.ts` 的 `include` 覆盖；`entrypoints/` 下的改动（`background.ts`、`App.tsx`、`store.ts`）没有自动化测试基建，通过 `pnpm compile` 做类型检查 + 手动验证确认行为。
- 每个改动 `browser.storage.session` 的模块，测试文件里都要用 `(globalThis as any).browser = fakeBrowser;` 手动挂载 `wxt/testing` 的 `fakeBrowser`（`vitest.config.ts` 没有接入 WXT 的 unimport 插件，裸标识符 `browser` 不会自动注入）。

---

### Task 1: `lib/agent/tab-conversation.ts` — tabId → conversationId 持久化模块

**Files:**
- Create: `lib/agent/tab-conversation.ts`
- Test: `lib/agent/tab-conversation.test.ts`

**Interfaces:**
- Produces: `getConversationIdForTab(tabId: number): Promise<string | undefined>`, `setConversationIdForTab(tabId: number, conversationId: string): Promise<void>`, `clearConversationIdForTab(tabId: number): Promise<void>` — Task 2（`background.ts`）和 Task 3（`store.ts`）都会导入这三个函数。

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/tab-conversation.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { clearConversationIdForTab, getConversationIdForTab, setConversationIdForTab } from './tab-conversation';

(globalThis as any).browser = fakeBrowser;

describe('tab-conversation', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no conversation mapping for an untouched tab', async () => {
    expect(await getConversationIdForTab(TAB_ID)).toBeUndefined();
  });

  it('stores and reads back a conversation id', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');
    expect(await getConversationIdForTab(TAB_ID)).toBe('c-1');
  });

  it('overwrites the previous mapping when set again', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');
    await setConversationIdForTab(TAB_ID, 'c-2');
    expect(await getConversationIdForTab(TAB_ID)).toBe('c-2');
  });

  it('clears the mapping', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');
    await clearConversationIdForTab(TAB_ID);
    expect(await getConversationIdForTab(TAB_ID)).toBeUndefined();
  });

  it('reads a mapping back through a fresh module instance (proves it is not held in module-level state)', async () => {
    await setConversationIdForTab(TAB_ID, 'c-1');

    // 模拟侧边栏面板文档被销毁重建（切走 tab 再切回）：重置模块注册表后重新 import，
    // 得到全新的模块实例。fakeBrowser 的 storage.session 数据不受影响。
    vi.resetModules();
    const fresh = await import('./tab-conversation');

    expect(await fresh.getConversationIdForTab(TAB_ID)).toBe('c-1');
  });

  it('degrades silently when persisting fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await setConversationIdForTab(TAB_ID, 'c-1');
    expect(await getConversationIdForTab(TAB_ID)).toBeUndefined();
  });

  it('does not throw when clearing a mapping that was never set', async () => {
    await expect(clearConversationIdForTab(TAB_ID)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/tab-conversation.test.ts`
Expected: FAIL — `Cannot find module './tab-conversation'` （模块还不存在）

- [ ] **Step 3: 实现模块**

创建 `lib/agent/tab-conversation.ts`：

```ts
// 每个标签页记录"当前面板正在展示哪个会话"，用于按-tab 侧边栏文档被销毁重建后
// （见 entrypoints/background.ts 的按-tab sidePanel 绑定）恢复上一次的对话。
//
// 持久化到 browser.storage.session（而非模块级变量）：面板切到别的 tab 时 Chrome 会
// 整个销毁面板文档，切回时重新加载——任何模块级变量都会被清空，只有 storage.session
// 能跨这次"文档重建"存活（同时不落盘，浏览器重启后自动清空）。

function storageKey(tabId: number): string {
  return `tabConversation:${tabId}`;
}

export async function getConversationIdForTab(tabId: number): Promise<string | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as string | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住。 */
export async function setConversationIdForTab(tabId: number, conversationId: string): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: conversationId });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearConversationIdForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/tab-conversation.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 无新增类型错误

- [ ] **Step 6: Commit**

```bash
git add lib/agent/tab-conversation.ts lib/agent/tab-conversation.test.ts
git commit -m "feat: add tabId->conversationId persistence for per-tab sidepanel"
```

---

### Task 2: `background.ts` — 按-tab 启用/打开侧边栏

**Files:**
- Modify: `entrypoints/background.ts:41-50` (imports), `entrypoints/background.ts:80-108` (`defineBackground` body)

**Interfaces:**
- Consumes: `clearConversationIdForTab` from Task 1 (`@/lib/agent/tab-conversation`).

- [ ] **Step 1: 新增 import**

在 `entrypoints/background.ts` 现有的 `turn-snapshot` import 之后追加一行：

```ts
import { resolveTargetTab } from '@/lib/agent/tab-target';
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
  type CapturePageState,
} from '@/lib/agent/turn-snapshot';
import { clearConversationIdForTab } from '@/lib/agent/tab-conversation';
```

- [ ] **Step 2: 替换全局面板行为为按-tab 绑定**

把 `defineBackground(() => { ... })` 里的这一段：

```ts
export default defineBackground(() => {
  // 点击工具栏图标时打开侧边栏
  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[Aluminum] sidePanel:', err));
  });

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

  // Tab 关闭后其"本轮"快照不再可能被用到，及时清理避免占用 storage.session 的共享配额。
  browser.tabs.onRemoved.addListener((tabId) => {
    clearSnapshot(tabId).catch((err: unknown) => console.error('[Aluminum] clearSnapshot on tab close:', err));
  });
});
```

替换为：

```ts
export default defineBackground(() => {
  // 全局侧边栏默认禁用；面板改为按 tab 单独启用（见下方 action.onClicked 监听器），
  // 切到未启用过面板的 tab 时 Chrome 会自动关闭面板文档，不再像全局模式那样
  // 跟着当前激活 tab 到处显示同一个面板实例。
  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel
      ?.setOptions?.({ enabled: false })
      .catch((err: unknown) => console.error('[Aluminum] sidePanel:', err));
  });

  // 点击工具栏图标时，只为当前这个 tab 启用并打开侧边栏——面板与这个 tab 强绑定。
  browser.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const tabId = tab.id;
    browser.sidePanel
      ?.setOptions?.({ tabId, path: 'sidepanel.html', enabled: true })
      .then(() => browser.sidePanel?.open?.({ tabId }))
      .catch((err: unknown) => console.error('[Aluminum] sidePanel open:', err));
  });

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

  // Tab 关闭后其"本轮"快照、以及"该 tab 上次展示的会话"记录都不再可能被用到，
  // 及时清理避免占用 storage.session 的共享配额。
  browser.tabs.onRemoved.addListener((tabId) => {
    clearSnapshot(tabId).catch((err: unknown) => console.error('[Aluminum] clearSnapshot on tab close:', err));
    clearConversationIdForTab(tabId).catch((err: unknown) =>
      console.error('[Aluminum] clearConversationIdForTab on tab close:', err),
    );
  });
});
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 无新增类型错误（`background.ts` 没有自动化测试基建，行为验证放在 Task 5）

- [ ] **Step 4: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: bind sidepanel to the tab that opened it instead of global mode"
```

---

### Task 3: `store.ts` — 面板挂载时恢复该 tab 上次的会话

**Files:**
- Modify: `entrypoints/sidepanel/store.ts:24-25` (imports), `entrypoints/sidepanel/store.ts:131-134` (module-level 变量), `entrypoints/sidepanel/store.ts:96-129` (`ChatState` 接口), `entrypoints/sidepanel/store.ts:291-307` (`openConversation` 之后新增 action), `entrypoints/sidepanel/store.ts:323` (`create<ChatState>` 收尾之后新增 subscribe)

**Interfaces:**
- Consumes: `getConversationIdForTab`, `setConversationIdForTab` from Task 1 (`@/lib/agent/tab-conversation`).
- Produces: `useChat` 的 `restoreTabConversation: () => Promise<void>` action，供 Task 4（`App.tsx`）在挂载时调用。

- [ ] **Step 1: 新增 import**

```ts
import { createBrowserAgent } from '@/lib/agent/agent';
import { summarizeToolCallForConfirmation } from '@/lib/agent/confirm-summary';
import { getConversationIdForTab, setConversationIdForTab } from '@/lib/agent/tab-conversation';
```

- [ ] **Step 2: 新增模块级 `panelTabId`**

把：

```ts
let activeAgent: Agent | null = null;
let pendingConfirmResolve: ((approved: boolean) => void) | null = null;
/** 当前这一轮固定下来的目标 tabId；用于 revertTurnChanges 在轮次结束后仍能撤销正确的标签页。 */
let currentTurnTabId: number | null = null;
```

改为：

```ts
let activeAgent: Agent | null = null;
let pendingConfirmResolve: ((approved: boolean) => void) | null = null;
/** 当前这一轮固定下来的目标 tabId；用于 revertTurnChanges 在轮次结束后仍能撤销正确的标签页。 */
let currentTurnTabId: number | null = null;
/** 侧边栏面板自己绑定的 tabId；挂载时解析一次并缓存，用于把 conversationId 变化写回对应 tab 的映射。 */
let panelTabId: number | null = null;
```

- [ ] **Step 3: `ChatState` 接口新增 action**

把：

```ts
  respondToConfirmation: (approved: boolean) => void;
  revertTurnChanges: () => Promise<void>;
}
```

改为：

```ts
  respondToConfirmation: (approved: boolean) => void;
  revertTurnChanges: () => Promise<void>;
  restoreTabConversation: () => Promise<void>;
}
```

- [ ] **Step 4: 实现 `restoreTabConversation`**

在 `openConversation` action 实现（`conversationId: id, ... }); },` 那个闭合括号）之后、`removeConversation` 之前插入：

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

- [ ] **Step 5: `conversationId` 变化时写回映射**

在 `export const useChat = create<ChatState>((set, get) => ({ ... }));` 这个语句结束（`}));`）之后，紧接着新增：

```ts

// conversationId 的每次变化（clear() / openConversation() / removeConversation() 的兜底新建）
// 都通过这里统一写回 tabId -> conversationId 映射，不需要在各个 action 里分别插入持久化代码。
useChat.subscribe((state, prevState) => {
  if (state.conversationId === prevState.conversationId) return;
  if (panelTabId === null) return;
  setConversationIdForTab(panelTabId, state.conversationId).catch(() => undefined);
});
```

- [ ] **Step 6: 类型检查**

Run: `pnpm compile`
Expected: 无新增类型错误（`store.ts` 没有自动化测试基建，行为验证放在 Task 5）

- [ ] **Step 7: Commit**

```bash
git add entrypoints/sidepanel/store.ts
git commit -m "feat: restore per-tab conversation on sidepanel remount"
```

---

### Task 4: `App.tsx` — 挂载时触发恢复

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx:38-64` (解构 `useChat()`), `entrypoints/sidepanel/App.tsx:79-82` (挂载 `useEffect`)

**Interfaces:**
- Consumes: `restoreTabConversation` from Task 3 (`useChat()`).

- [ ] **Step 1: 解构新 action**

把：

```ts
    respondToConfirmation,
    revertTurnChanges,
  } = useChat();
```

改为：

```ts
    respondToConfirmation,
    revertTurnChanges,
    restoreTabConversation,
  } = useChat();
```

- [ ] **Step 2: 挂载时调用**

把：

```ts
  useEffect(() => {
    refreshProvider();
    refreshConversations();
  }, [refreshProvider, refreshConversations]);
```

改为：

```ts
  useEffect(() => {
    refreshProvider();
    refreshConversations();
    restoreTabConversation();
  }, [refreshProvider, refreshConversations, restoreTabConversation]);
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 无新增类型错误

- [ ] **Step 4: Commit**

```bash
git add entrypoints/sidepanel/App.tsx
git commit -m "wire up per-tab conversation restore on sidepanel mount"
```

---

### Task 5: 手动端到端验证

**Files:** 无代码改动——本任务只验证 Task 1-4 组合后的真实行为（`entrypoints/` 下没有自动化测试基建，这是本次改动的最终验收手段）。

**Interfaces:** 无。

- [ ] **Step 1: 构建生产包**

Run: `pnpm build`
Expected: 构建成功，产物在 `.output/chrome-mv3`

- [ ] **Step 2: 加载未打包扩展**

打开 Chrome，访问 `chrome://extensions`，开启"开发者模式"，点击"加载已解压的扩展程序"，选择 `.output/chrome-mv3` 目录。如果这个扩展之前已经加载过（用于开发调试），先点它的"移除"再重新加载，确保用的是这次构建的产物。

**注意：** "移除后重新加载"走的是 Chrome 的全新安装路径（`onInstalled` 的 `reason: 'install'`），不会覆盖到"老版本原地升级"路径（`reason: 'update'`）。`browser.sidePanel.setPanelBehavior` 这个行为设置由 Chrome 按扩展持久化保存，不会因为新代码不再调用就自动清掉——如果之前装过还带着全局 `openPanelOnActionClick: true` 的旧版本（本功能改动前的版本），原地升级后残留的 `true` 会让 Chrome 直接消费掉图标点击去开（已禁用的）全局面板，`action.onClicked` 根本不会触发，图标点击又会失效。如果条件允许，额外走一遍这个路径：先加载改动前的一个旧版本构建，触发过一次面板打开后，不移除、直接对着同一个扩展目录点"重新加载"（对应真实的原地升级），再验证图标点击仍然正常打开面板。

- [ ] **Step 3: 验证面板绑定与自动关闭**

1. 打开一个网页（tab A），点击扩展工具栏图标，确认侧边栏打开。
2. 在侧边栏里发一条消息（需要已在设置里配置好 Provider；没有的话先按提示配置一个），等它出现在对话历史里。
3. 新开一个 tab（tab B，随便一个网页），确认侧边栏**自动关闭**（不再跟随显示）。
4. 切回 tab A，确认侧边栏**自动重新打开**（不需要重新点击图标），且刚才那条对话历史完整可见。

Expected: 步骤 3、4 的行为符合预期；如果侧边栏在 tab B 上仍然显示，或者切回 tab A 后历史丢失，说明 Task 2/3 的接线有问题，需要检查 `browser.action.onClicked` 是否真的被触发（可以在 `chrome://extensions` 的扩展详情页打开 service worker 的"检查视图"看 console 输出）。

- [ ] **Step 4: 验证新 tab 是独立空会话**

在一个全新的 tab（tab C）上点击扩展图标打开侧边栏，确认是一个空会话（不是 tab A 的历史）。

Expected: tab C 的侧边栏对话历史为空，和 tab A 互不影响。

- [ ] **Step 5: 验证关闭 tab 后的清理**

关闭 tab A（步骤 3 里用过的那个），观察 `chrome://extensions` 扩展详情页的 service worker console，确认没有报错输出。之后从任意 tab 打开侧边栏，点开会话历史列表，确认 tab A 那次对话仍然能找到并手动打开（历史记录本身不会因为 tab 关闭而被删除，只是 tab→会话的自动映射被清理）。

Expected: 无 console 报错；历史列表里能找到并正常打开那次对话。

- [ ] **Step 6: 验证运行中切 tab 直接中断（不做特殊处理）**

1. 在 tab A 的侧边栏里，发一条会触发写操作确认弹窗的消息（例如让 Agent"给页面加个红色边框"之类需要 `browser_set_style` 的请求），等确认弹窗出现但先不点确认。
2. 切到 tab B，再切回 tab A。

Expected: 侧边栏重新加载，之前那个确认弹窗消失（回合被中断，等同于点了"停止"），没有卡死或残留的"确认中"状态；可以正常发送新消息。

- [ ] **Step 7: 记录验证结果**

在本次任务的 PR 描述或提交信息里注明"已完成手动验证 Task 5 的 6 个场景"，不需要额外产出文件。

---

## Self-Review Notes

- **Spec coverage**：spec 的"决策 1"（按-tab sidePanel API）对应 Task 2；"决策 2"（tabId→conversationId 恢复）对应 Task 1 + Task 3 + Task 4；"决策 3"（tab 关闭清理）已包含在 Task 2 的 `onRemoved` 监听器里；"数据流"五步对应 Task 5 的验证场景 3-4；"边界情况"里的"中途切 tab 打断回合"对应 Task 5 场景 6；"老用户升级"依赖 `runtime.onInstalled` 的 `reason: 'update'`，不需要额外代码（已在 Task 2 的实现里天然覆盖，无需单独任务）。
- **占位符检查**：全部步骤都给了完整代码块和精确命令，没有"TBD"/"适当处理"一类的占位描述。
- **类型一致性**：`getConversationIdForTab`/`setConversationIdForTab`/`clearConversationIdForTab` 的签名在 Task 1 定义后，Task 2、Task 3 的调用点参数类型（`tabId: number`, `conversationId: string`）保持一致；`restoreTabConversation`/`openConversation` 的调用关系（前者内部调用后者）与 Task 3 现有 `openConversation` 签名（`(id: string) => Promise<void>`）匹配。
