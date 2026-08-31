# 对标 alibaba/page-agent：可借鉴项与优先级 backlog

- 日期：2026-08-31
- 对标对象：<https://github.com/alibaba/page-agent>（monorepo：`packages/core` / `page-controller` / `extension` / `mcp` / `ui`）
- 状态：调研结论，未排期。后续按优先级与实际情况逐条挑选，落地时再单独写 spec/plan。

## 1. 定位差异

| 维度 | page-agent | Runi |
|------|-----------|------|
| 形态 | 页面内 SDK（一行 script 引入）+ 可选 Chrome 扩展 | 扩展 side panel |
| 感知 | 沿用 browser-use 的 DOM 扁平树，全量索引成 `[index]<tag attrs>text />` | 语义抽取 + `browser_get_form` 的 `fieldId` 句柄表 |
| 动作 | 一步一个 action，宏工具 `AgentOutput` 强制自评 | pi-agent-core 原生多工具调用循环 |
| 权限 | 元素黑白名单 + prompt 约束（软约束） | Deny-First + 结构化提交每次确认（硬约束） |
| 遮罩 | mask 吞掉用户的 click/wheel/keydown | `pointer-events: none`，从不拦截用户输入 |
| 视觉 | 纯文本，无截图、无多模态 | 有 `browser_screenshot` |

它面向"网站开发者给自己的站点接一个 copilot"，我们面向"用户在任意站点上用的浏览器助手"。因此 SDK 形态、`execute_javascript`、拦截式遮罩这三项属于形态差异，不适用。

## 2. 已经对齐的能力（无差距，仅存档）

- native value setter 写入 + 完整 pointer/mouse 事件序列（`lib/agent/form-dom.ts`）
- contenteditable 回读校验后降级 `execCommand`（`lib/agent/form-dom.ts:625`、`:1142`；测试注释已标注对标来源）
- 新出现元素的 `isNew` 标记（`lib/agent/form-render.ts:73`）
- 滚动后的剩余距离反馈（`lib/agent/action-result-text.ts`）
- 工具预算耗尽的分档软提醒（`lib/agent/tool-policy.ts`）
- 弱模型 tool call 修复（`lib/agent/tool-call-repair.ts` ↔ 对方 `core/src/utils/autoFixer.ts`）
- 敏感字段不回读、不写入（`lib/agent/form-schema.ts`，对方无对应机制，我们更强）
- 任务结果自报（我们的 `report_task_outcome` 三态 + 强制补报，强于对方的 `done{success}` 二态）

## 3. 可借鉴项（按价值排序）

### P0

#### 3.1 上下文装配方式：每步重建 prompt，历史压成摘要

对方 `PageAgentCore.#assembleUserPrompt()` 每步从 `history` 重新拼一整份 prompt：
历史事件只保留 `Evaluation of Previous Step / Memory / Next Goal / Action Results` 四行，
**浏览器状态只挂当前这一份**，此前所有页面快照完全不进上下文。

我们 `lib/agent/agent.ts` 的 `transformContext` 是"保留最近 `MAX_CONTEXT_MESSAGES` 条 + 把长工具结果截断到 `MAX_TOOL_RESULT_CHARS`"，
后果是旧的 DOM dump 仍留在窗口里、被截成半截：既占 token，又让模型看到过期的页面状态。

- 落点：`lib/agent/agent.ts` 的 `transformContext`
- 收益：token 占用与"模型照着过期快照操作"这两个问题一起解决，比继续调 `MAX_CONTEXT_MESSAGES` 有效得多
- 风险：需要一个稳定的"历史摘要"来源。我们没有强制自评字段，可考虑用 `activity-steps.ts` 已有的步骤时间线作为摘要素材

#### 3.2 `<sys>` observation 通道

对方 `PageAgentCore.#handleObservations()` 在每步开头往历史里插系统旁白：

- URL 变化 → `Page navigated to → {url}`，并 `waitFor(0.5)` 等页面稳定
- 累计 `wait` ≥ 3s → "不要再等了，除非有充分理由"
- 剩余步数 == 5 / == 2 → 分级警告

我们只有预算档位提醒。其中 **URL 变化通知 + 导航后稳定等待** 最实用：
当前导航后立刻读页面会拿到半加载状态，是真实痛点。

- 落点：`lib/agent/agent.ts` 的 `afterToolCall`；文案侧 `lib/agent/action-result-text.ts`

#### 3.3 页面内容脱敏钩子

对方把 `transformPageContent(content)` 做成一等公民配置项，官网文档直接给出手机号 / 邮箱 / 身份证 / 银行卡的脱敏正则。

我们目前**页面正文零脱敏**，只在表单层做了 sensitive 字段不回读。
对一个"provider 配置永不云同步"的隐私定位产品，这是明显缺口。

- 落点：`EXTRACT_PAGE` 结果与 `lib/agent/form-render.ts` 输出之前，统一过一道可配置的脱敏管线
- 附带：设置页需要一个开关 + 自定义规则入口

### P1

#### 3.4 抽取层的交互元素黑名单（含 React 根容器误判修复）

React 常把大量事件委托挂在 `#root` / `#app` 上，导致根容器被判成"可交互元素"。
对方 `page-controller/src/patches/react.ts` 在抽取前给这些节点打 `data-page-agent-not-interactive`，直接不进索引；
同时 `DomConfig` 暴露 `interactiveBlacklist` / `interactiveWhitelist`。

我们是在 `lib/agent/permissions.ts` 里 deny 根容器选择器 —— **拦得太晚**：
元素已经进了清单、占了 token、模型已经决定点它了，才被权限层拒绝。

