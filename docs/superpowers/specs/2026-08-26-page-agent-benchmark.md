# 对标 alibaba/page-agent · 结论与待办

- 首次走读：2026-08-26；**第二轮复核：2026-08-28**
- 来源：`github.com/alibaba/page-agent` 的 `packages/core`、`packages/page-controller`、`packages/llms`、`packages/extension`、`packages/ui`
- 版本：package.json version **1.12.2**，最新提交 `d02db1e`（2026-08-10）——距首轮走读**对方无版本变化**，第二轮更新的是我方进度，以及首轮漏掉的发现（条目标注「第二轮新增」）
- 状态：**进度追踪文档**——按下方优先级逐项实施，每完成一项就在本文件里勾掉并记录落地位置

## 用法（给以后重开窗口的自己）

这份文档不是一次性交付物，是一个跨会话的待办清单。规则：

1. 挑一项开始做之前，按项目 docs-first 流程在 `docs/superpowers/specs/` / `docs/superpowers/plans/` 下建这一项自己的设计说明 + 实施计划（参考 `2026-08-25-execution-overlay-design.md` 的格式）。
2. 做完后回到本文件，把对应的 `- [ ]` 改成 `- [x]`，并在条目下补一行「落地：链接到 spec/plan 或 commit」。
3. 不要跳过 spec/plan 直接改代码——这是本项目的既定约定，不是本文档新加的规则。

## 一、定位差异（背景，不是待办）

| | page-agent (alibaba) | Runi |
|---|---|---|
| 形态 | npm SDK（一行 script 嵌进任意网页）+ 可选扩展 + MCP hub | 纯 MV3 扩展 + 侧边栏 |
| 交互模型 | `execute(task)` 一次性任务，ReAct 循环跑到 `done`（maxSteps 40） | 流式对话助手，逐轮工具调用 |
| 页面表示 | browser-use 式「带序号的简化 DOM 树」，全页扁平化成一段文本 | Readability 正文 + `browser_get_form` 结构化字段表 |
| 可交互性判定 | 计算样式 `cursor` 为主 + 事件监听器 + 属性/class 兜底 | 标签名 / `role` / `tabindex` / `href` |
| 单步动作数 | 每步**一个** action（MacroTool 参数里的 union） | 标准 tool calling，可并行多调用 |
| 上下文策略 | 每步重建 prompt，历史只保留 `evaluation/memory/next_goal` 三行摘要 | 保留最近 24 条原始消息 + 结果截断 |
| 权限 | 完全没有确认门，跑起来就一路点 | Deny-First + 每回合确认 + 表单提交每次必问 |
| 写入校验 | 只看 DOM 事件是否派发成功 | 写前写后指纹 + 回读校验 |
| 代码规模 | `packages/` 约 9k 行 TS（另有 1.7k 行移植自 browser-use 的 `buildDomTree`） | `lib/` + `entrypoints/` 约 27k 行，含成套单测 |

两个产品不是同一个东西：它对标 browser-use 的浏览器内实现，Runi 是 side-panel copilot。下面待办只挑在 Runi 形态里成立的部分。

## 二、已经借鉴过 / 已有等价能力（不重复投入）

- `<sys>` 观察式软提醒 → `lib/agent/tool-policy.ts` 的 `BUDGET_WARNING_THRESHOLDS`
- `isNew` 新元素标记 → `lib/agent/form-dom.ts` 的 `isNew` 字段
- 模拟光标 + 执行期遮罩 + 完整 pointer 事件序列 + `elementFromPoint` 遮挡检测 → `lib/agent/agent-overlay.ts`（`docs/superpowers/specs/2026-08-25-execution-overlay-design.md`）
- 弱模型 tool call 修复 → `lib/agent/tool-call-repair.ts`（比它的 `autoFixer.ts` 更干净）
- `ask_user` / `wait` 工具 → `lib/agent/tools.ts` 已有同名工具，且都归在 `READ_ONLY_TOOL_NAMES`
- contenteditable 双方案写入（先合成 `beforeinput`/`input` 事件，回读不符再降级 `execCommand`）→ `lib/agent/form-dom.ts:515-533`，与它 `actions.ts` 的 Plan A / Plan B 是同一套做法
- 自身 UI 不被采集 → 它靠 `data-page-agent-ignore` 黑名单，我们靠 `attachShadow({ mode: 'closed' })`（`agent-overlay.ts:110`）。我们这条更彻底：`collectFormFields` 只穿透 open shadow root，闭合的根天然进不去

