# Agent 工具扩展设计：视觉截图 / press_key / wait_for

- 日期：2026-09-03
- 来源：对现有 26 个工具做能力盘点后，识别出三处不需要新权限、不动安全模型、且直接命中当前最常见失败模式与最大耗时来源的缺口
- 状态：待实现

## 1. 问题

### 1.1 截图对模型不可见

`browser_screenshot` 已经注册在只读工具表里，`CAPTURE_SCREENSHOT` 也已经能拿到 `dataUrl`，但 `lib/agent/tools.ts` 的 `makeScreenshotTool` 只把它塞进 `details`，回给模型的文本是：

```
已截取当前可见标签页截图。dataUrl 长度：${response.data.dataUrl.length}。
```

模型拿到的是一个数字。这个工具在今天的形态下对任何模型都是死的——它的 description 甚至自陈是 "for future vision-capable workflows"。

后果是 canvas 渲染的页面、`<iframe>` 里的内容、纯视觉判断（"这个按钮是不是变灰了"、"布局有没有错位"）构成一整片盲区，而这些恰恰是 DOM 读取工具原理上够不着的地方。

### 1.2 没有任何按键能力

`MessageType` 里与页面交互相关的写操作是 `CLICK_ELEMENT` / `TYPE_TEXT` / `SELECT_OPTION` / `SCROLL_PAGE` / `FILL_FORM`。没有按键。

`browser_type` 只是设值加派发 `input`/`change`，补不上这个缺口。因此：搜索框输入完按不了 Enter，弹层关不掉 Escape，焦点链走不了 Tab。模型遇到"输入后需要回车提交"的页面时只能猜一个提交按钮的选择器，猜不中就卡在原地重试。

### 1.3 只能盲等固定秒数

`wait` 工具只支持"睡 N 秒"。模型面对"点击后内容异步加载"的场景，唯一策略是 `wait(3)` 然后重读，等不够就再等——每一轮都是一次完整的 LLM 往返。

而实测数据显示 LLM 往返占端到端耗时的约 96%，减少轮数是唯一有效的提速杠杆。盲等既浪费固定墙钟时间，又因为等不准而额外增加轮数。

## 2. 目标 / 非目标

**目标：**

- `browser_screenshot` 把图片真正送进模型上下文，两种协议（Anthropic Messages / OpenAI 兼容 chat completions）都支持。
- 新增 `browser_press_key`，支持具名按键与修饰键，且 Enter 触发表单提交时必须走既有的确认闸门。
- 新增 `browser_wait_for`，支持 `appear` / `disappear` / `textContains` / `domIdle` 四种条件，替代大多数 `wait(N)` 盲等。
- 上述三者都不需要新增 manifest 权限，不引入 `debugger`，不放松 Deny-First 策略。

**非目标（本次明确不做）：**

- 不动 `patches/@earendil-works__pi-agent-core@0.79.3.patch`。pi-ai 的 `ToolResultMessage.content` 类型本就是 `(TextContent | ImageContent)[]`，图片在类型层面已被允许，缺的只是两个 converter 的翻译。
- 不模拟 Tab 的原生焦点移动、Escape 的原生弹层关闭。只补 Enter 的表单提交这一个副作用（理由见 §4.2）。
- 不做 `networkIdle` 等待条件。`PerformanceObserver` 看不到 WebSocket/SSE，且常驻轮询的页面永远等不到空闲，失败模式对模型不直观。
- 不做多张截图的视觉对比工作流。上下文里只保留最新一张（见 §3.4）。
- 不改动 `permissions.ts` 的分级机制本身，只往既有名单里加条目。

## 3. 视觉链路

### 3.1 能力声明：ProviderConfig 加 visionModels

用户可以把 `baseURL` 指向任意 OpenAI 兼容端点，包括不支持视觉的本地小模型。给这类模型发图片是硬报错，会直接打断整个 run。

**决策：在 `ProviderConfig` 上新增 `visionModels?: string[]`，工具按能力动态注册。**

```ts
export interface ProviderConfig {
  // ...现有字段不变
  models?: string[];
  /** models 中支持图片输入的子集；缺省视为空（历史配置无此字段时按不支持处理）。 */
  visionModels?: string[];
}
```

