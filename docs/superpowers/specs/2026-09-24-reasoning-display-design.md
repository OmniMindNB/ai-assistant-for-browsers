# 显示推理过程：展示推理模型返回的思考内容

- 日期：2026-09-24
- 来源：2026-09-24 全面审查"可新增功能"一节；用户选定此项，并确认范围为**只展示供应商本来就会返回的推理内容**、推理**保存进历史并默认折叠**、呈现方式采用**消息顶部折叠块**（方案 A）
- 状态：已实现
- 依赖：无新增权限、无新增工具、无新增 `lib/messaging.ts` 消息类型、不改 `run-port-protocol.ts` 的消息种类（`RunSnapshot.messages` 里的 `ChatMessage` 多两个可选字段）。不改 Dexie schema（新增的都是非索引字段）

## 1. 目标与非目标

**目标**：用 DeepSeek-reasoner、Qwen3、Kimi 等推理模型时，把模型流式返回的推理内容展示在侧边栏里：

1. **等待期有反馈**：推理模型的首个正文 token 常常要等十几秒（实测首 token 耗时 1.3s–11.2s，推理模型更久），这段时间里用户现在只能看到一个等待指示器。推理内容实时显示出来，用户就知道模型在干什么。
2. **事后可回看**：agent 做了奇怪的操作时，可以展开当时的推理，看它为什么这么做。

**非目标**：

- 不主动开启 Claude extended thinking：不发 `thinking` 参数，不处理 `budget_tokens` 和 temperature 限制，也不在工具循环里回传带签名的 thinking 块。
- 不把推理回传给模型。`toAgentMessages` 不回放，两个 `convertMessages` 不发送。
- 不进会话导出（`conversation-export.ts`）。
- 不穿插进活动步骤时间线（原方案 B）。存储按段划分，以后要升级到 B 不需要迁移数据（§3.1）。
- 不回填存量记录。

## 2. 方案总览

| 部分 | 落点 | 新增 / 改动 |
|---|---|---|
| 解析推理 | `openai-stream.ts`、`anthropic-stream.ts`，共用 `stream-shared.ts` 里新增的 thinking 发射器 | 发出 pi-ai 已有的 `thinking_start` / `thinking_delta` / `thinking_end` 事件；**不改** `AssistantMessage.content` |
| 累积与限量 | `run-registry.ts` 已有的 `agent.subscribe` 订阅 | 按 LLM 调用分段，20,000 字符滑动窗口；写到占位 assistant 消息上 |
| 持久化 | `ChatMessage` / `ChatMessageRecord`、`toMessageRecords`、`store.ts` 的读库映射 | `reasoning?: string[]`、`reasoningOmittedChars?: number` |
| 展示 | 新组件 `entrypoints/sidepanel/components/ReasoningBlock.tsx`，由 `App.tsx` 的 `Message` 渲染 | 运行中展开，正文出现或本轮结束后折叠 |

## 3. 设计

### 3.1 流式层：推理只走事件，不进 content

**OpenAI 兼容协议**（`openai-stream.ts` 的 `processChunk`）：从 `delta.reasoning_content ?? delta.reasoning` 读取推理，只接受非空字符串。DeepSeek、Qwen、Kimi 用的是 `reasoning_content`，OpenRouter 和部分 vLLM 部署用的是 `reasoning`。其他形态（如 OpenRouter 的 `reasoning_details` 数组）都忽略。

**Anthropic Messages 协议**（`anthropic-stream.ts`）：处理 `content_block_start` 中 `content_block.type === 'thinking'` 的块，以及 `content_block_delta` 中 `delta.type === 'thinking_delta'` 的 `delta.thinking`。`redacted_thinking` 块和 `signature_delta` 忽略。我们不发 `thinking` 参数，所以只有兼容端点主动返回推理时这条路径才会触发。代价很小，而且两个协议能保持对称。

**共用发射器**：在 `stream-shared.ts` 里新增一个小工具，内部记录"推理块是否已开启"：

- 收到第一段推理时发 `thinking_start`，之后每段发一次 `thinking_delta`。
- 第一段正文或第一个 tool_call 到达时发 `thinking_end`；流结束（包括出错和中止）时，如果推理块还开着，也补发 `thinking_end`。
- 推理和正文交替出现（先推理、再正文、又推理）时，每次都重新开一个推理块，不合并。

