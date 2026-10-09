# Runi

**中文** | [English](README.en.md)

[🚀 从 Chrome Web Store 安装 Runi](https://chromewebstore.google.com/detail/dhdgahnfefoojenfojbcdaohbbdoabcd)

> 浏览器侧边栏里的 AI 助手：一句话自动填表、操作网页、总结翻译当前页面。已知页面操作自动执行，只有检测到的表单提交会逐次请求确认。对话历史只保存在本地；你发起请求后，当前提示词、近期对话上下文和相关页面结果会直接发送到你配置的 AI Provider。

## 使用前配置

Runi 不提供内置模型，需要使用你自己的 AI Provider 和 API Key。以 DeepSeek 为例：

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建并复制 API Key（API 调用会产生费用）。
2. 打开 Runi 侧边栏，点击顶部提示中的“设置”，或从右上角菜单进入“设置”。
3. 在“模型 Provider”中点击“添加 Provider”，快速预设选择 `DeepSeek`，Base URL 和模型会自动填好。
4. 粘贴 API Key，点击“添加”，回到侧边栏即可开始对话。

详细说明和常见问题见 [Provider 配置指南](docs/provider-setup.md)。

## 功能

- **自动填表与网页操作**：点击、输入、选择、滚动、跳转，以及打开和切换标签页。每次写入前后都会校验，没写进去会如实报告失败；密码和支付字段既不读取也不写入。
- **保存任务，一键重放**：成功的操作可以“保存为指令”，之后在输入框输入 `/` 选中它，就能在相似页面再做一遍。
- **总结与问答**：回答基于页面原文；可附加文本、图片和 PDF（在本地提取文本），也可以输入 `@` 引用其他标签页（只读）。
- **划词提问与快捷指令**：选中文字后点击“问 Runi”；内置总结本页、翻译划词、帮我填表、润色改写、专注阅读，也可自定义。
- **页面实现分析**：读取 DOM、HTML、脚本、样式和计算样式，回答“这个效果是怎么实现的”。
- **始终由你掌控**：Deny-First 权限模型，未知工具一律拒绝，跳转只允许 http(s)；执行中你一动鼠标或键盘就会暂停询问；工具调用有预算上限。
- **发送前脱敏**：手机号、邮箱、身份证号、银行卡号等命中内容会整体替换为占位符，规则可自定义（截图不经过这一层）。
- **本地优先**：对话历史和配置只保存在浏览器本地，没有开发者后端，也不接入分析 SDK。
- **自带模型**：支持 OpenAI 兼容和 Anthropic Messages 两种协议，可配置多个 Provider，在输入框下方切换。

## 权限

`sidePanel`、`storage`、`scripting`、`activeTab`、`tabs`、`alarms`（仅在你发起的任务执行期间保持 Service Worker 存活）、`userScripts`（Agent 在与页面隔离的环境中运行脚本，需在扩展详情页手动开启“允许用户脚本”才生效），以及 `<all_urls>` 主机权限。

## 开发

```bash
pnpm install   # postinstall 会执行 wxt prepare
pnpm dev       # 开发模式，热更新
pnpm build     # 生产构建，产物在 .output/chrome-mv3
pnpm zip       # 打包成可上传商店的 zip
pnpm compile   # 类型检查
pnpm test      # 运行测试
```

Firefox 目标使用 `pnpm dev:firefox` / `pnpm build:firefox` / `pnpm zip:firefox`。加载未打包扩展：`chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`。

技术栈：[WXT](https://wxt.dev/)（Manifest V3，Chrome 138+）、React 19、TypeScript、Tailwind CSS v4、[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)、Zustand、Dexie、Vitest。架构说明见 [CLAUDE.md](CLAUDE.md)，设计文档见 [docs/](docs/README.md)。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