不把 `models` 改成对象数组：那会破坏所有已存储的配置，而 `chrome.storage.local` 里的 provider 配置是用户手填 API key 的地方，迁移失败的代价很高。

- `lib/agent/vision.ts`（新增）：纯函数 `supportsVision(provider: ProviderConfig, modelId: string): boolean`。字段缺失时返回 `false`。
- `PROVIDER_PRESETS` 为已知的视觉模型预填 `visionModels`。
- `entrypoints/options/ProviderSettings.tsx`：模型列表每行加一个"支持图片"勾选框。
- `createBrowserTools(session, config)` 的 config 新增 `vision?: boolean`，**默认 `false`**。为假时 `browser_screenshot` 根本不进工具表。

工具不进表意味着模型看不见、也就不会调用，不存在运行时报错。这比现状严格更好：今天这个工具在任何模型下都只回一个数字，本来就没有价值。

`agent.ts:145` 处解析当前 provider/model 的视觉能力并传入。

### 3.2 图片瘦身在 background 完成

`captureVisibleTab` 在 2560px 宽的显示器上会吐出数 MB 的 PNG。直接送进上下文，token 成本和延迟都会失控。

在 `captureScreenshotWithoutOverlay` 拿到 `dataUrl` 之后加一道缩放与重编码：

```
fetch(dataUrl) → blob → createImageBitmap → OffscreenCanvas
  → convertToBlob({ type: 'image/jpeg', quality: 0.7 })
  → arrayBuffer() → 分块 btoa → base64
```

**注意：MV3 service worker 里没有 `FileReader`。** blob 转 base64 不能用常见的 `FileReader.readAsDataURL` 写法，必须走 `arrayBuffer()` 加分块 `btoa`（一次性 `String.fromCharCode(...bigArray)` 会爆栈，需分块）。`createImageBitmap` 和 `OffscreenCanvas` 在 worker 里可用。

- 最长边压到 1280px（已经更小则不放大）。1280×800 的图在 Anthropic 计价下约 1365 token。
- 编码后再加一道字节硬上限兜底；超限则降低 quality 重试一次，仍超限则返回失败文本而非图片。
- 尺寸计算 `planScreenshotResize(width, height, maxEdge)` 拆进 `lib/agent/screenshot-image.ts` 作为纯函数，canvas 调用留在 `background.ts`。

`CaptureScreenshotResult` 增加 `width` / `height` / `mimeType` 字段，供工具层构造 image part 与写结果文案。

### 3.3 协议翻译

`makeScreenshotTool` 返回两个 content part：

```ts
{
  content: [
    { type: 'text', text: '已截取当前可见标签页截图（1280×800）。' },
    { type: 'image', data: base64, mimeType: 'image/jpeg' },
  ],
  details: { ... },
}
```

两个 converter 各自翻译，协议差异关在协议层内部——这正是 `selectStreamFn` 已经建立的边界：

**`anthropic-stream.ts` 的 `convertMessagesForAnthropic`。** `toolResult` 分支目前是：

```ts
const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: stringifyContent(message.content) };
```

`stringifyContent` 只挑 `text` part，图片被静默丢弃。改为构造块数组：文本块加 `{ type: 'image', source: { type: 'base64', media_type, data } }`。Anthropic 的 `tool_result` 原生支持内嵌图片块。

**`openai-stream.ts` 的 `convertMessages`。** OpenAI chat completions 协议**不允许** `role: 'tool'` 消息携带图片。采用标准变通：那条 tool 消息只放文本（说明截图见下条），紧随其后**追加一条合成的 `role: 'user'` 消息**装 `image_url`（`data:` URL 形式）。

该函数目前是 `.map()`，需改为 `.flatMap()`——一条 `toolResult` 可能展开成两条线格式消息。

合成只发生在 `convertMessages` 内部（纯函数：`context.messages` → 线格式），**不进入 agent 自己的消息列表**，因此不会被写进 Dexie、不会显示在面板消息流里、不会被会话恢复读回来。

