# Runi

**中文** | [English](README.en.md)

[🚀 从 Chrome Web Store 安装 Runi](https://chromewebstore.google.com/detail/dhdgahnfefoojenfojbcdaohbbdoabcd)

> 值得信赖的浏览器页面 Agent —— 已知页面操作自动执行，仅在检测到表单提交时征求确认；回答基于页面证据而非泛泛而谈。持久化对话历史只留在本地；你发起请求后，当前提示词、近期对话上下文和相关页面结果可能直接发送到你配置的 AI Provider。

> 网页，如你所愿。

## 使用前配置

Runi 不提供内置托管模型。首次对话前，需要配置你自己的 AI Provider 和 API Key。以 DeepSeek 为例：

1. 前往 [DeepSeek 开放平台的 API Keys 页面](https://platform.deepseek.com/api_keys)，登录后创建并复制 API Key。API 调用可能产生费用，请同时确认账户余额和 DeepSeek 的计费规则。
2. 打开 Runi 侧边栏。未配置 Provider 时，顶部会显示提示；点击其中的“设置”，也可以从右上角菜单进入“设置”。
3. 在“模型 Provider”页面点击“添加 Provider”，然后在“快速预设”中选择 `DeepSeek`。
4. 预设会自动填写协议 `OpenAI Chat Completions`、Base URL `https://api.deepseek.com` 和默认模型 `deepseek-v4-pro`，通常无需修改。Base URL 不要追加 `/chat/completions`。
5. 在 `API Key` 字段粘贴刚创建的密钥，点击“添加”。不要把真实 API Key 发到 issue、截图或提交到仓库。
6. 返回侧边栏，确认输入框下方显示 `DeepSeek / deepseek-v4-pro`，发送一条消息即可开始使用。需要时可从同一位置切换 Provider 或模型。

详细说明和常见问题见 [Provider 配置指南](docs/provider-setup.md)。DeepSeek 当前可用模型与接口以其[官方 API 文档](https://api-docs.deepseek.com/)为准。

## 核心功能

- 🔒 **仅提交前确认**：Deny-First 权限模型会自动执行所有已知页面操作，只有检测到的表单提交会逐次请求确认，未知工具一律拒绝。`browser_navigate` 在权限层和后台双重校验，只允许 http(s)；页面外部资源抓取会拒绝环回、内网、链路本地与 IPv4-mapped IPv6 地址
- 🔍 **证据驱动的分析**：可读取页面正文 / DOM / HTML / 脚本 / 样式表 / 计算样式 / 截图；`browser_inspect_page_implementation` 一次调用汇总全部证据并给出关键词匹配的 `evidenceSummary`，回答「这个效果怎么实现的」时点名引用具体代码，而不是泛泛描述
- 🖐️ **页面操作**：可改样式、改 DOM、点击、输入、选择下拉、滚动、跳转、写 storage，也可以打开新标签页、在多个标签页间切换、关闭并跟踪当前操作目标；写操作执行期间页面上会显示不遮挡输入的执行遮罩，操作过程清晰可见。这些已知操作会自动执行，只有检测到的表单提交会停下来询问。工具调用有预算上限（默认 12 次读取分析，开始写操作后放宽到 24 次），预算耗尽只允许再生成一次最终回答
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
    tools.ts        # browser_* 工具定义（13 个只读 + 11 个写入/交互）+ ask_user / wait / report_task_outcome
    permissions.ts  # Deny-First 权限分级（always_allow / auto_allow / confirm_always / deny）
    confirm-gate.ts # 检测到的表单提交逐次触发确认
    tool-policy.ts  # 工具调用预算、重复失败熔断、收敛终止
    system-prompt.ts        # 系统提示词（写工具清单由权限表推导）
    stream-shared.ts        # 协议无关的流式解析公共逻辑
    openai-stream.ts        # OpenAI 兼容 Chat Completions streamFn
    anthropic-stream.ts     # Anthropic Messages streamFn
    activity-steps.ts       # 本轮工具调用的步骤时间线
    tab-conversation.ts     # 标签页 ↔ 会话绑定
    tab-session.ts          # 多标签页编排：追踪 agent 打开的标签页与当前操作目标
    agent-overlay.ts        # 写操作执行期页面遮罩（视觉信号，不拦截输入）
  chat/             # 附件（文本/图片/PDF）、PDF 本地提取与解析队列
  i18n/             # zh / en 词典与 useTranslation()
  shortcuts.ts      # 快捷指令存储与校验（内置 + 自定义）
  theme.ts          # 浅色 / 深色 / 跟随系统
  db.ts             # IndexedDB（Dexie）会话持久化
  settings.ts       # Provider 配置与预设
  page-resource-fetch.ts    # 页面资源抓取的 SSRF 防护
docs/               # 文档（文档驱动开发）
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
