# 多标签页编排 · 设计说明

- 日期：2026-08-26
- 来源：对标 `alibaba/page-agent` 的 `packages/extension/src/agent/tabTools.ts` + `TabsController.ts`，见 `docs/superpowers/specs/2026-08-26-page-agent-benchmark.md` P0 项
- 状态：已评审，待实现

## 1. 问题

Runi 的写工具（`browser_click`/`browser_fill_form`/…）只能操作侧边栏面板自己绑定的那一个 tab——`entrypoints/sidepanel/store.ts:923` 的 `runAgent()` 每一轮都调用 `createBrowserTools(tabId)`，`tabId` 在工具创建时闭包死，整套工具集从头到尾只认这一个 tab。任何「搜一下 → 打开第 3 条结果 → 回来填表」「对比三个网站的价格」这类需要多个页面协作的任务，agent 完全做不了，只能建议用户自己开新标签页手动操作。

page-agent 的 `MultiPageAgent` 通过 `TabsController.currentTabId`（可变）+ `open_new_tab`/`switch_to_tab`/`close_tab` 三个工具解决了这个问题，所有页面操作工具都转发到 `currentTabId` 指向的那个 tab。这份设计把这个能力落到 Runi 的架构里，但不是照搬——Runi 是持续对话而非一次性任务，且是隐私优先定位的扩展，两点都要求偏离 page-agent 的默认行为，见下方决策。

## 2. 目标与非目标

**目标**

- agent 能在一轮或多轮对话中，打开新标签页、在多个自己打开的标签页之间切换操作目标、关闭不再需要的标签页。
- 页面操作工具（click/fill/type/…）的执行目标，是"当前操作 tab"而不是永远固定为面板绑定的 tab。
- 当前操作 tab 跨对话轮次持续有效，直到面板关闭或对话被清空。
- 用户批准写操作时，如果操作目标不是自己正看着的面板绑定 tab，确认卡片必须显式告知目标是哪个 tab。
- 执行期遮罩/模拟光标显示在真正被操作的那个 tab 上。

**非目标（明确不做）**

| 不做 | 理由 |
|------|------|
| 切换/操作用户自己已经开着的、非 agent 打开的标签页 | 隐私边界：Runi 定位隐私优先，agent 能读写用户任意已开标签页（邮箱、银行页）的风险不可接受。只能操作 `browser_open_tab` 自己开出来的 |
| 每步向模型注入全量标签页状态表（对标 page-agent 的 `summarizeTabs()` 每步注入） | Runi 的 agent loop 是按需工具调用，不是每步重建 prompt 的 ReAct 循环；标签页状态通过工具返回值自然传达即可，见 §4 |
| tab group 视觉隔离（对标 page-agent 用 `chrome.tabGroups` 把 agent 开的 tab 分组） | 锦上添花，不是本次范围；遮罩本身已经是"这个 tab 正被 agent 操作"的视觉信号 |
| 逐 tab 独立的工具调用预算 | `tool-policy.ts` 的预算按整个回合算，不按 tab 拆分，跨 tab 操作不改变这个模型 |

## 3. 关键决策

### 3.1 操作目标可切换，对标 page-agent 全量语义

`browser_click`/`browser_fill_form`/`browser_type`/`browser_scroll`/`browser_navigate`/`browser_set_style`/`browser_modify_dom`/`browser_set_storage`/`browser_read_page`/`browser_get_form`/…等所有既有页面操作工具，执行目标从"创建工具集时闭包死的 tabId"改为"当前 `TabSessionController.currentTabId`"。这是范围最大的一条改动，但用户已确认要对标 page-agent 的完整语义，而不是退化成"新标签页只能只读抓取"。

### 3.2 标签页可见范围：只能看到/操作自己开的

`browser_switch_tab` 只能切到 `TabSessionController.trackedTabs` 里已经存在的 id——这个列表只由 `browser_open_tab` 追加，不会从 `browser.tabs.query()` 拉取整个窗口的标签页列表。agent 看不到、也切不到用户自己开着的其他标签页。这是隐私边界，不是简化。

### 3.3 状态生命周期：跨对话轮次持续

`createBrowserTools` 每轮都重新调用是既有架构约束（见 §1），不需要、也不应该为此发明跨轮共享的模块级可变对象。改为：

