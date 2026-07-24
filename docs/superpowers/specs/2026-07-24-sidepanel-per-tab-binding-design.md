# 设计：侧边栏按 tab 绑定，切换 tab 后自动关闭

日期：2026-07-24

## 背景

`entrypoints/background.ts` 目前用 `browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
（`onInstalled` 里）——这是 Chrome 的"全局侧边栏"模式：面板是单一实例/单一文档，跟随当前激活的
标签页显示。在某个页面打开侧边栏后切换到一个新 tab，面板不会关闭，仍展示原来那个会话的历史，
但 Agent 的问答语境已经悄悄换成了新 tab 的页面——这是不合理的，用户容易误以为回答仍是关于原页面。

`lib/agent/tab-target.ts` 的 `resolveTargetTab` 和 `store.ts` 里"回合级固定 tabId"的既有设计
（ref: [[2026-07-23-turn-tabid-pinning-and-userscripts-wait-design]]）已经解决了"一轮对话执行
期间 tab 被切走"的问题，但没有解决"面板本身该不该跟着切到别的 tab 上显示"这个更上层的问题。

## 决策

### 1. 用 Chrome 原生的按-tab sidePanel API 替换全局模式

- `background.ts` 的 `onInstalled` 里，把 `setPanelBehavior({ openPanelOnActionClick: true })`
  换成 `browser.sidePanel.setOptions({ enabled: false })`（不传 `tabId`，作用于全局默认状态）。
  这样 Chrome 自带的侧边栏选择器 UI（工具栏上那个独立于扩展 action 按钮的"显示侧边栏"入口）
  在没有为某个 tab 单独启用之前，也不会展示本扩展的面板。
- 新增 `browser.action.onClicked.addListener((tab) => { ... })`：只在用户点击扩展工具栏图标时，
  为**当前被点击的 tab**调用 `sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true })`
  后接 `sidePanel.open({ tabId: tab.id })`。
- 效果：面板与打开它的那个 tab 强绑定。切到其它未启用过面板的 tab，Chrome 会自动关闭（销毁）
  面板文档；切回这个 tab，Chrome 会自动重新加载面板文档并展示——不需要重新点击图标，这是 Chrome
  按-tab 侧边栏的原生行为，不需要我们自己监听 `tabs.onActivated` 去手动开关。
- 已确认现有安装的自动迁移路径：`runtime.onInstalled` 在扩展更新时也会以 `reason: 'update'`
  触发，因此老用户升级后会自动执行"全局禁用 + 按需按-tab 启用"的迁移，无需单独处理。

### 2. 面板文档被销毁重建时，恢复该 tab 上一次的对话

按-tab 面板切离时会销毁面板页面的整个 JS 上下文（`store.ts` 里的 zustand store、正在进行的
`fetch` 流式请求、待确认的写操作弹窗全部丢失，等同于用户手动点了"停止"）；切回时面板重新
从零加载。为了不让用户觉得"记录丢了"，需要让面板重新加载后自动恢复这个 tab 上一次在用的会话
（对话内容本身已经通过 `lib/db.ts` 的 IndexedDB 持久化，只是内存态的"当前显示哪个会话"会丢）。

- 新增 `lib/agent/tab-conversation.ts`，结构对齐已有的 `lib/agent/turn-snapshot.ts`
  （同样用 `browser.storage.session`，因为这个映射也是"进程级、不需要跨浏览器重启存活"的
  轻量状态，语义上和 turn-snapshot 一致）：
  - `getConversationIdForTab(tabId): Promise<string | undefined>`
  - `setConversationIdForTab(tabId, conversationId): Promise<void>`
  - `clearConversationIdForTab(tabId): Promise<void>`
  - 写入失败（配额等）时静默降级，不抛出——和 `turn-snapshot.ts` 的既有约定一致；这里只是丢失
    "记住上次会话"这个体验优化，不影响对话本身的持久化（那是 IndexedDB 的职责）。
- `entrypoints/sidepanel/store.ts` 新增模块级 `let panelTabId: number | null = null`，在面板
  挂载时通过 `browser.tabs.query({ active: true, currentWindow: true })` 解析一次并缓存。这个
  取法是可靠的：按-tab 面板只会在它绑定的那个 tab 处于激活状态时渲染，所以"挂载时刻的激活 tab"
  必然就是这个面板自己绑定的 tab。
- 新增 store action `restoreTabConversation()`：解析出 `panelTabId` 后查
  `getConversationIdForTab`，命中则调用已有的 `openConversation(id)` 走现成的恢复逻辑；未命中
  则保留挂载时 `genConversationId()` 生成的新会话 id，不做特殊处理。在 `App.tsx` 现有的挂载
  `useEffect`（`refreshProvider()` / `refreshConversations()` 那处）里追加调用。
- 用 `useChat.subscribe`，订阅 `conversationId` 变化，变化时调用
  `setConversationIdForTab(panelTabId, conversationId)`。这是唯一的写入点，覆盖
  `clear()`、`openConversation()`、`removeConversation()` 的兜底新建、以及挂载时的初始值——不需要
  在这四处调用点分别插入持久化代码。

### 3. tab 关闭时的清理

`background.ts` 里已有的 `browser.tabs.onRemoved` 监听器（当前只调用 `clearSnapshot`）追加一行
`clearConversationIdForTab(tabId)` 调用，避免 `storage.session` 里堆积已关闭 tab 的映射，占用
和 turn-snapshot 共享的配额。对话记录本身不删除，仍可从历史列表里找到。

## 数据流

1. 用户在 tab A 点击工具栏图标 → background 只为 tab A 启用并打开面板。
2. 面板加载，解析出 `panelTabId = A`，查 `storage.session['tabConversation:A']`：首次为空 →
   使用挂载时生成的新会话 id，订阅回调立即把 `A → <新 id>` 写回 storage。
3. 用户切到 tab B → Chrome 关闭面板（B 从未被启用）→ 面板的整个 JS 上下文被销毁，进行中的
   Agent 回合（流式回答/待确认弹窗）直接中断，等同于点了"停止"。
4. 用户切回 tab A → Chrome 自动为 A 重新打开面板（原生行为，不需要重新点击图标）→ 面板重新
   加载，`panelTabId` 再次解析为 A，查到映射的会话 id，调用 `openConversation` → 从 IndexedDB
   恢复历史消息，界面和离开前一致（中断的那次回合本身不会被补上）。
5. 用户在新 tab C 点击图标 → background 只为 C 启用并打开 → 全新空会话，和 A/B 互不影响。

## 边界情况

- **中途切 tab 打断回合**：按你的决定不做特殊处理，直接允许中断——和现有 `stop()` 效果一致，
  不新增状态机。
- **老用户升级**：`onInstalled` 的 `reason: 'update'` 天然覆盖迁移，不需要额外代码路径。
- **多窗口**：不做特殊处理，维持现状——`GET_ACTIVE_TAB` / `resolveActiveTabId` 等既有逻辑同样
  没有区分窗口，这次改动不扩大这个既有假设的范围。
- **Chrome 原生侧边栏选择器入口**：全局默认已禁用，未被单独启用过的 tab 上，用户从那个原生入口
  尝试打开本扩展面板会显示不可用——符合"面板只在被显式打开过的 tab 上存在"的预期，不额外处理。

## 影响范围

- `entrypoints/background.ts`：`onInstalled` 里的面板行为设置改为全局禁用；新增
  `action.onClicked` 监听器；`tabs.onRemoved` 监听器追加一行清理调用。
- 新增 `lib/agent/tab-conversation.ts`（及配套 `.test.ts`）。
- `entrypoints/sidepanel/store.ts`：新增 `panelTabId` 解析、`restoreTabConversation()` action、
  `conversationId` 变化订阅。
- `entrypoints/sidepanel/App.tsx`：挂载 `useEffect` 里追加一次 `restoreTabConversation()` 调用。
- 不改动 `lib/messaging.ts`、`lib/db.ts`、`lib/agent/turn-snapshot.ts`、`lib/agent/tab-target.ts`
  ——这次改动是新增一层"面板生命周期与 tab 绑定"，不触碰既有的"回合级 tabId 固定"和撤销快照逻辑。
- `wxt.config.ts` 无需变更：`sidePanel` 权限已声明。

## 测试计划

- `lib/agent/tab-conversation.test.ts`：对齐 `turn-snapshot.test.ts` 的写法（get/set/clear
  往返、写入失败静默降级），复用同一个本地 `storage.session` fake 模式。
- `entrypoints/background.ts` 和 `entrypoints/sidepanel/store.ts` / `App.tsx` 的改动没有自动化
  测试基建（CLAUDE.md 已注明 `entrypoints/` 目前不在 vitest 覆盖范围内），按现状手动验证：
  1. tab A 打开面板 → 发一条消息 → 切到 tab B，确认面板自动关闭。
  2. 切回 tab A，确认面板自动重新打开，且历史消息完整恢复。
  3. 在全新 tab C 打开面板，确认是空会话，和 A 的历史互不影响。
  4. 关闭 tab A（历史未被主动清空的情况下），确认扩展 service worker 无报错，且 A 的历史仍能从
     侧边栏的会话列表里找到并手动打开。
  5. 在 tab A 触发一次写操作确认弹窗，弹窗未确认时切到 tab B 再切回 A，确认面板正常重新加载，
     没有残留卡死的确认状态（等同于验证"中断即中断"，不会有僵死 UI）。

## 不做的事

- 不实现多窗口感知逻辑。
- 不为"回合被切 tab 中断"设计恢复/续传机制，也不新增提示 UI 告知用户"回合被中断"——效果与既有
  的"停止"按钮一致，用户可以从截断的历史里自行判断。
- 不改动 `lib/agent/turn-snapshot.ts` 或"回合级固定 tabId"的既有逻辑。
- 不引入内存缓存层加速 `storage.session` 读写，理由同
  [[2026-07-23-revert-snapshot-persistence-design]]。
