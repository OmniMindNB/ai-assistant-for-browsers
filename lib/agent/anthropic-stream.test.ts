// lib/agent/anthropic-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessageEventStream, Api, Context, Model } from '@earendil-works/pi-ai';
import { PERF_TRACE_FLAG, currentPerfUsage, resetPerfTrace } from './perf-trace';
import { anthropicMessagesUrl, browserAnthropicStream, buildAnthropicSystem, convertMessagesForAnthropic } from './anthropic-stream';
import { LLM_RETRY_DELAYS_MS } from './stream-shared';

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
  vi.useRealTimers();
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
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'result-1' }] },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'result-2' }] },
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
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const pending = collectEvents(stream);
    await vi.runAllTimersAsync();
    const events = await pending;

    // 网络层失败先按退避重试，重试用尽才报错。
    expect(fetchMock).toHaveBeenCalledTimes(LLM_RETRY_DELAYS_MS.length + 1);
    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('https://example.com/v1/messages');
      expect(errorEvent.error.errorMessage).toContain('Failed to fetch');
    }
  });

  // Anthropic 高峰期会返回 529 overloaded，几秒后通常就恢复；不该因此让整次多步任务失败。
  it('recovers from a transient 529 overloaded response by retrying', async () => {
    vi.useFakeTimers();
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好了"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 }))
      .mockResolvedValueOnce(sseResponse(sse));
    vi.stubGlobal('fetch', fetchMock);

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const pending = collectEvents(stream);
    await vi.runAllTimersAsync();
    const events = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe('done');
  });

  // 与 openai-stream.test.ts 里同名用例同因：用户停止导致的 AbortError 不是模型故障，
  // 收尾消息必须标 'aborted'，否则上层只会看到 stopReason:'error' 并给出配置排查提示。
  it('finishes with stopReason "aborted" (not "error") when the request is aborted by the user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('signal is aborted without reason', 'AbortError')));
    const controller = new AbortController();
    controller.abort();

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k', signal: controller.signal }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.reason).toBe('aborted');
      expect(errorEvent.error.stopReason).toBe('aborted');
    }
  });
});