考虑过的替代方案：在工具层双写（工具回文本，同时让 `run-registry` 在 tool result 后插一条真实 user 消息带图）。协议无关、两边一套代码，但那条伪造的 user 消息会污染真实历史与持久化。为绕协议差异去污染历史，不划算。已否决。

**已知代价：截图绕过内容脱敏。** `lib/redaction.ts` 的规则只处理文本，截图是直接发给视觉模型的原始 JPEG 像素，完全不经过脱敏管线。这是可接受的产品取舍（对截图做 OCR 再脱敏不现实），但需要显式写下来而不是隐含行为——已在设置页 `provider.visionModelsHint` 文案里补一句提示。

### 3.4 上下文淘汰：只保留最新一张

`agent.ts` 的 `compactAgentMessages` 目前只截断 `part.type === 'text'`：

```ts
if (part.type !== 'text' || part.text.length <= MAX_TOOL_RESULT_CHARS) return part;
```

image part 会完整穿过压缩层，只有滑出 `MAX_CONTEXT_MESSAGES`（48）窗口才会消失。一个多轮任务可能同时挂着十几张图。

**决策：只保留最新一张截图。** 压缩时从后往前扫，第二新及更早的 image part 替换为文本：

```
[截图已移出上下文，如需重新查看请再次截图]
```

视觉任务几乎总是只关心"页面现在长什么样"，历史截图价值低、成本高。模型确实需要前后对比时，代价是多截一次图——一次工具调用，远低于每轮都驮着十几张图的持续成本。

**这里还有一处既有行为必须一并处理（写计划时发现，补记于此）：** `compactAgentMessages` 对**所有非最新的只读工具结果**整条替换成一行文字摘要（`agent.ts:473-484`）。`browser_screenshot` 是只读工具，所以在不额外处理的情况下，一张截图只要后面跟了**任何**别的读取工具就会被摘要掉——那是"截图只在当前轮可见"的行为，不是本节选定的"保留最新一张"。

因此实现时必须单独跟踪最新截图的索引，让它**豁免**这条摘要规则。漏掉这一步，多步视觉任务（截图 → 点击 → 再看）会退化成模型看一眼就失忆。

同时修 `keptReadResultChars`：它目前只统计 `part.type === 'text'` 的长度，图片对读预算完全隐形。

## 4. browser_press_key

### 4.1 寻址与派发

payload：

- `key`：具名按键白名单——`Enter` / `Tab` / `Escape` / `Backspace` / `Delete` / `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight` / `Home` / `End` / `PageUp` / `PageDown`。白名单外拒绝，不接受任意字符串（输入文本用 `browser_type` / `browser_fill_form`）。
- `modifiers`：`ctrl` / `shift` / `alt` / `meta` 的可选布尔组合。
- 目标：`fieldId`（优先，复用 `tab-form-fields.ts` 的句柄表）→ `selector` 兜底 → 两者都不给则打到 `document.activeElement`。

activeElement 是 `body` 或 `null` 时直接返回失败，文案明确要求模型传 `fieldId`——不猜一个目标。

按键规范化（`key` / `code` / `keyCode` / 修饰键标志）作为纯函数放 `lib/agent/key-dispatch.ts`。`keyCode` 必须填：仍有大量页面读这个已废弃属性。

派发序列为 `keydown` → `keyup`；白名单中只有 `Enter` 额外派发 `keypress`（其余按键在真实浏览器里也不产生 `keypress`，多派发反而与真实行为不符）。注入函数放 `form-dom.ts`，遵守该文件的既有约束：**被 `executeScript` 序列化，不得引用任何模块作用域的东西**。

派发的事件 `isTrusted` 为 `false`（这也正是 `takeover-detect.ts` 区分用户与 agent 的依据），因此浏览器原生行为不会触发。页面自己监听 `keydown` 的场景（绝大多数 SPA）不受影响。

### 4.2 Enter 的提交路径（安全关键）

一旦 Enter 能提交表单，`browser_press_key` 就成了绕过"结构化检测到的表单提交每次都要确认"这条硬边界的后门。因此它必须进 `permissions.ts` 的 `SUBMIT_CAPABLE_TOOLS`。