- `runAgent` 开始时，从 `browser.storage.session`（键 `runi:tab-session:${panelTabId}`，`panelTabId` 即面板自己绑定的 tab——`runAgent` 入参里原本叫 `tabId` 的那个，与 `lib/agent/tab-conversation.ts` 的持久化模式一致——session 级、不落盘、面板文档重建也能存活）恢复上一轮结束时留下的 tracked 列表 + currentTabId，构造出这一轮的 `TabSessionController` 实例。
- 轮次结束（正常完成、出错、用户中止，三条路径都算）时，把 `TabSessionController` 的最终状态写回同一个 key。
- 面板自己绑定的 tab 永远在 tracked 列表里，且不可被 `browser_close_tab` 关闭；它可能暂时不是 `currentTabId`，但角色上依然是"回退目标"。

这一点是本设计相对 page-agent 的刻意偏离：page-agent 的 `TabsController` 在每次 `execute()`（约等于 Runi 的一轮对话）开始时重新 `init()`，标签页追踪不跨任务持续。Runi 是连续对话，"这轮开的三个标签页，下一轮还想继续用"是真实场景，所以选择跨轮持续，直到面板关闭或对话清空。

### 3.4 遮罩跟随当前操作 tab

`lib/agent/agent.ts` 里 `onOverlay` 回调目前无条件把 `SET_AGENT_OVERLAY` 发给闭包住的 `tabId`。改为发给 `session.currentTabId`；`currentTabId` 变化的那一刻（`browser_open_tab` 或 `browser_switch_tab` 生效时），先给旧目标 tab 发一次 `{active:false}`（如果它还存在），再给新目标发 `{active:true}`。面板自己绑定的 tab 在不是当前操作目标期间，遮罩应处于未挂载状态。

### 3.5 确认卡片必须标注跨 tab 目标

这是唯一一处"不改就有体验/安全隐患"而非纯粹锦上添花的关联改动。`beforeToolCallPermissionGate`（`lib/agent/permissions.ts`）弹确认卡片时，如果本次写操作的目标 tab 不是面板自己绑定的那个，卡片摘要必须显式标出目标标签页的标题/URL，否则用户会误以为自己在批准操作当前正看着的页面。`confirm-summary.ts` 需要新增一个可选的 targetTab 展示字段。

### 3.6 工具命名与权限分级

新增四个工具，全部带 `browser_` 前缀（与"改动浏览器/页面状态就带前缀，纯问答/等待不带前缀"的既有约定一致，见 `tools.ts` 里 `ask_user`/`wait` 的注释）：

| 工具 | 语义 | 权限层级 |
|---|---|---|
| `browser_open_tab(url)` | 在面板绑定 tab 所在的**同一窗口**里开新 tab、导航到 url、设为 current、加入 tracked 列表 | `confirm`（新增进 `CONFIRM_TOOL_NAMES`）——与 `browser_navigate` 同量级的浏览器可见动作 |
| `browser_switch_tab(tabId)` | 把 currentTabId 切到 tracked 列表里的某个 id | `always_allow`（新增进 `READ_ONLY_TOOL_NAMES`）——自身无副作用，真正的写操作仍在各自工具的确认闸门上把关 |
| `browser_close_tab(tabId)` | 关闭一个 tracked tab（不能是面板自己绑定的） | `confirm`——不可逆丢失该 tab 状态，但达不到表单提交那种"每次都问"的 `confirm_always` |
| `browser_list_tabs()` | 只读，返回 tracked 列表 + 当前是哪个 | `always_allow` |

`browser_open_tab`/`browser_close_tab` 走两个新增消息类型 `OPEN_NEW_TAB`/`CLOSE_TAB`（`entrypoints/background.ts`，复用 `navigateTab` 已有的 `waitForTabLoad` 落地等待模式）。`browser_switch_tab` 不需要新消息类型：纯内存操作，如果用户手动关闭了目标 tab，下一个真正落到该 tab 上的工具调用会在 `resolveTargetTab` 里自然抛"目标标签页已关闭"，不必在 switch 这一步单独查存在性——这是刻意简化，把"tab 是否还活着"的校验统一收在已有的 `resolveTargetTab` 这一个地方，不重复实现。

### 3.7 标签页状态如何传达给模型：工具返回值，不进 system prompt

