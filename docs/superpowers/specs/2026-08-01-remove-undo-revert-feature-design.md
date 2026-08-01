# 设计：删除撤销（Undo/Revert）功能

- 状态：已批准 Approved
- 日期：2026-08-01
- 关联：`lib/agent/turn-snapshot.ts`、`lib/agent/tools.ts`、`lib/agent/permissions.ts`、
  `lib/agent/system-prompt.ts`、`lib/messaging.ts`、`entrypoints/background.ts`、
  `entrypoints/sidepanel/store.ts`、`entrypoints/sidepanel/App.tsx`、
  `entrypoints/sidepanel/components/AgentActivityCard.tsx`、`lib/i18n/locales/{zh,en}.ts`、
  `CLAUDE.md`、`README.md`、`README.en.md`、`docs/privacy-policy.en.md`

## 背景

浏览器插件里 agent 对页面的写操作本身就很轻量（改样式、改 DOM、填表单、点击、跳转、写
storage），而且每轮首次写操作前用户已经要走一次确认（Deny-First 权限闸门，见
`lib/agent/permissions.ts`）。在此之上再维护一套"本轮改动快照 + 一键撤销"机制，价值有限，
但代价不小：每个写工具调用前都要 `ensureTurnSnapshot`（对写 DOM 前的整页 `head`/`body`
innerHTML 做一次快照并持久化进 `chrome.storage.session`，见 `turn-snapshot.ts` 顶部注释里
解释的 MV3 service worker 存活问题），侧边栏还要维护 `turnHasChanges`/`currentTurnTabId`
状态和一条"撤销条"UI。

用户判断这套机制不值得维护，要求整体删除：不保留降级形式，也不用别的确认/二次提示替代。

## 目标

- 删除撤销功能的全部实现：`turn-snapshot.ts` 模块、`browser_revert_changes` 工具、
  `REVERT_CHANGES`/`RESET_TURN_SNAPSHOT` 消息类型、侧边栏撤销条 UI 及相关状态。
- 删除仅为支撑撤销而存在的周边代码：每个写工具调用前的 `ensureTurnSnapshot`、
  `setStorage` 里为撤销记录的 `previousValue`、`AUTO_ALLOW_TOOL_NAMES`/`auto_allow`
  权限档位（该档位只服务于这一个工具）。
- 更新所有引用撤销功能的 i18n 文案、系统提示词、`CLAUDE.md` 架构说明、README（中英）、
  隐私政策文字。
- 删除/更新相应测试。

## 非目标

- 不改变确认闸门（confirm-gate）"每轮首次写操作确认一次"的行为——这是留下的、独立的安全
  机制，与撤销无关。
- 不新增任何替代性的"二次确认"或"危险操作提示"——用户明确要求这类轻量操作不需要额外保护。
- 不处理 Chrome Web Store 上架文案（`docs/chrome-store-listing.en.md`、
  `docs/chrome-store-permission-justifications.md`、`docs/chrome-store-submission-guide.md`）
  和商店截图资产（`screenshot-04-undo.png`、`demo/store-assets-frame.html`）——这些涉及重新
  生成截图和实际店铺重新提交流程，是独立的后续任务。
- 不触碰 `docs/superpowers/specs/`、`docs/superpowers/plans/` 下的历史 spec/plan 文档
  （例如 `2026-07-23-revert-snapshot-persistence-design.md`）——按文档驱动开发约定，
  已批准的编号文档是不可变历史记录。
- 不改变 `entrypoints/sidepanel/store.ts` 里 `persistConversationSnapshot`（会话消息持久化）
  相关逻辑——命名带 "snapshot" 但与本次删除的"页面改动快照"无关。

## 设计

### 1. 删除 `lib/agent/turn-snapshot.ts` 及其测试

整个模块（`StorageSnapshotEntry`、`CapturePageState`、`TurnSnapshot`、`hasSnapshot`、
`getSnapshot`、`beginSnapshotIfNeeded`、`recordStorageEntryIfAbsent`、`clearSnapshot`）
连同 `lib/agent/turn-snapshot.test.ts` 一起删除。

### 2. `entrypoints/background.ts`

- 删除 `revertChanges`、`resetTurnSnapshot`、`ensureTurnSnapshot` 三个函数。
- 删除六处写工具函数（`setStyle`、`modifyDom`、`clickElement`、`typeText`、
  `selectOption`、`scrollPage`）以及 `navigateTab`、`setStorage`（合计 8 处）开头的
  `await ensureTurnSnapshot(tabId);` 调用。
