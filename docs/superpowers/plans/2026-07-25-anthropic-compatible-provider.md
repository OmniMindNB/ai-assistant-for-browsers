# Anthropic 兼容协议 Provider 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `ProviderConfig` 能显式选择 Anthropic Messages 协议（而不仅是现有的 OpenAI 兼容协议），使配置了 Anthropic 兼容端点的第三方厂商（如火山方舟 Coding Plan）也能被这个扩展接入。

**Architecture:** 把 `lib/agent/stream.ts` 里协议无关的流式状态构建逻辑抽到 `lib/agent/stream-shared.ts`；新增 `lib/agent/anthropic-stream.ts` 实现 Anthropic Messages 协议的请求构造、消息格式转换（含 `tool_result` 合并）与 SSE 解析，映射到与现有 OpenAI 实现完全相同的内部事件协议（`AssistantMessageEvent`）；`ProviderConfig` 新增 `api` 字段驱动 `agent.ts` 在两个 `StreamFn` 之间选择。

**Tech Stack:** TypeScript, `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core`（提供 `Api`/`Context`/`Model`/`StreamFn`/`AssistantMessageEvent` 等类型与 `createAssistantMessageEventStream`），vitest（`environment: 'node'`，全局 `fetch`/`Response`/`ReadableStream` 可用）。

## Global Constraints

- 协议字面量固定为 pi-ai 的 `Api` 值：`'openai-completions' | 'anthropic-messages'`，不做自定义命名转换。
- `ProviderConfig.api` 缺省（`undefined`）必须等价于 `'openai-completions'`——历史保存的 Provider 配置没有这个字段，行为不能变。
- Anthropic 认证头固定为 `x-api-key` + `anthropic-version: 2023-06-01`（写死常量），不使用 `Authorization: Bearer`。
- `baseURL` 约定与现有 OpenAI 分支一致：用户填到厂商自己的 `/v1` 前缀为止，代码负责拼接路径尾巴（Anthropic 分支拼接 `/messages`）。
- 不新增自定义 HTTP header 配置项，不在 `PROVIDER_PRESETS` 里加具体厂商预设，不做基于 URL 的协议自动探测——这些都是本次明确排除的范围（见
  [[2026-07-25-anthropic-compatible-provider-design]] 的"不做的事"）。
- `components/ProviderSettings.tsx` / `entrypoints/` 目前不在 vitest 覆盖范围内（`vitest.config.ts` 的 `include` 只有 `lib/**/*.test.ts`），UI 改动按现状手动验证，不新增自动化测试。

---

### Task 1: 抽取协议无关的流式辅助函数，`stream.ts` 改名为 `openai-stream.ts`

这是一次纯重构：把 `buildPartial`/`finishStream`/`createAssistantMessage`/`parseToolArguments`/`stringifyContent`/`ZERO_USAGE`/`ToolCallAccumulator` 这些与协议无关、Task 3 也要用到的部分挪到新文件，避免后面复制粘贴出两份几乎相同的代码。不改变任何对外行为。

**Files:**
- Create: `lib/agent/stream-shared.ts`
- Create: `lib/agent/openai-stream.ts`（`lib/agent/stream.ts` 的重构版本）
- Delete: `lib/agent/stream.ts`
- Modify: `lib/agent/agent.ts:4`（import 路径）

**Interfaces:**
- Produces（`stream-shared.ts` 导出，供 Task 3 的 `anthropic-stream.ts` 复用）：
  - `export interface ToolCallAccumulator { id: string; name: string; argumentsText: string }`
  - `export const ZERO_USAGE: Usage`
  - `export function createAssistantMessage(model: Model<Api>, timestamp: number, stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage`
  - `export function buildPartial(model: Model<Api>, timestamp: number, text: string, toolCalls: Map<number, ToolCallAccumulator>, stopReason: AssistantMessage['stopReason']): AssistantMessage`
  - `export function finishStream(model: Model<Api>, push: (event: AssistantMessageEvent) => void, timestamp: number, text: string, toolCalls: Map<number, ToolCallAccumulator>, fallbackReason: 'stop' | 'toolUse' | 'length'): void`
  - `export function parseToolArguments(value: string): Record<string, unknown>`
  - `export function stringifyContent(content: unknown): string`
