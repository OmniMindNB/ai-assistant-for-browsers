# 任务回放：把一次成功的对话沉淀成可复用的指令

- 日期：2026-09-23
- 来源：仓库整体评估里的"任务回放 / 宏"建议；用户确认核心场景是"这次让 agent 摸索着做成了，下次一句话就能让它照着这条路再做一遍，允许它根据页面变化自行调整"
- 状态：已实现（95337b1..HEAD）
- 依赖：无新增权限、无新增工具、无新增 `lib/messaging.ts` 消息类型、不改 `run-port-protocol.ts`。不改 Dexie schema（新增的是非索引字段）

## 1. 目标与非目标

**目标**：用户在一条动过页面的回复上点"保存为指令"，得到一条录制型快捷指令；之后在 `/` 面板里选中它，可选地补一句"这次的不同之处"，agent 带着上次成功的**参考轨迹**重跑一遍——省掉摸索的轮次（LLM 往返占端到端 96%，减少轮数是唯一的提速杠杆），同时页面有变化时仍能自行调整。

**非目标**：

- 不做确定性重放（不经模型、按选择器直接执行）。那等于在 agent 之外另开一条写页面的通道，权限分级、提交确认、接管检测、写入校验都得重新接一遍，且与"允许自行调整"的要求相反。
- 不做变量模板（保存时标 `{金额}`、执行前弹表单）。差异由用户执行时补的一句话表达，模型自己对应到步骤里。
- 保存时不调用模型概括目标。默认拼出的用户原话已足够准确，多一次调用就多一条失败路径（没配 Provider、限流）和一段等待。
- 不做端到端真实模型回放测试——那属于独立的 agent 回归评测工作。

## 2. 方案总览

三段，各自落在已有的机制上：

| 阶段 | 落点 | 新增 |
|---|---|---|
| 录制 | `run-registry.ts` 已有的 `tool_execution_start` / `tool_execution_end` 订阅 | `lib/agent/task-trajectory.ts`（纯函数）；`ChatMessage.trajectory` |
| 保存 | assistant 消息操作行（复制 / 重新生成旁边） | 保存抽屉组件；`ShortcutOrigin` 新增 `'recorded'` |
| 回放 | 现有 `runShortcut` → `buildShortcutExecution` 路径 | 输入框"待执行胶囊"；`shortcut-prompts.ts` 的 recorded 分支；`ShortcutRerun.supplement` |

回放就是一次普通的 `page` 作用域 agent 运行——权限、提交确认、接管检测、写入校验、脱敏、预算原样生效，不开任何旁路。这是本设计最重要的性质。

## 3. 录制

### 3.1 录哪些调用

只录**成功的**、在页面上生效的调用：`WRITE_TOOL_NAMES`（`permissions.ts:62`）里除位置类工具之外的成员。

**保存的指令不绑定具体页面。** 位置类工具（`browser_navigate` / `browser_go_back` / `browser_open_tab` / `browser_switch_tab` / `browser_close_tab`，见 `task-trajectory.ts` 的 `PAGE_LOCATION_TOOLS`）不录，每一步也不带网址；回放总是在用户当前所在的页面上执行。最初的设计每步都带 origin + pathname，并规定"当前页不是第 1 步所在页面就先跳转"——结果在另一个视频上回放"给这个视频加速"时，模型先跳回了录制时的那个视频：录下来的网址是上次那一个具体实例，而保存的任务是"对当前页面做这件事"。旧版本存下的 `url` 字段与位置类步骤由 `parseTrajectory`（设置里的指令）和 `recorded-task.ts`（会话里还没保存的回复）在读取时规范化掉。

- 读工具一律不录。回放时 agent 反正要重读；录进去它会照抄多余的读取轮次，和目标背道而驰。
- `isError === true` 的不录。失败和重试不进轨迹，这正是"照着成功的那条路走"。
- `terminatedToolCallIds` 里的（用户点了停止被掐断的）不录。

### 3.2 步骤结构

实现时拆成 `task-trajectory.ts`（类型/校验/渲染）与 `trajectory-recorder.ts`（录制），理由见实现计划开头。