describe('convertMessagesForAnthropic 的图片工具结果', () => {
  const toolResult = {
    role: 'toolResult' as const,
    toolCallId: 'call-1',
    toolName: 'browser_screenshot',
    content: [
      { type: 'text' as const, text: '已截取截图（1280×800）。' },
      { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' },
    ],
    isError: false,
    timestamp: 0,
  };

  it('把图片作为 image 块放进 tool_result', () => {
    const [message] = convertMessagesForAnthropic({ messages: [toolResult] } as never);
    const block = (message.content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe('tool_result');
    const inner = block.content as Array<Record<string, unknown>>;
    expect(inner[0]).toEqual({ type: 'text', text: '已截取截图（1280×800）。' });
    expect(inner[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
  });

  it('没有图片时 tool_result 仍是纯文本内容', () => {
    const textOnly = { ...toolResult, content: [{ type: 'text' as const, text: '正文' }] };
    const [message] = convertMessagesForAnthropic({ messages: [textOnly] } as never);
    const block = (message.content as Array<Record<string, unknown>>)[0];
    const inner = block.content as Array<Record<string, unknown>>;
    expect(inner).toEqual([{ type: 'text', text: '正文' }]);
  });

  // 既无文本又无图片时，改动前 stringifyContent 兜底吐出 ''，现在若不特殊处理会变成
  // `content: []`——两种形状都可能不被 Anthropic 接受，用占位文本兜底。
  it('既没有文本也没有图片时，tool_result 的 content 不是空数组，而是一个占位文本块', () => {
    const empty = { ...toolResult, content: [] as unknown as typeof toolResult.content };
    const [message] = convertMessagesForAnthropic({ messages: [empty] } as never);
    const block = (message.content as Array<Record<string, unknown>>)[0];
    expect(block.content).toEqual([{ type: 'text', text: '(empty)' }]);
  });
});

// Anthropic 的前缀缓存要显式打断点（cache_control），不打就是每轮全价重发整段 prompt。
// 此前这条路径一个断点都没有：DeepSeek 那条 OpenAI 兼容路径靠服务端自动前缀缓存兜着
// （实测命中率 71%），Anthropic 这条则完全没有缓存收益。
// ref: claude-api skill / shared/prompt-caching.md。
describe('前缀缓存断点', () => {
  const MINIMAL_SSE = ['event: message_stop', 'data: {"type":"message_stop"}', ''].join('\n');

  async function captureRequestBody(context: Partial<Context>): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(MINIMAL_SSE));
    vi.stubGlobal('fetch', fetchMock);
    const stream = browserAnthropicStream(makeModel(), context as Context, {
      apiKey: 'test-key',
    }) as AssistantMessageEventStream;
    await collectEvents(stream);
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
  }

  /** 递归数整个请求体里有多少个 cache_control——上限是硬性的 4 个。 */
  function countBreakpoints(value: unknown): number {
    if (Array.isArray(value)) return value.reduce((total: number, item) => total + countBreakpoints(item), 0);
    if (!value || typeof value !== 'object') return 0;
    const record = value as Record<string, unknown>;
    let total = record.cache_control ? 1 : 0;
    for (const [key, nested] of Object.entries(record)) {
      if (key !== 'cache_control') total += countBreakpoints(nested);
    }
    return total;
  }

  const systemPrompt = ['<identity>\n稳定正文\n</identity>', '<runtime_context>\nURL：https://a.example\n</runtime_context>'].join(
    '\n\n',
  );

  it('system 拆成稳定段与运行时尾巴，断点只打在稳定段', async () => {
    const body = await captureRequestBody({
      systemPrompt,
      messages: [{ role: 'user', content: '问题' }],
    } as unknown as Partial<Context>);

    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(blocks[0].text).toContain('稳定正文');
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toContain('runtime_context');
  });

  // 会让这个用例失败的 production 改动：无条件发两个 block。Anthropic 拒绝空字符串 text 块，
  // 没有运行时分区时第二块就是空串，整个请求 400。
  it('没有运行时尾巴时只发一个 block', async () => {
    const body = await captureRequestBody({
      systemPrompt: '<identity>\n只有稳定正文\n</identity>',
      messages: [{ role: 'user', content: '问题' }],
    } as unknown as Partial<Context>);

    const blocks = body.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  // 多轮对话的标准打法：断点打在最新一轮的最后一个内容块上，下一轮整段历史就成了可读前缀，
  // 命中随对话增长而累积（ref: shared/prompt-caching.md 的 multi-turn 模式）。
  it('断点打在最后一条消息的最后一个内容块上', async () => {
    const body = await captureRequestBody({
      systemPrompt,
      messages: [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
        { role: 'user', content: '第二轮' },
      ],
    } as unknown as Partial<Context>);

    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const last = messages[messages.length - 1];
    expect(last.content[last.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // 更早的轮次不重复打点：断点名额只有 4 个，而且更早的位置下一轮就会被新断点覆盖。
    expect(messages[0].content[0].cache_control).toBeUndefined();
  });

  it('断点总数不超过 4 个', async () => {
    const body = await captureRequestBody({
      systemPrompt,
      messages: [
        { role: 'user', content: '一' },
        { role: 'assistant', content: [{ type: 'text', text: '二' }] },
        { role: 'user', content: '三' },
        { role: 'assistant', content: [{ type: 'text', text: '四' }] },
        { role: 'user', content: '五' },
      ],
    } as unknown as Partial<Context>);

    expect(countBreakpoints(body)).toBeLessThanOrEqual(4);
  });

  it('消息为空时不炸', async () => {
    const body = await captureRequestBody({ systemPrompt, messages: [] } as unknown as Partial<Context>);

    expect(body.messages).toEqual([]);
  });
});

describe('前缀缓存断点：system 缺失时的退化', () => {
  // Context.systemPrompt 是可选的。会让这个用例失败的 production 改动：无条件把它交给
  // splitSystemPromptForCache——undefined.indexOf 直接抛错，整条流在发请求前就炸了。
  it('没有系统提示词时整个省掉 system 字段', () => {
    expect(buildAnthropicSystem(undefined)).toBeUndefined();
    expect(buildAnthropicSystem('')).toBeUndefined();
  });
});

// 缓存最贵的失败方式是无声的：请求照样成功，只是每轮全价重发，账单更高但没有任何报错。
// usage 是唯一的证据，所以这条链路必须真的接上，而不是只有一个没人调用的换算函数。
describe('前缀缓存的可观测性', () => {
  it('把 message_start / message_delta 里的 usage 记进耗时画像', async () => {
    (globalThis as Record<string, unknown>)[PERF_TRACE_FLAG] = true;
    resetPerfTrace();
    try {
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":240,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8600}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":88}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(sse)));

      const context = { systemPrompt: '提示词', messages: [{ role: 'user', content: '问题' }] } as unknown as Context;
      await collectEvents(browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream);

      expect(currentPerfUsage()).toEqual([
        { turn: 1, promptTokens: 10040, completionTokens: 88, cacheHitTokens: 8600, cacheMissTokens: 1440 },
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>)[PERF_TRACE_FLAG];
      resetPerfTrace();
    }
  });
});

describe('thinking blocks', () => {
  function sse(events: Array<Record<string, unknown>>): string {
    return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n`).join('\n');
  }

  async function eventsFor(body: string): Promise<AssistantMessageEvent[]> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(body)));
    const context = { systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserAnthropicStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    return collectEvents(stream);
  }

  function kinds(events: AssistantMessageEvent[]): string[] {
    return events
      .map((event) => event.type)
      .filter((type) => type.startsWith('thinking') || type.startsWith('text') || type === 'done');
  }

  it('turns thinking_delta into thinking events and ignores signatures and redacted blocks', async () => {
    const events = await eventsFor(sse([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'OPAQUE' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]));
    expect(kinds(events)).toEqual([
      'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end',
      'text_start', 'text_delta', 'text_end', 'done',
    ]);
    expect(events.find((event) => event.type === 'thinking_end')).toMatchObject({ content: 'Let me think' });
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.message.content).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(JSON.stringify(events)).not.toContain('SIG');
    expect(JSON.stringify(events)).not.toContain('OPAQUE');
  });

  it('closes an unterminated thinking block at message_stop', async () => {
    const events = await eventsFor(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'cut' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ]));
    expect(kinds(events)).toEqual(['thinking_start', 'thinking_delta', 'thinking_end', 'done']);
  });

  it('never sends thinking parts back in the request body', () => {
    const context = {
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '不该回传', thinkingSignature: 'S' }, { type: 'text', text: '答' }] },
      ],
    } as unknown as Context;
    expect(JSON.stringify(convertMessagesForAnthropic(context))).not.toContain('不该回传');
  });
});
