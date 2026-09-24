# 会话导出：把一次对话导成可用于排查问题的诊断记录

- 日期：2026-09-24
- 来源：用户需求"会话记录支持导出功能"；用户确认用途是**排查问题 / 反馈 bug**，范围是**单个会话**，并要求**补存关键诊断信息**（不只导出现有数据）
- 状态：已实现
- 依赖：无新增权限（不申请 `downloads`）、无新增工具、无新增 `lib/messaging.ts` 消息类型、不改 `run-port-protocol.ts`。不改 Dexie schema（新增的都是非索引字段）

## 1. 目标与非目标

**目标**：用户在历史抽屉里的任一会话上，或在顶栏对当前会话点"导出"，就能下载一个 `.md` 文件。前半部分给人读：按轮次列出问答、每一步工具调用（状态、重试次数、脱敏后的参数、失败原因）、任务结果、是否被停止、是否触发上下文重切、这一轮用的模型和耗时。文件末尾附一段脱敏后的结构化 JSON，供精确分析。整份文件可以直接贴进 issue 或发给开发者，不会泄露页面里的敏感数据、表单填写值或 API Key。

**非目标**：

- 不做导入。这份导出只给人看和排查问题用，不是备份格式。
- 不导出全部会话，也不支持批量导出。
- 不持久化工具**成功时**的返回正文。这类正文体积大，又最容易带出页面隐私；排查问题主要看失败原因，失败报错文本会补存（§3.1）。
- 不把 `perf-trace.ts` 的分桶耗时持久化。它受 `__RUNI_PERF__` 开关控制，还是模块级单例；本设计在 `run-registry.ts` 里另记粗粒度耗时（§3.2）。
- 不回填存量记录。旧消息没有新字段，导出时就不显示对应项。

## 2. 方案总览

| 部分 | 落点 | 新增 / 改动 |
|---|---|---|
| 补存诊断信息 | `run-registry.ts` 已有的 `tool_execution_end` 订阅和 `finally` 收尾 | `ActivityStep.errorText`；`ChatMessage.runDiagnostics`（及 `ChatMessageRecord` 同名字段） |
| 生成导出 | 新文件 `lib/chat/conversation-export.ts`（纯函数） | `buildConversationExport` → `ConversationExport`（已脱敏的中间结构）；`renderConversationExportMarkdown`；`exportFileName` |
| 触发下载 | 面板页 | `HistoryDrawer` 每行一个导出按钮；`WorkbenchHeader` 一个"导出当前会话"按钮；`store.ts` 的 `exportConversation(id)` |

生成导出分两步。脱敏只在 `buildConversationExport` 里做一次；Markdown 和 JSON 附录都从同一个已脱敏的结构渲染出来，不存在第二条未脱敏的输出路径。这一点和 `turn-context.ts` 对交接块整体过 `redactText` 是同一个道理。

## 3. 补存诊断信息

### 3.1 `ActivityStep.errorText`

在 `lib/agent/activity-steps.ts` 的 `ActivityStep` 上新增可选字段 `errorText?: string`。

- 只在 `tool_execution_end` 且 `event.isError === true` 时写入：取 `event.result.content` 里所有 `type: 'text'` 片段拼接，先 `redactText`，再截到 `MAX_STEP_ERROR_CHARS`（300 字）。顺序必须是先脱敏再截断，理由同 `page-outline.ts`：先截断可能把敏感串切成两半，脱敏正则就匹配不上了。
- 脱敏设置复用 `startRun` 里已有的 `recordRedaction` promise，不再加载第二次。
- 被用户停止、在 `stopRun` 里标成 failed 的步骤没有 `tool_execution_end`，所以没有 `errorText`。导出时这类步骤靠消息上的 `stopped` 区分。
- `finishActivityStep` 目前只接收状态和描述，需要增加一个可选参数 `errorText`。`upsertActivityStep` 做重试合并时，保留最后一次尝试的 `errorText`。
- 面板暂不渲染这个字段：本设计只负责导出。以后要在步骤列表里显示失败原因，另开设计。