```ts
// lib/agent/task-trajectory.ts
export interface TrajectoryStep {
  tool: string;                 // 'browser_fill_form'
  /** 人类可读的目标：「报销金额」输入框 / 「下一步」按钮。 */
  target?: string;
  /** fill_form / type / select 的写入值，已过 redactText；sensitive 字段不出现在这里。 */
  values?: { target: string; value: string }[];
  /** 其余关键参数的摘要：按键名、滚动方向、选择器、setAttribute 的属性名与值等。 */
  detail?: string;
  /** 这一步写过 sensitive 字段（密码/支付），值未记录。 */
  sensitive?: boolean;
}
export const MAX_TRAJECTORY_STEPS = 50;
export const MAX_TRAJECTORY_VALUE_CHARS = 500;
```

`fieldId` 和 CSS 选择器**不作为主定位信息**。`fieldId` 按元素身份分配（`field-id-allocation.ts`），跨页面加载必然失效；回放时 agent 必须按标签重新 `browser_get_form` / `browser_find_text`，而不是拿着过期句柄硬点。选择器只在查不到标签时降级进 `detail`。

### 3.3 标签必须在执行**前**解析

参数里有 `fieldId` 时，`tool_execution_start` 当场从 `tab-form-fields.ts` 的句柄表查出它的 `expect`（`{tag, label, text, …}`），生成 `target`。不能等到 `end`：点完"下一步"页面就跳走了，`background.ts` 会用新页面重建句柄表，旧 fieldId 查不到。

句柄表读取是异步的（`browser.storage.session`），所以 `start` 里把查询 promise 存进按 `toolCallId` 键的 map，`end` 时 await 它再拼步骤。这和 `pendingToolArgs` 是同一种形状。

### 3.4 各工具的特殊规则

| 工具 | 规则 |
|---|---|
| `browser_fill_form` / `browser_type` / `browser_select` | 值进 `values`，过 `redactText`，截到 `MAX_TRAJECTORY_VALUE_CHARS`；句柄 `sensitive` 为真的字段不录值，步骤标 `sensitive: true` |
| `browser_set_storage` | 只记键名，不记值（storage 值常常就是 token） |
| `browser_modify_dom` / `browser_set_style` | 只记选择器和操作类型的摘要，不记整段 HTML/CSS |
| `browser_navigate` / `browser_open_tab` | `detail` 记目标地址，同样去掉 query/hash |
| 用 CSS 选择器点击、或 fieldId 已不在表里 | `target` 降级为选择器摘要，同样过脱敏，如"点击 `button.submit`" |

脱敏用的是 `startRun` 为 `buildTurnHandoff` 已经加载的同一份 `RedactionSettings`，不另读一次。

### 3.5 存档

`RunState` 新增 `trajectory: TrajectoryStep[]`，在 `startRun` 的 `finally`（`run-registry.ts:572` 附近，`activitySteps` 存档的同一处）挂到最后一条 assistant 消息上：`...(state.trajectory.length > 0 ? { trajectory } : {})`。这一轮没有写操作就不加字段，纯问答消息零成本。

`ChatMessage`（`lib/chat/messages.ts`）和 `ChatMessageRecord`（`lib/db.ts`）各加 `trajectory?: TrajectoryStep[]`，`store.ts` 从记录恢复消息的映射（`store.ts:955` 附近）一并带上。非索引字段，Dexie 不需要升版本。

Service Worker 被回收时，当轮尚未存档的轨迹随 `RunState` 一起丢失，与现有 orphan 处理一致，不做恢复。

## 4. 保存

### 4.1 入口

assistant 消息操作行（`App.tsx:592` 附近，复制 / 重新生成旁边）新增"保存为指令"按钮。显示条件：

1. 从会话开头到这条消息为止，至少一条 assistant 消息带非空 `trajectory`；
2. 当前没有任务在跑。

### 4.2 取数范围

从会话开头到被点击的那条消息，把所有 assistant 消息的 `trajectory` 按顺序拼接，超出 `MAX_TRAJECTORY_STEPS` 的保留**最后** 50 步（越靠后越接近"最终走通的那条路"）并在抽屉里提示已截断。"一次成功的对话"常常跨多轮：第一轮填了一半，用户补了信息，第二轮才提交。拼接逻辑是 `task-trajectory.ts` 的纯函数 `collectSessionTrajectory(messages, uptoIndex)`。

### 4.3 编辑抽屉

从侧边栏滑出，形态与 `HistoryDrawer` 一致：