## 三、待办（按性价比排序）

### [ ] P0 — 按模型/厂商打请求参数补丁

**是什么**：`packages/llms/src/utils.ts:39` 的 `modelPatch()`：Qwen 关 `enable_thinking`、DeepSeek 删 `tool_choice`、MiniMax 删 `parallel_tool_calls`、Kimi K3 把具名 tool_choice 降级成 `required`、Claude 把 `tool_choice` 转成 `{type:'tool',name}`、OpenRouter 用 `reasoning:{enabled}` 而非 `reasoning_effort`；配套 `normalizeModelName()` 把 `openai/gpt-5.2-chat` / `GPT-52-date` 归一成 `gpt-52`。

**为什么**：Runi 的卖点是「自带 key、任意 OpenAI 兼容端点」，`lib/agent/agent.ts:103` 目前只有一个 `thinkingLevel: 'off'`。接第三方中转或本地模型（Qwen/GLM/Ollama）时，这些厂商差异会直接表现成「工具永远调不起来」，用户只会归因于扩展本身。它 1.11.0 一整个版本就是在重写这套补丁（见 `docs/CHANGELOG.md`），说明这是真实踩出来的坑，不是过度设计。

**怎么做**：在 `lib/agent/openai-stream.ts` 请求体组装处加一层纯函数 `patchRequestBody(body, baseURL)`，按 `resolveProviderApi` 已有的 provider 识别逻辑扩展，不碰 Anthropic Messages 协议那一路。

- [ ] 未开始

### [ ] P0 — `cursor: pointer` 作为可交互性信号（第二轮新增）

**是什么**：`dom_tree/index.js:695` 留了一句原作者注释：「一开始我们也试过事件监听器和各种花哨的 class/style 判断——**实际最有效的是把大部分东西和计算出来的 cursor 样式结合起来**」。它的 `isInteractiveElement()` 因此以 `getComputedStyle(el).cursor` 命中一张 interactive 光标白名单（`pointer` 等）为主信号，再叠加 `getEventListeners` / `onclick` 属性 / 交互类名兜底，并用一张 non-interactive 光标黑名单（`not-allowed` 等）排除禁用态。

**为什么**：这是两边**可交互元素召回率**上唯一的实质差距。我们的 `isFieldTag`（`form-dom.ts:96`）只认 `input/textarea/select/button` + `contenteditable` + 带 `href` 的 `a` + 7 个 `role` + 显式 `tabindex`。现代 SPA 里大量「卡片、列表行、图标按钮」是裸 `<div onClick={...}>`，既无 role 也无 tabindex——这些元素 `browser_get_form` **一个都收不到**，模型只能退回手写 CSS 选择器，恰恰是系统提示词 `FORM_WORKFLOW` 第 2 条明令禁止的路径。加一条 `cursor` 判定，召回率提升是数量级的。

**成本要算清楚**：`isVisible()`（`form-dom.ts:119`）确实已经在调 `getComputedStyle`，但它在 `describe()` 里、即**过滤通过之后**才跑；而 `collectFormFields` 的 `walk(scope)`（`form-dom.ts:258`）会遍历 `document.body` 下的每个元素。所以加 cursor 判定 = 整趟遍历里每个元素多一次 `getComputedStyle`（强制样式解算），重页面上是几千次。缓解办法：把廉价判定（tagName / role / tabindex）排在前面短路，只有落到最后的元素才读 `cursor`。输出规模这边不用担心——`genericFieldQuota = maxFields / 2`（`form-dom.ts:52`）已经把非标准字段的数量卡在一半预算内，正好是这类元素需要的闸门。

**注意反向风险**：它需要 `patches/react.ts` 的 `patchReact()`（给 `#root` / `#app` 打 `data-page-agent-not-interactive`）来压制误报，因为 React 常把事件委托挂在根节点上。我们如果只取 `cursor` 信号、不取 `getEventListeners` 信号，就基本不吃这个亏——根容器一般不是 `cursor: pointer`。仍建议加一条「不收整页尺寸元素」的护栏，并复用 `permissions.ts` 已有的 `isRootContainerSelector` 思路。

