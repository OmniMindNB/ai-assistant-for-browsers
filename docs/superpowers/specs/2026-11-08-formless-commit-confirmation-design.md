# 无 form 结构的提交确认（formless commit confirmation）

- 日期：2026-11-08
- 来源：会话导出 `runi-请答题-20261108-1734.md`（v1.9.1，wj.qq.com 文学常识问卷，20 题全部作答后点击「提交」，全程无确认）
- 状态：待评审
- 依赖：无新增权限、无新增工具

## 1. 现象与证据

导出轨迹里，模型用两次 `browser_fill_form` 落地 25 个字段后，单次 `browser_click` 点掉了 f120「提交」，问卷直接进入结束页。整段运行 71.7s = 模型 67.5s + 工具 4.2s，**没有任何等待用户决策的时间窗**——确认闸门没有触发，用户没有获得拦截机会。这是一次不可逆的考试提交。

同页另一条证据：步骤 #5 `browser_get_form {"selector":"form"}` 返回 0 个元素——该页面的可交互元素全部没有 form owner，wj.qq.com 是不使用 `<form>` 的 React SPA。

## 2. 根因

`form-submit.ts` 的 `decideSubmitIntent` 只做结构判定，要求**同时**满足：

1. `hasFormOwner`（目标元素归属某个 `<form>`）；
2. 是 `<button>`（type 缺省或 submit）或 `<input type=submit|image>`。

无 form 结构的 SPA 提交按钮（`<button type="button">`、`<div role="button">`、纯 cursor 命中的可点元素）两条都不满足，`isSubmit` 恒为 false，`browser_click` 按 `AUTO_APPROVE_TOOL_NAMES` 直接放行。「只看结构、不看文案」是 Spec-0005 的明确取舍——识别「提交」「下单」这类字样会让普通按钮频繁弹二次确认，毁掉确认的信噪比——本设计**不改这条边界**。

但结构判定并非只有「元素自身的标签结构」一个维度。确认闸门真正要防的是「**agent 批量填写之后自行按下了终结按钮**」，而运行上下文里有一个纯行为、零文案的强信号：**本轮已在本页成功落地了多少个字段写入**。导出轨迹里这个数是 25；一次普通搜索是 1。这个信号今天完全没有被使用。

## 3. 目标与非目标

**目标**：在不动文案启发式的前提下，让「批量填写后的提交性点击」也逐次请求用户确认，覆盖 click 与 fill_form(submit) 两条路径。

**非目标**：

- 不做按钮文案/语义识别（Spec-0005 边界不动）；
- 不改 `browser_press_key` 的 Enter 隐式提交判定（`decideEnterSubmitIntent` 仍只认结构；无 form 页面的 Enter 提交仍是缺口，见 §7）；
- 不做跨轮（跨 run）的填写计数（见 §7）；
- 不改确认闸门「逐次询问、绝不缓存」的既有语义。

## 4. 设计：一条行为规则

### 4.1 判定谓词

在现有结构判定之后追加一层。当 `browser_click`（单目标）或 `browser_fill_form`（带 `submit`）的目标**未**被结构判定为提交，且满足以下全部条件时，按 `confirm_always` 请求确认：

1. **单目标**：click 带 `fieldId`/`selector` 单点，或 fill_form 的 `submit` 目标。批量 `fieldIds` 天然免疫——它本来就不接受提交目标，且探针载荷不带计数（见 4.4）。
2. **目标是按钮类元素**（纯结构，不看文案）：
   - fieldId 路径：句柄 `kind ∈ {submit, button}`；
   - selector 路径：探针 `tag === 'button'`，或 `tag === 'input' && type ∈ {submit, button, image}`，或 `role === 'button'`（`ProbeClickOutput` 需补一个 `role` 字段）。
   - 排除：链接（`kind === 'link'` / `<a>`）、一切可写字段（text/textarea/select/checkbox/radio/contenteditable）、可滚动容器——点击它们是填写行为，不是提交。
3. **本轮填写活动达到阈值**：`landedFieldWrites ≥ FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES`（= 3，见 4.3）。

