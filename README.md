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
- 🔍 **证据驱动的分析**：可读取页面正文 / DOM / HTML / 脚本 / 样式表 / 计算样式 / localStorage / 截图；还能按可见文字定位元素、按条件（元素出现/消失/文字命中/DOM 静默）等待页面就绪，而不是盲等固定秒数。`browser_inspect_page_implementation` 一次调用汇总全部证据并给出关键词匹配的 `evidenceSummary`，回答「这个效果怎么实现的」时点名引用具体代码，而不是泛泛描述。截图工具只在你把该模型标记为「支持图片输入」后才会出现在工具表里
- 🖐️ **页面操作**：可改样式、改 DOM、点击、输入、按功能键（Enter / Tab / Esc / 方向键等具名键）、选择下拉、滚动、跳转、后退、写 storage，也可以打开新标签页、在多个标签页间切换、关闭并跟踪当前操作目标。表单字段与可点击元素通过稳定的 `fieldId` 句柄寻址（可穿透 open shadow root 与 iframe），每次写入前后都会做结构指纹校验与回读，没落地的写入会如实报失败而不是报成功；密码与支付字段既不读取也不写入。写操作执行期间页面上会显示不遮挡输入的执行遮罩，操作过程清晰可见。这些已知操作会自动执行，只有检测到的表单提交会停下来询问。工具调用有预算上限（默认 20 次读取分析，开始写操作后在已用次数之上再追加 40 次；纯等待和最初几次失败的调用不计入），可在设置页的「任务预算」里切换标准/宽松两档，预算耗尽只允许再生成一次最终回答
- 🔑 **自带模型**：支持 OpenAI 兼容的 Chat Completions 与 Anthropic Messages 两种协议，内置 DeepSeek / OpenAI 预设，也可完全自定义端点；可配置多个 Provider 与多个模型，在输入框里直接切换
- 🗂️ **本地优先**：对话历史存在本地 IndexedDB，Provider 配置与界面偏好存在 `chrome.storage.local`，不同步到任何云端，也没有开发者后端与分析 SDK
- 🛡️ **发送前脱敏**：页面内容在进入模型上下文之前先过一遍脱敏规则，内置手机号 / 邮箱 / 身份证 / 银行卡四条，可在设置页增删自定义规则。命中的内容整体替换为占位符而不是打码，原文字符不会有任何一位漏进上下文（截图是像素、无法做文本匹配，因此不经过这一层——这是已知且有意保留的缺口）
- 📎 **本地文件上下文**：单条消息最多附加 5 个文件，支持文本（最多 30,000 字符）、图片（≤ 5 MB）和 PDF（≤ 20 MB，本地提取最多 60,000 字符，不含 OCR）。PDF 在 Worker 中本地解析并显示进度，支持拖拽；PDF 正文只用于当前一轮，历史中只保留文件元数据
- ⚡ **快捷指令**：内置「总结本页 / 翻译划词 / 帮我填表 / 润色改写 / 专注阅读」五条，可编辑、删除、恢复默认，也可新增自定义指令；每条指令有明确的上下文作用域（当前页面 / 已选文本 / 不使用网页上下文），作用域同时决定它能不能动页面。输入框输入 `/` 即可唤出。`页面`作用域的指令会把正文随第一轮一起带上，省掉一次额外的读页往返。动过页面的回复可以一键「保存为指令」：Runi 记下这次成功走通的步骤（已脱敏，敏感字段不记录），之后在 `/` 面板里选中它、补一句"这次的不同之处"，就能让 agent 照着这条路再做一遍，页面有变化时它会自行调整
- 🖱️ **划词提问**：在页面上选中文本后就地弹出按钮，点击直接打开侧边栏并带上引用内容
- 🪟 **按标签页独立会话**：侧边栏按标签页单独开启与绑定，切回某个标签页会恢复它自己的对话。Agent 跑在 Service Worker 里而不是面板文档里，关掉或重开侧边栏都不会中断或重启正在执行的任务
- 🔗 **跨标签页上下文**：输入框输入 `@` 可以点选当前窗口的其他标签页，把它们的内容带进这轮对话。被引用的标签页**只读**——模型可以读它们、继续深挖，但任何写操作（点击、填表、跳转、关闭）都会被拒绝。agent 依然不能自主枚举你的标签页，只有你点选的才进入会话
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
| 测试 | Vitest 三个 project：`unit`（node 环境的 `lib/**/*.test.ts`）、`ui`（jsdom 环境的组件测试）、`dom`（jsdom 环境的 `lib/**/*.dom.test.ts`，覆盖注入页面执行的 DOM 函数） |
| 包管理 | pnpm |