**怎么做**：`form-dom.ts` 的 `isFieldTag` 增加 `cursor` 判定；`FormFieldDescriptor` 增一个来源标记（例如 `byCursor: true`），便于观察召回质量、必要时快速回退。

- [x] 已完成——设计：`docs/superpowers/specs/2026-08-28-form-recall-and-token-budget-design.md`，实施计划：`docs/superpowers/plans/2026-08-28-form-recall-and-token-budget.md`（7 个任务全部落地，`pnpm compile`/`pnpm test`（1089/1089）/`pnpm build` 均通过；子智能体驱动开发流程执行，commit 范围 `3e9b7a2..64745b3`）。`classifyInteractive` 以 computed `cursor` 为兜底信号，前置廉价的标签/role/tabindex 短路；配套两条护栏（html/body 永不因 cursor 入选、近乎全屏元素跳过）与祖先抑制（cursor 命中的后代若已有祖先被收录则不重复发句柄）。实施过程中发现并修复了护栏本身的两处继承缺口（shadow 边界穿越、body/html 页面级 cursor 未登记进抑制集合），已在 review 中独立验证。已知遗留（未阻塞合并）：祖先抑制的登记时机与 shadow 递归顺序冲突，导致「cursor 命中的宿主 + 其 open shadow root 内的 cursor 命中后代」这一组合未被抑制（已在代码注释中标注，纯 light DOM 场景不受影响）；人工浏览器冒烟测试（本条目原定的验收要求）经用户明确决定本次跳过，未执行。

### [x] P0 — 多标签页编排

**是什么**：`packages/extension/src/agent/tabTools.ts`（`open_new_tab` / `switch_to_tab` / `close_tab`）+ `TabsController.ts`（`summarizeTabs()` 每步在浏览器状态头部注入一张 Tab ID/URL/Title/Status/当前✅ 的 markdown 表，`syncTabs()` + `waitUntilTabLoaded()`，agent 开的标签页收进独立 tab group 做视觉隔离）。

**为什么**：Runi 现在只有 `browser_get_active_tab` + 原地 `NAVIGATE_TAB`，任何「搜一下 → 打开第 3 条结果 → 回来填表」的任务都做不了。

**怎么做**：复用现有的 `tab-target.ts` / `tab-conversation.ts` 按 tab 隔离基础设施。新开/关闭标签页是写操作，需要进 `permissions.ts` 的 `CONFIRM_TOOL_NAMES`。

- [x] 已完成 — 设计：`docs/superpowers/specs/2026-08-26-multi-tab-orchestration-design.md`，实施计划：`docs/superpowers/plans/2026-08-26-multi-tab-orchestration.md`（8 个任务全部落地，`pnpm compile`/`pnpm test`/`pnpm build` 均通过；手动浏览器多标签页冒烟测试未在本次实施会话中执行，需要在实际加载扩展后人工验证一遍）

### [ ] P1 — 工具结果的 token 成本（第二轮新增）

**是什么**：对比两边送进模型上下文的页面表示：

- 它：一行一个元素，形如 `[12]<button aria-label=提交>提交</button>`，约 15-25 token。序列化时（`dom/index.ts:flatTreeToString`）还做了四件降噪：属性值超 5 字符的做去重、`role` 与 tagName 相同就删、`aria-label`/`placeholder`/`title` 与可见文本相同就删、所有属性值截断到 20 字符。
- 我们：`formatJson()`（`tools.ts:842`）把整个 `GetFormResult` 用 `JSON.stringify(value, null, 2)` 原样吐出。`FormFieldDescriptor`（`lib/messaging.ts:364`）有 20+ 个键，两格缩进，每个字段十几行。

**为什么**：其中 `fingerprint` 是**纯浪费**——那是给我们写入校验层用的哈希，模型永远用不到它，却每个字段都占一份；`writable`/`clickable`/`valueState`/`formId` 也大多能从 `kind` 推出来。一个几十字段的后台表单页，我们要烧掉数千 token 才换来它一两千 token 的等价信息。这既直接吃掉 `MAX_CONTEXT_MESSAGES = 24` 的窗口（越早触发压缩，越早丢历史），也直接抬高每一轮的成本——对「自带 key、可能接便宜模型」的定位尤其不划算。