> **为什么句柄 `kind === 'submit'` 不能单独触发**：`resolveFieldKind` 把无 type 的裸 `<button>` 也归为 submit（HTML 缺省 type 即 submit）。React 站点上大量普通动作按钮（开弹窗、切换标签）就是这种裸按钮，且都不挂 form。若 kind=submit 即确认，无填写时点任何裸按钮都会弹卡——正是 form-submit.ts 头部注释警告的信噪比灾难。把它并进按钮类集合、由填写活动阈值把门，行为可预期：**「先批量填、再点按钮」才问**。

### 4.2 填写活动计数（landedFieldWrites）

口径：**本轮运行中，在目标标签页上成功落地的可写字段写入个数**。只数「真的写进页面并被回读确认」的：

| 来源 | 计数 |
|---|---|
| `browser_fill_form` | `outcomes` 里 `status === 'ok'` 且非 `pendingSelection` 的个数（待选定 = 没落地） |
| `browser_type` | 结果 `status === 'ok'` 且非 `pendingSelection` 记 1 |
| `browser_select` | 结果 `status === 'ok'` 记 1 |
| `browser_click`（单点，fieldId 路径） | `status === 'ok'` 且句柄 `kind` 为可写字段时记 1 |
| `browser_click`（批量 `fieldIds`） | `outcomes` 里 `ok` 且句柄 `kind` 为可写字段的个数（答题页逐个点选项是 FORM_WORKFLOW 规则 6 鼓励的合法路径，必须计入） |

为此 `ClickElementResult` 与 `BatchClickOutcome` 需补 `kind?: FormFieldKind`（background 侧查句柄表即得，selector 兜底路径无句柄则缺省、不计数——宁少不多的方向是安全的）。

作用域与生命周期：

- **按 tab 计数**（`Map<tabId, …>`，agent.ts 运行闭包内），写操作落在哪个 tab 就记在哪个 tab；
- **地址一变即清零**：挂接 afterToolCall 里现成的 `lastKnownUrl` 更新点（`NAVIGATION_WATCH_TOOLS` 分支与 navigate/open_tab/go_back 分支），URL 变了说明换了页面，旧计数没有意义。同地址下的 SPA 软转场**保留**计数——wj.qq.com「填完 → 提交」正是同地址，这是要覆盖的场景；
- **只看当前 run**：每轮从 0 开始。上一轮「把表单填了」、这一轮「提交」不会被计数，但那时提交指令来自用户本人，风险性质不同（见 §7）；
- **fill_form 自带的字段计入本次探测**：探针是执行前发出的，`fill_form(N 字段, submit)` 的 N 还没落地，计数取 `已跟踪数 + args.fields.length`（敏感字段此刻尚不可知，属上界，接受）。

### 4.3 阈值常量

`FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES = 3`，与谓词一起放 `form-submit.ts`（「这次点击会不会提交表单」的判定家族，唯一常量，遵守一限一常量规则）。

阈值两侧的实测画像：

- **≥3 命中**：问卷/考试（本轨迹 25）、注册表单、多字段设置页 + 保存。
- **<3 放行**：搜索框 + 搜索按钮（1）、聊天输入 + 发送（1）、登录（用户名 1 + 密码被 sensitive 拦掉不落地）、1–2 项筛选 + 应用。
- **灰区（假阳性）**：3 项筛选 + 「应用」、向导式表单每步「下一步」。注意结构判定**今天**就会对带 form 的向导每步 type=submit 逐次确认——新规则只是把同样的行为延伸到无 form 页面，不产生新的不对称。

### 4.4 数据流

沿用现有探针通道，不新增消息类型：

1. `agent.ts` 运行闭包维护计数（4.2），`buildSubmitIntentProbePayload` 为 click / fill_form 两个分支附上 `landedFieldWrites`（fill_form 加上本次 `args.fields.length`）；
2. `messaging.ts`：`ProbeClickTargetPayload` += `landedFieldWrites?: number`；
3. `background.ts` `probeSubmitIntent`：结构判定为否、且探针确实找到了单目标时，调用新的纯函数 `decideFormlessCommitIntent({ tag, type, role, kind, landedFieldWrites })`（`form-submit.ts`），命中则在 `ProbeClickTargetResult` 上带回 `commitConfirm: { landedFieldWrites }`；
4. `permissions.ts`：`ToolWriteIntent` += `commitConfirm`；闸门里 `intent.isSubmit || intent.commitConfirm` 走 `always = true`，两种来源用不同的 reason 文案；`ConfirmFn` 签名加第 5 个参数 `kind: 'submit' | 'commit'`，经 `resolveConfirmGate` 透传；
5. `run-registry.ts` `onConfirm`：`kind === 'commit'` 时写入 `PendingConfirmation.kind = 'commit'`（复用现有字段与应答通道，不加新快照字段）；
6. 面板 `ConfirmationCard` 按 `kind` 分支渲染新文案。