- Produces（`openai-stream.ts` 导出，供 Task 4 使用）：
  - `export const browserOpenAIStream: StreamFn`（与改动前 `lib/agent/stream.ts` 导出的 `browserOpenAIStream` 完全等价）

- [ ] **Step 1: 新建 `lib/agent/stream-shared.ts`**

```ts
// lib/agent/stream-shared.ts
// 协议无关的流式响应内部状态与事件构建工具，供 openai-stream.ts / anthropic-stream.ts 共用。
import type { AssistantMessage, AssistantMessageEvent, Api, Model, ToolCall, Usage } from '@earendil-works/pi-ai';

export interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createAssistantMessage(
  model: Model<Api>,
  timestamp: number,
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    errorMessage,
    timestamp,
  };
}

export function buildPartial(
  model: Model<Api>,
  timestamp: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: parseToolArguments(call.argumentsText),
    } satisfies ToolCall);
  }
  return { ...createAssistantMessage(model, timestamp, stopReason), content };
}

export function finishStream(
  model: Model<Api>,
  push: (event: AssistantMessageEvent) => void,
  timestamp: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  fallbackReason: 'stop' | 'toolUse' | 'length',
): void {
  const reason = toolCalls.size > 0 ? 'toolUse' : fallbackReason;
  const message = buildPartial(model, timestamp, text, toolCalls, reason);
  let contentIndex = text ? 1 : 0;
  for (const toolCall of message.content) {
    if (toolCall.type !== 'toolCall') continue;
    push({ type: 'toolcall_end', contentIndex, toolCall, partial: message });
    contentIndex += 1;
  }
  push({ type: 'done', reason, message });
}

export function parseToolArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
```

- [ ] **Step 2: 新建 `lib/agent/openai-stream.ts`（内容等价于原 `stream.ts`，改为从 `stream-shared.ts` 导入公共部分）**