- 落点：`lib/agent/form-dom.ts` 的 `collectFormFields`，抽取阶段前移过滤
- 延伸：用户可配的按域名黑白名单（"这个站点的删除按钮永远不许点"）

#### 3.5 渲染层属性去重

对方 `page-controller/src/dom/index.ts`（`flatTreeToString`）里一串很便宜的 token 优化：

- 同一元素上值重复且长度 > 5 的属性只保留一个
- `role` 等于 tagName 就丢掉
- `aria-label` / `placeholder` / `title` 与文本内容相同就丢掉
- 属性值统一 `capTextLength(value, 20)`

- 落点：`lib/agent/form-render.ts`，可直接吸收

#### 3.6 点击的两个细节

均在对方 `page-controller/src/actions.ts`：

1. 移动指针后用 `document.elementFromPoint(x, y)` 做命中测试，若结果是目标元素的后代则把事件派发给它 ——
   匹配真实浏览器"事件落在最内层元素"的行为。我们目前直接派发给解析出的元素。
2. `blurLastClickedElement()`：下一次点击前，给上一个被点元素补 `pointerout` / `pointerleave` / `mouseout` / `mouseleave` / `blur`，
   防止 hover 菜单粘住不消失。

- 落点：`lib/agent/form-dom.ts` 的点击实现
- 注意：对方需要临时把 mask 切成 `pointer-events: none` 才能命中测试；我们的遮罩本来就是穿透的，无此步骤

#### 3.7 `wait` 扣除 LLM 往返耗时

对方 `wait` 工具先算 `Date.now() - getLastUpdateTime()`，只补差额时间。
我们的 `wait` 是实打实睡满，叠加在本就很慢的 LLM 往返之上。

- 落点：`lib/agent/tools.ts` 的 `wait`

#### 3.8 可滚动容器在元素清单里直接带四向剩余距离

对方把 `data-scrollable="top=..., bottom=..., left=..., right=..."` 拼进元素行，
模型能一次性决定滚哪个容器、还能滚多远。

我们的 `scrollables` 有 `fieldId`，但剩余距离只在滚完之后由 `action-result-text.ts` 事后告知。

- 落点：`lib/agent/form-dom.ts`（收集）+ `lib/agent/form-render.ts`（渲染）

#### 3.9 按 URL 的用户自定义指令

对方 `AgentConfig.instructions.getPageInstructions(url)` 注入站点专属提示，
另有实验性的 `experimentalLlmsTxt`（抓站点 `/llms.txt`）。

对扩展形态这是**真差异化**：让用户为常去的内网 ERP 存一条
"保存按钮在右上角，提交前必须先选部门"，比任何通用 prompt 都管用。

- 落点：参照 `lib/shortcuts.ts` 的存储形态，新增 per-domain instructions
- `llms.txt` 抓取需走 `lib/page-resource-fetch.ts` 的既有校验

### P2

#### 3.10 模型兼容矩阵 + live 冒烟测试

对方有 `packages/llms/src/models.live.test.ts` 和一个 `maintain-model-list` skill 专门维护"哪些模型跑得通"。
我们主打"自带 key、任意 OpenAI 兼容端点"，`tool-call-repair.ts` 的存在本身就证明弱模型问题很实在 ——
一份「已验证可用模型」清单能显著降低支持成本。

#### 3.11 MCP 桥（战略项）

对方 `packages/mcp` 通过本地 WS hub，把扩展的页面控制能力暴露成 MCP server，
让 Claude Code / Cursor 这类外部 agent 驱动**用户已登录的真实浏览器**。

我们已有完整的工具层（`lib/agent/tools.ts`）与多标签页编排（`lib/agent/tab-session.ts`），
加这一层的边际成本不高，但打开的是完全不同的用户群。

- 前置：必须想清楚权限模型 —— 外部 agent 不受我们 side panel 的确认 UI 约束

#### 3.12 Limitations 文档作为产品资产

对方官网有一页诚实的能力边界说明（支持什么 / 不支持什么 / 为什么）。
我们的 `docs/` 里没有对应物，用户只能靠试。

## 4. 明确不借鉴

| 项 | 理由 |
|----|------|
| `execute_javascript` 工具 | 页面内容是不可信输入，任意 JS 执行会把提示注入直接升级成任意代码执行。Deny-First 是我们的核心资产，不为此开口子 |
| 拦截式遮罩 | 对方 mask 吞掉所有 click / wheel / keydown。我们在 CLAUDE.md 明确选了 `pointer-events: none`，"不能挡用户自己的输入"这条理由依然成立 |
| 单动作 / 步 | 强制自评质量高，但吞吐掉一大截，且与我们的多工具并行调用冲突。可只借"每步写一句 evaluation"，不借"一步一个动作" |
| 页面内 SDK 形态 | 不同产品 |

## 5. 别一起抄进来的已知问题

对方源码里自己标注的坑：

- `actions.ts` 的滚动容器启发式搜索标了 `@deprecated`：找不到就 `querySelectorAll('*')` 全局扫，多面板布局下不可靠
- `scroll_horizontally` 工具的注释写着 `This tool is useless`（表格需要专门的结构化解析器）
- `isNew` 用 `WeakMap<HTMLElement, string>` 判断，元素删除后重新添加会误判；
  对方 TODO 里承认 browser-use 用「位置 + 属性 hash」才是对的做法
- `viewportExpansion` 默认 -1（全页）；其注释指出 `isTopElement` 依赖 `elementFromPoint`，
  视口外恒返回 null，因此该字段除了 -1 / 0 之外没有实际作用 —— 我们若引入类似机制需注意这个陷阱
- `patches/antd.ts` 的 `fixAntdSelect()` 是个空函数（只留了注释说明 antd Select 是 div 包不可见 input 的结构）
