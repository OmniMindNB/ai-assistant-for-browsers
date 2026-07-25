# 设计：支持 Anthropic 兼容协议的 Provider

日期：2026-07-25

## 背景

`lib/settings.ts` 里的 `ProviderConfig` 目前只描述一种协议：OpenAI 兼容的 chat completions
（`baseURL` 约定填到 `/v1` 为止，`lib/agent/agent.ts` 的 `createOpenAICompatibleModel` 硬编码
`api: 'openai-completions'`，`lib/agent/stream.ts` 也只实现了 OpenAI 风格的 SSE 解析）。

现在越来越多第三方厂商（如火山方舟 Coding Plan，`https://docs.volcengine.com/docs/82379/1928261`）
针对 Claude Code / Codex / OpenCode 等编程 Agent 场景，同时给出 OpenAI 兼容和 Anthropic 兼容两种
接口形态。用户希望这个扩展也能接入这类厂商暴露的 **Anthropic Messages 协议**端点，而不仅限于
OpenAI 协议。

底层依赖的 `@earendil-works/pi-ai`（`dist/types.d.ts`）已经把 `anthropic-messages` 作为一等公民的
`Api` 类型，且 `Model.compat` 为它单独定义了 `AnthropicMessagesCompat`（如是否发送
`eager_input_streaming`、长期缓存、`x-session-affinity` 等第三方厂商兼容开关），说明这个包本身就是
为"多协议、多厂商"场景设计的——本项目目前只是没有用上 Anthropic 这一支。

## 决策

### 1. `ProviderConfig` 新增协议字段，不做自动探测

`lib/settings.ts` 的 `ProviderConfig` 新增：

```ts
api?: 'openai-completions' | 'anthropic-messages';
```

直接复用 pi-ai 自己的 `Api` 字面量值，不额外做一层名称转换。**字段缺省（`undefined`）统一按
`'openai-completions'` 处理**——历史上保存过的 Provider 配置没有这个字段，必须原样继续工作，不做
迁移脚本。

协议类型通过 `components/ProviderSettings.tsx` 表单里新增的"协议类型"下拉框显式选择（选项：
OpenAI 兼容 / Anthropic 兼容），默认 OpenAI 兼容。不做基于 `baseURL` 特征或试探请求的自动协议判断
——不同厂商 URL 形态差异很大，猜错的代价（请求失败又不易定位原因）比多一次手动选择更高，且与本项目
一贯"显式配置、不做隐式推断"的风格一致（对照 `browser_navigate` 只认 http/https 白名单、不猜测
协议的做法）。

范围上**不**在 `PROVIDER_PRESETS` 里新增火山方舟或其他具体厂商的预设条目——这次只做协议层的通用
支持，厂商由用户自行填写 `baseURL` / `apiKey`。

### 2. `agent.ts`：按协议选择 Model 和 StreamFn

- `createOpenAICompatibleModel` 更名为 `createModel(provider)`，在返回的 `Model<Api>` 上设置
  `api: provider.api ?? 'openai-completions'`；`maxTokens: 4096`、`contextWindow: 128000` 等其余
  字段两种协议共用，不拆分。
- `createBrowserAgent` 里选择 `streamFn`：
  ```ts
  const streamFn = provider.api === 'anthropic-messages' ? browserAnthropicStream : browserOpenAIStream;
  ```
- 顺带把 `lib/agent/stream.ts` 改名为 `lib/agent/openai-stream.ts`，与新增的
  `anthropic-stream.ts` 对称命名。当前只有 `agent.ts` 一处 import，改名成本低、无测试文件依赖旧路径。

### 3. 新增 `lib/agent/anthropic-stream.ts`：`browserAnthropicStream: StreamFn`

**请求端**：

- 端点：`POST ${baseURL 去掉结尾斜杠}/messages`（约定与 OpenAI 一致，`baseURL` 填到厂商自己的
  `/v1` 前缀为止，代码负责拼接路径尾巴）。
- 认证头：`x-api-key: <apiKey>` + `anthropic-version: 2023-06-01`（写死的常量），**不使用**
  `Authorization: Bearer`。
- `system` 直接取自 `context.systemPrompt`（已确认 pi-ai 的 `Context` 类型把 `systemPrompt` 和
  `messages` 分开存放，不需要从消息数组里摘取 role: 'system' 的消息）。
- 工具定义：`tools[].input_schema` 替代 OpenAI 的 `function.parameters`，其余字段（`name` /
  `description`）不变。
- `max_tokens` 必填（Anthropic 协议强制要求，不同于 OpenAI 的可选字段），取
  `options?.maxTokens ?? model.maxTokens`。

**消息格式转换**（与 OpenAI 差异最大的部分）：

