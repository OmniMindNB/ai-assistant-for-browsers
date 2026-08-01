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
- [x] 编辑历史用户消息并从该处重新生成（截断后续消息 + 会话全量重写持久化，
      见 [设计](superpowers/specs/2026-07-26-edit-history-message-design.md)）
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

- [x] 9 个写入/交互工具注册：browser_set_style、browser_modify_dom、browser_click、browser_type、browser_select、browser_scroll、browser_navigate、browser_set_storage、browser_revert_changes（`lib/agent/tools.ts`）；`browser_inject_script` 已在 1.1.0 Store 最终审查中移除。
- [x] 每轮一次确认闸门：`lib/agent/confirm-gate.ts`（`resolveConfirmGate`/`raceWithAbort`）+ `lib/agent/permissions.ts`（`beforeToolCallPermissionGate` 真正等待用户确认，取代此前的硬拒绝占位）
- [x] `browser_navigate` 硬拒绝非 http/https 协议（权限层 + 后端 `isNavigableUrl` 双重校验）
- [x] 整轮撤销：`lib/agent/turn-snapshot.ts` 每 tab 一份快照，`RESET_TURN_SNAPSHOT`/`REVERT_CHANGES` 取代旧的单槽 `UNDO_SCRIPT`
- [x] 侧边栏 UI：确认卡片（批准/拒绝）、撤销条、工具调用列表新增「待确认」状态（`entrypoints/sidepanel/store.ts`、`App.tsx`）
- [x] 系统提示词补充写工具说明（原提示词完全面向只读分析，模型不会主动调用写工具）

> 写工具的确认和撤销行为已通过真实 LLM 会话验证；1.1.0 Store 最终审查已移除 `browser_inject_script` 和对应的 `userScripts` 权限，保留其余结构化页面工具。

## 变更日志