### 3.2 `ChatMessage.runDiagnostics`

只在 assistant 消息上出现，由 `startRun` 的 `finally` 在写 `taskOutcome` / `activitySteps` 的同一处合并进最后一条消息：

```ts
export interface RunDiagnostics {
  /** ProviderConfig.name，例如 "DeepSeek"；不含 apiKey。 */
  providerName: string;
  /** resolveProviderApi 的结果：'openai-completions' | 'anthropic-messages'。 */
  api: string;
  /** baseURL 只保留 host（本地模型常见 localhost:11434，依然有排查价值）；解析失败记 ''。 */
  baseUrlHost: string;
  modelId: string;
  /** supportsVision 的结果——决定了这一轮有没有 browser_screenshot。 */
  vision: boolean;
  /** 这一轮是否不带浏览器工具（selection/none 作用域的快捷指令）。 */
  withoutBrowserTools: boolean;
  readToolCallBudget: number;
  writeToolCallBudget: number;
  startedAt: number;
  durationMs: number;
  /** turn_start 事件计数。 */
  llmTurns: number;
  /** tool_execution_start 事件计数（含失败、含被拦截后仍发出 start 的调用）。 */
  toolCalls: number;
}
```

- 值全部取自 `StartRunRequest` 和 `run-registry.ts` 自己订阅的事件，不依赖 `perf-trace.ts`。
- 正常结束、报错、用户停止三种情况都写。`scanForOrphans` 追加的"因重启中断"消息不写，因为那一轮的内存状态已经没了。
- `lib/chat/messages.ts` 的消息 → 记录映射，以及 `store.ts` 的记录 → 消息映射，都照 `trajectory` 的写法各加一行。
- `ChatMessageRecord` 加同名字段，不建索引，不升级 Dexie 版本。

## 4. 生成导出

### 4.1 输入与脱敏规则

```ts
buildConversationExport({
  conversation: ConversationRecord,
  messages: ChatMessage[],
  redaction: RedactionSettings,
  extensionVersion: string,
  locale: Locale,
  exportedAt: number,
}): ConversationExport
```

| 数据 | 处理 |
|---|---|
| 用户消息、assistant 回复正文、`quotedText` | `redactText`，不截断。回复本来就基于已脱敏的页面文本生成，但用户自己输入的内容可能含手机号、邮箱 |
| 会话 `url`、`tabReferences[].url`、参数里的 `url` | http(s) 去掉 query 和 hash，只留 `origin + pathname`；其他 scheme 连 pathname 也不留（`data:` 的 pathname 就是载荷，`file:` 带本机用户名）；之后再 `redactText`（路径里可能有邮箱）。解析失败就整段省略（终审修订）|
| `tabReferences[].title`、会话标题 | `redactText` |
| 附件 | 只保留 `kind` / `name` / `mimeType` / `size`（PDF 另加 `pageCount`）。不导出图片 `dataUrl`，也不导出文本附件 `textContent` |
| 步骤 `description`、`tabLabel` | `redactText`。写工具的描述如果依赖被屏蔽的参数（`browser_type` 会把输入原文写进描述），改用屏蔽后的参数重新生成（终审修订）|
| 步骤 `signature` | 拆出工具名和参数 JSON。参数先按 §4.2 处理，再序列化成字符串，截到 300 字 |
| 步骤 `errorText` | 落库时已脱敏，原样保留 |
| `taskOutcome` | 原样保留（模型自报的结果，没有页面原文） |
| `trajectory` | 落库时已脱敏、不含 sensitive 字段的值，但普通字段的填写值还在：`values[].value` 按 §4.2 只留长度（终审修订）|
| `rerun` | 只保留快捷指令的 `id` / `name` / `scope`。`selection` 和 `supplement` 不导出（`selection` 是页面原文，而且那条用户消息的 `quotedText` 已经带了） |
| `runDiagnostics` | 原样保留 |

