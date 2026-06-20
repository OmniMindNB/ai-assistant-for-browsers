# 浏览器 AI 辅助插件 — 研究报告与实施方案

> 研究日期: 2026-06-13
> 目标: 构建一个"浏览器版 Claude Code"——具有深度浏览器操控能力的 AI 辅助插件

---

## 目录

1. [核心结论](#1-核心结论)
2. [Pi 项目深度分析](#2-pi-项目深度分析)
3. [Claude Code 源码泄露——架构洞察](#3-claude-code-源码泄露架构洞察)
4. [浏览器 AI Agent 生态现状](#4-浏览器-ai-agent-生态现状)
5. [可行性评估](#5-可行性评估)
6. [推荐实施方案](#6-推荐实施方案)
7. [风险与挑战](#7-风险与挑战)

---

## 1. 核心结论

### Pi 项目 **强烈推荐** 作为项目的核心基础

| 维度 | 评估 |
|------|------|
| 技术匹配度 | ⭐⭐⭐⭐⭐ — Agent 核心 + 扩展系统 + 已有浏览器 CDP 扩展 |
| 开源协议 | MIT — 可商用，无限制 |
| 社区活跃度 | ~60K Stars, ~220 贡献者, 持续更新 |
| 浏览器生态 | 已有 6+ 浏览器 CDP 扩展可直接参考/复用 |
| Claude Code 架构参考 | 权限系统、上下文压缩、扩展体系可直接借鉴 |

### 推荐策略: **基于 Pi 核心 + 参考 Claude Code 架构 + 自研浏览器特有模块**

---

## 2. Pi 项目深度分析

### 2.1 项目概况

- **仓库**: [github.com/earendil-works/pi](https://github.com/earendil-works/pi)
- **作者**: Mario Zechner (badlogic, libGDX 创始人)
- **语言**: TypeScript (monorepo)
- **协议**: MIT
- **Stars**: ~60,000
- **描述**: "AI agent toolkit: coding agent CLI, unified LLM API, TUI & web UI libraries"

### 2.2 Monorepo 包结构

| 包名 | 用途 | 对我们的价值 |
|------|------|-------------|
| `@earendil-works/pi-agent-core` | Agent 运行时：循环、工具调用、状态管理 | 🔥 **核心复用** |
| `@earendil-works/pi-ai` | 统一 LLM API（15+ 厂商） | 🔥 **直接使用** |
| `@earendil-works/pi-tui` | 终端 UI 组件 | ⚠️ 浏览器插件不需要 |
| `@earendil-works/pi-web-ui` | Web UI 组件 | ✅ 可复用部分 |
| `@earendil-works/pi-coding-agent` | CLI 入口 | ❌ 不适用于浏览器 |

### 2.3 三层 Agent API 架构（关键）

```
┌──────────────────────────────────────────────┐
│          Layer 3: AgentHarness                │
│  持久化 + 阶段状态机 + Hooks/Extensions       │
│  阶段: idle → turn → compaction → retry       │
├──────────────────────────────────────────────┤
│          Layer 2: Agent                       │
│  状态管理 + 订阅 + Steer/FollowUp 队列        │
│  agent.prompt() / agent.steer() / subscribe() │
├──────────────────────────────────────────────┤
│          Layer 1: agentLoop                   │
│  无状态异步生成器，纯 LLM ↔ Tools 循环        │
│  for await (event of agentLoop(...))          │
└──────────────────────────────────────────────┘
```

**关键设计**:
- `agentLoop` 是无状态的纯函数——可以在任何环境运行（包括浏览器 Service Worker）
- `Agent` 包装了状态，支持中途干预（steer）和完成后追加（followUp）
- `AgentHarness` 添加了持久化、阶段管理和完整的 hook 系统

### 2.4 扩展系统（核心价值）

Pi 的扩展系统通过 TypeScript 模块实现，提供以下能力：

```typescript
// 注册自定义工具（LLM 可调用）
pi.registerTool({
  name: "browser_click",
  description: "Click on an element in the current page",
  parameters: Type.Object({
    selector: Type.String(),
  }),
  execute: async (toolCallId, params, signal) => {
    // 通过 CDP 执行点击
    return { content: [{ type: "text", text: "Clicked" }], details: {} };
  },
});

// 注册自定义命令
pi.registerCommand("/screenshot", async (ctx) => { ... });

// 注册快捷键
pi.registerShortcut("Ctrl+Shift+B", async (ctx) => { ... });

// 拦截事件
pi.on("before_tool_call", async (event) => { ... });
pi.on("after_tool_call", async (event) => { ... });
```

**扩展加载方式**:
- `~/.pi/agent/extensions/*.ts` — 全局扩展（所有项目可用）
- `.pi/extensions/*.ts` — 项目级扩展
- npm 包安装 — `pi install npm:my-extension`
- 快速测试 — `pi -e ./path.ts`

### 2.5 已有浏览器 CDP 扩展（关键发现 🔥）

Pi 生态中已有 **6+ 个浏览器自动化扩展**，证明了这个架构的可行性：

| 扩展 | 特点 | 对我们的参考价值 |
|------|------|-----------------|
| **pi-browser-harness** | 驱动用户真实 Chrome，保留登录态；CDP compositor 级分发 | 🔥🔥🔥 最接近我们的目标 |
| **@amaster.ai/pi-browser-use** | 包装 chrome-devtools-mcp，统一 browser_ 前缀工具 | 🔥🔥 MCP 集成参考 |
| **pi-agent-browser-native** | 单 agent_browser 原生工具；紧凑页面快照 | 🔥🔥 工具设计参考 |
| **@narumitw/pi-chrome-devtools** | 原生 Pi 扩展：list_pages, select_page, navigate, evaluate, screenshot | 🔥🔥 CDP 工具封装参考 |
| **larsderidder/pi-browser** | Playwright 后端，50+ 工具 | ✅ 工具列表参考 |
| **pi-ui-bridge** | 浏览器 overlay 选择 DOM 元素，映射回源码 | ✅ UI 交互参考 |

**共同架构模式**:
```
Pi Agent Core ←→ CDP WebSocket ←→ Chrome/Chromium
                    ↕
            pi.registerTool() 注册浏览器工具
```

---

## 3. Claude Code 源码泄露——架构洞察

### 3.1 泄露概况

- **时间**: 2026 年 3 月 31 日
- **原因**: npm 包 (v2.1.88) 的 `.npmignore` 失误，打包了 59.8MB 的 source map
- **规模**: ~1,900 个 TypeScript 文件，~512,000 行代码
- **运行时**: Bun（非 Node.js）
- **终端 UI**: React + Ink

### 3.2 核心架构（对我们最重要的部分）

#### 3.2.1 核心循环 — 出乎意料地简单

```typescript
async function agentLoop(messages: Message[]) {
  while (true) {
    const response = await callModel(messages);
    if (!response.toolCalls?.length) return response.text;
    const toolResults = await executeTools(response.toolCalls);
    messages = [...messages, response, ...toolResults];
  }
}
```

**关键洞察**: 50 万行代码中约 **98.4% 不在这个循环本身**，而在围绕它的工程基础设施上。对浏览器的启示：**核心循环可以复用 Pi 的 agentLoop，我们的工作重点在浏览器专属的工具系统和安全机制上。**

#### 3.2.2 工具系统 — 40+ 原子化工具

每个工具是自包含的独立单元：
- `name` + `description`（给模型看的细粒度 Prompt）
- Zod Schema（参数校验）
- Permission Model（权限门控）
- `execute()`（实际执行逻辑）

**设计原则**: 工具质量 > 工具数量。40 个精心设计的工具胜过 800 个模糊定义的。

#### 3.2.3 七层权限系统（浏览器场景的核心参考）

```
Layer 1: Always Allow      — 只读操作（读页面内容）
Layer 2: Auto Allow        — 匹配白名单的写操作
Layer 3: ML Classifier     — 训练过的分类器判断命令危险性
Layer 4: Per-Session Allow — 当前会话已授权的操作
Layer 5: Explicit Confirm  — 高危操作必须确认
Layer 6: Directory Scoped  — 限制操作范围
Layer 7: Global Deny       — 硬编码禁止列表
```

**Deny-First 原则**: 即使 allow 规则更具体，deny 规则也始终优先。模型无法靠"说服"绕过安全检查。

**对浏览器场景的启示**: 这是构建浏览器 AI 插件安全系统的蓝图。浏览器操作的安全风险甚至高于文件系统操作（XSS、隐私泄露、恶意重定向等），需要更严格的权限控制。

#### 3.2.4 五阶段上下文压缩

| 阶段 | 策略 | 触发条件 |
|------|------|---------|
| Budget Reduction | 每条消息大小上限 | 始终活跃 |
| Snip | 修剪较早历史 | Feature-gated |
| MicroCompact | 缓存感知细粒度压缩 | 基于时间 |
| Context Collapse | 虚拟投影（非破坏性） | Feature-gated |
| Auto-Compact | 模型生成结构化摘要 | 最后手段（熔断器保护） |

**对浏览器场景的启示**: 浏览网页会快速消耗上下文（DOM 内容、截图等）。Claude Code 的分层压缩策略可以直接借鉴。

#### 3.2.5 扩展体系 — 四层渐进式

```
CLAUDE.md (始终加载的上下文)
    → Skills (按需加载的知识/工作流)
        → Hooks (生命周期自动化)
            → Plugins (打包发布)
```

**对浏览器场景的启示**: 浏览器的扩展体系应该分层：基础配置 → 网站专属 Skills → 自动化 Hooks → 可分享的插件包。

#### 3.2.6 其他关键设计

| 设计 | 说明 | 浏览器场景适用性 |
|------|------|-----------------|
| **Coordinator-Worker + 邮箱模式** | Worker 请求 → Coordinator 审批 → 原子认领 | 多标签页并行操作协调 |
| **Bash 安全子系统** | tree-sitter WASM 解析 AST + 22 个验证器 | JavaScript 脚本安全验证 |
| **Anti-Distillation** | 注入假工具定义污染训练数据 | ⚠️ 可选 |
| **Agent 可观测性** | OpenTelemetry + 语义 Span + 挫败感指标 | 用户行为分析 |
| **Harness 哲学** | 模型 = 大脑，Harness = 手+免疫系统 | 核心理念 |

---

## 4. 浏览器 AI Agent 生态现状

### 4.1 主流架构模式

所有 2025-2026 年的浏览器 AI Agent 都遵循相同的三层架构：

```
┌──────────────┐   MCP/STDIO    ┌──────────────┐   WebSocket   ┌────────────────┐
│  AI Client   │ ◄────────────► │  MCP Server   │ ◄───────────► │ Chrome Extension│
│ (Claude, etc)│                │ (Node bridge) │               │ (Background SW)│
└──────────────┘                └──────────────┘               └───────┬────────┘
                                                                       │
                                                                chrome.debugger API
                                                                       │
                                                              ┌────────┴────────┐
                                                              │   Web Pages     │
                                                              │ (CDP commands)  │
                                                              └─────────────────┘
```

### 4.2 两条技术路线

| 路线 | 机制 | 优点 | 缺点 |
|------|------|------|------|
| **Extension-based** | Chrome Extension + `chrome.debugger` API | 使用真实浏览器会话/登录态 | 需要安装扩展 |
| **Remote Debugging** | Chrome 启动参数 `--remote-debugging-port=9222` | 无需扩展，直接 CDP | 需要单独启动浏览器 |

**推荐**: Extension-based 路线更符合"浏览器插件"的产品形态。

### 4.3 竞品分析

| 产品 | 核心能力 | 与我方差异 |
|------|---------|-----------|
| **ApexAgent** | 完整 CDP + DevTools 检查 + 扩展管理 | 最接近我们的目标，但缺少深度 AI Agent 架构 |
| **BrowserPilot** | 29 MCP 工具 + HMAC 安全 | 工具较少，没有代码生成能力 |
| **QuillMonkey** | AI 生成用户脚本（TamperMonkey 替代） | 只有脚本注入，没有浏览器配置修改 |
| **BrowseMCP** | WebSocket + MCP | 标准化程度高，但定制性弱 |
| **Crawlio** | 100 工具 + 17 框架检测 + JIT 运行时 | 偏向自动化测试，不是 AI 助手 |

**我们的差异化**: 
- 浏览器版"Claude Code"——不仅操控页面，还能修改浏览器配置/flags
- 基于 Pi 的 Agent 架构，比竞品有更深层的 AI 推理能力
- 完整的权限/安全体系

---

## 5. 可行性评估

### 5.1 技术可行性

| 能力需求 | 实现方式 | 可行度 |
|---------|---------|--------|
| 读取/分析页面内容 | CDP `Runtime.evaluate` + `DOM.getDocument` | ✅ 成熟 |
| 执行脚本修改页面 | CDP `Runtime.evaluate` + 用户脚本注入 | ✅ 成熟 |
| 操控页面交互（点击/输入/滚动） | CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` | ✅ 成熟 |
| 截图/视觉分析 | CDP `Page.captureScreenshot` + Vision LLM | ✅ 成熟 |
| **修改浏览器配置** | `chrome.privacy` API / `chrome.settings` API | ✅ 可行 |
| **启用/禁用浏览器 flags** | `chrome.experimental.*` API (有限) / 引导用户访问 `chrome://flags` | ⚠️ 部分可行 |
| **管理扩展** | `chrome.management` API | ✅ 可行 |
| Agent 核心循环 | 复用 Pi `agentLoop` | ✅ 直接可用 |
| 多 LLM 厂商支持 | 复用 Pi `pi-ai` (15+ 厂商) | ✅ 直接可用 |
| 安全/权限系统 | 参考 Claude Code 7 层体系 | ✅ 设计可复用 |
| 上下文管理（长会话） | 参考 Claude Code 5 阶段压缩 | ✅ 设计可复用 |

### 5.2 浏览器 API 限制分析

| 限制 | 影响 | 对策 |
|------|------|------|
| `chrome://flags` 无法通过扩展 API 直接修改 | 不能程序化修改 flags | 引导用户手动操作 + 提供 deep-link |
| `chrome.debugger` 每个标签页只能 attach 一个 | 多标签页并发受限 | 实现标签页锁定 + 队列调度 |
| Service Worker 生命周期有限 (30s) | 长会话可能被中断 | 使用 native messaging host 保持连接 |
| CSP (Content Security Policy) | 可能阻止脚本注入 | 通过 CDP 绕过（CDP 不受 CSP 限制） |
| Manifest V3 限制 | `eval()` 等受限 | 通过 CDP `Runtime.evaluate` 执行 |

---

## 6. 推荐实施方案

### 6.1 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                   Browser AI Assistant                     │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │  Side Panel   │  │  Popup UI    │  │  Content Script │ │
│  │  (主界面)     │  │  (快捷操作)   │  │  (页面注入)     │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬─────────┘ │
│         │                 │                   │           │
│         └─────────────────┼───────────────────┘           │
│                           │                               │
│                  ┌────────┴────────┐                      │
│                  │  Background SW  │                      │
│                  │  (消息路由中心)  │                      │
│                  └────────┬────────┘                      │
│                           │                               │
│         ┌─────────────────┼─────────────────┐             │
│         │                 │                  │             │
│  ┌──────┴──────┐  ┌───────┴───────┐  ┌──────┴──────┐    │
│  │ Agent Core   │  │ CDP Bridge    │  │ Browser API │    │
│  │ (Pi agent-   │  │ (chrome.      │  │ (chrome.    │    │
│  │  core 适配)  │  │  debugger)    │  │  privacy,   │    │
│  │              │  │               │  │  management, │    │
│  │              │  │               │  │  settings)   │    │
│  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘ │
│         │                  │                   │         │
│         └──────────────────┼───────────────────┘         │
│                            │                              │
│                   ┌────────┴────────┐                    │
│                   │  LLM Providers  │                    │
│                   │  (pi-ai 适配)    │                    │
│                   └─────────────────┘                    │
│                                                            │
└──────────────────────────────────────────────────────────┘
```

### 6.2 技术选型推荐

| 层级 | 推荐方案 | 理由 |
|------|---------|------|
| **Agent 核心** | `@earendil-works/pi-agent-core` | 成熟的 agentLoop + 工具系统 + 状态管理 |
| **LLM 调用** | `@earendil-works/pi-ai` | 统一 API，15+ 厂商，直接可用 |
| **浏览器 CDP** | `chrome.debugger` API | Extension-based 路线，使用真实浏览器 |
| **UI 框架** | React + TailwindCSS + shadcn/ui | Chrome Side Panel 实现 |
| **安全验证** | 参考 Claude Code 的 tree-sitter WASM + Zod Schema | 脚本安全验证 |
| **上下文管理** | 参考 Claude Code 5 阶段压缩 | 长会话支持 |
| **构建工具** | Vite + CRXJS | Chrome Extension 现代构建 |

### 6.3 分阶段实施路线图

#### Phase 1: 核心骨架 (4-6 周)

**目标**: 基础问答 + 简单页面操控

```
□ 搭建 Chrome Extension 项目骨架 (Manifest V3)
□ 集成 pi-agent-core，实现基础 agentLoop
□ 实现 Side Panel UI (聊天界面)
□ 实现 5 个核心浏览器工具:
   - browser_read_page    (读取页面内容)
   - browser_evaluate     (执行 JavaScript)
   - browser_click        (点击元素)
   - browser_type         (输入文本)
   - browser_screenshot   (截图)
□ 实现基础权限确认弹窗
□ 集成 pi-ai，支持至少 Claude + OpenAI
```

#### Phase 2: 深度操控 (6-8 周)

**目标**: 脚本生成 + 浏览器配置修改

```
□ 扩展工具集到 ~20 个:
   - browser_navigate      (导航)
   - browser_scroll        (滚动)
   - browser_fill_form     (填表)
   - browser_get_network   (网络请求查看)
   - browser_get_storage   (localStorage/Cookie 查看)
   - browser_inject_script (注入用户脚本，持久化)
   - browser_modify_style  (修改页面样式)
   - browser_get_dom        (DOM 检查)
   - browser_settings_get   (读取浏览器设置)
   - browser_settings_set   (修改浏览器设置)
   - browser_extensions_list (列出扩展)
   - browser_flags_guide     (引导修改 flags)
□ 实现 AI 脚本生成 + 预览 + 一键注入
□ 实现页面修改历史/撤销功能
□ 实现网站专属配置 (.site.md 类似 CLAUDE.md)
□ 完善权限系统（参考 Claude Code 7 层模型）
```

#### Phase 3: 高级能力 (8-12 周)

**目标**: 多标签页协调 + 自动化 + 可观测性

```
□ 多标签页 Agent 协调 (Coordinator-Worker 模式)
□ 浏览器自动化录制/回放
□ 上下文压缩（长会话支持）
□ 用户行为分析（参考 Claude Code ABA）
□ 扩展/插件市场
□ Skills 系统（可分享的自动化脚本）
□ 语音交互（可选）
□ 自定义 slash 命令
```

### 6.4 关键设计决策

#### 决策 1: 直接复用 Pi vs 自研 Agent 核心

**推荐**: 直接复用 `pi-agent-core`。

理由:
- 已有成熟的 agentLoop + 状态管理 + 扩展系统
- 已有 6+ 浏览器 CDP 扩展参考实现
- MIT 协议，无法律风险
- 社区活跃，持续维护

#### 决策 2: Extension-based vs Remote Debugging

**推荐**: Extension-based (Chrome Extension + `chrome.debugger`)。

理由:
- 符合"浏览器插件"产品形态
- 使用用户真实浏览器会话
- 不需要额外启动浏览器进程
- 可通过 Chrome Web Store 分发

#### 决策 3: 安全模型设计

**推荐**: 完全参考 Claude Code 的 Deny-First 7 层权限系统，并增加：

```
浏览器专属安全层:
  Layer 8: CSP 边界 — 限制注入脚本的作用域
  Layer 9: 敏感数据过滤 — 自动遮蔽密码/信用卡等字段
  Layer 10: 域名白名单/黑名单 — 限制工具在特定网站上的使用
```

---

## 7. 风险与挑战

| 风险 | 级别 | 对策 |
|------|------|------|
| **Chrome Web Store 审核** | 高 | 需要详细的隐私说明；限制工具权限范围；提供透明的用户控制 |
| **Manifest V3 限制** | 中 | Service Worker 生命周期问题可通过 native messaging 解决 |
| **CDP 单连接限制** | 中 | 实现标签页锁定 + 队列调度 |
| **LLM 上下文快速消耗** | 中 | 实现分层压缩；页面内容智能摘要 |
| **Prompt Injection** | 高 | 严格隔离 AI 决策和实际执行；多层验证 |
| **隐私合规** | 高 | 所有数据本地处理；明确告知用户数据流向 |
| **Pi 项目依赖** | 低 | MIT 协议，可 fork；API 已稳定 |
| **浏览器 API 变更** | 中 | 跟随 Chrome 发布节奏；抽象浏览器 API 层 |

---

## 附录 A: 关键参考资源

### Pi 项目
- 主仓库: https://github.com/earendil-works/pi
- Agent 核心文档: https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
- 扩展系统文档: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi Browser Harness: https://socket.dev/npm/package/pi-browser-harness
- Pi Agent Browser Native: https://www.npmjs.com/package/pi-agent-browser-native
- Pi Chrome DevTools: https://www.npmjs.com/package/@narumitw/pi-chrome-devtools

### Claude Code 架构分析
- WaveSpeed 深度分析: https://wavespeed.ai/blog/posts/claude-code-architecture-leaked-source-deep-dive/
- DeepWiki 架构文档: https://deepwiki.com/anthropics/claude-code/3-github-automation
- 源码分析 (VILA-Lab): https://github.com/VILA-Lab/Dive-into-Claude-Code
- 36氪报道: https://36kr.com/p/3747435652596484
- Ars Technica: 搜索 "Claude Code CLI source code leaks"

### 竞品参考
- ApexAgent: https://github.com/RTBRuhan/ApexAgent
- BrowserPilot: Chrome Web Store
- QuillMonkey: Chrome Web Store
- BrowseMCP: https://github.com/mantou132/browser4agent
- Open Browser Control: https://github.com/smankoo/open-browser-control

---

## 附录 B: 推荐工具集清单（浏览器版 Claude Code）

### 页面操作类 (10 个)
1. `browser_read_page` — 读取页面文本/结构化内容
2. `browser_evaluate` — 执行 JavaScript 并返回结果
3. `browser_click` — 点击元素
4. `browser_type` — 输入文本
5. `browser_scroll` — 滚动页面
6. `browser_hover` — 悬停元素
7. `browser_select` — 选择下拉选项
8. `browser_drag` — 拖拽元素
9. `browser_fill_form` — 批量填写表单
10. `browser_screenshot` — 截图（支持全页/元素级）

### 页面分析类 (8 个)
11. `browser_get_dom` — 获取 DOM 结构
12. `browser_get_styles` — 获取计算样式
13. `browser_get_network` — 查看网络请求
14. `browser_get_storage` — 查看 localStorage/Cookie
15. `browser_get_console` — 查看控制台输出
16. `browser_query_selector` — CSS 选择器查询
17. `browser_get_accessibility` — 获取无障碍树
18. `browser_analyze_screenshot` — Vision 分析截图

### 页面修改类 (6 个)
19. `browser_inject_script` — 注入持久化用户脚本
20. `browser_modify_style` — 修改页面样式
21. `browser_modify_dom` — 修改 DOM 结构
22. `browser_set_storage` — 写入 localStorage/Cookie
23. `browser_block_request` — 拦截/修改网络请求
24. `browser_revert_changes` — 撤销修改

### 浏览器控制类 (8 个)
25. `browser_navigate` — 导航到 URL
26. `browser_tabs_list` — 列出所有标签页
27. `browser_tabs_switch` — 切换标签页
28. `browser_tabs_close` — 关闭标签页
29. `browser_settings_get` — 读取浏览器设置
30. `browser_settings_set` — 修改浏览器设置
31. `browser_extensions_list` — 列出扩展
32. `browser_flags_guide` — 引导修改 flags

### 自动化类 (4 个)
33. `browser_record_start` — 开始录制操作
34. `browser_record_stop` — 停止录制
35. `browser_replay` — 回放录制的操作
36. `browser_schedule` — 定时执行任务

---

*报告完毕。下一步建议：基于 Pi 项目创建一个最小可行原型 (MVP)，验证核心架构在 Chrome Extension 环境中的可行性。*