| 日期 | 内容 | 关联 |
|------|------|------|
| 2026-08-01 | 删除撤销（Undo/Revert）功能：`browser_revert_changes` 工具、`turn-snapshot.ts` 快照模块、`REVERT_CHANGES`/`RESET_TURN_SNAPSHOT` 消息类型、`auto_allow` 权限档位、侧边栏撤销条 UI 及相关状态全部移除；同步更新 CLAUDE.md、README（中英）与隐私政策文字。起因：浏览器插件写操作本身轻量，且每轮首次写操作前已有用户确认闸门，撤销这层安全网的维护成本大于收益。验证：`pnpm compile` 通过，`pnpm test`（29 个测试文件、387 个测试）通过，`pnpm build`（Chrome MV3）成功构建。 | [设计](superpowers/specs/2026-08-01-remove-undo-revert-feature-design.md) |
| 2026-07-31 | 简化聊天界面页面附加机制：删除 `PageContextBar` 组件、移除 `WorkbenchComposer` 的交互式 pill，只在受限/读取出错的页面显示不可点击的状态提示；`pageAttached` 从手动状态变为纯派生值（`resolvePageAttached`），受限/读取出错页面自动无需点击地不带浏览器工具，其余页面跟随全局设置 `attachPageByDefault`。验证：`pnpm compile` 通过，`pnpm test`（27 个测试文件、352 个测试）通过，`pnpm build`（Chrome MV3）成功构建。 | [设计](superpowers/specs/2026-07-31-simplify-page-attach-toggle-design.md) |
| 2026-07-31 | 移除侧边栏「问答/Agent」模式切换：删除 `ModeSwitch` 组件、工作台偏好中的 `defaultMode` 字段与设置页模式单选组，以及相关 i18n 键，统一为单一输入区体验；`pageAttached`/`withoutBrowserTools` 行为不受影响。验证：`pnpm compile` 通过，`pnpm test`（27 个测试文件、348 个测试）通过，`pnpm build`（Chrome MV3）成功构建。 | [设计](superpowers/specs/2026-07-31-remove-ask-agent-mode-design.md) |
| 2026-07-30 | 删除失败跨会话隔离回归：B 删除失败后，C 的独立持久化仍可完成，队列不会形成全局阻塞。验证：`pnpm test`（27 文件、347 测试）、`pnpm compile` 均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 删除队列测试覆盖补全：验证单次失败删除恢复写入、重叠删除 generation、失败删除后队列恢复以及 B/C 会话隔离。验证：`pnpm test`（27 文件、346 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 删除 tombstone 并发回归：同一会话的第一删除成功、第二删除失败后，成功 tombstone 仍阻止迟到快照，队列继续可用。验证：`pnpm test`（27 文件、343 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 删除持久化队列补强：成功删除与进行中删除 generation 分离；成功 tombstone 不会被随后失败的并发删除清除。真实延迟写入回归验证同会话顺序为 save→delete，且成功删除后的迟到快照继续被拒绝。验证：`pnpm test`（27 文件、342 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 上下文工作台删除持久化加固：按会话串行化 Dexie 写入/删除；删除意图建立会话级 tombstone，删除前已排队的快照先完成而删除最后执行，删除开始后的快照永远跳过。成功删除保留 tombstone（会话 id 唯一），删除失败才清除，防止迟到运行重建已删除会话。验证：`pnpm test`（27 文件、341 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 上下文工作台生命周期最终排序修复：Agent 终态在持久化前同步释放 ActiveRun、Agent 与确认 resolver，导航不会再次中止已完成运行或写入重复快照；删除会话在完成时按最新活动会话重新判定，即使最初删除的是非活动会话，若其等待期间变为当前会话也会取消运行并替换为空白新会话。新增延迟持久化导航与非活动目标变为活动的删除回归。验证：`pnpm test`（27 文件、340 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 上下文工作台会话所有权加固：会话导航 epoch 与 Agent 运行 id 分离；每次 Agent/快捷指令前置请求固定来源会话与 epoch，打开、清空和删除活动会话在状态转换前再次取消间隙启动的运行。单个 ActiveRun 统一拥有 Agent、确认 resolver 与来源；终态持久化只使用来源快照，完成后清理注册，已删除会话不会被迟到 finally 复活。新增延迟打开/删除、快捷指令选区前置请求和完成运行清理回归。验证：`pnpm test`（27 文件、338 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 上下文工作台收尾审查修复：Agent 运行在开始时固定会话 epoch/id，打开、清空或删除当前会话会先取消运行；所有迟到文本、工具、确认、终态与持久化仅可作用于原会话，不能覆盖新会话或把已删除会话写回。统一输入区新增可点击、可触摸且可访问的 `/` 快捷指令入口；空输入写入 `/`，已有草稿保持不丢失，忙碌时禁用。当前标签页的可读性从外部资源 SSRF 策略中分离：内容脚本可读取 localhost/内网 HTTP(S) 标签页，Chrome Web Store 和非 HTTP(S) 仍受限；外部资源获取继续拒绝私有地址。验证：`pnpm test`（27 文件、334 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 上下文工作台最终修复：侧边栏实时响应 Provider/偏好存储变更；快捷指令显示命令与过滤使用同一无空白规范化；Agent 时间线明确显示拒绝/停止终态且不被迟到错误覆盖；历史打开成功后重置模式和页面附加默认值；Provider 初始读取加入加载/错误/重试闸门；模型菜单按完整输入区宽度定位；Chrome Web Store 两个受保护 HTTP(S) 域名按受限页面处理；忙碌时快捷指令禁用并补齐问答/Agent 输入提示。验证：`pnpm test`（27 文件、327 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-30 | 上下文工作台收尾：侧边栏完成双语问答/Agent 空白状态、页面专用“未命名页面”回退、页面上下文失败/缺失/畸形 URL 与无效偏好回归；历史抽屉/更多菜单保持 Escape 关闭与焦点返回，所有原生交互控件有共用可见焦点，Agent 状态在浅深色下使用更高对比度；Options 的 Provider/快捷方式操作名称和翻译键集同步。验证：`pnpm test`（27 文件、306 测试）、`pnpm compile`、`pnpm build`（Chrome MV3）均通过。 | [设计](superpowers/specs/2026-07-30-sidepanel-context-workbench-redesign-design.md) |
| 2026-07-29 | 自定义快捷方式：新增独立的本地快捷方式存储；两个内置项支持编辑、删除和恢复默认；明确“当前页面 / 已选文本 / 不使用网页上下文”三种强作用域边界；桌面设置页新增快捷方式导航，侧边栏设置复用紧凑版管理界面；输入区按存储顺序直显前三项，其余收进“更多”；移除空状态中央快捷卡片。代码层已通过 216/216 单测、TypeScript 类型检查和 Chrome MV3 生产构建；未打包扩展的真机交互验收待执行。 | [设计](superpowers/specs/2026-07-29-custom-shortcuts-design.md) |
| 2026-07-28 | Chrome Web Store 1.1.0 最终审查：移除 AI 生成 JavaScript 执行、`browser_inject_script`、`userScripts` 权限及等待 UI；新增可测试的资源获取模块，拒绝 IPv6 本地/未指定/链路本地/唯一本地与 IPv4 映射内网地址，并对 Chrome 隐藏目标的不透明重定向安全失败；同步修正双语同意说明、隐私政策和 Store 材料 | 2026-07-27-chrome-web-store-1-1-relaunch |
| 2026-07-27 | 侧边栏 + 设置页新增「跟随浏览器 / 中文 / English」三态语言切换（默认跟随浏览器，偏好存 `chrome.storage.local`）：新增 `lib/i18n` 模块（zh/en 字典 + `useTranslation()` Context + 供 `store.ts` 用的非 hook `t()`，与 `lib/theme.ts` 的 auto/手动覆盖模式一致），全量迁移侧边栏/设置页/Provider 表单/错误提示与注入聊天气泡（Agent 系统提示词与发给模型的 prompt 变量维持中文不译）；Chrome Web Store 商店列表（扩展名称/描述）通过 `default_locale` + `_locales/{zh_CN,en}/messages.json` 独立本地化；新增 `README.en.md` 并与中文版互链。代码层已通过类型检查、154/154 单测、生产构建；中英文界面切换的真机视觉验收待用户执行确认 | [[2026-07-27-english-language-support-design]], 2026-07-27-english-language-support.md |
| 2026-07-26 | 「添加 Provider」表单的「快速预设」下拉新增「自定义（手动填写）」选项（末尾，上方带不可选分隔项）。自定义被建模为空预设 `{ name: '', baseURL: '', model: '' }`，复用 `applyPresetToDraft` 已有的双分支语义：添加态整体覆盖 → 清空厂商字段，编辑态「非空不覆盖」→ 保护已保存值不被误清。新增 `resolvePresetSelection()`/`draftPlaceholders()` 两个纯函数，后者把组件内写死的 DeepSeek 风格 placeholder 收进 `lib/settings.ts` 并按选中预设切换（自定义态给与厂商无关的通用示例）。起因：厂商字段本就是自由文本、配置任意中转站早已可行，但下拉只列内置厂商，用户会误以为必须从中选一个。代码层已通过类型检查、单测、生产构建；两项真机验收待用户执行确认：不可选分隔项在 Chrome + Firefox 下的跨引擎渲染表现，以及添加态的冒烟流程（选 DeepSeek 填充 → 选自定义 → 三个字段清空并显示新占位文案） | [[2026-07-26-provider-custom-preset-option-design]], 2026-07-26-provider-custom-preset-option.md |
| 2026-07-26 | LLM HTTP 报错自带上下文：`stream-shared.ts` 新增 `describeHttpFailure()`（两个 stream 共用），报错写入请求 URL、模型名，空 body 时不再退化成零信息的 `LLM 请求失败 (404 )`，404 额外提示「路径或模型名不存在，非 Key 问题」；`openAiCompletionsUrl()` 兜底 Base URL 已带 `/chat/completions` 的重复拼接（不自动补版本段——各厂商版本段不同，猜错只是换个地方报 404）。起因：Provider 从 Anthropic 协议切到 OpenAI 协议后报 404，而原报错既无 URL 也无 detail，无法区分「路径拼错」与「模型名在该端点不存在」（方舟对后者返回 404，且其网关在鉴权阶段对所有路径一律返回 401，故 404 反证 Key 有效） | 2026-07-25-anthropic-compatible-provider.md |
| 2026-07-26 | 真机接入 Anthropic 兼容端点（火山方舟 Kimi K2）暴露的「空回复」问题修复：`anthropic-stream.ts`/`openai-stream.ts` 读取 `stop_reason`/`finish_reason` 并映射为真实 StopReason（此前 `max_tokens` 截断被当作正常 `stop`）；`agent.ts` 的 `maxTokens` 4096 → 16000，避免推理模型的 thinking 块吃掉全部预算；`store.ts` 在无文本结果时读取末条 assistant 的 `stopReason`/`errorMessage` 给出具体原因并打印控制台日志，取代无信息量的「没有生成文本结果」；`anthropicMessagesUrl()` 兼容带/不带版本段的 baseURL（方舟对未命中路由返回 401，极易误判为 API Key 问题） | 2026-07-25-anthropic-compatible-provider.md |
| 2026-07-25 | 新增 Anthropic Messages 协议支持：`ProviderConfig.api` 协议字段（缺省 OpenAI 兼容）、设置页协议下拉框、`lib/agent/anthropic-stream.ts` 实现 Anthropic 消息格式转换（含 tool_result 合并）与 SSE 解析；`lib/agent/stream.ts` 拆分出协议无关的 `stream-shared.ts` 供两种协议共用。代码层已通过类型检查、96/96 单测、生产构建；真机加载扩展 + 真实 Anthropic 兼容端点的端到端手动验证待用户执行确认 | [[2026-07-25-anthropic-compatible-provider-design]], 2026-07-25-anthropic-compatible-provider.md |
| 2026-07-24 | Spec-0002 全部验收标准通过：真机验证 `browser_inject_script` 的开关等待+自动重试/取消/孤儿轮询三条路径均正常；状态更新为已实现；同步修正 submission guide 中过时的"一次性报错"描述为等待重试流程 | Spec-0002, 2026-07-23-turn-tabid-pinning-and-userscripts-wait.md Task 9 |
| 2026-07-21 | Chrome 应用商店合规修复：`browser_inject_script` 从 `new Function` 迁移到 `chrome.userScripts.execute`，消除 Remote Hosted Code 政策违规；新增 `userScripts` manifest 权限与 Chrome 138 版本下限 | Spec-0002 |
| 2026-07-21 | 文档一致性清理：修正 Agent A/Spec-0001/ADR-0003 的过时状态标记、补全 docs/README 目录索引、technical-plan.md 三处加「已被取代」说明、归档已完成的实现计划；删除未被引用的死代码 `lib/llm.ts`（功能已由 `lib/agent/stream.ts` 承接） | 本次审计 |
| 2026-07-21 | Agent Phase B 完成：10 个写入/交互工具、每轮一次确认闸门、整轮撤销（已于 2026-08-01 整体移除，见变更日志）、确认卡片/撤销条 UI、系统提示词补充写工具说明；真实 LLM 会话现场验证通过 | Spec-0001, 实现计划 |
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