判定逻辑**不能复用** `decideSubmitIntent`：后者的输入是 `ClickTargetInfo`，看的是 `button` / `input[type=submit]`；而 Enter 走的是 HTML 的**隐式提交**规则——焦点在归属某 form 的文本类 input 上，且该 form 有提交按钮，或该 form 只有一个此类字段。形状不同。

在 `form-submit.ts` 中新增并列的 `decideEnterSubmitIntent(info: EnterTargetInfo): SubmitIntent`，同样**只看结构不看文案**——这是该文件开篇明写的原则（识别"下单""支付"字样会带来假阳性，毁掉确认的信噪比）。

探测消息新增 `PROBE_KEY_TARGET`。复用 `PROBE_CLICK_TARGET` 会让消息名变成假话。`agent.ts` 的 `buildSubmitIntentProbePayload` 按工具名分流到新探测；探测失败或无响应时按 `{ isSubmit: false }` 处理，与现有 `resolveSubmitIntent` 的降级策略一致。

执行顺序：探测 → 命中提交则走确认卡 → 用户批准后派发 `keydown` → 若事件未被 `preventDefault` 且判定为隐式提交，则调用 `form.requestSubmit()`。

**只补这一个副作用。** Tab 不模拟焦点移动，Escape 不模拟弹层关闭——两者的原生行为都需要重新实现可聚焦元素排序（`tabindex` / shadow DOM / `inert` 全都要处理）或 dialog/popover 栈管理，代价远超收益。工具 description 必须对模型明说这一点，否则它会以为按了 Tab 焦点就走了。

### 4.3 分级与结果反馈

加入 `AUTO_APPROVE_TOOL_NAMES`，因而自动进入 `WRITE_TOOL_NAMES`——执行遮罩、接管闸门、写预算全部自动生效，无需额外接线。

结果文案交给 `action-result-text.ts`：事件是否被 `preventDefault`、是否触发了提交、有没有新字段出现（复用现成的 `describeNewFields`）。这符合项目"每次写操作都要能被验证"的既有原则：按键的可验证信号就是默认行为是否被阻止、目标元素是否仍存在、是否触发了导航。

## 5. browser_wait_for

### 5.1 四种条件

| 条件 | 参数 | 含义 |
|---|---|---|
| `appear` | `selector` | 匹配元素出现 |
| `disappear` | `selector` | 匹配元素消失（等 loading 指示器） |
| `textContains` | `text`，可选 `selector` | 指定子树（默认 `body`）内出现该文本 |
| `domIdle` | 可选 `idleMs`（默认 500） | 连续 `idleMs` 毫秒无 DOM 变动 |

统一带 `timeoutMs`，默认 5000、上限 15000。硬上限是为了不让一次盲等吃掉整轮时间。

`domIdle` 是不知道该等什么选择器时的通用兜底，恰好接住现在 `wait(3)` 盲等的大多数场景。

不做 `urlChanged`：`agent.ts` 的 `NAVIGATION_WATCH_TOOLS` 已有导航监控，会主动把隐式导航告知模型，重复建设。

### 5.2 实现

注入一个自包含的 async 函数（`lib/agent/wait-dom.ts`，同样禁止引用模块作用域），内部是一个 `MutationObserver` 与一个 `setTimeout` 竞速，返回 `{ met: boolean, reason: string, elapsedMs: number }`。

`scripting.executeScript` 会 await 注入函数返回的 promise，因此不需要在 background 侧轮询。background 侧再加一层比 `timeoutMs` 略长的超时兜底，防止注入上下文因导航被销毁而使调用永久挂起。

条件解析与结果文案（`describeWaitResult`）拆进 `lib/agent/wait-condition.ts` 作为纯函数。

### 5.3 分级与超时语义

进 `READ_ONLY_TOOL_NAMES`——它不修改任何状态，因此不触发执行遮罩、不进写预算。但**计入读预算**（20 次），否则模型可能拿它刷循环。

**超时不是错误。** 超时返回 `met: false` 加已等时长，不抛异常。模型需要知道"等过了、没等到"并据此改变策略；抛异常只会让它原样重试。

### 5.4 提示词

`browser_wait_for` 的 description 与 `system-prompt.ts` 都要明确写：**优先用 `browser_wait_for`，不要用 `wait(N)` 盲等**。否则模型会继续走老路，这个工具就白加了。

