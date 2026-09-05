# 工具扩展设计：browser_go_back 与 browser_find_text

- 日期：2026-09-04
- 来源：2026-09-04 对 30 个工具做能力盘点后识别出的两处低成本缺口。iframe 寻址那一项体量大得多，单独立篇（`2026-09-04-iframe-addressing-design.md`）
- 状态：已实现（未做真实浏览器验收——见 lib/agent/find-text-dom.dom.test.ts / lib/agent/history-nav.test.ts 的单测覆盖范围）
- 依赖：`browser_find_text` 的句柄要带 `frameId`，因此排在 iframe 那篇之后实现

## 1. 问题

### 1.1 没有历史导航

`MessageType` 里与导航相关的只有 `NAVIGATE_TAB` / `OPEN_NEW_TAB` / `CLOSE_TAB`，全都要求一个明确的 URL。没有后退。

多步任务里"从列表页进详情页、看完回列表页继续下一个"是最常见的结构之一。今天模型只能记住列表页 URL 再 `browser_navigate` 回去——这会丢掉滚动位置、已展开的筛选、已填的表单状态，而且模型经常根本没有记住那个 URL（列表页可能是 POST 结果或 SPA 路由）。失败模式是模型在详情页里打转，或者退回首页重新走一遍流程。

### 1.2 按可见文字定位元素只能靠猜

CSS 选择器选不了文本内容。因此"找到写着 X 的那个元素"今天有两条路：

- `browser_get_form`——但它只收控件（可写字段、链接、按钮、`role`/`tabindex` 驱动的自定义控件），非交互的内容节点完全不在其中；
- `browser_query_dom` + 模型手写一个选择器猜——猜不中就再猜，每一轮都是一次完整的 LLM 往返。

真正的空白是**非交互的内容节点**："总计那一行的金额是多少"、"找到写着'已发货'的状态标签"、"页面上那个红色的错误提示写了什么"。`browser_read_page` 能拿到全文，但 Readability 会丢表格和零散的 UI 文本，而且从一大段文字里定位"哪个数字挨着哪个标签"本身就不可靠。

按内存里的侧边栏耗时实测，LLM 往返占端到端耗时约 96%，减少轮数是唯一有效的提速杠杆——"猜选择器"正是最典型的多轮消耗。

## 2. 目标 / 非目标

**目标：**

- 新增 `browser_go_back`，走 `chrome.tabs.goBack`，等导航落定后如实回报落地 URL。
- 新增 `browser_find_text`，按可见文字定位元素并发放可直接用于 `browser_click` / `browser_scroll` 的句柄，同时回带一小段上下文，让"定位 + 读取"在一次调用里完成。
- 两者都不新增 manifest 权限（`tabs` 与 `scripting` 已有），不放松 Deny-First 策略。

**非目标：**

- 不做 `browser_go_forward`（理由见 §3.1）。
- 不做正则或 XPath 匹配。文本匹配只支持归一化 contains 与 exact 两档；把正则交给模型会带来灾难性回溯与难以解释的空结果。
- `browser_find_text` 不做"点击第一个匹配"这类复合动作。定位与操作分开，否则模型无法在两者之间检查自己找对了没有——那正是写操作可验证性原则要保住的东西。

## 3. browser_go_back

### 3.1 只做后退

`browser_go_forward` 只在刚刚后退过之后才有意义，而那种情况下模型可以直接 `browser_navigate` 回原 URL。加一个方向参数是将来一行的事，现在不加。

### 3.2 走 tabs.goBack，不注入 history.back()

新增 `MessageType: 'NAVIGATE_HISTORY'`，background 调用 `browser.tabs.goBack(tabId)`。

不选注入 `history.back()` 的理由：它要走 `scripting`、会被页面自己的 `beforeunload` 或 history 劫持拦住，而且拿不到"这个标签页根本没有历史记录"这个信号——`tabs.goBack` 在无历史可退时会失败，正好把它转成一条明确的结果文案（实现时以实际的错误文案为准，不要按猜测的字符串匹配）。

`tabId` 照例是显式参数（回合钉住的目标标签页），不做"当前活动标签页"的隐式查找。

### 3.3 分级与边界

进 `AUTO_APPROVE_TOOL_NAMES`——它改变浏览器状态，是写工具，因此执行遮罩、接管闸门、写预算全部自动生效。

`browser_navigate` 的 http(s) 硬限制在这里无从施加：后退的目标由历史记录决定，可能是 `chrome://`、`file://` 或扩展页。**这不构成安全漏洞**——那些页面本来就注入不进去，`executeScript` 会被浏览器直接拒绝，读不到任何东西。但它会让后续每个页面工具连环报错，模型看不懂为什么。

因此结果文案必须回报落地后的 URL，并在它不是 http(s) 时明说"已退回到扩展无法操作的页面，请改用其他方式继续"。这属于 `action-result-text.ts` 的职责范围：给下一轮足够的信号，让模型停止盲目重试。

### 3.4 必须等导航落定再回报

`tabs.goBack` 立即 resolve，此时 URL 还没有变。直接读 `tabs.get` 会拿到旧页面，回报给模型的就是一句假话。

复用 `background.ts:1319` 的 `waitForCondition` 那套写法：监听 `tabs.onUpdated` 等 `status === 'complete'`，外加一个 guard timeout。等到了就读 URL/title 回报；超时就如实回报"已触发后退，但未在 N 秒内完成加载"，**不猜**。这与 `waitForCondition` 把基础设施失败收敛成"没等到"而不是整轮报错的处理是同一档。

### 3.5 句柄表不需要手动清

`FormFieldTable` 存了发放句柄时的主框架 `url`，写入前比对不符即判整表过期。后退换了 URL，这套机制自动生效，不需要在导航路径上额外挂清理逻辑。