### 4.2 工具参数的值屏蔽

调用签名里的参数就是模型传给工具的原始参数，其中可能有 `browser_fill_form` / `browser_type` 写入的密码、身份证号。规则如下：

- 只对 `WRITE_TOOL_NAMES`（`permissions.ts`）里的工具生效：递归遍历参数对象，键名属于 `MASKED_WRITE_ARG_KEYS = ['value', 'text']` 的字符串值替换成 `‹已省略 N 字›`（中英文案走 i18n）。目前覆盖的写入值有：`browser_fill_form` 的 `fields[].value`、`browser_type` 的 `text`、`browser_select` 的 `value`、`browser_modify_dom` 的 `value`、`browser_set_storage` 的 `value`。
- 读工具的参数不屏蔽，只脱敏。`browser_find_text` / `browser_wait_for` 的 `text` 是模型要找的文字，不是写进页面的值，而排查"为什么没找到"恰恰需要它。
- 所有未屏蔽的字符串值先 `redactText`，再各自截到 120 字。
- `fieldId`、`selector`、`key`、`url`（按 §4.1 去掉 query）这类定位信息保留原样，排查"点错了元素"主要就靠它们。

用键名规则而不是按工具逐个写，这样新增写工具时只要沿用 `value` / `text` 命名就自动被屏蔽；命名不一致的情况由 §7 的守护测试拦住。

### 4.3 Markdown 结构

文案跟随 UI 语言（传入 `Translate`）。大致如下：

```markdown
# Runi 会话导出：<会话标题>

- 导出时间：2026-09-24 14:03
- 扩展版本：1.4.0 · 界面语言：zh
- 会话页面：https://example.com/checkout
- 说明：已按脱敏规则处理；表单填写值、图片、附件正文、API Key 未导出

## 第 1 轮

### 用户 · 14:01
> 引用：<quotedText>
<正文>
附件：screenshot.png（image/png，210 KB）

### Runi · 14:02 · 已停止 / 上下文已重切（有才显示）
<正文>

**运行信息**：DeepSeek · deepseek-v4-pro（openai-completions @ api.deepseek.com）· 视觉 否 · 耗时 38.2s · LLM 5 轮 · 工具 9 次 · 预算 读 20 / 写 40
**任务结果**：partial —— <summary>

| # | 状态 | 步骤 | 调用 | 失败原因 |
|---|---|---|---|---|
| 1 | ✓ | 读取页面表单 | `browser_get_form {}` | |
| 2 | ✗ ×2 | 填写 3 个字段 | `browser_fill_form {"fields":[{"fieldId":"f3","value":"‹已省略 11 字›"}]}` | 字段 f3 写入后读回不一致 |

---

## 附录：结构化数据

​```json
{ "schema": "runi-conversation-export/1", ... }
​```
```

- "一轮"指一条用户消息加上它后面的 assistant 消息。
- 表格单元格里的 `|` 和换行要转义，JSON 附录里的 ``` 也要转义，防止模型回复里的内容撑坏文件结构。
- 附录 JSON 就是 `ConversationExport` 本身，顶层带 `schema: 'runi-conversation-export/1'`，结构以后变了可以区分版本。

### 4.4 文件名

`runi-<标题>-<YYYYMMDD-HHmm>.md`。标题里 Windows / macOS 文件名不允许的字符（`\/:*?"<>|` 和控制字符）替换成 `_`，截到 40 字；标题为空时用 `conversation`。

## 5. 触发下载

