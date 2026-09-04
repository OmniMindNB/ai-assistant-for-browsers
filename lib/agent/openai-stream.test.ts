// lib/agent/openai-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessageEventStream, Api, Context, Model } from '@earendil-works/pi-ai';
import { browserOpenAIStream, convertMessages, convertUserContent, openAiCompletionsUrl } from './openai-stream';

function makeModel(): Model<Api> {
  return {
    id: 'kimi-k2-test',
    name: 'kimi-k2-test',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: 'https://ark.example.com/api/coding/v3',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** 把若干 chunk 拼成一条 SSE 响应，末尾补 [DONE]。 */
function sseResponse(chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`), 'data: [DONE]\n'].join('\n');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function contextWithTools(toolNames: string[]): Context {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    tools: toolNames.map((name) => ({ name, description: '', parameters: { type: 'object' } })),
  } as unknown as Context;
}

async function finalMessage(context: Context): Promise<{ type: string; text?: string; name?: string; arguments?: unknown }[]> {
  const stream = browserOpenAIStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
  const events = await collectEvents(stream);
  const done = events.at(-1);
  if (done?.type !== 'done') throw new Error(`expected a done event, got ${done?.type}`);
  return done.message.content as { type: string; text?: string; name?: string; arguments?: unknown }[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openAiCompletionsUrl', () => {
  // 与 Anthropic 相反，OpenAI 生态约定 base_url 自带版本段，客户端只补 /chat/completions。
  it('appends /chat/completions to the configured base URL', () => {
    expect(openAiCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(openAiCompletionsUrl('https://ark.cn-beijing.volces.com/api/coding/v3/')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    );
  });

  // 把控制台/文档里的完整端点整条粘进设置页是最常见的手滑，重复拼接后必然 404。
  it('does not double-append when the base URL already ends with /chat/completions', () => {
    expect(openAiCompletionsUrl('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    );
  });
});

describe('convertUserContent', () => {
  it('returns a plain string unchanged when content is already a string', () => {
    expect(convertUserContent('hi')).toBe('hi');
  });

  it('collapses an array of only text parts to a plain string, matching pre-image-support behavior', () => {
    expect(convertUserContent([{ type: 'text', text: 'hi' }])).toBe('hi');
  });

  it('returns multi-part content with an image_url block when an image is present', () => {
    const result = convertUserContent([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('omits the text block when there is no text alongside an image', () => {
    const result = convertUserContent([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }]);
    expect(result).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
  });
});

describe('browserOpenAIStream', () => {
  // 报错必须自带真实请求 URL 和模型名：同样一个 404，既可能是 Base URL 拼错，也可能是模型名
  // 在该端点不存在（方舟对后者返回 "The model or endpoint xxx does not exist"）。
  it('includes the request URL and model id in the error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    // Cast: fixture omits fields (timestamp/usage/etc.) not read by the code under test.
    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserOpenAIStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('https://ark.example.com/api/coding/v3/chat/completions');
      expect(errorEvent.error.errorMessage).toContain('kimi-k2-test');
    }
  });

  // 空 body 的 4xx（网关直接拒绝、没有 JSON 错误体）此前会退化成 "LLM 请求失败 (404 )"。
  it('still explains itself when the error response body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserOpenAIStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).not.toMatch(/\(404\s*\)\s*$/);
    }
  });

  // fetch() 从未拿到响应（DNS/连接被拒/CORS）时抛的是 TypeError，跟上面 404 那类"拿到了响应
  // 但状态非 2xx"是不同的失败层级；这里确认它也带着请求地址，而不是一句裸的 "Failed to fetch"。
  it('explains a network-layer failure (fetch() itself rejecting) with the request URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;
    const stream = browserOpenAIStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
    const events = await collectEvents(stream);

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.errorMessage).toContain('https://ark.example.com/api/coding/v3/chat/completions');
      expect(errorEvent.error.errorMessage).toContain('Failed to fetch');
    }
  });

  // 弱模型兼容（ref: lib/agent/tool-call-repair.ts）。修复前这两种畸形分别退化成
  // 「工具收到空参数」和「工具压根不执行、用户看到一坨裸 JSON」。
  it('repairs double-stringified tool arguments instead of dropping them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'browser_click', arguments: JSON.stringify('{"selector":"#ok"}') } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );

    const content = await finalMessage(contextWithTools(['browser_click']));
    expect(content).toEqual([{ type: 'toolCall', id: 'call_1', name: 'browser_click', arguments: { selector: '#ok' } }]);
  });

  it('salvages a tool call the model wrote into the message text, keeping the prose', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          { choices: [{ delta: { content: '我先读一下页面。\n' } }] },
          { choices: [{ delta: { content: '{"name":"browser_read_page","arguments":{}}' } }, ] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );

    const content = await finalMessage(contextWithTools(['browser_read_page']));
    expect(content).toEqual([
      { type: 'text', text: '我先读一下页面。' },
      { type: 'toolCall', id: expect.any(String), name: 'browser_read_page', arguments: {} },
    ]);
  });

  it('leaves the text alone when it contains no recognizable tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          { choices: [{ delta: { content: '这页讲的是气候变化。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );

    const content = await finalMessage(contextWithTools(['browser_read_page']));
    expect(content).toEqual([{ type: 'text', text: '这页讲的是气候变化。' }]);
  });
});

describe('convertMessages 的图片工具结果', () => {
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

  // OpenAI chat completions 不允许 role:'tool' 消息带图片，只能拆成两条。
  it('把一条带图的 toolResult 展开成 tool + user 两条消息', () => {
    const messages = convertMessages({ messages: [toolResult] } as never);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    expect(String(messages[0].content)).toContain('已截取截图');
    expect(messages[1]).toMatchObject({ role: 'user' });
    const parts = messages[1].content as Array<Record<string, unknown>>;
    expect(parts.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('tool 消息本身不含图片字段', () => {
    const messages = convertMessages({ messages: [toolResult] } as never);
    expect(JSON.stringify(messages[0])).not.toContain('image_url');
  });

  it('没有图片的 toolResult 仍然只产生一条消息', () => {
    const textOnly = { ...toolResult, content: [{ type: 'text' as const, text: '正文' }] };
    expect(convertMessages({ messages: [textOnly] } as never)).toHaveLength(1);
  });

  it('合成 user 消息以 untrusted-content 免执行声明开头', () => {
    const messages = convertMessages({ messages: [toolResult] } as never);
    const parts = messages[1].content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('untrusted page content');
    expect(parts.slice(1).every((part) => part.type === 'image_url')).toBe(true);
  });
});

describe('convertMessages 并行工具调用不破坏 tool 消息连续性', () => {
  const assistantMessage = {
    role: 'assistant' as const,
    content: [
      { type: 'toolCall' as const, id: 'call-1', name: 'browser_screenshot', arguments: {} },
      { type: 'toolCall' as const, id: 'call-2', name: 'browser_read_page', arguments: {} },
    ],
    timestamp: 0,
  };

  const screenshotResult = {
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

  const readPageResult = {
    role: 'toolResult' as const,
    toolCallId: 'call-2',
    toolName: 'browser_read_page',
    content: [{ type: 'text' as const, text: '页面正文' }],
    isError: false,
    timestamp: 0,
  };

  // 修复前：第一条 toolResult（截图）一处理完就立刻插入图片 user 消息，把它挤进两条
  // tool 消息中间，破坏了 OpenAI 要求的"同批 tool_calls 的 tool 消息必须连续"的约束，
  // 触发 400。
  it('两条 tool 消息连续出现，图片 user 消息推迟到这批 toolResult 结束后才出现', () => {
    const messages = convertMessages({ messages: [assistantMessage, screenshotResult, readPageResult] } as never);

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-2' });
    const parts = messages[3].content as Array<Record<string, unknown>>;
    expect(parts.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('两条 toolResult 都带图片时，合并成一条 user 消息里的多个 image_url，而不是两条消息', () => {
    const secondScreenshotResult = {
      ...readPageResult,
      toolName: 'browser_screenshot',
      content: [
        { type: 'text' as const, text: '已截取截图 2（1280×800）。' },
        { type: 'image' as const, data: 'BBBB', mimeType: 'image/jpeg' },
      ],
    };
    const messages = convertMessages({ messages: [assistantMessage, screenshotResult, secondScreenshotResult] } as never);

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    const parts = messages[3].content as Array<Record<string, unknown>>;
    const imageParts = parts.filter((part) => part.type === 'image_url');
    expect(imageParts).toHaveLength(2);
    expect(imageParts[0]).toMatchObject({ image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(imageParts[1]).toMatchObject({ image_url: { url: 'data:image/jpeg;base64,BBBB' } });
  });
});