## 4. browser_find_text

### 4.1 定位：找内容，不是找控件

`browser_get_form` 找控件，`browser_find_text` 找内容。两个工具的 description 必须这样明确区分，否则模型会在"点这个按钮"的场景里滥用 `find_text`——那条路上 `get_form` 的句柄已经带了写入前后的结构校验，绕开它是净损失。

description 里要写明：目标是可点击控件时用 `browser_get_form`；目标是页面上的一段文字、一个状态标签、一个数值时用本工具。

### 4.2 匹配语义

参数：

- `text`：要找的文字。
- `mode`：`contains`（默认）或 `exact`。
- `limit`：最多返回几条，默认 10，上限 20。

匹配前对候选元素的文本做空白归一化（连续空白压成单空格、首尾去空白），比对大小写不敏感。

**只取最深的匹配元素。** 不做这一步，`<body>` 会匹配页面上的任何文字，返回结果里全是祖先容器。判定方式：一个元素只有在它的**任何子元素都不匹配**时才成为候选。

不支持正则和 XPath：正则会带来灾难性回溯，且模型写错时返回空结果，无从解释自己错在哪。

### 4.3 返回形态

每条匹配返回：

| 字段 | 用途 |
|---|---|
| `fieldId` | 可直接交给 `browser_click` / `browser_scroll` 的句柄 |
| `tag` | 判断这是标题、单元格还是按钮 |
| `text` | 归一化后的匹配文本，截断 |
| `visible` | 隐藏元素也返回，但标记出来——模型需要知道"找到了但看不见" |
| `clickable` | 与 `CLICKABLE_KINDS` 同口径 |
| `context` | 父元素的文本，归一化并截断（建议 200 字符） |

`context` 是让这个工具同时成为精准读取器的那一半：「找 `总计`」直接回带 `总计 ¥1,280.00`，"定位→再读一次"两轮变一轮。这正对着 §1.2 里那条"减少轮数是唯一提速杠杆"。

文本一律走 `sanitizeFieldText` 与脱敏管线，与其他文本类工具结果一致。

### 4.4 句柄表怎么共存（唯一的结构性决策）

`browser_find_text` 发放 `t*` 前缀的 id（`t1`、`t2`…），与 `browser_get_form` 的 `f*` 不冲突，并**并入**现有的 `FormFieldTable.fields`。

`browser_get_form` 保持现在的整表覆写语义不变。因此一次新的 `get_form` 会顺带丢掉之前的 `t*` 句柄——**这是正确行为而不是 bug**：重新采集意味着模型认为页面状态已经变了，此时旧的文本句柄同样不该继续被信任。

这个先后语义必须写进 `tab-form-fields.ts` 的注释，否则将来读到"我的 t3 怎么没了"的人会把它当缺陷修掉。

`t*` 句柄与 `f*` 走完全相同的写入前校验：`expect` 结构比对、URL 比对、（iframe 篇落地后）`frameOrigin` 比对。`find_text` 不是一条绕开校验的捷径。

### 4.5 分级与 frame

只读，进 `READ_ONLY_TOOL_NAMES`。

采集走 `executeScript`，因此在 iframe 篇落地后天然要处理多帧：复用那边的 `allFrames` 注入与 `scope` 分流，发放的句柄带 `frameId` / `frameOrigin`。子帧的文本匹配不做窄采集限制——`find_text` 本来就是按关键词过滤的，命中量天然可控，`limit` 兜底。

## 5. 测试

| 测试 | 位置 | 钉住的行为 |
|---|---|---|
| 归一化与 contains/exact | `find-text.test.ts`（纯函数） | 空白压缩、大小写不敏感、exact 不误命中 |
| 最深匹配 | `find-text.dom.test.ts` | 祖先容器不进结果 |
| limit 截断 | `find-text.test.ts` | 超限时的截断与旁注 |
| `t*` / `f*` 共存 | `tab-form-fields.test.ts` | find_text 并入、get_form 覆写丢弃 `t*` |
| 后退等待落定 | `history-nav.test.ts` | complete 后回报新 URL；超时回报"未完成"而不猜 |
| 非 http(s) 落地 | `history-nav.test.ts` | 结果文案明示扩展无法操作该页面 |

匹配与归一化的纯逻辑放 `lib/agent/find-text.ts`，注入页面的采集函数放 `lib/agent/find-text-dom.ts`，遵守 `form-dom.ts` / `wait-dom.ts` 的同款约束：**被 `executeScript` 序列化，不得引用任何模块作用域的东西**。后退的等待编排放 `lib/agent/history-nav.ts`，把 background 留作 I/O。

## 6. 影响文件

| 文件 | 改动 |
|---|---|
| `lib/messaging.ts` | 新增 `NAVIGATE_HISTORY` / `FIND_TEXT` 及其 payload/result |
| `entrypoints/background.ts` | 两个 handler，I/O 编排 |
| `lib/agent/history-nav.ts` | 新增：后退的等待落定与结果文案 |
| `lib/agent/find-text.ts` | 新增：归一化、匹配、截断的纯函数 |
| `lib/agent/find-text-dom.ts` | 新增：注入页面的采集函数 |
| `lib/agent/tools.ts` | 注册两个工具 |
| `lib/agent/permissions.ts` | `browser_go_back` 进 `AUTO_APPROVE_TOOL_NAMES`；`browser_find_text` 进 `READ_ONLY_TOOL_NAMES` |
| `lib/agent/tab-form-fields.ts` | `t*` / `f*` 共存语义的注释 |
| `lib/agent/action-result-text.ts` | 后退的结果文案 |
| `lib/agent/system-prompt.ts` | 说明两个工具各自的适用场景 |