## 6. 文件清单

**新增：**

- `lib/agent/vision.ts` — `supportsVision()`，纯函数
- `lib/agent/screenshot-image.ts` — `planScreenshotResize()`，纯函数
- `lib/agent/key-dispatch.ts` — 按键规范化，纯函数
- `lib/agent/wait-condition.ts` — 等待条件解析与结果文案，纯函数
- `lib/agent/wait-dom.ts` — 注入页面的等待观察函数

**修改：**

- `lib/settings.ts` — `ProviderConfig.visionModels`，预设填充
- `lib/messaging.ts` — `PRESS_KEY` / `WAIT_FOR` / `PROBE_KEY_TARGET` 三个 MessageType 及其 payload/result；`CaptureScreenshotResult` 加 `width`/`height`/`mimeType`
- `entrypoints/background.ts` — 三个新 handler；截图缩放重编码
- `lib/agent/tools.ts` — `makeScreenshotTool` 改造；新增 `makePressKeyTool` / `makeWaitForTool`；`BrowserToolsConfig.vision`
- `lib/agent/permissions.ts` — `browser_press_key` 进 `AUTO_APPROVE_TOOL_NAMES` 与 `SUBMIT_CAPABLE_TOOLS`；`browser_wait_for` 进 `READ_ONLY_TOOL_NAMES`
- `lib/agent/form-submit.ts` — `decideEnterSubmitIntent`
- `lib/agent/form-dom.ts` — 注入的按键派发函数
- `lib/agent/agent.ts` — 视觉能力解析并传入 `createBrowserTools`；`buildSubmitIntentProbePayload` 分流；`compactAgentMessages` 的图片淘汰与 `keptReadResultChars` 修正
- `lib/agent/anthropic-stream.ts` / `lib/agent/openai-stream.ts` — 图片翻译
- `lib/agent/action-result-text.ts` — 按键结果文案
- `lib/agent/system-prompt.ts` — 新工具的使用指引
- `lib/agent/activity-steps.ts` / `activity-description.ts` / `lib/i18n/` — 新工具的步骤标签与中英文案
- `entrypoints/options/ProviderSettings.tsx` — 每模型的"支持图片"勾选

## 7. 测试

三个 vitest project 的既有划分不变：纯逻辑进 `unit`，注入 DOM 的进 `dom`（`*.dom.test.ts`），UI 进 `ui`。

| 文件 | 覆盖 |
|---|---|
| `screenshot-image.test.ts` | 缩放边界：已够小时不放大、极端长图、正方形 |
| `vision.test.ts` | 能力判定；历史配置缺 `visionModels` 时回退为不支持 |
| `anthropic-stream.test.ts` / `openai-stream.test.ts` | 带图 toolResult 的翻译；OpenAI 侧展开成两条消息 |
| `agent.test.ts`（或就近新增） | 只保留最新一张图；旧图换占位符；`keptReadResultChars` 计入图片 |
| `key-dispatch.test.ts` | 按键映射、`keyCode` 填充、白名单外拒绝、修饰键组合 |
| `form-submit.test.ts` | `decideEnterSubmitIntent`：有/无提交按钮、单字段表单、非文本 input、无 form 归属 |
| `permissions.test.ts` | press_key 命中隐式提交时落到 `confirm_always`，不得被 `auto_allow` 放行 |
| `form-dom.dom.test.ts` | 按键派发；`preventDefault` 后不提交 |
| `wait-condition.test.ts` | 参数校验、超时文案、四种条件描述 |
| `wait-dom.dom.test.ts` | 四种条件各一个命中用例 + 一个超时用例 |

## 8. 实现顺序

三部分互相独立，可按此顺序分批合入，每批自成一个可验证的整体：

1. **wait_for** — 依赖最少，不碰协议层与权限分级（只加一条只读名单），最快见效。
2. **press_key** — 依赖 `form-submit.ts` 与确认闸门，是三者中安全面最大的一块，单独一批便于集中审查。
3. **视觉链路** — 跨模块最多（settings / UI / 两个 converter / 压缩层），放最后，避免它的改动面干扰前两块的审查。
