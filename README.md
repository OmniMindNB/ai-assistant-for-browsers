# Runi

**中文** | [English](README.en.md)

> 值得信赖的浏览器页面 Agent —— 每轮第一次写操作前征求确认，决定仅在该轮内复用；回答基于页面证据而非泛泛而谈。持久化对话历史只留在本地；你发起请求后，当前提示词、近期对话上下文和相关页面结果可能直接发送到你配置的 AI Provider。

> 网页，如你所愿。

## 核心功能

- 🔒 **确认后才动手**：Deny-First 权限模型把工具分成「只读直接放行 / 写操作需确认 / 未知工具一律拒绝」三档；每轮第一次写操作执行前弹出确认卡片，决定仅在该轮内复用。`browser_navigate` 在权限层和后台双重校验，只允许 http(s)；页面外部资源抓取会拒绝环回、内网、链路本地与 IPv4-mapped IPv6 地址
- 🔍 **证据驱动的分析**：可读取页面正文 / DOM / HTML / 脚本 / 样式表 / 计算样式 / 截图；`browser_inspect_page_implementation` 一次调用汇总全部证据并给出关键词匹配的 `evidenceSummary`，回答「这个效果怎么实现的」时点名引用具体代码，而不是泛泛描述
- 🖐️ **页面操作**：确认通过后可改样式、改 DOM、点击、输入、选择下拉、滚动、跳转、写 storage。工具调用有预算上限（默认 12 次读取分析，用户批准写操作后放宽到 24 次），预算耗尽只允许再生成一次最终回答
- 🔑 **自带模型**：支持 OpenAI 兼容的 Chat Completions 与 Anthropic Messages 两种协议，内置 DeepSeek / OpenAI / 通义千问 / 智谱 GLM / Moonshot / 本地 Ollama 预设，也可完全自定义端点；可配置多个 Provider 与多个模型，在输入框里直接切换
- 🗂️ **本地优先**：对话历史存在本地 IndexedDB，Provider 配置与界面偏好存在 `chrome.storage.local`，不同步到任何云端，也没有开发者后端与分析 SDK
- 📎 **本地文件上下文**：单条消息最多附加 5 个文件，支持文本（最多 30,000 字符）、图片（≤ 5 MB）和 PDF（≤ 20 MB，本地提取最多 60,000 字符，不含 OCR）。PDF 在 Worker 中本地解析并显示进度，支持拖拽；PDF 正文只用于当前一轮，历史中只保留文件元数据
- ⚡ **快捷指令**：内置「总结本页 / 解释选中内容 / 翻译选中内容」，可编辑、删除、恢复默认，也可新增自定义指令；每条指令有明确的上下文作用域（当前页面 / 已选文本 / 不使用网页上下文）。输入框输入 `/` 即可唤出
- 🖱️ **划词提问**：在页面上选中文本后就地弹出按钮，点击直接打开侧边栏并带上引用内容
- 🪟 **按标签页独立会话**：侧边栏按标签页单独开启与绑定，切回某个标签页会恢复它自己的对话
- 🌓 **界面偏好**：中文 / English / 跟随浏览器三态语言切换，浅色 / 深色 / 跟随系统主题；消息可编辑重发，历史会话可在抽屉中检索、打开与删除；工具调用过程以步骤时间线实时展示

## 技术栈

| 维度 | 选型 |
|------|------|
| 扩展框架 | [WXT](https://wxt.dev/)（Manifest V3，`minimum_chrome_version: 138`） |
| UI | React 19 + TypeScript + Tailwind CSS v4 |
| Agent | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)（工具调用循环；OpenAI 兼容 Chat Completions + Anthropic Messages 双协议） |
| 状态 | Zustand |
| 存储 | Dexie（IndexedDB） + `chrome.storage.local` |
| 页面解析 | `@mozilla/readability`（正文提取）、`pdfjs-dist`（本地 PDF 文本提取） |
| 渲染 | react-markdown + remark-gfm + highlight.js |
| 测试 | Vitest（`unit` 为 node 环境的 `lib/**/*.test.ts`，`ui` 为 jsdom 环境的组件测试） |
| 包管理 | pnpm |

扩展申请的权限：`sidePanel`、`storage`、`scripting`、`activeTab`、`tabs`，以及 `<all_urls>` 主机权限。