```ts
// lib/agent/openai-stream.ts
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type ToolCall, type Usage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { buildPartial, createAssistantMessage, finishStream, stringifyContent, type ToolCallAccumulator } from './stream-shared';

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Partial<Usage>;
}

export const browserOpenAIStream: StreamFn = (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();

  void runOpenAIStream(model, context, options, stream.push.bind(stream));

  return stream;
};

async function runOpenAIStream(
  model: Model<Api>,
  context: Context,
  options: Parameters<StreamFn>[2],
  push: (event: AssistantMessageEvent) => void,
): Promise<void> {
  const startedAt = Date.now();
  const partial = createAssistantMessage(model, startedAt, 'stop');
  let text = '';
  let textStarted = false;
  const toolCalls = new Map<number, ToolCallAccumulator>();

  push({ type: 'start', partial });

  try {
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options?.apiKey ?? ''}`,
        ...(model.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        messages: convertMessages(context),
        tools: context.tools?.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: context.tools?.length ? 'auto' : undefined,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${response.status} ${response.statusText})${detail ? `：${detail}` : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (data === '[DONE]') {
          if (textStarted) {
            push({
              type: 'text_end',
              contentIndex: 0,
              content: text,
              partial: buildPartial(model, startedAt, text, toolCalls, 'stop'),
            });
          }
          finishStream(model, push, startedAt, text, toolCalls, 'stop');
          return;
        }
        processChunk(JSON.parse(data) as OpenAIStreamChunk, model, push, startedAt, text, toolCalls, (delta) => {
          if (!textStarted) {
            textStarted = true;
            push({ type: 'text_start', contentIndex: 0, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          text += delta;
          push({ type: 'text_delta', contentIndex: 0, delta, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
        });
      }
    }

    if (textStarted) {
      push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
    }
    finishStream(model, push, startedAt, text, toolCalls, toolCalls.size > 0 ? 'toolUse' : 'stop');
  } catch (error) {
    const message = createAssistantMessage(model, startedAt, 'error', error instanceof Error ? error.message : String(error));
    push({ type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: message });
  }
}

function processChunk(
  chunk: OpenAIStreamChunk,
  model: Model<Api>,
  push: (event: AssistantMessageEvent) => void,
  startedAt: number,
  text: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  appendText: (delta: string) => void,
): void {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (!delta) return;

  if (delta.content) appendText(delta.content);

  for (const toolCall of delta.tool_calls ?? []) {
    const current = toolCalls.get(toolCall.index) ?? {
      id: toolCall.id ?? `tool-${toolCall.index}`,
      name: '',
      argumentsText: '',
    };
    if (toolCall.id) current.id = toolCall.id;
    if (toolCall.function?.name) current.name = toolCall.function.name;
    if (toolCall.function?.arguments) current.argumentsText += toolCall.function.arguments;
    toolCalls.set(toolCall.index, current);
    push({
      type: 'toolcall_delta',
      contentIndex: text ? toolCall.index + 1 : toolCall.index,
      delta: toolCall.function?.arguments ?? '',
      partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
    });
  }
}

function convertMessages(context: Context): Array<Record<string, unknown>> {
  return context.messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: stringifyContent(message.content) };
    }
    if (message.role === 'toolResult') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: stringifyContent(message.content),
      };
    }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const toolCalls = message.content
      .filter((part): part is ToolCall => part.type === 'toolCall')
      .map((part) => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.arguments) },
      }));
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  });
}
```

- [ ] **Step 3: 删除旧文件 `lib/agent/stream.ts`**

```bash
rm lib/agent/stream.ts
```

- [ ] **Step 4: 更新 `lib/agent/agent.ts` 的 import 路径**

`lib/agent/agent.ts:4` 把：

```ts
import { browserOpenAIStream } from './stream';
```

改成：

```ts
import { browserOpenAIStream } from './openai-stream';
```

- [ ] **Step 5: 类型检查 + 跑现有全部测试，确认纯重构没有破坏任何行为**

Run: `pnpm compile && pnpm test`
Expected: 两个命令都无报错退出（`pnpm compile` 无输出即通过；`pnpm test` 现有全部用例保持通过，因为这一步没有新增任何 `.test.ts`）。

- [ ] **Step 6: Commit**

```bash
git add lib/agent/stream-shared.ts lib/agent/openai-stream.ts lib/agent/agent.ts
git rm lib/agent/stream.ts
git commit -m "refactor: extract protocol-agnostic stream helpers into stream-shared.ts, rename stream.ts to openai-stream.ts"
```

---

### Task 2: `ProviderConfig` 新增协议字段 + 设置页协议下拉框

**Files:**
- Modify: `lib/settings.ts`
- Modify: `lib/settings.test.ts`
- Modify: `components/ProviderSettings.tsx`

**Interfaces:**
- Consumes: 无（独立于 Task 1/3）
- Produces（供 Task 4 消费）：
  - `ProviderConfig.api?: 'openai-completions' | 'anthropic-messages'`
  - `export function resolveProviderApi(provider: ProviderConfig): 'openai-completions' | 'anthropic-messages'`

- [ ] **Step 1: 在 `lib/settings.test.ts` 里写失败的测试**

在文件顶部的 import 里加入 `resolveProviderApi`：

```ts
import {
  applyPresetToDraft,
  hasDuplicateProviderName,
  resolveProviderApi,
  trimProviderDraft,
  type ProviderConfig,
} from './settings';
```

在文件末尾追加：

```ts
describe('resolveProviderApi', () => {
  it('defaults to openai-completions when api is not configured', () => {
    expect(resolveProviderApi(baseDraft)).toBe('openai-completions');
  });

  it('returns openai-completions when explicitly configured', () => {
    expect(resolveProviderApi({ ...baseDraft, api: 'openai-completions' })).toBe('openai-completions');
  });

  it('returns anthropic-messages when explicitly configured', () => {
    expect(resolveProviderApi({ ...baseDraft, api: 'anthropic-messages' })).toBe('anthropic-messages');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: FAIL — `resolveProviderApi` 在 `./settings` 里不存在（导入报错或 `TypeError: resolveProviderApi is not a function`）。

- [ ] **Step 3: 在 `lib/settings.ts` 里实现**

在 `ProviderConfig` interface（`lib/settings.ts:6-16`）里追加字段：

```ts
export interface ProviderConfig {
  id: string;
  name: string;
  /** OpenAI 兼容的基础地址，至 /v1 为止（不含 /chat/completions） */
  baseURL: string;
  apiKey: string;
  /** 默认 / 当前选中的模型 */
  model: string;
  /** 该 Provider 下可在输入框切换的全部模型（含 model）；为空时回退到 [model] */
  models?: string[];
  /** 协议类型；缺省按 'openai-completions' 处理（兼容未设置该字段的历史配置） */
  api?: 'openai-completions' | 'anthropic-messages';
}
```

紧接着现有的 `providerModels` 函数（`lib/settings.ts:84-87`）之后追加：

```ts
/** 解析 Provider 的协议类型；未显式配置时统一按 OpenAI 兼容处理（历史配置兼容）。 */
export function resolveProviderApi(provider: ProviderConfig): 'openai-completions' | 'anthropic-messages' {
  return provider.api ?? 'openai-completions';
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: PASS，全部用例（含新增的 3 条）通过。

- [ ] **Step 5: Commit**

```bash
git add lib/settings.ts lib/settings.test.ts
git commit -m "feat: add ProviderConfig.api protocol field with openai-completions default"
```

- [ ] **Step 6: 在 `components/ProviderSettings.tsx` 里加协议类型下拉框**

`EMPTY_DRAFT`（`components/ProviderSettings.tsx:18-24`）补上默认值：

```ts
const EMPTY_DRAFT: ProviderConfig = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
  api: 'openai-completions',
};
```

在 "Base URL" 的 `<Field>`（`components/ProviderSettings.tsx:307-313`）之后、"模型（默认）" 的 `<Field>` 之前插入：

```tsx
          <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
            协议类型
            <select
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              value={draft.api ?? 'openai-completions'}
              onChange={(e) =>
                setDraft((d) => ({ ...d, api: e.target.value as ProviderConfig['api'] }))
              }
            >
              <option value="openai-completions">OpenAI 兼容</option>
              <option value="anthropic-messages">Anthropic 兼容</option>
            </select>
          </label>
```

- [ ] **Step 7: 手动验证（`components/` 不在 vitest 覆盖范围内）**

Run: `pnpm dev`，在 `chrome://extensions` 加载 `.output/chrome-mv3` 后打开扩展的设置页：
1. 新增一个 Provider，协议类型下拉框默认显示"OpenAI 兼容"。
2. 切换到"Anthropic 兼容"并保存，重新点击"编辑"，确认下拉框正确回显"Anthropic 兼容"。
3. 打开一个改动前就存在的、没有 `api` 字段的历史 Provider（若本地已有配置）进行编辑，确认下拉框显示"OpenAI 兼容"（缺省回退），且不点保存的情况下其行为不受影响。

- [ ] **Step 8: Commit**

```bash
git add components/ProviderSettings.tsx
git commit -m "feat: add protocol type selector to ProviderSettings form"
```

---

### Task 3: 新增 `lib/agent/anthropic-stream.ts`（Anthropic Messages 协议实现）

这是本次改动里唯一的新协议逻辑：请求构造、消息格式转换（`tool_result` 合并）、SSE 解析，全部通过 mock `fetch` 单元测试覆盖，不依赖 Task 2/4。

**Files:**
- Create: `lib/agent/anthropic-stream.ts`
- Test: `lib/agent/anthropic-stream.test.ts`

**Interfaces:**
- Consumes（来自 Task 1 的 `stream-shared.ts`）：`buildPartial`、`createAssistantMessage`、`finishStream`、`stringifyContent`、`ToolCallAccumulator`
- Produces（供 Task 4 使用）：
  - `export const browserAnthropicStream: StreamFn`
  - `export function convertMessagesForAnthropic(context: Context): Array<Record<string, unknown>>`

- [ ] **Step 1: 写失败的测试 `lib/agent/anthropic-stream.test.ts`**

```ts
// lib/agent/anthropic-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, Api, Context, Model } from '@earendil-works/pi-ai';
import { browserAnthropicStream, convertMessagesForAnthropic } from './anthropic-stream';

function makeModel(): Model<Api> {
  return {
    id: 'claude-test',
    name: 'claude-test',
    api: 'anthropic-messages',
    provider: 'test-provider',
    baseUrl: 'https://example.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function sseResponse(body: string, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        controller.enqueue(bytes);
        sent = true;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status });
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('convertMessagesForAnthropic', () => {
  it('converts a plain user message to a text content block', () => {
    const context: Context = { messages: [{ role: 'user', content: 'hi' }] };
    expect(convertMessagesForAnthropic(context)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('merges consecutive toolResult messages into one user message with multiple tool_result blocks', () => {
    const context: Context = {
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'foo', arguments: {} }] },
        { role: 'toolResult', toolCallId: 't1', toolName: 'foo', content: 'result-1' },
        { role: 'toolResult', toolCallId: 't2', toolName: 'bar', content: 'result-2' },
      ],
    };
    const converted = convertMessagesForAnthropic(context);
    expect(converted).toHaveLength(2);
    expect(converted[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'result-1' },
        { type: 'tool_result', tool_use_id: 't2', content: 'result-2' },
      ],
    });
  });

  it('converts an assistant message with both text and a tool call', () => {
    const context: Context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'toolCall', id: 't1', name: 'get_weather', arguments: { city: 'NY' } },
          ],
        },
      ],
    };
    expect(convertMessagesForAnthropic(context)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'NY' } },
        ],
      },
    ]);
  });
});

describe('browserAnthropicStream', () => {
  it('streams text and a tool call, mapping SSE events to the internal protocol', async () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"NY\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sse)));

    const context: Context = { systemPrompt: '你是助手', messages: [{ role: 'user', content: '今天天气怎么样' }] };
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'test-key' });
    const events = await collectEvents(stream);

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' }),
      }),
    );

    const textDelta = events.find((e) => e.type === 'text_delta');
    expect(textDelta).toMatchObject({ delta: 'Hello' });

    const toolEnd = events.find((e) => e.type === 'toolcall_end');
    expect(toolEnd).toMatchObject({
      toolCall: { id: 'toolu_1', name: 'get_weather', arguments: { city: 'NY' } },
    });

    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', reason: 'toolUse' });
    if (done?.type === 'done') {
      expect(done.message.content).toContainEqual({ type: 'text', text: 'Hello' });
    }
  });

  it('pushes an error event when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })),
    );

    const context: Context = { messages: [{ role: 'user', content: 'hi' }] };
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'bad-key' });
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('401');
    }
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/anthropic-stream.test.ts`
Expected: FAIL — 找不到模块 `./anthropic-stream`。

- [ ] **Step 3: 实现 `lib/agent/anthropic-stream.ts`**

```ts
// lib/agent/anthropic-stream.ts
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { buildPartial, createAssistantMessage, finishStream, stringifyContent, type ToolCallAccumulator } from './stream-shared';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicSseEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  error?: { message?: string };
}

export const browserAnthropicStream: StreamFn = (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();

  void runAnthropicStream(model, context, options, stream.push.bind(stream));

  return stream;
};

async function runAnthropicStream(
  model: Model<Api>,
  context: Context,
  options: Parameters<StreamFn>[2],
  push: (event: AssistantMessageEvent) => void,
): Promise<void> {
  const startedAt = Date.now();
  const partial = createAssistantMessage(model, startedAt, 'stop');
  let text = '';
  let textStarted = false;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const toolBlockIndexes = new Set<number>();

  function toolContentIndex(blockIndex: number): number {
    return (text ? 1 : 0) + [...toolCalls.keys()].sort((a, b) => a - b).indexOf(blockIndex);
  }

  push({ type: 'start', partial });

  try {
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options?.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
        ...(model.headers ?? {}),
      },
      body: JSON.stringify({
        model: model.id,
        system: context.systemPrompt,
        messages: convertMessagesForAnthropic(context),
        tools: context.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        max_tokens: options?.maxTokens ?? model.maxTokens,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${response.status} ${response.statusText})${detail ? `：${detail}` : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (!data) continue;
        const event = JSON.parse(data) as AnthropicSseEvent;

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'text') {
          if (!textStarted) {
            textStarted = true;
            push({ type: 'text_start', contentIndex: 0, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          continue;
        }

        if (event.type === 'content_block_start' && event.index !== undefined && event.content_block?.type === 'tool_use') {
          toolBlockIndexes.add(event.index);
          toolCalls.set(event.index, {
            id: event.content_block.id ?? `tool-${event.index}`,
            name: event.content_block.name ?? '',
            argumentsText: '',
          });
          push({
            type: 'toolcall_delta',
            contentIndex: toolContentIndex(event.index),
            delta: '',
            partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
          });
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          text += event.delta.text;
          push({ type: 'text_delta', contentIndex: 0, delta: event.delta.text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          continue;
        }

        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'input_json_delta' &&
          event.index !== undefined &&
          toolBlockIndexes.has(event.index)
        ) {
          const accumulator = toolCalls.get(event.index);
          const delta = event.delta.partial_json ?? '';
          if (accumulator) accumulator.argumentsText += delta;
          push({
            type: 'toolcall_delta',
            contentIndex: toolContentIndex(event.index),
            delta,
            partial: buildPartial(model, startedAt, text, toolCalls, 'toolUse'),
          });
          continue;
        }

        if (event.type === 'error') {
          throw new Error(event.error?.message ?? 'Anthropic 流式请求返回错误');
        }

        if (event.type === 'message_stop') {
          if (textStarted) {
            push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
          }
          finishStream(model, push, startedAt, text, toolCalls, 'stop');
          return;
        }
      }
    }

    if (textStarted) {
      push({ type: 'text_end', contentIndex: 0, content: text, partial: buildPartial(model, startedAt, text, toolCalls, 'stop') });
    }
    finishStream(model, push, startedAt, text, toolCalls, toolCalls.size > 0 ? 'toolUse' : 'stop');
  } catch (error) {
    const message = createAssistantMessage(model, startedAt, 'error', error instanceof Error ? error.message : String(error));
    push({ type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: message });
  }
}

function isToolResultGroup(content: unknown): content is Array<{ type: string }> {
  return Array.isArray(content) && content.length > 0 && (content[0] as { type?: string })?.type === 'tool_result';
}

export function convertMessagesForAnthropic(context: Context): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of context.messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'text', text: stringifyContent(message.content) }] });
      continue;
    }
    if (message.role === 'toolResult') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: stringifyContent(message.content),
      };
      const prev = result[result.length - 1];
      if (prev && prev.role === 'user' && isToolResultGroup(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'toolCall') {
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.arguments });
      }
    }
    result.push({ role: 'assistant', content });
  }
  return result;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/anthropic-stream.test.ts`
Expected: PASS，全部 5 条用例通过。

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 无报错退出。

- [ ] **Step 6: Commit**

```bash
git add lib/agent/anthropic-stream.ts lib/agent/anthropic-stream.test.ts
git commit -m "feat: implement Anthropic Messages protocol stream (browserAnthropicStream)"
```

---

### Task 4: `agent.ts` 按协议选择 Model / StreamFn

**Files:**
- Modify: `lib/agent/agent.ts`
- Test: `lib/agent/agent.test.ts`

**Interfaces:**
- Consumes:
  - `resolveProviderApi` from `@/lib/settings`（Task 2）
  - `browserOpenAIStream` from `./openai-stream`（Task 1）
  - `browserAnthropicStream` from `./anthropic-stream`（Task 3）
- Produces：
  - `export function createModel(provider: ProviderConfig): Model<Api>`（替代原 `createOpenAICompatibleModel`）
  - `export function selectStreamFn(provider: ProviderConfig): StreamFn`

- [ ] **Step 1: 写失败的测试 `lib/agent/agent.test.ts`**

```ts
// lib/agent/agent.test.ts
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@/lib/settings';
import { createModel, selectStreamFn } from './agent';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';

const baseProvider: ProviderConfig = {
  id: 'p-1',
  name: 'Test',
  baseURL: 'https://example.com/v1',
  apiKey: 'key',
  model: 'test-model',
};

describe('selectStreamFn', () => {
  it('returns browserOpenAIStream when api is undefined (default)', () => {
    expect(selectStreamFn(baseProvider)).toBe(browserOpenAIStream);
  });

  it('returns browserOpenAIStream when api is openai-completions', () => {
    expect(selectStreamFn({ ...baseProvider, api: 'openai-completions' })).toBe(browserOpenAIStream);
  });

  it('returns browserAnthropicStream when api is anthropic-messages', () => {
    expect(selectStreamFn({ ...baseProvider, api: 'anthropic-messages' })).toBe(browserAnthropicStream);
  });
});

describe('createModel', () => {
  it('sets api to openai-completions by default', () => {
    expect(createModel(baseProvider).api).toBe('openai-completions');
  });

  it('sets api to anthropic-messages when configured', () => {
    expect(createModel({ ...baseProvider, api: 'anthropic-messages' }).api).toBe('anthropic-messages');
  });

  it('keeps id/provider/baseUrl derived from the ProviderConfig', () => {
    const model = createModel(baseProvider);
    expect(model.id).toBe('test-model');
    expect(model.provider).toBe('p-1');
    expect(model.baseUrl).toBe('https://example.com/v1');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: FAIL — `createModel`/`selectStreamFn` 未从 `./agent` 导出。

- [ ] **Step 3: 修改 `lib/agent/agent.ts`**

顶部 import（`lib/agent/agent.ts:1-7`）替换为：

```ts
import { Agent, type AgentMessage, type AgentOptions, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { resolveProviderApi, type ProviderConfig } from '@/lib/settings';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';
import { beforeToolCallPermissionGate } from './permissions';
import { createConfirmGateState, type ConfirmFn } from './confirm-gate';
import { createBrowserTools, type BrowserAgentTool } from './tools';
```

`createBrowserAgent` 内部（`lib/agent/agent.ts:51-58` 附近）把：

```ts
  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: createOpenAICompatibleModel(options.provider),
      thinkingLevel: 'off',
      tools,
      messages: options.messages ?? [],
    },
    streamFn: browserOpenAIStream,
```

改成：

```ts
  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: createModel(options.provider),
      thinkingLevel: 'off',
      tools,
      messages: options.messages ?? [],
    },
    streamFn: selectStreamFn(options.provider),
```

把 `export function createOpenAICompatibleModel(provider: ProviderConfig): Model<Api> {`（`lib/agent/agent.ts:121`）整段函数替换为：

```ts
export function createModel(provider: ProviderConfig): Model<Api> {
  return {
    id: provider.model,
    name: provider.model,
    api: resolveProviderApi(provider),
    provider: provider.id || provider.name,
    baseUrl: provider.baseURL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

export function selectStreamFn(provider: ProviderConfig): StreamFn {
  return resolveProviderApi(provider) === 'anthropic-messages' ? browserAnthropicStream : browserOpenAIStream;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: PASS，全部 6 条用例通过。

- [ ] **Step 5: 类型检查 + 跑全部测试**

Run: `pnpm compile && pnpm test`
Expected: 两个命令都无报错退出；`pnpm test` 全部套件（含 Task 1-4 新增的测试）通过。

- [ ] **Step 6: Commit**

```bash
git add lib/agent/agent.ts lib/agent/agent.test.ts
git commit -m "feat: wire ProviderConfig.api into agent.ts model/streamFn selection"
```

---

### Task 5: 端到端手动验证 + 更新变更日志

**Files:**
- Modify: `docs/PROGRESS.md`

- [ ] **Step 1: 全量类型检查 + 测试（回归确认）**

Run: `pnpm compile && pnpm test`
Expected: 全部通过。

- [ ] **Step 2: 构建并加载扩展**

Run: `pnpm build`
然后在 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`（若已加载过，点刷新）。

- [ ] **Step 3: 手动验证 Anthropic 兼容协议端到端可用**

需要一个真实的 Anthropic 兼容端点和 Key（或本地起一个符合 Anthropic Messages 协议的 mock server）：

1. 打开扩展设置页，新增 Provider：协议类型选"Anthropic 兼容"，填入该端点的 `baseURL`（到 `/v1` 前缀为止）、`apiKey`、`model`，保存并设为当前 Provider。
2. 打开任意网页的侧边栏，发送一句只读问题（如"总结一下这个页面"），确认能看到流式文本正常逐字出现、最终收到完整回答，Network 面板里请求打到了 `<baseURL>/messages`、请求头包含 `x-api-key` 而不是 `Authorization`。
3. 让它执行一次需要工具调用的问题（如"这个页面用了什么类库"，会触发 `browser_get_scripts` 等只读工具），确认工具调用能正常展示、正常执行、正常把结果喂回模型并给出最终回答（验证 `tool_use`/`tool_result` 往返链路）。
4. 触发一次写操作（如"把标题改成 xxx"），确认确认弹窗正常出现、批准后正常执行、`browser_revert_changes` 能正常撤销——验证协议切换没有破坏权限闸门/撤销这些既有机制（它们与协议无关，但要确认没有被这次改动间接破坏）。
5. 切回一个 OpenAI 兼容的 Provider，重复步骤 2，确认原有协议完全不受影响（回归验证）。

- [ ] **Step 4: 更新 `docs/PROGRESS.md` 变更日志**

在 `docs/PROGRESS.md` 的"变更日志"表格最上面一行（当前日期最新的条目之前）插入一行：

```markdown
| 2026-07-25 | 新增 Anthropic Messages 协议支持：`ProviderConfig.api` 协议字段（缺省 OpenAI 兼容）、设置页协议下拉框、`lib/agent/anthropic-stream.ts` 实现 Anthropic 消息格式转换（含 tool_result 合并）与 SSE 解析；`lib/agent/stream.ts` 拆分出协议无关的 `stream-shared.ts` 供两种协议共用 | [[2026-07-25-anthropic-compatible-provider-design]], 2026-07-25-anthropic-compatible-provider.md |
```

- [ ] **Step 5: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs: log Anthropic-compatible provider support in PROGRESS changelog"
```

---

## 不做的事（继承自 spec，不在本计划任何任务中实现）

- 自定义 HTTP header 配置项。
- `PROVIDER_PRESETS` 里加具体厂商（火山方舟等）预设。
- 基于 URL 特征或试探请求的协议自动探测。
- extended thinking / vision content block 的专门渲染。
- Anthropic 协议下的真实 token 用量统计。
