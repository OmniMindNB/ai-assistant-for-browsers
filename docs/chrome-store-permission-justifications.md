# Chrome Web Store Permission and Data-Use Answers

Paste-ready answers for the Chrome Web Store Developer Dashboard. The `1.1.0` Store build uses this permission set:

```text
permissions: sidePanel, storage, scripting, activeTab, tabs
host_permissions: <all_urls>
```

The source of truth is `wxt.config.ts`. Re-check the generated manifest before upload.

## Single purpose

**English**

```text
Aluminum is one controllable AI sidebar agent that helps the user understand and work with the current web page, including making user-requested page changes after approval.
```

**简体中文**

```text
Aluminum 是一个可控的 AI 侧边栏 Agent，帮助用户理解和处理当前网页，并在用户批准后执行其请求的页面修改。
```

## `activeTab`

**English**

```text
Used to support access to the active page when the user invokes Aluminum and starts a page-related request. Aluminum does not use this permission to monitor tabs in the background.
```

**简体中文**

```text
用于在用户调用 Aluminum 并发起页面相关请求时支持访问当前活动页面。Aluminum 不会使用此权限在后台监控标签页。
```

## `tabs`

**English**

```text
Used to identify and validate the user-selected target tab, read its title and URL for page-grounded requests, open the extension settings page, and perform navigation explicitly requested by the user. It is not used to build a browsing-history profile or track the user across tabs.
```

**简体中文**

```text
用于识别和校验用户选择的目标标签页、读取其标题与 URL 以处理基于页面的请求、打开扩展设置页，以及执行用户明确请求的导航。此权限不用于建立浏览历史画像或跨标签页跟踪用户。
```

## `scripting`

**English**

```text
Used to run functions packaged with Aluminum in the target tab for page reading, structured page changes, and turn-level undo snapshots. Page-changing tools run only after the user starts a request and approves the write action. Aluminum does not execute AI-generated JavaScript.
```

**简体中文**

```text
用于在目标标签页中运行随 Aluminum 打包的函数，以读取页面、执行结构化页面修改并保存轮次级撤销快照。页面写入工具只会在用户发起请求并批准写操作后运行。Aluminum 不执行 AI 生成的 JavaScript。
```

## `storage`

**English**

```text
Used to store provider settings and API keys, privacy-consent state, language and theme preferences in chrome.storage.local, and temporary tab, session, and undo state in chrome.storage.session. Aluminum does not sync this storage or upload it to a developer-operated backend. When the user makes an AI request, the selected provider API key is sent only to the configured provider endpoint as its authentication credential.
```

**简体中文**

```text
用于在 chrome.storage.local 中保存 Provider 设置与 API Key、隐私同意状态、语言和主题偏好，并在 chrome.storage.session 中保存临时标签页、会话和撤销状态。Aluminum 不会同步这些存储内容，也不会上传到开发者运营的后端。用户发起 AI 请求时，所选 Provider 的 API Key 仅作为认证凭据发送到已配置的 Provider 端点。
```

## `sidePanel`

**English**

```text
Used to host Aluminum’s primary user interface: the AI conversation and page-action side panel.
```

**简体中文**

```text
用于承载 Aluminum 的主要用户界面，即 AI 对话与页面操作侧边栏。
```

## Host access: `<all_urls>`

**English**

```text
Aluminum’s single purpose is to help with the current page on arbitrary user-selected sites. Host access is required for the content script, packaged page-reading and page-action functions, and retrieval of HTTP(S) scripts or stylesheets referenced by the current page during user-requested implementation analysis. Access occurs only after the user opens Aluminum and initiates a request; Aluminum does not passively scrape pages in the background.
```

**简体中文**

```text
Aluminum 的单一用途是处理用户在任意网站上选择的当前页面。主机访问权限用于内容脚本、随扩展打包的页面读取与页面操作函数，以及在用户请求实现分析时获取当前页面引用的 HTTP(S) 脚本或样式表。只有在用户打开 Aluminum 并主动发起请求后才会访问；Aluminum 不会在后台被动抓取页面。
```

## Data collection and use

### Overall answer

Answer **Yes** to the question asking whether the extension collects or processes user data. Aluminum has no developer-operated backend, but relevant data is transmitted off-device directly to the AI provider selected by the user.