## 快速开始

```bash
# 安装依赖（postinstall 会执行 wxt prepare）
pnpm install

# 启动开发（自动加载扩展并热更新）
pnpm dev

# 生产构建，产物在 .output/chrome-mv3
pnpm build

# 打包成可上传的 zip
pnpm zip

# 类型检查
pnpm compile

# 运行测试
pnpm test

# 校验 PDF.js 静态资源是否已正确产出
pnpm verify:pdfjs-assets
```

Firefox 目标使用 `pnpm dev:firefox` / `pnpm build:firefox` / `pnpm zip:firefox`（主力目标仍是 Chromium）。

加载未打包扩展：浏览器进入 `扩展` → 开启 `开发者模式` → `加载解压缩的扩展` → 选择 `.output/chrome-mv3`。

想在开发期直接对接真实模型，可在 [lib/dev-config.ts](lib/dev-config.ts) 里填入 Key 并把 `DEV_PROVIDER.enabled` 置为 `true`，加载时会自动注册一个 Provider——**不要把真实 Key 提交进仓库**。

## 项目结构

```
entrypoints/        # 扩展入口
  background.ts     # Service Worker：消息路由中心，唯一持有 tabs/scripting 权限
  content.ts        # Content Script：正文提取（Readability）/ 划词 / 划词提问气泡
  sidepanel/        # 侧边栏 React 应用
    store.ts        # Zustand：会话状态、附件、Agent 驱动
    App.tsx         # 消息流、确认卡片、活动步骤
    components/     # 输入区、快捷指令、历史抽屉、附件 chip 等
  options/          # 设置页（Provider / 外观 / 语言 / 快捷指令）
components/         # 设置页共享组件（侧边栏内的紧凑设置也复用）
lib/                # 共享库
  messaging.ts      # 三端统一消息协议
  agent/            # Agent 循环与工具调用
    agent.ts        # Agent 封装（model / tools / 生命周期钩子 / 上下文压缩）
    tools.ts        # browser_* 工具定义（10 个只读 + 8 个写入/交互）
    permissions.ts  # Deny-First 权限分级（always_allow / confirm / deny）
    confirm-gate.ts # 每轮首次写入弹出确认，结果当轮复用
    tool-policy.ts  # 工具调用预算、重复失败熔断、收敛终止
    system-prompt.ts        # 系统提示词（写工具清单由权限表推导）
    stream-shared.ts        # 协议无关的流式解析公共逻辑
    openai-stream.ts        # OpenAI 兼容 Chat Completions streamFn
    anthropic-stream.ts     # Anthropic Messages streamFn
    activity-steps.ts       # 本轮工具调用的步骤时间线
    tab-conversation.ts     # 标签页 ↔ 会话绑定
  chat/             # 附件（文本/图片/PDF）、PDF 本地提取与解析队列
  i18n/             # zh / en 词典与 useTranslation()
  shortcuts.ts      # 快捷指令存储与校验（内置 + 自定义）
  theme.ts          # 浅色 / 深色 / 跟随系统
  db.ts             # IndexedDB（Dexie）会话持久化
  settings.ts       # Provider 配置与预设
  page-resource-fetch.ts    # 页面资源抓取的 SSRF 防护
docs/               # 文档（文档驱动开发）
```

## 文档

本项目采用**文档驱动开发**。先文档后代码，文档为单一事实来源。

- [文档体系说明](docs/README.md)
- [进度看板与变更日志](docs/PROGRESS.md)
- [架构决策记录 (ADR)](docs/adr/)
- [功能规格 (Spec)](docs/specs/)
- [隐私政策](docs/privacy-policy.md)

## 开发状态

🚧 开发中（当前版本 1.1.2）—— Phase 0/1/2、Agent Phase A（Agent 循环 + 只读检查工具）与
Agent Phase B（写入/交互工具 + 权限确认 UI）已完成；Agent Phase C（CDP / 网络嗅探 / 多标签 /
抓取导出）未开始。历史上的脚本注入能力（`browser_inject_script` / `userScripts` 权限）与整轮撤销
已分别在 1.1.0 商店审查和 2026-08-01 移除，详见[进度看板](docs/PROGRESS.md)。
