# Chrome Web Store 权限用途说明（Dashboard 填写用）

提交时，Developer Dashboard → Privacy practices 页会要求为每个权限单独说明用途。以下文案可直接复制粘贴（中英双语，按 Store 后台语言选用）。

## activeTab

**中文**：用于在用户主动点击扩展图标或发起操作时，读取当前激活标签页的页面内容（标题、正文），以便 AI 助手生成总结、问答或执行页面改造操作。仅在用户主动交互时触发，不会在后台静默访问标签页。

**English**: Used to read the content of the currently active tab only when the user explicitly interacts with the extension (e.g. opening the side panel, sending a message), so the AI assistant can summarize, answer questions about, or transform the current page. Never accessed silently in the background.

## tabs

**中文**：用于查询当前激活的标签页（`tabs.query`）以定位要处理的页面，并向该标签页的 content script 发送消息（`tabs.sendMessage`）以提取页面正文或选中文本。不用于监控用户的浏览历史或跨标签页追踪。

**English**: Used to query the currently active tab and send messages to its content script to extract page text or the user's text selection. Not used to monitor browsing history or track the user across tabs.

## scripting

**中文**：用于在用户请求"页面改造"类操作时（如去广告、切换阅读模式、调整样式），向当前页面注入脚本以执行 DOM 修改，并支持撤销该次修改。仅响应用户在侧边栏内发起的明确指令执行。

**English**: Used to inject scripts into the current page only when the user explicitly requests a page-transformation action (e.g. removing ads, reading mode, style tweaks) from the side panel, and to support undoing that change. Never runs unsolicited.

## userScripts

**中文**：用于在用户明确要求且确认后，将 AI 生成的 JavaScript 代码通过 Chrome 官方的
`chrome.userScripts.execute()` API（而非 `eval`/`new Function`）注入并执行到当前页面，实现
阅读模式、深色主题等没有对应结构化工具覆盖的页面改造。该 API 是 Manifest V3 官方认可的动态
脚本执行通道，用户需在扩展详情页手动开启「允许用户脚本」开关后才能生效；未开启时该功能会
明确报错并提示用户开启，不会静默失败或绕过该同意步骤。

**English**: Used to inject and execute AI-generated JavaScript into the current page via
Chrome's official `chrome.userScripts.execute()` API (not `eval`/`new Function`), only after
explicit user confirmation, for page transformations not covered by the other structured tools
(e.g. reading mode, dark theme). This is the Manifest-V3-sanctioned channel for dynamic script
execution; the user must separately enable the "Allow User Scripts" toggle on the extension's
details page before it takes effect — if not enabled, the feature fails with a clear message
telling the user to enable it, rather than silently failing or bypassing that consent step.

## storage

**中文**：用于在本机保存用户配置（大模型 Provider、API Key、Skill 列表等）和会话状态，全部使用 `chrome.storage.local`，不同步到云端，也不会上传到开发者的服务器（本扩展没有后端服务器）。

**English**: Used to persist user configuration (LLM provider settings, API keys, saved skills) and session state locally via `chrome.storage.local`. Data is not synced to the cloud or uploaded to any developer-operated server — this extension has no backend.

## sidePanel

**中文**：用于承载扩展的核心交互界面——AI 对话侧边栏。这是本扩展的主要功能入口。

**English**: Used to host the extension's primary UI — the AI chat side panel, which is the core feature of this extension.

## host_permissions: `<all_urls>`

**中文**：本扩展的核心功能是"针对任意当前网页"提供 AI 总结、问答与页面改造，因此需要能够在用户访问的任意网站上运行 content script 以提取页面内容、注入改造脚本。所有访问均由用户在侧边栏内主动触发，扩展不会在后台自动扫描或抓取用户未主动操作的网页。

**English**: The extension's core purpose — summarizing, answering questions about, and transforming *any* web page the user is currently viewing — requires running a content script on arbitrary sites to read page content and apply user-requested transformations. All access is user-initiated from the side panel; the extension does not passively scan or scrape pages in the background.

## 关于数据使用披露表单（Data collection）

Dashboard 的 "Does your extension collect user data?" 问卷建议如下勾选：

- **Personally identifiable information**：否（除非用户在对话中自行输入了个人信息，那属于用户主动输入内容，不是扩展主动收集）
- **Web history**：否（不记录/上传浏览历史，仅按需读取当前页面内容用于生成回复）
- **User activity**（如点击、滚动）：否
- **Website content**（当前页面文本）：是——需要勾选，并注明"仅在用户主动发起操作时读取当前页面内容，发送给用户自行配置的第三方大模型 API 用于生成回复，不做其他用途，不落库到开发者服务器"
- 认证声明：需要勾选"我不会将用户数据出售给第三方""我不会将用户数据用于与核心功能无关的用途"等标准承诺条款——结合上表如实勾选即可。

隐私政策 URL：https://omnimindnb.github.io/aluminum-legal/ （GitHub Pages 渲染版，对应 [privacy-policy.md](privacy-policy.md) 内容；请勿使用 github.com 仓库的 blob 链接，那只会显示源码，不是渲染后的页面）。