Anthropic 协议没有独立的 `tool` role——工具结果是 `role: 'user'` 消息里的一个 `tool_result` 类型
content block；assistant 回合里的文本和 `tool_use` block 混在同一条 `assistant` 消息里。转换函数
需要把**连续出现的 `toolResult` AgentMessage 合并成一条 `user` 消息**，每个工具结果各自变成一个
`tool_result` block——即使当前 `agent.ts` 里 `toolExecution: 'sequential'` 通常一次只产生一个
`toolResult`，这个合并逻辑也要写，避免未来任何多工具并发场景下发出不合法的请求序列（Anthropic 端会
直接因协议错误拒绝请求）。

**流式响应解析**：

把 Anthropic 的 SSE 事件（`content_block_start` 的 text / `tool_use`、`content_block_delta` 的
`text_delta` / `input_json_delta`、`content_block_stop`、`message_delta`、`message_stop`）映射到
`openai-stream.ts` 已经在用的同一套内部事件序列（`start` / `text_start` / `text_delta` /
`text_end` / `toolcall_delta` / `toolcall_end` / `done` / `error`），下游（`agent.ts`、
`entrypoints/sidepanel`）完全不需要感知协议差异。

**用量统计**：继续用 `ZERO_USAGE` 占位——`openai-stream.ts` 里 `OpenAIStreamChunk.usage` 字段
从来没被 `processChunk` 实际读取过，当前用量本来就是桩实现；这次不额外把 Anthropic 的真实 token
用量接进来，避免范围扩大到一个既有的、独立的缺口。

## 边界情况

- **未选协议的历史配置**：`api` 字段缺省按 `openai-completions` 处理，行为与改动前完全一致。
- **多个连续 `tool_result`**：合并进同一条 `user` 消息，见决策 3。
- **厂商需要额外 header**（如特定 `anthropic-beta` 值、自定义认证头）：这次不做，
  `ProviderConfig` 暂不开放自定义 header 配置项，留待后续需求明确后再加字段。
- **Anthropic 的 `thinking` content block**：`agent.ts` 全局 `thinkingLevel: 'off'`，正常请求不会
  触发；若厂商仍返回 thinking block，转换逻辑按未知 block 类型忽略即可，不需要专门处理路径。

## 影响范围

- `lib/settings.ts`：`ProviderConfig` 新增 `api` 字段；`trimProviderDraft` /
  `applyPresetToDraft` 等辅助函数按现状透传该字段，不需要改逻辑。
- `components/ProviderSettings.tsx`：表单新增"协议类型"下拉框，`EMPTY_DRAFT` 补上默认值。
- `lib/agent/agent.ts`：`createOpenAICompatibleModel` → `createModel`；按 `provider.api` 选择
  `streamFn`。
- `lib/agent/stream.ts` 改名为 `lib/agent/openai-stream.ts`（内容不变，仅路径）。
- 新增 `lib/agent/anthropic-stream.ts`。
- 不改动 `lib/agent/tools.ts`、`lib/agent/permissions.ts`、`lib/agent/confirm-gate.ts`、
  `lib/agent/turn-snapshot.ts`——这次改动只影响"怎么跟模型服务商通信"这一层，不涉及工具执行、权限
  或撤销逻辑。

## 测试计划

- 新增 `lib/agent/anthropic-stream.test.ts`：
  - SSE 事件到内部事件协议的映射（text 增量、tool_use 增量、done）。
  - `system` 从 `context.systemPrompt` 正确提取。
  - 连续 `toolResult` 合并为单条 `user` 消息、`tool_use`/`tool_result` id 对应关系正确。
  - 非 2xx 响应时的错误抛出路径。
- 扩展 `lib/settings.test.ts`：覆盖 `api` 字段缺省时的默认协议行为。
- `components/ProviderSettings.tsx` 的下拉框改动没有自动化测试基建（CLAUDE.md 已注明
  `entrypoints/`/`components/` 目前不在 vitest 覆盖范围内），按现状手动验证：
  1. 新增 Provider 时选择"Anthropic 兼容"，保存后编辑回填能看到协议类型正确回显。
  2. 用一个真实的 Anthropic 兼容端点（或本地 mock server）走一轮带工具调用的对话，确认流式文本和
     工具调用都能正常触发确认弹窗、正常执行。
  3. 未选协议（历史配置）时，行为与改动前完全一致（回归验证）。

## 不做的事

- 不新增自定义 HTTP header 配置项。
- 不在 `PROVIDER_PRESETS` 里加具体厂商（火山方舟等）的预设条目。
- 不做基于 URL 特征或试探请求的协议自动探测。
- 不支持 extended thinking / vision content block 的专门渲染。
- 不接入 Anthropic 协议下的真实 token 用量统计（沿用现有的桩实现）。
