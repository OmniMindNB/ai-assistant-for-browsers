# 项目进度看板（PROGRESS）

> 持续更新。每完成一项，勾选并补充链接到对应 Spec/ADR/PR。

## 阶段总览

> 方向调整（2026-06-13）：从「关键词触发 + 文本上下文」转向「Agent 循环 + 工具调用」，
> 详见 [ADR-0003](adr/0003-agent-loop-and-tool-calling.md) 与 [agent-plan.md](agent-plan.md)。
> 原 Phase 3/4/5 顺延到 Agent Phase B/C 之后，Skill 演化为「固化的工具调用序列」。

| 阶段 | 目标 | 状态 |
|------|------|------|
| Phase 0 | 脚手架与三端通信 | ✅ 完成 |
| Phase 1 | MVP 对话（总结/问答/划词） | ✅ 完成 |
| Phase 2 | 脚本生成与注入（关键词触发，**将被 Agent 取代**） | ✅ 基本完成 |
| **Agent A** | **Agent 循环 + 工具调用 + 只读检查工具** | ✅ 完成 |
| Agent B | 写入/交互工具 + 权限确认 UI | ✅ 完成 |
| Agent C | CDP / 网络嗅探 / 多标签 / 抓取导出 | ⬜ 未开始 |

图例：⬜ 未开始 · 🚧 进行中 · ✅ 完成

## Phase 0 — 脚手架（基础设施）

参考：[ADR-0002 技术栈与脚手架](adr/0002-tech-stack-and-scaffold.md)

- [x] 初始化 WXT + React + TS 项目（pnpm）
- [x] 接入 Tailwind CSS（v4 + @tailwindcss/vite）
- [x] 配置 MV3 manifest：Side Panel / Service Worker / Content Script
- [x] 打通三端消息通信（统一消息协议 `lib/messaging.ts`）
- [x] 本地存储封装（`lib/db.ts` Dexie、`lib/settings.ts`）
- [x] 跑通 `pnpm build`，manifest 含 side_panel/权限校验通过

> 入口：`entrypoints/{background,content,sidepanel,options}`；侧边栏自检按钮可验证三端通信。
> 在浏览器手动加载：`pnpm dev`，或加载 `.output/chrome-mv3` 未打包扩展。

## Phase 1 — MVP 对话（功能 1、2）

参考：[technical-plan.md §4.1、§5](technical-plan.md)

- [x] OpenAI 兼容的流式对话客户端（原 `lib/llm.ts`，SSE 逐 token 输出；Agent 化后无调用方，已作为死代码删除，功能由 `lib/agent/stream.ts` 承接）
- [x] Provider / API Key 配置：「设置」页表单 + 预设（`entrypoints/options`、`lib/settings.ts`）
- [x] 开发测试快捷配置：`lib/dev-config.ts` 填入测试 Key 自动注入 Provider
- [x] Readability 正文提取（`entrypoints/content.ts`）
- [x] 侧边栏对话 UI：流式渲染 / 停止 / 清空（`entrypoints/sidepanel`）
- [x] 总结本页、解释划词（页面提取 + 选区）
- [x] 对话历史持久化（IndexedDB / Dexie）
- [x] Markdown 渲染 + 代码高亮（`Markdown.tsx`，react-markdown + rehype-highlight）
- [x] 历史会话列表 UI（查看/打开/删除，`lib/db.ts` 辅助函数）
- [ ] 长页面 Map-Reduce / RAG（待增强）

> 测试：在 `lib/dev-config.ts` 中填入 DeepSeek 等测试 Key 并将 `enabled` 改为 true，
> 或者运行 `pnpm dev` 后在「设置」页填入。

## Phase 2 — 脚本生成与注入（功能 3）

参考：[technical-plan.md §4.2](technical-plan.md)

- [x] LLM 生成脚本 → 预览 → 人工确认 → 注入执行（底层能力已完成）
- [x] 静态安全校验：acorn AST 扫描危险 API（`lib/security.ts`）
- [x] MAIN world 隔离执行 + 执行前快照、一键撤销（`background.ts`）
- [x] 内置模板：阅读模式 / 去悬浮广告 / 深色背景（底层模板能力已完成）
- [ ] 执行日志与多步撤销栈（待增强）
- [ ] AST 白名单沙箱 / 超时保护（待增强）

> 页面改造能力已收口到对话主流程；用户可直接在对话中要求 AI 修改当前页面，
> 确认后注入当前页面；危险 API 会高亮提示，语法错误会阻止执行。

> ⚠️ 已知缺陷：关键词路由（`looksLikePageActionRequest`/`maybeRunPageAction`）脆弱，
> 且上下文只含正文文本，导致「滚动效果怎么实现」等需读 DOM/脚本/CSS 的问题脱靶。
> 由 Agent Phase A 重构取代。

## Agent Phase A — Agent 循环 + 只读检查工具（修复「脱靶」）