- 消息路由 `switch` 中删除 `'RESET_TURN_SNAPSHOT'`、`'REVERT_CHANGES'` 两个 case。
- 删除 tab 关闭时的 `clearSnapshot(tabId)` 清理调用。
- `setStorage`：删除末尾 `recordStorageEntryIfAbsent(...)` 调用；`executeInTab` 内部仍然
  读取 `store.getItem(key)` 得到 `previousValue` 用于返回值——这部分连同
  `SetStorageResult.previousValue` 字段（见第 4 节）一并删除，写操作只返回
  `{ area, key }`。
- 删除对应的 `import { ... } from '@/lib/agent/turn-snapshot'`。

### 3. `lib/agent/tools.ts`

删除 `makeRevertChangesTool` 函数、`createBrowserTools`（或等价注册处）里对它的调用，以及
`import { type RevertChangesResult, ... }`。

### 4. `lib/messaging.ts`

- `MessageType` 联合类型删除 `'RESET_TURN_SNAPSHOT' | 'REVERT_CHANGES'`。
- 删除 `RevertChangesResult` 接口。
- `SetStorageResult` 删除 `previousValue: string | null;` 字段，只保留 `area`、`key`。

### 5. `lib/agent/permissions.ts`

- 删除 `AUTO_ALLOW_TOOL_NAMES` 常量。
- `PermissionLevel` 从 `'always_allow' | 'auto_allow' | 'confirm' | 'deny'` 收窄为
  `'always_allow' | 'confirm' | 'deny'`（全仓库排查确认 `auto_allow` 只服务于
  `browser_revert_changes` 这一个工具，见调研记录）。
- `decideToolPermission` 删除 `if (AUTO_ALLOW_TOOL_NAMES.has(toolName)) return { level:
  'auto_allow' };` 分支。
- `beforeToolCallPermissionGate` 里 `if (decision.level === 'always_allow' ||
  decision.level === 'auto_allow') return undefined;` 简化为
  `if (decision.level === 'always_allow') return undefined;`。

### 6. `lib/agent/system-prompt.ts`

写工具引导文案（约第 123 行）里删除"且整轮改动可通过 browser_revert_changes 完整撤销"
这半句，保留"写工具首次调用会触发一次性用户确认……用户批准后本轮内的同类调用会自动执行"
的部分。

### 7. `entrypoints/sidepanel/store.ts`

- 删除 `revertTurnChanges` action、`turnHasChanges` 状态字段（含类型声明与初始值）、
  `currentTurnTabId` 模块级变量、`WRITE_TOOL_NAMES` 常量。
- 删除新一轮开始时发送 `RESET_TURN_SNAPSHOT` 消息的调用。
- 删除工具活动事件处理里根据 `event.toolName === 'browser_revert_changes'` /
  `WRITE_TOOL_NAMES.has(event.toolName)` 切换 `turnHasChanges` 的分支。
- 删除对 `RevertChangesResult` 类型和 `'RESET_TURN_SNAPSHOT'` 字面量的引用。

### 8. `entrypoints/sidepanel/App.tsx`

删除 `UndoBar` 组件定义及其渲染行
（`{!busy && !pendingConfirmation && turnHasChanges && <UndoBar onRevert={revertTurnChanges} />}`）。

### 9. `entrypoints/sidepanel/components/AgentActivityCard.tsx`

删除 `browser_revert_changes: 'agentActivity.tool.revertChanges'` 这条工具名到 i18n key
的映射。

### 10. i18n（`lib/i18n/locales/zh.ts` / `en.ts`）

删除的 key（中英文各一份，共 6 个）：`agentActivity.tool.revertChanges`、
`confirm.undoBarStatus`、`confirm.undoBarButton`、`store.noRevertTabInfo`、
`store.revertFailed`、`store.noChangesToRevert`。

`confirm.approveHint` 重新措辞，去掉"这轮做的所有改动之后都能一键撤销"部分，只保留
"批准后自动执行后续同类操作"的语义：

- 中文：`批准后，本轮内后续的写操作会自动执行，无需逐条确认。`
- 英文：`Once approved, further write actions this turn run automatically without asking
  again.`

### 11. `CLAUDE.md`

- `permissions.ts` 架构说明句：把 "`always_allow`（只读）/ `auto_allow`
  (`browser_revert_changes`) / `confirm`（所有写/交互工具）/ `deny`" 改为 "`always_allow`
  （只读）/ `confirm`（所有写/交互工具）/ `deny`"。