**怎么做**：给 `browser_get_form` 的结果加一层「面向模型的渲染」，结构化数据仍原样留在 `textResult` 的第二个参数里供 UI 使用：白名单式挑键、省略等于默认值的项（`required: false` 之类不输出）、`fingerprint` 完全不进 LLM 文本、可选地改成一行一字段的紧凑写法。这一项风险低、可测（现成的 `form-tools.test.ts`）、收益立即可见。

- [x] 已完成——设计：`docs/superpowers/specs/2026-08-28-form-recall-and-token-budget-design.md`，实施计划：`docs/superpowers/plans/2026-08-28-form-recall-and-token-budget.md`（与上一条「cursor 召回」合并实施，同一份计划、同一次会话，commit 范围 `3e9b7a2..8d3b33b` 覆盖紧凑渲染部分）。新增纯函数模块 `lib/agent/form-render.ts`：`renderFieldLine`/`renderFormResultForModel` 按「等于默认值的项不输出」渲染一行一元素的紧凑文本，`fingerprint` 永不进入模型文本（有专门测试锁定），`makeGetFormTool` 的结构化数据参数保持不变。按设计要求，先完成本项紧凑渲染、再做 cursor 召回，避免召回提升前先放大 token 成本。

### [ ] P1 — 按站点的持久指令 + `llms.txt`

**是什么**：`PageAgentCore.ts:492` 的 `instructions.getPageInstructions(url)`（按 URL 注入领域知识）+ `experimentalLlmsTxt`（抓站点 `llms.txt` 塞进 prompt）。

**为什么**：与 `lib/shortcuts.ts`（已有 `scope: page | selection | none`）同构，扩展成「按域名保存的常驻指令」几乎顺手。用户在自家 ERP/CRM 上教一次，之后每次都记得——这是拉开体验差距的功能，且在扩展形态下（用户自配）比 SDK 形态下（站点主人配）更有价值。

**怎么做**：新增按域名存储的指令表（`chrome.storage.local`，参照 `shortcuts.ts` 的结构），在 `system-prompt.ts` 组装时按当前 tab URL 查表注入。**注意**：用户自己写的指令可以进系统提示词，但站点提供的 `llms.txt` 是站点可控的不可信内容，必须走和页面正文同一条 untrusted 通道，不能当成系统指令——它那边是 SDK 形态（站点主人自己配自己的站），我们是扩展形态（用户在别人的站上跑），威胁模型不同。

- [ ] 未开始

### [x] P1 — 页面位置感 + 容器内滚动

**是什么**：`dom/getPageInfo.ts` 每步给模型一行视口尺寸/总页高/上下方还有几屏/当前处在 x%；可滚动容器标成 `data-scrollable="top=...,bottom=..."`；`scroll(index)` 能滚指定容器（`actions.ts:275` 沿祖先链找最近可滚动祖先）。

**为什么**：`SCROLL_PAGE` 目前只有 window 滚动 + `scrollIntoView(selector)`，返回值要滚完才知道结果。后台管理系统、聊天记录、虚拟列表这类「内层 overflow 面板」现在基本滚不动。

**怎么做**：`browser_get_form` 采集时顺手收集可滚动容器（它已经在遍历 DOM），`browser_scroll` 支持按 `fieldId`/selector 滚容器而非只滚 window。

- [x] 已完成——设计：`docs/superpowers/specs/2026-08-27-scroll-position-awareness-design.md`，实施计划：`docs/superpowers/plans/2026-08-27-scroll-position-awareness.md`（9 个任务全部落地，`pnpm compile`/`pnpm test`/`pnpm build` 均通过，1027/1027 测试；子智能体驱动开发流程执行，每任务独立评审 + 全分支终审，终审发现的 4 处跨任务问题已在一轮修复中处理；已合并到 main，commit 范围 `e0ca3be..1ae4e19`）。已知遗留（未阻塞合并，见 SDD 终审记录）：`s{n}` 容器句柄会在任意写操作后被 `collectNewFieldsAfterWrite` 静默丢弃（已修正错误提示文案指向 `includeScrollable: true`，但未实现句柄跨写操作续存，留作后续跟进）；`browser_get_form(includeScrollable)` 尚未做人工浏览器冒烟测试。

