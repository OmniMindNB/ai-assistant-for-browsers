# Aluminum

**中文** | [English](README.en.md)

> 值得信赖的浏览器页面 Agent —— 修改页面前逐项征求你的确认，回答基于页面证据而非泛泛而谈；接入你自己选的、自己持有 Key 的模型，对话历史只留在本地、不上传云端。

## 核心功能

- 🔒 **逐项确认才动手**：改样式/DOM、点击/输入/滚动/跳转、注入脚本等写入类操作，逐轮征求你的确认后才会执行——Deny-First 权限模型 + 注入脚本静态扫描（AST 危险 API 检测）+ SSRF 防护
- 🔍 **证据驱动的分析**：自动读取页面文本 / DOM / 脚本 / 样式 / 计算样式 / 截图，回答「这个效果怎么实现的」时点名引用具体代码证据，而不是给泛泛的描述
- 🔑 **自带模型**：接入任意 OpenAI 兼容的 Provider / API Key / 模型，不绑定单一厂商
- 🗂️ **本地优先**：对话历史只存在本地 IndexedDB，不同步到任何云端
- 📄 **页面总结 / 理解辅助**：一键提炼要点、解释名词、基于页面上下文问答
- ⚡ **Skill 体系**：把常用操作固化为可复用 Skill 并集中管理

## 技术栈

| 维度 | 选型 |
|------|------|
| 扩展框架 | [WXT](https://wxt.dev/)（Manifest V3） |
| UI | React 18 + TypeScript + Tailwind CSS |
| Agent | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)（工具调用循环，OpenAI 兼容 Chat Completions） |
| 状态 | Zustand |
| 存储 | Dexie（IndexedDB） + `chrome.storage` |
| 测试 | Vitest |
| 包管理 | pnpm |

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发（自动加载扩展并热更新）
pnpm dev

# 生产构建，产物在 .output/chrome-mv3
pnpm build

# 类型检查
pnpm compile

# 运行测试
pnpm test
```

> 本机若未安装 Google Chrome，可在 [web-ext.config.ts](web-ext.config.ts) 中将浏览器二进制指向 Microsoft Edge 等 Chromium 内核浏览器。

加载未打包扩展：浏览器进入 `扩展` → 开启`开发者模式` → `加载解压缩的扩展` → 选择 `.output/chrome-mv3`。

## 项目结构

```
entrypoints/        # 扩展入口
  background.ts     # Service Worker：消息路由中心，唯一持有 tabs/scripting 权限
  content.ts        # Content Script：页面提取（Readability）/ 划词
  sidepanel/        # 侧边栏 React 应用（对话 UI、确认卡片）
  options/          # 设置 / Provider & API Key 管理
lib/                # 共享库
  messaging.ts      # 三端统一消息协议
  agent/            # Agent 循环与工具调用
    agent.ts        # Agent 封装（model / tools / 生命周期钩子）
    tools.ts        # browser_* 工具定义（只读 / 写入）
    permissions.ts  # Deny-First 权限分级（always_allow / confirm / deny）
    confirm-gate.ts # 每轮首次写入弹出确认，结果当轮复用
    stream.ts       # SSE 流式响应解析
  db.ts             # IndexedDB（Dexie）
  settings.ts       # Provider 配置存储封装
  security.ts       # 注入脚本静态安全扫描（acorn AST）
docs/               # 文档（文档驱动开发）
```

## 文档

本项目采用**文档驱动开发**。先文档后代码，文档为单一事实来源。

- [文档体系说明](docs/README.md)
- [产品需求](docs/plan.md)
- [技术规划](docs/technical-plan.md)
- [进度看板](docs/PROGRESS.md)
- [架构决策记录 (ADR)](docs/adr/)

## 开发状态

🚧 开发中 —— Phase 0/1/2 与 Agent Phase B（写入/交互工具 + 权限确认 UI）已完成，
Agent Phase A（工具调用循环）验收中，Agent Phase C（CDP / 多标签 / 抓取导出）未开始。
详见[进度看板](docs/PROGRESS.md)。
