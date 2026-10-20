# OpenAI Responses API 协议支持

日期：2026-10-20

## 1. 背景

OpenAI 官方文档（2026-10 核对）：

- Responses API（`POST /v1/responses`）是推荐给所有新项目的接口；Chat Completions 仍受支持。
- 从 GPT-5.4 起，Chat Completions 不支持在 `reasoning_effort` 不为 `none` 时调用工具；**GPT-6 Astra 与 GPT-6.1 Sol 的工具调用只能走 Responses API**。
- 当前官方模型列表是 `gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna`，窗口都是 1.05M；`gpt-5.6-*` 已不在列表中。

Runi 的 agent 完全依赖工具调用，所以原来的 OpenAI 预设（Chat Completions + gpt-5.6）已经跑不了当前的旗舰模型。

## 2. 方案

新增第三种协议 `openai-responses`，与 `openai-completions`、`anthropic-messages` 并列（`lib/settings.ts` 的 `ProviderApi`）。它不是 Chat Completions 的开关：请求结构、工具调用回传和流式事件都不一样。

| 位置 | 改动 |
|---|---|
| `lib/agent/openai-responses-stream.ts` | 新的 `streamFn` |
| `lib/agent/agent.ts` | `selectStreamFn` 按协议三选一 |
| `lib/agent/one-shot-completion.ts` | 测试连接、整理通用做法用的非流式分支 |
| `components/ProviderSettings.tsx` + i18n | 协议下拉框新增「OpenAI Responses」 |
| `PROVIDER_PRESETS` | OpenAI 预设改用 `openai-responses` + GPT-6 系列 |

## 3. 请求映射

- 系统提示 → `instructions`；消息历史 → `input` 条目列表。
- 用户消息：纯文本保持字符串；有图片时拆成 `input_text` + `input_image`（`image_url` 为 data URL）。
- 助手消息：文本 → `{ role: 'assistant', content }`；工具调用 → `{ type: 'function_call', call_id, name, arguments }`。**不带条目 id（`fc_…`）**：带了 id 而不带它对应的 reasoning 条目，推理模型会拒绝请求，而我们不回传推理（见 §5）。
- 工具结果 → `{ type: 'function_call_output', call_id, output }`。有截图时 `output` 直接是 `input_text` + `input_image` 数组，图片留在它所属的工具结果里，紧挨着那句 untrusted-content 声明；不需要 `openai-stream.ts` 那种「合成一条 user 消息」的做法。
- 工具定义是扁平的 `{ type: 'function', name, description, parameters, strict: false }`。不写 `strict` 时 API 会尝试严格模式，可能改变可选参数的语义，所以显式关掉，保持和 Chat Completions 一样的非严格语义。
- `store: false`：每轮都完整重放历史，用不到服务端状态，也不在 OpenAI 侧留存对话。
- 不发 `temperature`：推理模型不保证接受采样参数。
- `max_output_tokens` 取 `options.maxTokens`；非流式分支把它抬到至少 16（API 的下限），否则测试连接用的 1 会直接返回 400。

## 4. 流式事件

只读 `data:` 行，事件类型取自 JSON 里的 `type`；Responses 的流没有 `[DONE]`。

| 事件 | 处理 |
|---|---|
| `response.output_text.delta` / `response.refusal.delta` | 正文增量 |
| `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` | 只走 thinking 事件 |
| `response.output_item.added` / `.done`（`function_call`） | 以 `output_index` 为键登记调用，`call_id` 作为 ToolCall id；`.done` 的 `arguments` 覆盖累积值 |
| `response.function_call_arguments.delta` / `.done` | 参数增量 / 最终值 |
| `response.completed` / `response.incomplete` | 收尾；`incomplete_details.reason === 'max_output_tokens'` 报为 `length` |
| `response.failed` / `error` | 抛错，走统一的错误收尾 |

usage 从 `response.usage` 读取（`input_tokens` 已包含 `input_tokens_details.cached_tokens`），只进耗时画像。

## 5. 不做的事

- **不回传推理条目。** OpenAI 建议无状态调用时把 reasoning 条目（含 `encrypted_content`）原样回传，但这只是建议，不是必需。项目的既定约束是推理只走事件、不进 `AssistantMessage.content`、不回传（`stream-shared.ts`），要回传就得给 AssistantMessage 加一个不透明的字段，并一路穿过上下文压缩、会话持久化和导出。先不做；如果实测发现多轮工具调用质量明显下降，再单独设计。
- **不请求推理摘要**（`reasoning.summary`）：部分组织要先完成验证才能开启，开了可能直接 400。
- **不用 `previous_response_id`**：与 `store: false` 和每轮完整重放的上下文管理冲突。
- `Decisions API`（DevDay 2026，有限预览）是分类/路由用的专用接口，不是对话协议，不在本次范围内。

## 6. 参考

- [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [Models](https://developers.openai.com/api/docs/models)