1. **名称**：默认取会话标题，可改；即 `/` 面板里显示的名字。
2. **目标**：多行文本框，默认把区间内所有用户消息的 `content` 按顺序以换行拼起来，可改。
3. **参考步骤**：每步渲染成一句话（"在『报销金额』填入 280""点击『下一步』"），可逐条删除、可直接改写入值；`sensitive` 步骤显示"🔒 敏感字段「X」需由用户自己填写（未记录）"，不可编辑值。`planFormFill` 在到达页面之前就丢掉了 sensitive 字段，Runi 从未替用户填过它们，所以不能写成"已填写"，也不该让模型去索取一个它无法写入的值。
4. 顶部固定一行："这些内容只保存在本机；执行时会作为参考发送给你配置的模型"。
5. 区间内任一 `taskOutcome` 为 `failure` / `partial` 时，额外显示黄色提示"上次这轮报告为未完成，确认要保存吗"——提示，不阻止。
6. 名称或目标为空、或步骤全删光时，"保存"禁用。重名不拦截（id 不同）。

步骤的人读渲染是纯函数 `describeTrajectoryStep(step, t)`，抽屉和回放 prompt 共用，保证用户在抽屉里看到的就是模型将收到的。

### 4.4 落盘

以 `origin: 'recorded'`、`scope: 'page'` 写入现有快捷指令列表（`SHORTCUTS_STORAGE_KEY`），toast 提示"已保存，输入 / 即可调用"。设置页快捷指令页里可改名、改目标、删除；轨迹只读展示，要改就删掉重录。

## 5. 存储合并

`lib/shortcuts.ts`：

- `ShortcutOrigin = 'builtin' | 'custom' | 'recorded'`。
- `ShortcutConfig` / `ResolvedShortcut` 新增 `trajectory?: TrajectoryStep[]`。
- `validateShortcutConfigs`：`recorded` 必须带非空 `name`、`prompt`（目标）、`scope === 'page'`、合法且不超上限的 `trajectory`；逐步校验字段类型。不合法的条目按现有规则报错，不能让一条坏数据拖垮整个列表。
- `recorded` 不参与 `BUILTINS_REVISION` / `RETIRED_BUILTIN_IDS` 的演进逻辑，行为同 `custom`。"恢复预设"是出厂重置，会像删掉 custom 一样删掉 recorded——`window.confirm` 的文案要把这点写出来。

## 6. 触发与回放

### 6.1 显示位置

录制指令**只出现在 `/` 面板里**，以 ▶ 图标区分，不进输入框下方的常驻胶囊栏——存上十几条胶囊栏就被挤满了。CLAUDE.md 里"每条可用快捷指令都渲染成胶囊"的描述需同步改成"除录制指令外"。

### 6.2 待执行胶囊（补一句话）

现状有两处与"补一句话"冲突：`/` 面板按整个输入框内容匹配指令名（`presentation.ts:48`），`/报销单 金额改成300` 匹配不到；选中指令立即执行（`WorkbenchComposer.tsx:248`），没有补充的机会。

因此在面板里选中录制指令时**不立即执行**：

1. 输入框上方出现"▶ 差旅报销单 ✕"胶囊，输入框清空并聚焦，placeholder 改为"补充这次的不同之处（可留空），回车执行"；
2. 回车即执行，输入框内容（可为空）作为本次补充说明；
3. ✕ 或 Esc 取消，回到普通输入状态。

普通指令"选中即执行"的行为不变。待执行状态存在 composer 本地，`onRunShortcut` 扩展一个可选的 `supplement` 参数传给 store。

### 6.3 首轮 prompt

`buildShortcutExecution` 新增 recorded 分支，**不做正文预取**——回放要的是表单和按钮，不是正文，`browserTools: 'all'`。文案走 i18n（zh / en 两套），形如：

```
[已保存的任务]
目标：<goal>
上次成功完成时的参考步骤（按顺序；定位靠可见标签，旧的 fieldId 已失效，
需要先 browser_get_form / browser_find_text 重新取句柄）：
1. 在「报销金额」填入 280
2. 点击「下一步」
3. 🔒 敏感字段「支付密码」需由用户自己填写（未记录）
本次补充说明：金额改成 300
执行规则：补充说明优先于参考值；页面与参考不一致时以页面实际为准自行调整；
这个任务不绑定具体页面，就在用户当前所在的页面上执行，不要为了找回上次的页面而跳转。
```

没有补充说明时整行省略，而不是写"本次补充说明：（无）"。参考值里的脱敏占位符由 system prompt 现有第 9 条规则处理，不新增规则。`planFormFill` 在到达页面之前就丢掉了 sensitive 字段，Runi 从未替用户填过它们，所以不能写成"已填写"，也不该让模型去索取一个它无法写入的值。