### `Website content`

Mark **collected/processed** for the core feature.

**English**

```text
When the user initiates a request, Aluminum may process the current page’s title, URL, readable text, selected text, HTML, DOM structure and attributes, metadata, scripts, stylesheets, computed styles, and a visible-tab screenshot, depending on the tools used. Relevant text and page-derived tool results are sent directly to the AI provider endpoint configured by the user solely to answer or carry out that request. Aluminum has no developer-operated backend, does not sell this data, and does not use it for advertising, profiling, credit decisions, or unrelated purposes. In version 1.1.0, screenshot image bytes remain transient in tool details and are not included in the provider request.
```

**简体中文**

```text
用户发起请求后，Aluminum 可能会根据所用工具处理当前页面的标题、URL、可读正文、选中文本、HTML、DOM 结构与属性、元信息、脚本、样式表、计算样式和可见标签页截图。与请求有关的文本和页面工具结果会直接发送到用户配置的 AI Provider 端点，仅用于回答或执行该请求。Aluminum 不运营开发者后端，不出售这些数据，也不会将其用于广告、画像、信贷判断或无关用途。在 1.1.0 中，截图图片字节仅短暂保存在工具详情中，不会包含在 Provider 请求里。
```

### `Web history` / web browsing activity

If the live form follows the Chrome Web Store policy definition that includes domains or URLs the browser interacts with, mark this category **collected/processed**. Aluminum does not build or retain a browsing-history list, but it processes the current target page URL and page-referenced resource URLs for the active request.

**English**

```text
Aluminum processes the URL of the current user-selected page and, for requested implementation analysis, URLs of scripts or stylesheets referenced by that page. The current page URL and relevant page-derived results may be sent directly to the AI provider configured by the user solely for the active request. Aluminum does not build a browsing-history profile, use URLs for analytics or advertising, or send them to a developer-operated backend.
```

**简体中文**

```text
Aluminum 会处理用户当前选择页面的 URL；在用户请求页面实现分析时，还会处理该页面引用的脚本或样式表 URL。当前页面 URL 和与请求有关的页面工具结果可能会直接发送到用户配置的 AI Provider，仅用于当前请求。Aluminum 不建立浏览历史画像，不把 URL 用于分析或广告，也不会发送到开发者运营的后端。
```

### Other categories and live-form review

- **User activity:** Aluminum does not collect behavioral analytics. User-approved click, type, select, scroll, navigation, and page-storage actions are executed as core functionality rather than recorded for analytics.
- **Authentication information:** Provider API keys are stored locally and transmitted only to the configured provider endpoint as authentication credentials. Check whether the live form defines user-supplied third-party API keys as this category.
- **Personally identifiable information / personal communications:** Do not answer categorically “No” merely because Aluminum does not solicit these categories. Conversation content and current-page content can contain personal information entered or selected by the user, and recent conversation content is sent to the configured AI provider.

> **Reviewer hard stop:** Before saving Privacy practices, inspect the live Dashboard wording for conversation content and user-entered personal information. If the current form treats prompts or user-to-AI conversations as `Personal communications`, or treats incidental personal information in prompts/page content as `Personally identifiable information`, disclose the applicable category. Record the final category decisions in the release checklist.

### Required use certifications

Confirm only statements that remain true in the live form:

- Data is used only to provide or improve Aluminum’s user-facing single purpose.
- Data is not sold to third parties.
- Data is not used or transferred for advertising.
- Data is not used or transferred for creditworthiness, lending, or unrelated profiling.
- Transfers are limited to the user-configured AI provider and resource hosts contacted as necessary for a user-requested operation.

## Privacy-policy routes

- English default: `https://omnimindnb.github.io/aluminum-legal/`
- Simplified Chinese: `https://omnimindnb.github.io/aluminum-legal/zh-CN/`

Use the rendered GitHub Pages URL, not a repository blob URL.

## Policy references

- Chrome Web Store Program Policies: `https://developer.chrome.com/docs/webstore/program-policies/policies`
- User Data FAQ: `https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/`
- Limited Use: `https://developer.chrome.com/docs/webstore/program-policies/limited-use`