### [x] P2 — 统一的页面快照工具（小范围验证已完成，暂不上完整树表示）

**是什么**：一次调用拿到「带缩进的树 + `[n]` 序号可交互元素 + 穿插纯文本」，模型一眼看出页面长什么样、能点什么、层级关系如何。

**为什么**：Runi 现在 `browser_read_page`（正文）与 `browser_get_form`（字段）两次调用之间没有位置/层级关联——模型知道有个「提交」按钮，但不知道它在哪个区块里。

**怎么做**：改造量大，先做小范围验证：给 `browser_get_form` 加一个 `includeText: true` 选项，把正文按 DOM 顺序穿插进字段列表，验证收益后再决定要不要上完整的树表示。

- [x] 已完成——设计：`docs/superpowers/specs/2026-08-26-form-include-text-design.md`，实施计划：`docs/superpowers/plans/2026-08-26-form-include-text.md`（4 个任务全部落地并通过 `pnpm compile`/`pnpm test`/`pnpm build`，已合并到 main，commit 范围 `468c8fd..0ee13a0`）。人工验证结论：`precedingText` 确实有用——先不急着投入完整的 `[n]` 序号 + 缩进树表示，等后续再有明确信号时再开新的待办跟进。

### [ ] P2 — 用户接管检测

**是什么**：`types.ts:232` / `PageAgentCore.ts:623` 的 `user_takeover` 历史事件，检测到后往下一轮 prompt 塞 `<sys>User took over control and made changes to the page</sys>`。

**为什么**：`agent-overlay.ts` 全程 `pointer-events:none`（设计上刻意如此，见 `2026-08-25-execution-overlay-design.md` §3.1，比它的全遮挡阻断更对），但代价是用户中途点了什么、手动跳了页，agent 完全不知道，还在用过期的 `fieldId` 句柄操作。已有指纹校验兜底失败，但事前告知比事后失败体验更好。

**怎么做**：遮罩挂载期间在 content script 监听真实用户输入（`isTrusted: true` 的 click/keydown），发生后下一轮工具结果里追加一条系统观察。建议与下面「导航观察」合并成同一条系统观察通道一起做。

- [ ] 未开始

### [ ] P2 — 导航 / 页面变化的主动观察（第二轮新增）

**是什么**：`PageAgentCore.ts` 的 `#handleObservations` 每步比对 URL，变了就推一条 `<sys>Page navigated to → {url}</sys>` 并额外 `waitFor(0.5)` 等页面稳定；步与步之间还有固定 `stepDelay = 0.4s`。

**为什么**：我们目前是**被动**发现导航——模型拿着旧 `fieldId` 去写，撞上 `fieldsTableStale` 才知道页面换了，白烧一次工具预算，还得靠提示词反复教它「不要原样重试」。主动在下一次工具结果里说一句「页面已跳转到 X，句柄表已重置，请重新 `browser_get_form`」，比事后报错省一轮，也省掉一段提示词。

**怎么做**：`tab-session.ts` 已经在跟踪当前 tab；在工具执行前后比对 tab 的 url，变化时把观察拼进下一个工具结果的文本里，不需要新的消息类型。与上面「用户接管检测」共用同一条通道。

- [ ] 未开始

### [ ] P2 — 送模型前的正文脱敏

**是什么**：`transformPageContent(content)` 钩子，调用方可对页面正文做脱敏处理。

**为什么**：Runi 表单层做得更好（密码/支付字段在 `planFormFill` 阶段就丢弃，根本不到页面），但 `browser_read_page` 的**正文**是原样送出去的——邮箱、手机号、身份证号照样出境。作为隐私优先定位的扩展（provider 配置明确不上云同步），这块补上更自洽。

**怎么做**：在 `browser_read_page` 返回前加一层轻量正则脱敏（邮箱/手机号/身份证号模式），可配置开关。

- [ ] 未开始

### [x] P2 — 显式任务成败信号

**是什么**：`done(success, text)` 的 `success: boolean`，UI 直接据此显示成功/失败。