- `store.ts` 新增 `exportConversation(conversationId)`：用 `getConversationMessages` 从 IndexedDB 读消息，用 `listConversations` 找会话记录，加载 `loadRedactionSettings()`，取 `browser.runtime.getManifest().version`，然后调用 `buildConversationExport` 和 `renderConversationExportMarkdown`。拿到结果后，用 `Blob` + `URL.createObjectURL` + 临时 `<a download>` 触发下载，再 `revokeObjectURL`。
  - 统一从 IndexedDB 读，不读面板内存。历史抽屉导出的会话可能不是当前会话，两条路径应该拿到同一份数据。
  - 当前会话还在运行时（`busy`），顶栏按钮置灰，不导出一份半截的记录。历史抽屉里的按钮不受限制：从抽屉导出，导的是已经落库的内容。
  - 失败（会话已被删除、读库报错）时沿用面板现有的错误提示通道，不静默吞掉。
- `HistoryDrawer`：每行的删除按钮旁边加一个导出图标按钮，新增 `onExport(id)` 回调，`aria-label` 走 i18n。
- `WorkbenchHeader`：新对话按钮旁边加一个"导出当前会话"按钮，新增 `onExport` 回调；当前会话没有消息或正在运行时禁用。
- 新增的 i18n key 放在 `export.*` 下，`zh` 和 `en` 两份字典都要补。不涉及 manifest 字符串，不用改 `public/_locales`。

## 6. 测试

- `lib/chat/conversation-export.test.ts`（unit 项目）：
  - 脱敏：用户正文、步骤描述、参数里的手机号或邮箱被替换；`value` / `text` 等键被屏蔽，只显示长度；URL 去掉了 query 和 hash。
  - 附件：结果里不含 `dataUrl` 和 `textContent`。
  - 存量兼容：没有 `runDiagnostics` / `errorText` 的消息照常渲染，不出现空的"运行信息"行。
  - 结构：表格单元格里的 `|` 和换行被转义；附录 JSON 能被 `JSON.parse` 解析，`schema` 字段正确。
  - 分轮：连续的 assistant 消息和开头的 assistant 消息都能正确归到某一轮。
  - `exportFileName`：非法字符、空标题、超长标题。
  - §7 的写工具参数键守护测试：`browser_set_style` 的 `styles` 是 CSS 键值对，归入 `KEPT_WRITE_ARG_KEYS`。
- `lib/agent/run-registry.test.ts`：
  - 失败的工具调用会落下已脱敏、已截断的 `errorText`；成功的调用没有这个字段。
  - 正常结束、报错、用户停止三种情况下，最后一条 assistant 消息都带 `runDiagnostics`，而且 `baseUrlHost` 不含路径，结构里没有 `apiKey`。
- `lib/agent/activity-steps.test.ts`：重试合并时保留最后一次尝试的 `errorText`。
- `entrypoints/sidepanel/components/workbench-components.test.tsx`（ui 项目）：历史抽屉的导出按钮用正确的 id 调用 `onExport`；顶栏按钮在 busy 或没有消息时禁用。
- 端到端手动验证：`pnpm build` 后加载扩展，跑一轮带写操作、带一次失败的任务，分别从顶栏和历史抽屉导出，检查文件内容。

## 7. 风险

- **键名规则漏掉写值的键。** 如果以后某个写工具把写入值放在别的键下（比如 `content`），这个值会只经过 `redactText`，以明文导出。缓解办法是加一条守护测试：遍历 `WRITE_TOOL_NAMES` 对应工具的 TypeBox 参数 schema，收集所有字符串类型叶子参数的键名，断言每个键要么在 `MASKED_WRITE_ARG_KEYS` 里，要么在一份显式的 `KEPT_WRITE_ARG_KEYS` 清单里（`selector`、`fieldId`、`url`、`key`、`attribute`、`action` 等定位或枚举参数）。新增写工具或新参数时这条测试会失败，逼着开发者当场决定这个键该不该屏蔽。
- **`errorText` 来自页面。** 写入校验的失败文本可能带出页面上的字段标签。已经过 `redactText`，并截到 300 字，风险和工具结果进入模型上下文时相同，没有扩大。