- 工具列表句里的 `browser_revert_changes` 从写/交互工具枚举中移除。
- 删除提到 `turn-snapshot.ts`/`confirm-gate.ts` 撤销相关的架构说明句（`confirm-gate.ts`
  本身保留，只删撤销相关表述）。

### 12. README（`README.md` / `README.en.md`）

- 删除标语句中"一键撤销"/"one-click undo"的分句。
- 删除功能列表里的"↩️ 一键撤销"/"One-click undo" 条目。
- 文件树注释里删除 `turn-snapshot.ts` 一行；`tools.ts` 注释里的"撤销"字样一并去掉。

### 13. `docs/privacy-policy.en.md`

- 删除"Session and undo state"整行数据表条目。
- `scripting` 权限说明行里去掉"captures undo state"。
- `storage` 权限说明行里去掉"and undo"（保留"temporary session ... state"，因为
  per-tab 会话绑定状态本身不属于本次删除范围）。
- 正文里"Tab-to-conversation state and undo snapshots are stored temporarily in
  `chrome.storage.session`"改为"Tab-to-conversation state is stored temporarily in
  `chrome.storage.session`"。

## 边界与异常

- **已安装用户升级后残留的 `chrome.storage.session` 快照数据**：`storage.session` 本身
  不持久化到磁盘，浏览器进程结束或扩展重装即清空，不需要做迁移或清理逻辑。
- **正在进行中的对话引用了 `browser_revert_changes` 工具调用记录**（历史消息里 agent 曾
  调用过这个工具名）：这是纯展示问题——`AgentActivityCard.tsx` 的映射表删除后，历史消息
  里这类工具调用会走 `agentActivity.tool.unknown` 兜底文案，不会报错。属于可接受的行为，
  不需要额外处理。

## 安全与隐私

- 删除的是"改动后可撤销"这一便利机制，不改变"写操作前必须用户确认"这条核心安全边界
  （Deny-First 闸门、confirm-gate 均不变）。
- 隐私政策更新是纯文字对齐：删除的 `chrome.storage.session` 快照字段（页面 HTML、
  storage 变更前的值等）不再产生，文字描述同步收窄，不存在"文档承诺了但代码没做"或反过来
  的不一致。

## 测试

- 删除 `lib/agent/turn-snapshot.test.ts`。
- `lib/agent/permissions.test.ts`：删除 `browser_revert_changes` / `auto_allow` 相关用例；
  确认 `PermissionLevel` 类型收窄后其余用例（`always_allow`/`confirm`/`deny`）不受影响。
- `entrypoints/sidepanel/components/workbench-components.test.tsx`：删除撤销条渲染/排序的
  用例（`places the activity card before confirmation and undo cards...`）及对
  `chatStore.revertTurnChanges` 的 mock。
- 全仓库（不含 `docs/superpowers/{specs,plans}/` 历史文档、不含商店资产）搜索
  `revert|Revert|undo|Undo|snapshot|Snapshot` 复查是否有遗漏引用；注意排除
  `persistConversationSnapshot`（会话持久化，命名巧合，非本次范围）。
- 验证命令：`pnpm compile`、`pnpm test`、`pnpm build`。
- 手动验证（`pnpm dev` 加载解包扩展）：让 agent 执行一次页面写操作（如改样式），确认确认
  卡片正常弹出、批准后操作生效，且不再出现"撤销条"；随后发起新一轮对话确认无残留状态。

## 验收标准

- [ ] `lib/agent/turn-snapshot.ts` 及其测试已删除，仓库内无残留 import。
- [ ] `browser_revert_changes` 工具、`REVERT_CHANGES`/`RESET_TURN_SNAPSHOT` 消息类型、
      `RevertChangesResult` 类型已全部移除。
- [ ] `AUTO_ALLOW_TOOL_NAMES` 与 `auto_allow` 权限档位已从 `permissions.ts` 移除，
      `PermissionLevel` 收窄为三档。
- [ ] 侧边栏不再渲染撤销条；`turnHasChanges`/`currentTurnTabId`/`WRITE_TOOL_NAMES` 已删除。
- [ ] i18n 中撤销相关 key 已删除，`confirm.approveHint` 中英文均已改写。
- [ ] `CLAUDE.md`、`README.md`、`README.en.md`、`docs/privacy-policy.en.md` 中撤销相关表述
      已更新，历史 spec/plan 文档未被改动。
- [ ] `pnpm compile`、`pnpm test`、`pnpm build` 均通过。

## 开放问题

- 无。