参考：[ADR-0003](adr/0003-agent-loop-and-tool-calling.md)、[agent-plan.md](agent-plan.md)

- [x] A0'：**Pi 打包 spike** —— ✅ 已验证通过（2026-06-13）：`@earendil-works/pi-agent-core` + `pi-ai` 在 WXT MV3 `pnpm build` 成功；`node:fs` 仅 warning 且被 Node 运行时守卫（源码显式面向浏览器）；agent 入口约 1.69MB（可接受）。**直接用 Pi，不启用降级方案 D**
- [x] A1：`lib/agent/agent.ts` 封装 Pi `Agent`（传入 browser `streamFn`、`beforeToolCall` 作为 Deny-First 闸门、`AgentTool` 注册）+ 轮次熔断
- [x] A2：只读检查工具集（read_page / query_dom / get_html / get_scripts / get_stylesheets / get_computed_style / get_page_meta / screenshot），后端在 `background.ts` + 协议在 `messaging.ts`
- [x] A3：`store.ts` 删除关键词路由，`send()` 改为驱动 Pi `Agent.prompt()`；`App.tsx` 订阅 `tool_execution_*` 事件展示工具调用中间态
- [x] 验收：问「当前网页的滚动效果是怎么做的」→ 模型自动读脚本/样式后给出基于真实代码的分析（2026-06-20 起围绕该场景多轮迭代 `browser_inspect_page_implementation` 的 `evidenceSummary` 与收敛约束，见下方变更日志）

> 上下文管理（单步预算 / 结果折叠 / 轮次熔断）随 A1/A2 落地最小集；CDP、网络嗅探、多标签留待 Agent B/C。

## Agent Phase B — 写入/交互工具 + 权限确认 UI

参考：[Spec-0001](specs/0001-agent-write-tools-and-permission-ui.md)、[实现计划（已归档）](superpowers/plans/archive/2026-07-20-agent-write-tools-and-permission-ui.md)

- [x] 10 个写入/交互工具注册：browser_set_style、browser_modify_dom、browser_click、browser_type、browser_select、browser_scroll、browser_navigate、browser_set_storage、browser_inject_script、browser_revert_changes（`lib/agent/tools.ts`）
- [x] 每轮一次确认闸门：`lib/agent/confirm-gate.ts`（`resolveConfirmGate`/`raceWithAbort`）+ `lib/agent/permissions.ts`（`beforeToolCallPermissionGate` 真正等待用户确认，取代此前的硬拒绝占位）
- [x] `browser_navigate` 硬拒绝非 http/https 协议（权限层 + 后端 `isNavigableUrl` 双重校验）
- [x] 整轮撤销：`lib/agent/turn-snapshot.ts` 每 tab 一份快照，`RESET_TURN_SNAPSHOT`/`REVERT_CHANGES` 取代旧的单槽 `UNDO_SCRIPT`
- [x] 侧边栏 UI：确认卡片（含代码预览、批准/拒绝）、撤销条、工具调用列表新增「待确认」状态（`entrypoints/sidepanel/store.ts`、`App.tsx`）
- [x] 系统提示词补充写工具说明（原提示词完全面向只读分析，模型不会主动调用写工具）

> 实现过程中发现并修复两处计划外的缺口：`browser_inject_script` 从未被注册为 Agent 工具（补上）；系统提示词从未提及写工具存在，导致模型即使有工具也不会调用（补上）。均已通过真实 LLM 会话（DeepSeek deepseek-v4-pro）现场验证：确认卡片每轮仅弹出一次、批准后同轮后续写操作自动执行、页面确实按要求改变、撤销能还原、拒绝后模型能正常收敛而不崩溃或重试、新一轮会重新要求确认。

## 变更日志

