# ADR-0003：从「关键词触发 + 文本上下文」转向「Agent 循环 + 工具调用」

- 状态：草稿 Draft
- 日期：2026-06-13
- 决策者：项目维护者
- 相关：[research-report.md](../research-report.md)、[agent-plan.md](../agent-plan.md)、[technical-plan.md](../technical-plan.md) §5、[ADR-0002](0002-tech-stack-and-scaffold.md)

## 背景（Context）

当前实现存在结构性缺陷，导致用户问题「脱靶」：

1. **上下文只有正文文本。** `entrypoints/sidepanel/store.ts` 的 `getPageContextPrompt()` 仅用 Readability 抽取**可见正文**塞进一条 system 消息。DOM 结构、`<script>` 源码、外链/内联 CSS、计算样式、网络请求一概不在上下文中。
   - 典型失败：用户问「当前网页的滚动效果是怎么做的」，模型手里只有正文文本，自然回答「没有详细描述滚动效果的具体实现」。正确做法应是**去读 DOM、读脚本、读样式后再分析**。

2. **能力靠关键词硬匹配。** `maybeRunPageAction()` 用 `PAGE_ACTION_TARGET_HINTS` / `PAGE_ACTION_VERB_HINTS` 两张中文词表判断「是否是改造请求」。这套规则脆弱、不可扩展、语言绑定，且把「问答」与「改造」割裂成两条互斥分支，模型无法在一次任务里**先查再改**。

3. **模型不能自主决定下一步。** `lib/llm.ts` 的 `chatStream()` 只支持纯文本流式，不支持 tool calling。模型无法说「我需要先看一下这个元素的事件监听器」。

根因：产品被实现成了「带页面文本的对话入口」，而非「能操作浏览器的 Agent」。研究报告（[research-report.md](../research-report.md) §3.2.1）的结论是——核心循环极简，价值在围绕循环的**工具系统 + 安全机制**。

## 决策（Decision）

将核心交互从「关键词分支」重构为 **Agent 循环（agentLoop）+ 工具调用（tool calling）**，并**优先直接采用 `@earendil-works/pi-agent-core`**（详见下方「关于 Pi 的决策修正」）：

1. **Agent 循环**：`LLM → tool_calls → 执行工具 → 回灌结果 → 再 LLM`，直到模型不再请求工具，产出最终回答。无状态生成器形态（Pi 的 `agentLoop()`），运行在侧边栏（Phase A）/ 后续可下沉 Service Worker。
2. **工具注册表**：把「读 DOM / 读脚本 / 读样式 / 查计算样式 / 执行 JS / 截图 / 点击 / 输入 / 滚动 / 导航 / 注入脚本」等注册为模型可调用的工具（OpenAI function-calling schema）。模型自主决定调用顺序。
3. **删除关键词分支**：移除 `looksLikePageActionRequest` / `maybeRunPageAction` 的词表路由。「问答」与「改造」统一进 Agent 循环，由模型按需调用只读或写入工具。
4. **Deny-First 权限闸门**：只读工具自动放行；写入/高危工具（注入脚本、改 storage、导航、点击提交等）经权限层判定，必要时人工确认。安全规则优先于模型意图（参考 [research-report.md](../research-report.md) §3.2.3）。
5. **执行后端先用 `chrome.scripting`**：DOM/JS/CSS 检查无需 `chrome.debugger`，避免「正在被调试」横幅；CDP（`chrome.debugger`）作为 Phase C 的可选增强（网络嗅探、真实输入事件、Console 捕获）。
6. **`chatStream` 升级**：扩展 `lib/llm.ts` 支持 `tools` 入参与流式 `tool_calls` 增量解析，沿用 OpenAI 兼容协议（DeepSeek/OpenAI/Qwen/GLM 均支持）。

详见 [agent-plan.md](../agent-plan.md)。

## 关于 Pi 的决策修正（2026-06-13 复查源码后）

初稿曾把 Pi 「暂缓」、主张自研 loop。复查 [pi-agent-core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) 与各包 `package.json` 后，修正为**优先直接采用 pi-agent-core**，依据：

1. **pi-agent-core 原生支持浏览器**：README 有专节 “Proxy Usage — For browser apps”，并暴露可替换的 `streamFn`。我们可传入**基于 `fetch` 的浏览器原生 `streamFn`**（复用现有 `lib/llm.ts` 的 OpenAI 兼容逻辑），扩展页有 `host_permissions`、不受 CORS 限制，**无需后端代理**。
2. **Claude Code 式基础设施 Pi 已内置**：`beforeToolCall`（可 `block`，即权限闸门）/ `afterToolCall`（审计）/ `terminate`（提前终止）/ `transformContext`（上下文压缩）/ `steer` 与 `followUp`（中途打断与追加）/ `AgentTool`（typebox 参数 + `execute`）。这正是我们原计划自研的部分，重复造轮不值得。
3. **唯一真实代价：`pi-ai` 是 Node 取向的**：`engines.node >=22.19.0`，依赖 `@smithy/node-http-handler`、`http/https-proxy-agent`、AWS Bedrock SDK 等 Node 专属包；agent-core 依赖 pi-ai（用其 `Model`/`getModel`）。风险**不在能否跑循环，而在 MV3 Service Worker 能否干净打包 pi-ai**（需把 `node:` 内建 alias 为空 shim + Tree-shaking 摘掉 AWS/proxy 部分）。这是**打包验证问题，不是架构阻断**。