**推理不放进 `AssistantMessage.content`**，这是本节最关键的决定：

- `content` 被上下文压缩（`compactAgentMessages`）、`tool-call-repair.ts` 的正文兜底、`task-outcome`、`run-registry.ts` 的 `extractLastAssistantText` / `describeEmptyAgentRun` 等多处读取。加入第三种 part 类型，这些地方每一处都要重新确认一遍。
- 现在的约定是正文在 `contentIndex` 0、工具调用紧随其后（`buildPartial`、`toolContentIndex`）。把推理插到前面，这些下标都要跟着改。
- 我们本来就不回传推理（§1 非目标），把它放进 content 没有任何好处。

因此事件里的 `partial` 仍然用现有的 `buildPartial` 构造，不带推理。thinking 事件的 `contentIndex` 统一写 `0`。pi-ai 的类型要求这个字段必须有，但我们唯一的消费方 `run-registry.ts` 不读它。这个约定在发射器旁边写注释说明。

**请求体不变**：两个 `convertMessages` 本来就只取 `text` 和 `toolCall`，这次不需要改。新增测试把这一点固定下来。

### 3.2 后台累积：按 LLM 调用分段，总量限 20,000 字符

在 `run-registry.ts` 的订阅里：

- `message_update` 中 `assistantMessageEvent.type === 'thinking_delta'` 的事件，把 `delta` 追加到当前段。
- **分段规则**：一次 LLM 调用最多一段，按已有的 `llmTurns` 计数判断（`turn_start` 时加一）。收到推理时，如果当前轮次还没有段，就新开一段。同一次调用里推理被正文打断后又继续（§3.1 的交替情况），仍然追加到同一段，因为展示上"第 N 次思考"对应的是一次 LLM 调用。没有产生推理的调用不留空段。
- **写入位置**：写到占位 assistant 消息（`state.messages` 的最后一条）的 `reasoning` 字段，复用现有的 48ms `flush` 定时器，不单独推送。`flush` 现在只写 `acc`（正文），需要改成同时写入推理；这是 `replaceLastAssistant` 的一处小改动。
- **滑动窗口**：常量 `MAX_REASONING_CHARS = 20_000`，定义在新文件 `lib/agent/reasoning.ts` 里。不放进 `context-budget.ts`，因为那个文件管的是"多少文本能进模型上下文"，而推理从不进入上下文。追加后如果所有段的总长度超过上限，就从最早的段开头删字，删空的段整段移除，删掉的字数累加到 `reasoningOmittedChars`。这部分做成纯函数 `appendReasoning(state: { segments: string[]; omitted: number }, turn, delta)`，方便测试。
  - **为什么运行时就限量，而不是落库时再截断**：快照每 48ms 会整份经 Port 发给面板并写入 `storage.session`（上限 10MB）。推理动辄几万字，不在运行时限量会把审查报告里的问题 3 放大。
  - **为什么保留最新的内容**：用户最关心的是离最终行动最近的那次推理，运行时面板显示的也是末尾部分。
- **收尾**：`finally` 归档时，推理已经在最后一条 assistant 消息上了，不需要另外处理。被用户停止的一轮保留已经流出的推理。
- **不经过 `redactText`**：和 assistant 正文的处理一致。模型看到的文本类页面内容本来就已经脱敏，推理只是模型的输出。截图不脱敏这个已知缺口同样适用于正文，这里不新增风险。

### 3.3 持久化

- `ChatMessage`（`lib/chat/messages.ts`）和 `ChatMessageRecord`（`lib/db.ts`）新增：
  - `reasoning?: string[]`：每个元素是一次 LLM 调用的推理，已经过 §3.2 的限量。
  - `reasoningOmittedChars?: number`：滑动窗口丢掉的字数，没有丢弃时不写这个字段。