**为什么**：Runi 一轮结束就是一段文本，「任务没做成」和「任务做成了」在 UI 上没区别，历史记录里也没法筛选/统计。

- [x] 已完成（2026-08-27/28）——设计：`docs/superpowers/specs/2026-08-27-explicit-task-outcome-signal-design.md`，实施计划：`docs/superpowers/plans/2026-08-27-explicit-task-outcome-signal.md`。落地为 `report_task_outcome` 工具（`lib/agent/task-outcome.ts`）+ `ChatMessage.taskOutcome` 字段 + 侧边栏成败徽标，commit 范围 `6366770..663b3ec`。比它的做法更细：三态 `success/partial/failure`（不是布尔），且预算耗尽 / 连续被阻断的收尾分支会强制补调，不会因为工具预算被吃光就把成败信号一起丢掉。

### [ ] P3 — 反向暴露为 MCP Server（第二轮新增，战略性）

**是什么**：`packages/mcp` + `extension/src/entrypoints/hub/hub-ws.ts`。一个 Node 进程既是 MCP server（对 Claude Desktop / Cursor 走 stdio），又开一个 localhost WebSocket（默认 38401）；扩展里有个常驻「hub tab」连上去。对外只暴露三个工具：`execute_task(task)`（阻塞）、`get_status()`、`stop_task()`。

**为什么**：这是一个**定位**问题而不是功能问题。它把浏览器变成了别的 agent 的一只手——Claude Code / Cursor 能直接驱动用户**已登录**的真实浏览器会话，这是 headless 方案（Playwright MCP 之类）拿不到的东西。Runi 的全部资产（Deny-First 权限门、写入校验、表单敏感字段硬阻断）在这个形态下反而变成差异化卖点：「可以让外部 agent 开我的浏览器，但危险动作仍然弹卡片问我」。

**为什么排 P3**：跨进程分发（npx 包 + 本地端口）会把当前「纯扩展、零后端」的安装故事复杂化，也新开一个安全面——本地端口意味着任何本机进程都能敲。等前面几项把单机体验做扎实再考虑，且动手前要先想清楚端口鉴权。

- [ ] 未开始

## 四、明确不追（我们更强，避免为了对标倒退）

1. **权限模型**——它没有确认门。Deny-First + 每回合确认 + 表单提交每次必问，是扩展形态下唯一负责任的做法。
2. **写入校验**——写前写后指纹 + 回读，落不了地就报失败；它只 dispatch 完事件就返回成功。
3. **敏感字段硬阻断**——在请求规划阶段就丢弃，不是靠 prompt 约束。
4. **流式输出 + 附件（PDF/图片）+ 划词提问**——它是非流式 `invoke`，没有对话形态。
5. **安全边界**——`page-resource-fetch.ts` 的 SSRF 防护、非 http(s) 跳转双重拦截；它的 `execute_javascript` 默认关闭但架构上就在那，是个隐患。
6. **测试覆盖**——`lib/` 带成套单测（1000+ 用例）；它 core 只有一个 365 行的测试文件。
7. **单步单动作的 MacroTool**——它把所有工具压成一个 `AgentOutput` 工具的 union 参数，每步只能出一个 action。这是为了迁就弱模型的结构化输出能力，配套那份 200 行的 `autoFixer.ts`（专门修「模型把 action 名当工具名返回」「参数被二次 JSON 字符串化」「JSON 藏在 content 里」等六七种畸形响应）就是代价。我们走标准 tool calling、可并行调用，`tool-call-repair.ts` 也比它干净，不要往回走。
8. **每步重建 prompt / 三行摘要式历史**——它每步只保留 `evaluation_previous_goal` / `memory` / `next_goal` 三行，丢掉原始工具结果。这在「一次性任务跑 40 步」下是对的，但 Runi 是多轮对话，用户随时会追问「你刚才读到的那段脚本是什么」，丢掉原文就答不上来。保持现有的 24 条原始消息 + 结果截断策略。
   - **可以借的半步**：将来若真出现很长的连续写操作链，可以在消息超出窗口时把被丢弃的部分压成一行 `memory` 摘要挂在上下文头部，而不是直接丢掉。目前还没到这个规模，先记着。
