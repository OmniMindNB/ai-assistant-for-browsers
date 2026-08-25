// lib/agent/openai-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessageEventStream, Api, Context, Model } from '@earendil-works/pi-ai';
import { browserOpenAIStream, convertUserContent, openAiCompletionsUrl } from './openai-stream';

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
