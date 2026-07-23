# 设计：把"本轮"撤销快照持久化到 chrome.storage.session

日期：2026-07-23

## 背景

`lib/agent/turn-snapshot.ts` 用一个模块级的 `Map<tabId, TurnSnapshot>` 记录"本轮"第一次写操作前
的页面状态（URL、`body.innerHTML`、滚动位置、被修改过的 storage 条目），供"撤销本轮更改"
（`browser_revert_changes` 工具 / 侧边栏 UndoBar 的"撤销本轮更改"按钮）复原页面。

问题：Chrome MV3 的 service worker 在空闲 ~30 秒后会被终止，下次事件触发时重新启动——这会清空
这个内存态的 `Map`。`entrypoints/background.ts` 的 `revertChanges()` 在快照缺失时按设计静默返回
`{ reverted: false }`（不算错误）。但 `entrypoints/sidepanel/store.ts` 的 `revertTurnChanges()`
只检查了消息是否成功往返（`res.ok`），从未检查 `res.data.reverted`，于是即便什么都没恢复，UI
也会静默清空 `turnHasChanges`——用户点了撤销、界面毫无异常，但页面其实原封不动。对比同样场景下
`lib/agent/tools.ts` 的 `browser_revert_changes` 工具（~534-538 行），它正确处理了这种情况，返回
"本轮没有可撤销的改动"。

2026-07-23 手动验证 [inject-script-blocked-notice] 功能时发现并复现（见内存记录
`project_revert_snapshot_bug`）。已确认当前代码仍存在此问题，行号与描述一致。

本设计采用根因修复：把快照持久化到 `chrome.storage.session`（MV3 官方为"进程级但要跨 service
worker 重启存活"场景设计的存储区），使快照在 service worker 重启后依然可用；同时顺带修掉
`store.ts` 的静默失败问题，因为 `reverted: false` 在极端情况下（配额超限降级、本轮确实无改动）
仍会发生，UI 侧无论如何都不该静默吞掉这个信号。

## 决策

1. **存储形态**：`lib/agent/turn-snapshot.ts` 的现有函数名和签名保持不变
   （`hasSnapshot`/`getSnapshot`/`beginSnapshotIfNeeded`/`recordStorageEntryIfAbsent`/
   `clearSnapshot`），全部改为 `async`，内部读写 `browser.storage.session` 而非模块级 `Map`。
   `entrypoints/background.ts` 里所有调用点（`ensureTurnSnapshot`、`revertChanges`、
   `resetTurnSnapshot`、`setStorage`）本来就已经是 `async` 函数，只需补 `await`，不需要结构调整。
   每个 tab 用独立的 key（`turnSnapshot:<tabId>`），直接存 `TurnSnapshot` 对象本身
   （已经是 JSON 可序列化的纯数据，`chrome.storage` 原生支持，不需要手动 `JSON.stringify`）。
   独立 key 避免每次操作都读写整个聚合对象，也避免跨 tab 的写竞争。

2. **配额与失败处理（静默降级）**：`chrome.storage.session` 对整个扩展有约 10MB 的硬配额。绝大多数
   页面的 `body.innerHTML` 远小于这个量，但内容极多的页面可能导致单次快照写入超限。
   `beginSnapshotIfNeeded` 和 `recordStorageEntryIfAbsent` 内部的 `browser.storage.session.set(...)`
   调用包一层 try/catch：写入失败时直接吞掉错误，视为"本轮未记录快照"——不阻塞写工具本身的实际
   动作（DOM/storage 修改、导航照常执行）。后续该 tab 的撤销会走"本轮没有可撤销的改动"这条已有
   路径，和"本轮确实没做任何修改"用同一套文案，不新增 UI。

3. **关闭 tab 时清理**：目前内存 `Map` 里，关闭的 tab 对应的快照会一直留到下次 service worker 被
   回收才消失（无害，因为回收很快发生）。持久化到 `chrome.storage.session` 后，这类快照会一直占用
   共享的 10MB 配额直到浏览器重启。这直接影响"未来的快照是否还写得进去"，属于本次修复的必要范围：
   新增一个 `browser.tabs.onRemoved` 监听器，tab 关闭时调用 `clearSnapshot(tabId)`。

