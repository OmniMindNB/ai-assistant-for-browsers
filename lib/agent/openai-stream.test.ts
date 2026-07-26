// lib/agent/openai-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessageEventStream, Api, Context, Model } from '@earendil-works/pi-ai';
import { browserOpenAIStream, openAiCompletionsUrl } from './openai-stream';

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
});