**决策**：先跑一个限时 spike（A0'，见 [agent-plan.md](../agent-plan.md) §8）验证 `pi-agent-core` + 自带浏览器 `streamFn` 能在 WXT MV3 构建中干净打包；通过则直接采用 Pi，**仅在 spike 失败时**退回自研最小 loop。

### A0' spike 结果（2026-06-13，已验证）— **通过，采用 Pi**

实际装包并 `pnpm build`（WXT 0.20.26 / Vite 8 / rolldown），结论：

- **能打包、能构建成功**。`import { Agent } from '@earendil-works/pi-agent-core'` 的 spike 入口构建通过，无致命错误。
- **`node:fs` 被外部化仅为 warning，且完全无害**。pi-ai 源码显式面向浏览器：`node:fs/os/path` 仅在 `typeof process !== 'undefined' && process.versions?.node` 守卫下通过**动态 import** 加载（源注释：“NEVER convert to top-level imports - breaks browser/Vite builds”）；`hasVertexAdcCredentials()` 有专门的“Definitively in a browser”分支。浏览器环境下这些代码路径永不执行。
- **唯一代价：体积**。agent 入口约 **1.69 MB**（pi-ai 的 `register-builtins.js` 有副作用，未被 tree-shake，拖入全部 provider SDK）。对扩展可接受（非网页首屏）；优化手段：将 agent 模块改为 `import()` 动态分块按需加载，或后续评估 patch 掉 provider 注册。

**结论：降级方案 D 不需启用，直接基于 `pi-agent-core` 实现。**

## 备选方案（Alternatives）

- **A. 继续堆关键词 + 把更多页面信息塞进上下文（被否决）**：把 DOM/脚本/CSS 一次性全塞进 prompt 会瞬间爆上下文，且仍无法按需取数；关键词路由永远覆盖不全。
- **B（采用）. 直接采用 `@earendil-works/pi-agent-core` + 自带浏览器 `streamFn`**：复用成熟的 loop / 状态 / 工具调用 / 权限 hook / 压缩与打断基设，不重复造轮。前置 A0' spike 验证 pi-ai 在 MV3 可打包。
- **C. 一步到位上 CDP（`chrome.debugger`）（暂缓）**：能力最强但有调试横幅、单标签单连接、审核与体验成本高。降级为 Phase C 可选项。
- **D. 自研最小 agentLoop（降级方案）**：仅在 B 的 spike 失败（pi-ai 无法在 MV3 瘦身）时启用；拷贝 ~100 行 agentLoop，概念与 Pi 三层 API 对齐，便于后续替换。

## 影响（Consequences）

- **正面**
  - 修复「脱靶」：模型可主动读 DOM/脚本/样式后再回答「滚动怎么实现」类问题。
  - 问答与改造统一，支持「先查后改」的多步任务。
  - 工具可插拔、可分阶段扩充，对齐研究报告的工具清单（[research-report.md](../research-report.md) 附录 B）。
  - 安全集中到权限闸门，Deny-First，可审计。
- **代价 / 风险**
  - `lib/llm.ts` 需支持 tool calling 流式解析；非全部本地模型支持 function calling（需能力探测与降级）。
  - Agent 多轮调用 → token 与时延上升，需上下文压缩与单步预算（参考 [research-report.md](../research-report.md) §3.2.4）。
  - MAIN world 注入读取页面数据存在 Prompt Injection 面（页面内容可操纵模型），需对工具返回值做 untrusted 标注 + 写操作人工确认。
- **后续行动项**（落到 [PROGRESS.md](../PROGRESS.md) 新阶段）
  1. **A0' spike**：验证 `pi-agent-core` + 自带浏览器 `streamFn` 在 WXT MV3 Service Worker 中可打包（`node:` alias 空 shim + 体积可接受）。✅ **已完成（2026-06-13）：通过**（见上「A0' spike 结果」）。
  2. 通过：新增 `lib/agent/` 封装 Pi `Agent`（传入 browser `streamFn`、`beforeToolCall` 作为权限闸门、`AgentTool` 注册浏览器工具）；未通过：启用降级方案 D（自研 loop + `chatWithTools()`）。
  3. 新增只读工具集（read_page / query_dom / get_scripts / get_stylesheets / get_computed_style / evaluate_js / screenshot）。
  4. `store.ts` 删除关键词路由，`send()` 改为驱动 Pi `Agent`（订阅 `message_update`/`tool_execution_*` 事件渲染）。
  5. 写入工具接入权限确认（走 `beforeToolCall`），复用现有 `lib/security.ts` 的 AST 扫描。