用户消息气泡显示"▶ 差旅报销单 · 金额改成 300"（无补充说明时只显示名称）。

### 6.4 重新生成

`ShortcutRerun` 新增 `supplement?: string`。重新生成时重放的是当时那一版录制指令（`ResolvedShortcut` 本身已带 `trajectory`）加上当时的补充说明——与现有"存定义本身而不是 id"的约定一致，用户事后删改了这条指令也不影响。

## 7. 错误处理

| 情况 | 处理 |
|---|---|
| 没配 Provider / 当前页受限 | 走现有 `runShortcut` 的报错路径 |
| 页面改版、步骤对不上 | agent 按"以页面实际为准"自行处理；做不下去时用 `report_task_outcome` 报 failure |
| 参考步骤里的提交按钮 | 照常触发 `confirm_always`，逐次询问 |
| 目标标签页是只读引用 | 写工具照常被 `tab-access.ts` 拒绝 |
| prompt 长度 | 最坏 50 步 × 500 字符 ≈ 3 万字符，远低于上下文预算 |
| 存储损坏的 recorded 条目 | `validateShortcutConfigs` 报错并跳过该条，不影响其他指令 |

## 8. 被否掉的方案

- **纯自然语言配方**（保存时让模型把对话总结成一段指令，存成普通 `page` 快捷指令）：几乎零改动，但丢掉了"当时具体点了哪个按钮、填了哪些字段"，回放仍要从头摸索，省不下轮次。
- **确定性重放 + LLM 兜底**：见 §1 非目标。
- **从 `activitySteps` 反推轨迹**：`ActivityStep` 只有给人看的 `description`，没有工具名和参数，且描述文案会随 i18n 和措辞调整而变——拿展示文案当数据源迟早漂移。
- **`/名称 参数` 语法**：要改 `/` 面板的匹配逻辑，名称里带空格时还有歧义；待执行胶囊更直观，也不动现有指令的行为。

## 9. 测试

先写测试再实现，按现有三个 vitest project 分层：

- `unit`
  - `task-trajectory.test.ts`：各工具从参数 + 结果 + 句柄得到步骤；位置类工具不录、步骤不带网址；sensitive 不录值；`set_storage` 只记键；脱敏生效；值截断；`collectSessionTrajectory` 跨多条消息拼接与超上限保留最后 50 步；`describeTrajectoryStep` 中英文渲染。
  - `run-registry.test.ts` 补用例：只录成功调用；被停止掐断的不录；fieldId 标签在 start 时解析（模拟 end 前句柄表已被替换）；轨迹存档到最后一条 assistant 消息；无写操作时不加字段。
  - `shortcuts.test.ts`：recorded 的合法 / 非法数据；不受 `BUILTINS_REVISION` 影响。
  - `shortcut-prompts.test.ts`：recorded 分支在有 / 无补充说明、中 / 英文下的 prompt；不预取。
  - `messages.test.ts` / `presentation.test.ts`：保存按钮的显示条件判定；面板里 ▶ 区分、录制指令不进胶囊栏。
- `ui`
  - 保存按钮显示条件；抽屉删步骤、改值、空名称禁用、失败提示、保存写入存储。
  - 输入框待执行胶囊：选中不立即执行、回车执行并带出补充说明、空补充说明、Esc / ✕ 取消。
  - 重新生成带回 `supplement`。

## 10. 影响面清单

- 新增：`lib/agent/task-trajectory.ts`（+ 测试）、`lib/agent/trajectory-recorder.ts`、`lib/chat/recorded-task.ts`、保存抽屉组件（`entrypoints/sidepanel/components/`）。
- 修改：`lib/agent/run-registry.ts`（录制 + 存档）、`lib/chat/messages.ts`、`lib/db.ts`、`entrypoints/sidepanel/store.ts`（记录映射、`runShortcut` 的 supplement、保存动作）、`lib/shortcuts.ts`、`lib/chat/shortcut-prompts.ts`、`lib/chat/shortcut-rerun.ts`、`lib/workbench/presentation.ts`、`entrypoints/sidepanel/App.tsx`、`entrypoints/sidepanel/components/WorkbenchComposer.tsx`、`components/ShortcutSettings.tsx`、`lib/i18n/locales/{zh,en}.ts`。
- 文档：CLAUDE.md 的快捷指令段落（recorded 类型、胶囊栏例外、恢复预设会删除录制指令）、README 的快捷指令功能描述。
