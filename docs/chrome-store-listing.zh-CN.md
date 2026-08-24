# Runi Chrome Web Store 商品详情 — 简体中文

用于 `zh_CN` 本地化商品详情的可直接粘贴文案。

## 名称

```text
Runi
```

## 简短说明

```text
可控的网页 AI 助手：理解、改造与自动化当前页面，修改前由你确认。
```

## 类别

```text
Productivity
```

## 单一用途

```text
Runi（如你）是一个可控的 AI 侧边栏 Agent，帮助用户理解和处理当前网页及其主动选择的文件，并在用户批准后执行其请求的页面修改。
```

## 详细说明

```text
Runi 是浏览器侧边栏中的可控 AI Agent。它帮助你在不离开当前页面的情况下理解和处理正在浏览的网页。

网页，如你所愿。

你可以使用 Runi：

• 总结当前网页，并提出基于页面内容的问题。
• 为请求附加文本文件、图片和 PDF；PDF 文本会先在本地提取再用于分析。
• 检查正文、HTML、DOM 结构、脚本、样式表和计算样式等页面证据，进行技术分析。
• 请求页面改造与网页操作。写操作执行前，Runi 会展示计划执行的内容并请求你的批准；该决定在当前一轮内生效。
• 连接你自己的 OpenAI 兼容或 Anthropic 兼容 AI Provider，也可填写自定义端点。

首次使用前需要配置你自己的 AI Provider 和 API Key。以 DeepSeek 为例：

1. 登录 DeepSeek 开放平台，创建并复制 API Key。
2. 打开 Runi 侧边栏，点击未配置提示中的“设置”，或从右上角菜单进入“设置”。
3. 在“模型 Provider”中点击“添加 Provider”，并从“快速预设”选择 DeepSeek。
4. 保留预设填写的 OpenAI Chat Completions、https://api.deepseek.com 和 deepseek-v4-pro，在 API Key 字段粘贴密钥后点击“添加”。
5. 返回侧边栏，确认输入框下方显示 DeepSeek / deepseek-v4-pro，即可开始对话。API 使用可能由 DeepSeek 收费。

Runi 采用本地优先设计：Provider 设置、API Key、界面偏好和对话历史保存在你的浏览器中。文本和图片附件内容可能随本地对话历史保存；PDF 文本会在本地为当前请求提取，不作为 PDF 内容持久化。Runi 不运营开发者后端，不接入分析或广告 SDK。当你发起 Agent 请求时，即表示你指示 Runi 根据完成该请求的需要，将 API Key、当前提示词、近期对话上下文、与当前页面有关的工具结果，以及你为该请求选择的文件内容，由扩展直接发送到你配置的 AI Provider 端点，并由该 Provider 按其自身条款和隐私政策处理。

只有在你打开产品并主动发起操作后，Runi 才会读取或修改页面。每轮第一次写操作执行前，Runi 会请求批准，并将决定仅在该轮内复用。

```

## 截图说明

1. `快速理解任意网页——基于当前页面生成总结与回答。`
2. `回答有据可查——检查 DOM、样式、脚本与计算后的实际行为。`
3. `修改前由你确认——查看计划执行的页面操作，并在写工具运行前批准。`
4. `结合网页与文件提问——为当前请求附加文本、图片和 PDF。`

## 当前已部署的隐私政策 URL

```text
https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/
```

## 支持邮箱

```text
liudong.ucas@gmail.com
```