- 两个字段都只在 assistant 消息上出现，并且只在这一轮真的收到过推理时才写。
- 字段不建索引，不升级 Dexie 版本。
- 映射有两处要补：写库用的 `toMessageRecords`，和读库用的 `store.ts` 里 record → `ChatMessage` 映射（与 `runDiagnostics` 相邻）。
- `conversation-export.ts` 按字段白名单从记录里取值，推理天然不会进入导出。补一条守卫测试，防止以后有人整对象展开时把它带出去。
- `turn-context.ts` 的 `toAgentMessages` 只读 `content`，推理天然不会回放。同样补一条测试固定下来。

### 3.4 界面：`ReasoningBlock`

新组件 `entrypoints/sidepanel/components/ReasoningBlock.tsx`，由 `App.tsx` 的 `Message` 渲染在 assistant 正文上方，只在 `message.reasoning` 非空时出现。

- **渲染方式**：纯文本，`whitespace-pre-wrap`，不经过 Markdown。流式期间每 48ms 都会重新渲染，用 Markdown 解析成本太高；推理文本本身也不依赖 Markdown 排版。多段之间用小标题"第 N 次思考"隔开。有省略时，块顶部显示"更早的 N 字已省略"。
- **运行中**（本轮最后一条消息，且 busy，且正文还是空的）：
  - 默认展开；内容区限高约 8 行，出现新内容时自动滚到底。
  - 标题为"思考中…"。
  - 此时替换掉现有的等待指示器（`showThinkingIndicator`）。没有推理的模型仍然显示原来的指示器，行为不变。
- **正文开始输出后，或本轮结束后**：自动折叠，标题改为"已思考 · N 段"（只有一段时写"已思考"），点击可展开或收起。
- **用户手动操作优先**：用户点过展开或收起之后，组件内部记住这个选择，自动状态不再覆盖它。这个状态只存在组件内，不持久化。
- **可访问性**：标题是一个 `<button>`，带 `aria-expanded` 和 `aria-controls`。内容区不是 live region，状态播报仍然只交给 header 那一行（沿用 2026-09-03 走查 P2-9 的约定）。
- **文案**：新增的 zh/en 文案走 `lib/i18n`（"思考中…"、"已思考"、"已思考 · {count} 段"、"第 {n} 次思考"、"更早的 {count} 字已省略"）。

## 4. 测试

| 层 | 文件 | 覆盖点 |
|---|---|---|
| 流式解析 | `openai-stream.test.ts` | `reasoning_content` 与 `reasoning` 两种字段；推理 → 正文 → 推理交替时 start/end 成对；推理之后直接出 tool_call 时补发 end；出错和中止时收口；最终 `AssistantMessage.content` 不含推理 |
| 流式解析 | `anthropic-stream.test.ts` | thinking 块的 start/delta/end；`redacted_thinking` 和 `signature_delta` 被忽略；content 不含推理 |
| 请求体 | 两个 stream 测试 | `convertMessages` 对带历史的上下文输出不变（锁住"不回传"） |
| 纯函数 | `lib/agent/reasoning.test.ts` | 按轮次分段；超过 20,000 字符后从最早的段开头删字；删空的段整段移除；`omitted` 累加正确 |
| 后台 | `run-registry.test.ts` | 推理写到占位消息上并随 flush 推送；归档到最后一条 assistant 消息；被停止的一轮保留推理；没有推理的一轮不写字段 |
| 数据 | `messages` / `store` / `conversation-export` / `turn-context` 测试 | 落库和读库往返一致；导出不含推理；`toAgentMessages` 不含推理 |
| 界面 | `workbench-components.test.tsx` 或新的 `ReasoningBlock.test.tsx` | 运行中展开且替换等待指示器；正文出现后折叠；结束后显示"已思考 · N 段"；手动切换后不被自动状态覆盖；省略提示 |

## 5. 待验证事项

- **DeepSeek 思考模式下的工具循环**：DeepSeek 文档提到，思考模式配合工具调用时，同一问题的工具子轮次应把 `reasoning_content` 回传。我们现在不回传，这次也不改，所以行为和今天一致。本设计只是让推理可见，不影响这个问题。如果之后实测发现不回传会导致报错或效果变差，另立一项处理。
- **推理和正文交替**：部分端点会在同一次调用里交替输出推理和正文。§3.1 和 §3.2 已按"每次重新开块、同一次调用归为一段"处理，需要在真实模型上确认显示效果。