4. **UI 静默失败修复（顺带解决最初报的 bug）**：`entrypoints/sidepanel/store.ts` 的
   `revertTurnChanges()` 增加对 `res.data?.reverted` 的检查，为 `false` 时展示提示文案（与
   `browser_revert_changes` 工具的"本轮没有可撤销的改动"一致），而不是无声地清空
   `turnHasChanges`。这样无论"没有快照"是因为 SW 重启前那次竞争、配额降级，还是本轮真的没有
   改动，用户都能得到明确反馈。

## 影响范围

- `lib/agent/turn-snapshot.ts`：全部导出函数改为 `async`，内部实现从 `Map` 换成
  `browser.storage.session`，新增按 tab 的 storage key 方案和 try/catch 降级逻辑。
- `entrypoints/background.ts`：
  - `ensureTurnSnapshot`/`revertChanges`/`resetTurnSnapshot`/`setStorage` 里对应调用点补 `await`。
  - 新增 `browser.tabs.onRemoved` 监听器调用 `clearSnapshot`。
- `entrypoints/sidepanel/store.ts`：`revertTurnChanges()` 增加 `res.data?.reverted` 检查与提示文案。
- 不改动 `lib/messaging.ts`（`RevertChangesResult` 类型不变）、`lib/agent/tools.ts`
  （`browser_revert_changes` 已经正确处理 `reverted: false`，无需改动）。
- `wxt.config.ts` 无需变更：`storage` 权限已声明，MV3 下 `chrome.storage.session` 包含在同一权限
  下，无需单独申请。

## 测试计划

- `lib/agent/turn-snapshot.test.ts` 全面重写为 `async` 测试，覆盖现有全部用例（首次创建快照、
  重复调用不覆盖、storage 条目只记录一次、无快照时 no-op、清空快照）。
- 新增一个本地极简 fake（`Map` 支撑的对象，实现 `storage.session` 用到的
  `get`/`set`/`remove`），在测试文件的 `beforeEach` 里赋给 `globalThis.browser`——项目里目前没有
  `fake-browser` 一类的测试依赖，`vitest.config.ts` 也是纯 `node` 环境、不经过 WXT 的 ambient
  `browser` 注入，不新增 npm 依赖，用这个本地 fake 即可。
- 新增用例：写入失败（fake 的 `set` reject）时验证静默降级——`hasSnapshot` 之后仍为 `false`，
  不抛出异常。
- 新增用例：验证 `clearSnapshot` 行为覆盖 `tabs.onRemoved` 场景所需的清理路径（清理函数本身已有
  测试覆盖，`onRemoved` 监听器只是调用它，作为 `background.ts` 里的胶水代码，按 CLAUDE.md 现状
  `entrypoints/` 无测试基建，不额外补测试，手动验证即可）。
- 手动验证：
  1. 打开一个页面，让 Agent 做一次 DOM/style 修改，手动在 `chrome://serviceworker-internals`
     或等待 30 秒以上让 service worker 被回收，再点"撤销本轮更改"，确认页面确实被复原（而不是
     之前的"什么都没发生"）。
  2. 正常撤销流程（不等待 SW 回收）确认无回归。
  3. 关闭一个有未撤销快照的 tab，确认没有残留报错（配合新的 `onRemoved` 清理）。

## 不做的事

- 不引入额外的内存缓存层去"加速" `chrome.storage.session` 读写——它本身就是浏览器进程内的存储，
  没有磁盘序列化开销,直接读写即可,避免多一层缓存失效的复杂度。
- 不做配额超限时的主动 UI 提示（对比 [inject-script-blocked-notice] 的"显眼提示"模式）——已确认
  走静默降级，复用"本轮没有可撤销的改动"这条已有文案，这是一个足够罕见的边缘情况，不值得新增
  持久提醒 UI。
- 不新增结构化错误码或诊断字段——`reverted: boolean` 已经足够表达"是否真的撤销了"这一件事。
- 不改动 `RevertChangesResult` 类型或消息协议。