批量点击免疫的实现事实：`clickElementsByFieldIds` 内部调 `probeSubmitIntent({ submitFieldId })` 时不带计数，谓词自然不触发。

### 4.5 确认卡片：诚实的文案

结构判定和新规则的可信度不同，卡片不能共用「表单提交」的说法。`PendingConfirmation.kind` 增加 `'commit'` 值（缺省仍按 `'submit'` 兼容旧快照）：

- 标题：`🔒 请确认此次点击`（en: `🔒 Confirm this click`）
- 批准按钮：`允许点击`（en: `Allow click`）；拒绝按钮沿用「拒绝」
- 提示行：`本轮已批量填写表单字段；这类按钮点击可能提交或终结表单，因此逐次确认。`
- 摘要（confirm-summary.ts，`landedFieldWrites` 随 label 一样注入确认副本）：
  - click：`AI 已在本页填写 N 个字段，现在想要点击「X」——这一步可能会提交或终结表单。`
  - fill_form：沿用现有字段清单，尾部 `，并提交表单到 …` 换成 `，随后点击「X」——这一步可能会提交或终结表单`

模型侧文案：闸门 reason `该操作可能提交或终结表单（本轮已批量填写字段），需要单独确认。`；拒绝后的 block reason `用户拒绝了这次点击。`

## 5. 系统提示词

`system-prompt.ts` 151 行「只有检测到的表单提交会触发用户确认」微调为涵盖推断提交（「检测到或按运行上下文推断的表单提交」），避免模型在被拦下时对原因产生错误归因。权限实现不依赖这句提示词，改动只为模型心智一致。

## 6. 已知代价

- **假阳性多一次确认**：3+ 字段填写后的非提交按钮点击（筛选「应用」、设置「保存」）会弹卡。接受：卡片文案如实说明「可能」提交，且这类流程本身低频、一次批准即可继续。
- **计数是近似**：URL 不变的 SPA 整页改写不清零（多计，方向安全）；selector 兜底点击写的字段不计数（少计）；跨轮、Enter 路径不覆盖（见 §7）。
- **向导式无 form 表单每步都问**：与带 form 向导的现状对齐，不新增不对称。

## 7. 剩余缺口（记录，不在本次范围）

1. **Enter 提交**：`decideEnterSubmitIntent` 仍只认结构。无 form 页面聚焦文本框按 Enter 触发的页面自有提交逻辑不受闸门保护。
2. **跨轮计数**：用户分两轮说「填表」「提交」时，提交轮计数为 0。此时提交指令出自用户本人，风险性质不同于本轮自决；若日后要覆盖，计数需挂在 run-registry 的 per-tab 状态上跨 run 存续。
3. **文案判定**：明确不做（Spec-0005 边界）。

## 8. 测试计划

- `form-submit.test.ts`：`decideFormlessCommitIntent` 全分支（阈值边界 2/3、按钮类集合、链接/字段/滚动容器排除、kind 缺省的 selector 路径、role=button）；`FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES` 单一来源。
- `permissions.test.ts`：`commitConfirm` 走 always 路径且 `kind='commit'` 传出；结构提交行为不变（kind='submit'）；拒绝后的 block reason；批量 fieldIds 不探测。
- `agent.test.ts`：计数口径（fill_form outcomes 过滤 pendingSelection、type/select ok、单点/批量点击按 kind 计入）、URL 变化清零、探针载荷带计数（fill_form 加 args.fields.length）。
- `confirm-summary.test.ts`：两种新摘要文案与字段数展示。
- `run-port-protocol` / 面板：`kind: 'commit'` 快照往返；`ConfirmationCard` 新文案渲染（ui project）。
- `i18n`：新增 key 的 zh/en 对齐（i18n.test.ts 既有校验）。
- 回归确认：`final-review.test.ts`、`brand-*.test.ts` 不受影响；`injected-functions.dom.test.ts` 的 INJECTED 清单已含 `probeClickTarget`，输出加 `role` 字段不改变清单。