扩展申请的权限：`sidePanel`、`storage`、`scripting`、`activeTab`、`tabs`、`alarms`（仅用于在你发起的任务执行期间保持 Service Worker 存活，任务结束即清除，不用来安排任何后台任务），以及 `<all_urls>` 主机权限。不申请 `userScripts`，也没有执行模型生成脚本的通道。

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
  options/          # 设置页（Provider / 外观 / 语言 / 快捷指令 / 脱敏规则 / 任务预算）
components/         # 设置页共享组件（侧边栏内的紧凑设置也复用）
lib/                # 共享库
  messaging.ts      # 三端统一消息协议
  agent/            # Agent 循环与工具调用
    agent.ts        # Agent 封装（model / tools / 生命周期钩子 / 上下文压缩）
    tools.ts        # browser_* 工具定义（16 个只读 + 13 个写入/交互）+ ask_user / wait / report_task_outcome
    permissions.ts  # Deny-First 权限分级（always_allow / auto_allow / confirm_always / deny）
    confirm-gate.ts # 检测到的表单提交逐次触发确认
    tool-policy.ts  # 工具调用预算、重复失败熔断、收敛终止
    run-registry.ts         # Agent 运行在 Service Worker：每标签页一个运行态，快照推送给面板
    context-budget.ts       # 进入上下文的文本预算（单次读取上限与整体水位）
    form-schema.ts          # 表单字段采集与敏感字段识别（纯逻辑，与注入页面的 form-dom.ts 分离）
    system-prompt.ts        # 系统提示词（写工具清单由权限表推导）
    stream-shared.ts        # 协议无关的流式解析公共逻辑
    openai-stream.ts        # OpenAI 兼容 Chat Completions streamFn
    anthropic-stream.ts     # Anthropic Messages streamFn
    activity-steps.ts       # 本轮工具调用的步骤时间线
    tab-conversation.ts     # 标签页 ↔ 会话绑定
    tab-session.ts          # 多标签页编排：追踪 agent 打开的标签页与当前操作目标
    agent-overlay.ts        # 写操作执行期页面遮罩（视觉信号，不拦截输入）
  chat/             # 附件（文本/图片/PDF）、PDF 本地提取与解析队列、页面正文预取
  workbench/        # 侧边栏纯逻辑：历史按日分组、状态行最小驻留节流
  i18n/             # zh / en 词典与 useTranslation()
  shortcuts.ts      # 快捷指令存储与校验（内置 + 自定义）
  redaction.ts      # 页面内容脱敏规则（手机号 / 邮箱 / 身份证 / 银行卡 + 自定义）
  page-outline.ts   # h1–h3 标题大纲（长页面窗口化预取时供模型定位）
  tab-panel-scope.ts        # 侧边栏「只在用户打开过的标签页启用」的记录
  theme.ts          # 浅色 / 深色 / 跟随系统
  db.ts             # IndexedDB（Dexie）会话持久化
  settings.ts       # Provider 配置与预设
  page-resource-fetch.ts    # 页面资源抓取的 SSRF 防护
docs/               # 文档（文档驱动开发）
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
