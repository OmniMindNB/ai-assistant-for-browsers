# 对标 alibaba/page-agent · 结论与待办

- 日期：2026-08-26
- 来源：走读 `D:\startup\page-agent`（package.json version 1.12.2）的 `packages/core`、`packages/page-controller`、`packages/llms`、`packages/extension`、`packages/ui`
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
| 上下文策略 | 每步重建 prompt，历史只保留 `evaluation/memory/next_goal` 三行摘要 | 保留最近 24 条原始消息 + 结果截断 |
| 权限 | 完全没有确认门，跑起来就一路点 | Deny-First + 每回合确认 + 表单提交每次必问 |
| 写入校验 | 只看 DOM 事件是否派发成功 | 写前写后指纹 + 回读校验 |

两个产品不是同一个东西：它对标 browser-use 的浏览器内实现，Runi 是 side-panel copilot。下面待办只挑在 Runi 形态里成立的部分。

## 二、已经借鉴过 / 已有等价能力（不重复投入）

- `<sys>` 观察式软提醒 → `lib/agent/tool-policy.ts` 的 `BUDGET_WARNING_THRESHOLDS`
- `isNew` 新元素标记 → `lib/agent/form-dom.ts` 的 `isNew` 字段
- 模拟光标 + 执行期遮罩 + 完整 pointer 事件序列 + `elementFromPoint` 遮挡检测 → `lib/agent/agent-overlay.ts`（`docs/superpowers/specs/2026-08-25-execution-overlay-design.md`）
- 弱模型 tool call 修复 → `lib/agent/tool-call-repair.ts`（比它的 `autoFixer.ts` 更干净）

## 三、待办（按性价比排序）

### [ ] P0 — 按模型/厂商打请求参数补丁

**是什么**：`packages/llms/src/utils.ts:39` 的 `modelPatch()`：Qwen 关 `enable_thinking`、DeepSeek 删 `tool_choice`、MiniMax 删 `parallel_tool_calls`、Kimi K3 把具名 tool_choice 降级成 `required`、Claude 把 `tool_choice` 转成 `{type:'tool',name}`、OpenRouter 用 `reasoning:{enabled}` 而非 `reasoning_effort`；配套 `normalizeModelName()` 把 `openai/gpt-5.2-chat` / `GPT-52-date` 归一成 `gpt-52`。

**为什么**：Runi 的卖点是「自带 key、任意 OpenAI 兼容端点」，`lib/agent/agent.ts:103` 目前只有一个 `thinkingLevel: 'off'`。接第三方中转或本地模型（Qwen/GLM/Ollama）时，这些厂商差异会直接表现成「工具永远调不起来」，用户只会归因于扩展本身。

**怎么做**：在 `lib/agent/openai-stream.ts` 请求体组装处加一层纯函数 `patchRequestBody(body, baseURL)`，按 `resolveProviderApi` 已有的 provider 识别逻辑扩展，不碰 Anthropic Messages 协议那一路。

- [ ] 未开始

### [x] P0 — 多标签页编排

**是什么**：`packages/extension/src/agent/tabTools.ts`（`open_new_tab` / `switch_to_tab` / `close_tab`）+ `TabsController.ts`（`summarizeTabs()` 每步在浏览器状态头部注入一张 Tab ID/URL/Title/Status/当前✅ 的 markdown 表，`syncTabs()` + `waitUntilTabLoaded()`，agent 开的标签页收进独立 tab group 做视觉隔离）。

**为什么**：Runi 现在只有 `browser_get_active_tab` + 原地 `NAVIGATE_TAB`，任何「搜一下 → 打开第 3 条结果 → 回来填表」的任务都做不了。

**怎么做**：复用现有的 `tab-target.ts` / `tab-conversation.ts` 按 tab 隔离基础设施。新开/关闭标签页是写操作，需要进 `permissions.ts` 的 `CONFIRM_TOOL_NAMES`。

- [x] 已完成 — 设计：`docs/superpowers/specs/2026-08-26-multi-tab-orchestration-design.md`，实施计划：`docs/superpowers/plans/2026-08-26-multi-tab-orchestration.md`（8 个任务全部落地，`pnpm compile`/`pnpm test`/`pnpm build` 均通过；手动浏览器多标签页冒烟测试未在本次实施会话中执行，需要在实际加载扩展后人工验证一遍）

### [ ] P1 — 按站点的持久指令 + `llms.txt`

**是什么**：`PageAgentCore.ts:492` 的 `instructions.getPageInstructions(url)`（按 URL 注入领域知识）+ `experimentalLlmsTxt`（抓站点 `llms.txt` 塞进 prompt）。

**为什么**：与 `lib/shortcuts.ts`（已有 `scope: page | selection | none`）同构，扩展成「按域名保存的常驻指令」几乎顺手。用户在自家 ERP/CRM 上教一次，之后每次都记得——这是拉开体验差距的功能，且在扩展形态下（用户自配）比 SDK 形态下（站点主人配）更有价值。

**怎么做**：新增按域名存储的指令表（`chrome.storage.local`，参照 `shortcuts.ts` 的结构），在 `system-prompt.ts` 组装时按当前 tab URL 查表注入。

