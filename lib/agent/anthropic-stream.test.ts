// lib/agent/anthropic-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessageEventStream, Api, Context, Model } from '@earendil-works/pi-ai';
import { anthropicMessagesUrl, browserAnthropicStream, convertMessagesForAnthropic } from './anthropic-stream';

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

describe('anthropicMessagesUrl', () => {
  // Anthropic 生态的约定与 OpenAI 相反：base_url 不带版本段，由客户端补 /v1/messages。
  // 只补 /messages 会让官方端点和火山方舟 Anthropic 兼容端点都打不中（方舟还会把
  // 路由未命中报成 401 AuthenticationError，看起来像 key 的问题）。
  it('appends /v1/messages when the base URL carries no version segment', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropicMessagesUrl('https://ark.cn-beijing.volces.com/api/coding')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    );
  });

  it('appends only /messages when the base URL already ends with a version segment', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropicMessagesUrl('https://ark.cn-beijing.volces.com/api/coding/v1')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    );
  });

  it('tolerates trailing slashes', () => {
    expect(anthropicMessagesUrl('https://ark.cn-beijing.volces.com/api/coding/')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    );
    expect(anthropicMessagesUrl('https://api.anthropic.com/v1//')).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('convertMessagesForAnthropic', () => {
  it('converts a plain user message to a text content block', () => {
    // Cast: fixture omits fields (timestamp/usage/etc.) not read by the code under test —
    // the real Context/Message types require them, but they're irrelevant here.
    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    expect(convertMessagesForAnthropic(context)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('adds an image content block for an image attachment alongside text', () => {
    const context = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
          ],
        },
      ],
    } as unknown as Context;
    expect(convertMessagesForAnthropic(context)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        ],
      },
    ]);
  });

  it('adds an image content block for each image when a user message has multiple images', () => {
    const context = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'compare these' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
            { type: 'image', data: 'RUZH', mimeType: 'image/jpeg' },
          ],
        },
      ],
    } as unknown as Context;
    expect(convertMessagesForAnthropic(context)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'compare these' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'RUZH' } },
        ],
      },
    ]);
  });

  it('omits the text block when a user message has only an image', () => {
    const context = {
      messages: [{ role: 'user', content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] }],
    } as unknown as Context;
    expect(convertMessagesForAnthropic(context)).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] },
    ]);
  });

  it('merges consecutive toolResult messages into one user message with multiple tool_result blocks', () => {
    // Cast: fixture omits fields not read by convertMessagesForAnthropic (see note above).
    const context = {
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'foo', arguments: {} }] },
        { role: 'toolResult', toolCallId: 't1', toolName: 'foo', content: 'result-1' },
        { role: 'toolResult', toolCallId: 't2', toolName: 'bar', content: 'result-2' },
      ],
    } as unknown as Context;
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
    // Cast: fixture omits fields not read by convertMessagesForAnthropic (see note above).
    const context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'toolCall', id: 't1', name: 'get_weather', arguments: { city: 'NY' } },
          ],
        },
      ],
    } as unknown as Context;
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

  it('drops an assistant message whose content is only an empty text block', () => {
    // Cast: fixture omits fields not read by convertMessagesForAnthropic (see note above).
    const context = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
    } as unknown as Context;
    const converted = convertMessagesForAnthropic(context);
    expect(converted).toHaveLength(1);
    expect(converted).not.toContainEqual(expect.objectContaining({ role: 'assistant' }));
  });

  it('keeps the tool_use block but drops an empty text block alongside it', () => {
    // Cast: fixture omits fields not read by convertMessagesForAnthropic (see note above).
    const context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'toolCall', id: 't1', name: 'foo', arguments: {} },
          ],
        },
      ],
    } as unknown as Context;
    expect(convertMessagesForAnthropic(context)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }],
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

    // Cast: fixture omits fields not read by browserAnthropicStream (see note above).
    const context = {
      systemPrompt: '你是助手',
      messages: [{ role: 'user', content: '今天天气怎么样' }],
    } as unknown as Context;
    // Cast: StreamFn's declared return type is `T | Promise<T>` for generality, but this
    // implementation always returns synchronously (matches browserOpenAIStream's pattern).
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'test-key' }) as AssistantMessageEventStream;
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

  it('falls back to the inline content_block.input when no input_json_delta events arrive', async () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"NY"}}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sse)));

    // Cast: fixture omits fields not read by browserAnthropicStream (see note above).
    const context = { messages: [{ role: 'user', content: '今天天气怎么样' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'test-key' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const toolEnd = events.find((e) => e.type === 'toolcall_end');
    expect(toolEnd).toMatchObject({
      toolCall: { id: 'toolu_1', name: 'get_weather', arguments: { city: 'NY' } },
    });
  });

  it('pushes an error event when the SSE stream sends a mid-stream error event', async () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: error',
      'data: {"type":"error","error":{"message":"overloaded_error: the server is overloaded"}}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sse)));

    // Cast: fixture omits fields (timestamp/usage/etc.) not read by the code under test —
    // the real Context/Message types require them, but they're irrelevant here.
    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'test-key' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('overloaded_error: the server is overloaded');
    }
  });

  it('reports "length" (not "stop") when max_tokens is hit inside a thinking block before any text', async () => {
    // Reproduces a reasoning-model provider (e.g. Anthropic-compatible Kimi K2) whose entire
    // max_tokens budget is consumed by the hidden `thinking` block before any visible text or
    // tool_use — content_block_start "text" opens but no text_delta ever arrives.
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning..."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sse)));

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'test-key' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    expect(events.some((e) => e.type === 'text_delta')).toBe(false);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', reason: 'length' });
    if (done?.type === 'done') {
      expect(done.message.content).toEqual([]);
    }
  });

  it('pushes an error event when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })),
    );

    // Cast: fixture omits fields (timestamp/usage/etc.) not read by the code under test —
    // the real Context/Message types require them, but they're irrelevant here.
    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'bad-key' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('401');
    }
  });

  // 协议下拉框与 Base URL 是两个独立字段，填错任一个都表现为一句没有上下文的 4xx。
  // 报错必须自带真实请求 URL 和模型名，否则「404」既可能是路径拼错、也可能是模型名在该端点
  // 不存在，用户和我们都只能靠猜。
  it('includes the request URL and model id in the error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('https://example.com/v1/messages');
      expect(errorEvent.error.errorMessage).toContain('claude-test');
    }
  });

  // fetch() 从未拿到响应（DNS/连接被拒/CORS）时抛的是 TypeError，跟上面 404 那类"拿到了响应
  // 但状态非 2xx"是不同的失败层级；这里确认它也带着请求地址，而不是一句裸的 "Failed to fetch"。
  it('explains a network-layer failure (fetch() itself rejecting) with the request URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('https://example.com/v1/messages');
      expect(errorEvent.error.errorMessage).toContain('Failed to fetch');
    }
  });
});