page-agent 每一步都把 `summarizeTabs()` 的 markdown 表注入 prompt，因为它的 agent loop 是强制每步重建完整 `browser_state` 的 ReAct 循环。Runi 的 agent 是按需工具调用循环，没有"每步"这个概念，`system-prompt.ts` 只在轮次开始时构建一次。因此标签页状态改为：`browser_open_tab`/`browser_switch_tab`/`browser_close_tab`/`browser_list_tabs` 四个工具的返回值里，都带上当前完整的 tracked 列表 + 高亮当前 currentTabId，模型每次调用这几个工具之一就能看到最新状态，不需要额外的系统提示词改动。

## 4. 数据流

```
runAgent(tabId=面板绑定的tab)
  │
  ├─ 恢复 TabSessionController ← storage.session["runi:tab-session:{tabId}"]
  │     （若无历史记录：trackedTabs=[面板tab], currentTabId=面板tab）
  │
  ├─ createBrowserTools(session, ...)  // 不再传裸 tabId
  │     所有 makeXTool(session) 内部执行时读 session.currentTabId
  │
  ├─ agent 工具调用循环
  │     browser_open_tab → OPEN_NEW_TAB 消息 → background 建tab+等加载
  │                       → session.trackedTabs.push(...); session.currentTabId = 新tab
  │                       → onOverlay 联动：旧目标 unmount，新目标 mount
  │     browser_switch_tab → session.currentTabId = 目标（校验在 trackedTabs 内）
  │                        → onOverlay 联动
  │     browser_click 等写工具 → beforeToolCallPermissionGate
  │                            → 若 targetTab != 面板绑定tab，确认卡片标注目标
  │                            → 批准后 sendMessage(TYPE, payload, session.currentTabId)
  │     browser_close_tab → CLOSE_TAB 消息 → session.trackedTabs 移除
  │                        → 若关掉的是 current，回退到面板绑定tab
  │
  └─ 轮次结束（成功/失败/中止）
        写回 storage.session["runi:tab-session:{tabId}"] ← session 最终状态
```

## 5. 错误处理

- **当前操作 tab 在轮次进行中被用户手动关闭**：下一次工具调用触发 `resolveTargetTab` 失败，工具把失败信息作为文本结果返回给模型；模型可选择 `browser_switch_tab` 到其他 tracked tab，或退回面板自己的 tab。
- **面板被关闭时 currentTabId 指向非面板 tab**：`browser.storage.session` 是 session 级存储，浏览器/扩展进程存活期间都在；不需要主动清理逻辑，过期的 tracked tab 在下次任何工具调用命中 `resolveTargetTab` 时自然报错暴露。
- **`browser_close_tab` 关闭的正好是 currentTabId**：自动回退到面板绑定的 tab，工具文本结果里注明"已自动切回原标签页"。
- **`browser_open_tab` 的 url 非 http(s)**：复用 `isNavigableUrl` 现有校验逻辑，拒绝方式与 `browser_navigate` 一致（`decideToolPermission` 里的 deny 路径）。
- **`browser_switch_tab` 传入不在 trackedTabs 里的 id**：工具返回失败文本，不触发任何浏览器 API 调用，不消耗额外的确认闸门。

## 6. 测试策略

- `lib/agent/tab-session.ts`（新文件，纯逻辑，node 环境单测）：open/switch/close 的状态转换、越权 switch（非 tracked id）报错、close 掉 current 后正确回退到面板 tab、序列化/反序列化往返（对应 storage.session 读写边界）。
- `lib/agent/tools.ts` 新增的四个工具：沿用现有 `form-tools.test.ts` 一类的 mock-`sendMessage` 测试模式。
- `permissions.ts`：扩展 `permissions.test.ts`，覆盖新工具的分级（`browser_open_tab`/`browser_close_tab` → confirm，`browser_switch_tab`/`browser_list_tabs` → always_allow）。
- `confirm-summary.ts`：扩展 `confirm-summary.test.ts`，覆盖 targetTab 存在/不存在两种摘要文案。
- `entrypoints/background.ts` 里的 `openNewTab`/`closeTab` 两个新 handler 保持纯 I/O、不塞业务逻辑（项目里没有覆盖 `entrypoints/**` 的 vitest project，这是既有约定，不是本次新加的限制）。

## 7. 与 `docs/superpowers/specs/2026-08-26-page-agent-benchmark.md` 的关系

完成后回到该文档，把"多标签页编排"那一项的 `- [ ]` 改成 `- [x]`，并补一行落地链接指向本文件与对应的实施计划（`docs/superpowers/plans/`）。