- [ ] 未开始

### [ ] P1 — 页面位置感 + 容器内滚动

**是什么**：`dom/getPageInfo.ts` 每步给模型一行视口尺寸/总页高/上下方还有几屏/当前处在 x%；可滚动容器标成 `data-scrollable="top=...,bottom=..."`；`scroll(index)` 能滚指定容器（`actions.ts:275` 沿祖先链找最近可滚动祖先）。

**为什么**：`SCROLL_PAGE` 目前只有 window 滚动 + `scrollIntoView(selector)`，返回值要滚完才知道结果。后台管理系统、聊天记录、虚拟列表这类「内层 overflow 面板」现在基本滚不动。

**怎么做**：`browser_get_form` 采集时顺手收集可滚动容器（它已经在遍历 DOM），`browser_scroll` 支持按 `fieldId`/selector 滚容器而非只滚 window。

- [ ] 未开始

### [x] P2 — 统一的页面快照工具（小范围验证已完成，暂不上完整树表示）

**是什么**：一次调用拿到「带缩进的树 + `[n]` 序号可交互元素 + 穿插纯文本」，模型一眼看出页面长什么样、能点什么、层级关系如何。

**为什么**：Runi 现在 `browser_read_page`（正文）与 `browser_get_form`（字段）两次调用之间没有位置/层级关联——模型知道有个「提交」按钮，但不知道它在哪个区块里。

**怎么做**：改造量大，先做小范围验证：给 `browser_get_form` 加一个 `includeText: true` 选项，把正文按 DOM 顺序穿插进字段列表，验证收益后再决定要不要上完整的树表示。

- [x] 已完成——设计：`docs/superpowers/specs/2026-08-26-form-include-text-design.md`，实施计划：`docs/superpowers/plans/2026-08-26-form-include-text.md`（4 个任务全部落地并通过 `pnpm compile`/`pnpm test`/`pnpm build`，已合并到 main，commit 范围 `468c8fd..0ee13a0`）。人工验证结论：`precedingText` 确实有用——先不急着投入完整的 `[n]` 序号 + 缩进树表示，等后续再有明确信号时再开新的待办跟进。

### [ ] P2 — 用户接管检测

**是什么**：`types.ts:232` / `PageAgentCore.ts:623` 的 `user_takeover` 历史事件，检测到后往下一轮 prompt 塞 `<sys>User took over control and made changes to the page</sys>`。

**为什么**：`agent-overlay.ts` 全程 `pointer-events:none`（设计上刻意如此，见 `2026-08-25-execution-overlay-design.md` §3.1，比它的全遮挡阻断更对），但代价是用户中途点了什么、手动跳了页，agent 完全不知道，还在用过期的 `fieldId` 句柄操作。已有指纹校验兜底失败，但事前告知比事后失败体验更好。

**怎么做**：遮罩挂载期间在 content script 监听真实用户输入（`isTrusted: true` 的 click/keydown），发生后下一轮工具结果里追加一条系统观察。

- [ ] 未开始

### [ ] P2 — 送模型前的正文脱敏

**是什么**：`transformPageContent(content)` 钩子，调用方可对页面正文做脱敏处理。

**为什么**：Runi 表单层做得更好（密码/支付字段在 `planFormFill` 阶段就丢弃，根本不到页面），但 `browser_read_page` 的**正文**是原样送出去的——邮箱、手机号、身份证号照样出境。作为隐私优先定位的扩展（provider 配置明确不上云同步），这块补上更自洽。

**怎么做**：在 `browser_read_page` 返回前加一层轻量正则脱敏（邮箱/手机号/身份证号模式），可配置开关。

- [ ] 未开始

### [ ] P2 — 显式任务成败信号

**是什么**：`done(success, text)` 的 `success: boolean`，UI 直接据此显示成功/失败。

**为什么**：Runi 一轮结束就是一段文本，「任务没做成」和「任务做成了」在 UI 上没区别，历史记录里也没法筛选/统计。

**怎么做**：需要模型在收尾时显式声明成败，涉及 system prompt 与消息 schema 改动，优先级最低，等前面几项验证完 pattern 再动。

- [ ] 未开始

## 四、明确不追（我们更强，避免为了对标倒退）

1. **权限模型**——它没有确认门。Deny-First + 每回合确认 + 表单提交每次必问，是扩展形态下唯一负责任的做法。
2. **写入校验**——写前写后指纹 + 回读，落不了地就报失败；它只 dispatch 完事件就返回成功。
3. **敏感字段硬阻断**——在请求规划阶段就丢弃，不是靠 prompt 约束。
4. **流式输出 + 附件（PDF/图片）+ 划词提问**——它是非流式 `invoke`，没有对话形态。
5. **安全边界**——`page-resource-fetch.ts` 的 SSRF 防护、非 http(s) 跳转双重拦截；它的 `execute_javascript` 默认关闭但架构上就在那，是个隐患。
6. **测试覆盖**——9000+ 行 `lib/` 带成套单测；它 core 只有一个 365 行的测试文件。