| 日期 | 内容 | 关联 |
|------|------|------|
| 2026-07-26 | 真机接入 Anthropic 兼容端点（火山方舟 Kimi K2）暴露的「空回复」问题修复：`anthropic-stream.ts`/`openai-stream.ts` 读取 `stop_reason`/`finish_reason` 并映射为真实 StopReason（此前 `max_tokens` 截断被当作正常 `stop`）；`agent.ts` 的 `maxTokens` 4096 → 16000，避免推理模型的 thinking 块吃掉全部预算；`store.ts` 在无文本结果时读取末条 assistant 的 `stopReason`/`errorMessage` 给出具体原因并打印控制台日志，取代无信息量的「没有生成文本结果」；`anthropicMessagesUrl()` 兼容带/不带版本段的 baseURL（方舟对未命中路由返回 401，极易误判为 API Key 问题） | 2026-07-25-anthropic-compatible-provider.md |
| 2026-07-25 | 新增 Anthropic Messages 协议支持：`ProviderConfig.api` 协议字段（缺省 OpenAI 兼容）、设置页协议下拉框、`lib/agent/anthropic-stream.ts` 实现 Anthropic 消息格式转换（含 tool_result 合并）与 SSE 解析；`lib/agent/stream.ts` 拆分出协议无关的 `stream-shared.ts` 供两种协议共用。代码层已通过类型检查、96/96 单测、生产构建；真机加载扩展 + 真实 Anthropic 兼容端点的端到端手动验证待用户执行确认 | [[2026-07-25-anthropic-compatible-provider-design]], 2026-07-25-anthropic-compatible-provider.md |
| 2026-07-24 | Spec-0002 全部验收标准通过：真机验证 `browser_inject_script` 的开关等待+自动重试/取消/孤儿轮询三条路径均正常；状态更新为已实现；同步修正 submission guide 中过时的"一次性报错"描述为等待重试流程 | Spec-0002, 2026-07-23-turn-tabid-pinning-and-userscripts-wait.md Task 9 |
| 2026-07-21 | Chrome 应用商店合规修复：`browser_inject_script` 从 `new Function` 迁移到 `chrome.userScripts.execute`，消除 Remote Hosted Code 政策违规；新增 `userScripts` manifest 权限与 Chrome 138 版本下限 | Spec-0002 |
| 2026-07-21 | 文档一致性清理：修正 Agent A/Spec-0001/ADR-0003 的过时状态标记、补全 docs/README 目录索引、technical-plan.md 三处加「已被取代」说明、归档已完成的实现计划；删除未被引用的死代码 `lib/llm.ts`（功能已由 `lib/agent/stream.ts` 承接） | 本次审计 |
| 2026-07-21 | Agent Phase B 完成：10 个写入/交互工具、每轮一次确认闸门、整轮撤销、确认卡片/撤销条 UI、系统提示词补充写工具说明；真实 LLM 会话现场验证通过 | Spec-0001, 实现计划 |
| 2026-06-20 | Agent A3 完成：sidepanel 发送流程切换为 Pi `Agent.prompt()`，删除关键词路由与正文-only prompt，新增工具调用状态 UI | agent-plan.md |
| 2026-06-20 | 提升聚合巡检答案质量：`browser_inspect_page_implementation` 增加 `evidenceSummary`，抽取 scroll/sticky/IntersectionObserver/animation/Primer/GitHub landing-page 等脚本、样式、HTML、DOM 与 computed style 证据；聚合后允许最多 4 次、每类 1 次定向补查 | agent-plan.md |
| 2026-06-20 | 增加聚合巡检后的运行时收敛约束：`browser_inspect_page_implementation` 成功后通过 `agent.steer()` 引导回答，并阻断重复读取 page_meta/read_page；scripts/styles/html/DOM/computed style 仅允许最多 4 次、每类 1 次定向补查 | agent-plan.md |
| 2026-06-20 | 新增 `browser_inspect_page_implementation` 聚合工具：一次 Agent 工具调用内收集 meta/readable text/HTML/DOM/scripts/stylesheets/computed style，降低实现分析类问题的工具预算消耗 | agent-plan.md |
| 2026-06-20 | 调整 Agent 工具预算：默认/侧边栏分析预算从 8 提升到 12，提示词要求避免重复工具调用并在预算耗尽时直接收敛回答 | agent-plan.md |
| 2026-06-20 | Agent A2 完成：扩展只读浏览器检查协议与 background 后端，注册 page meta / DOM / HTML / scripts / stylesheets / computed style / screenshot 工具 | agent-plan.md |
| 2026-06-20 | Agent A1 完成：新增 Pi Agent factory、浏览器 OpenAI-compatible streamFn、Deny-First 权限闸门、最小工具注册表（active tab/read page）与工具结果压缩/调用上限 | agent-plan.md |
| 2026-06-13 | A0' Pi 打包 spike 验证通过：pi-agent-core 在 WXT MV3 可干净打包，node 内建被浏览器守卫；确定直接基于 Pi | ADR-0003, agent-plan.md |
| 2026-06-13 | 方向调整：转向 Agent 循环 + 工具调用，修复关键词路由与纯文本上下文导致的「脱靶」 | ADR-0003, agent-plan.md |
| 2026-06-08 | Phase 2 脚本注入：LLM 生成+预览+确认执行、acorn 安全扫描、MAIN world 注入+撤销、内置模板 | technical-plan §4.2 |
| 2026-06-08 | Phase 1 增强：Markdown 渲染 + 代码高亮、历史会话列表 UI | technical-plan §2.2 |
| 2026-06-08 | Phase 1 MVP 对话：OpenAI 兼容流式对话、设置页、总结/划词、历史持久化 | technical-plan §4.1/§5 |
| 2026-06-07 | 整合 plan/technical-plan 进 docs/，新增根 README | docs/README |
| 2026-06-07 | 建立文档驱动开发机制；完成 Phase 0 脚手架 | ADR-0001, ADR-0002 |
