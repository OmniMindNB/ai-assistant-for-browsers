import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOnce } from './one-shot-completion';

afterEach(() => {
  vi.unstubAllGlobals();
});

const openai = { baseURL: 'https://llm.test/v1', apiKey: 'sk-test', model: 'm1', api: 'openai-completions' as const };
const anthropic = { baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-x', api: 'anthropic-messages' as const };

describe('completeOnce', () => {
  it('sends a non-streaming OpenAI-compatible request with system and user messages and returns the reply text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeOnce(openai, { system: 'sys', user: 'hi', maxTokens: 50 });

    expect(result).toEqual({ ok: true, text: 'hello', truncated: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm1',
      max_tokens: 50,
      stream: false,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('omits the system message when none is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await completeOnce(openai, { user: 'ping', maxTokens: 1 });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('sends an Anthropic Messages request with a top-level system and joins every text block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'b' }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeOnce(anthropic, { system: 'sys', user: 'hi', maxTokens: 50 });

    expect(result).toEqual({ ok: true, text: 'ab', truncated: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'claude-x',
      max_tokens: 50,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('returns an empty text for a 200 response without a recognisable reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    expect(await completeOnce(openai, { user: 'ping', maxTokens: 1 })).toEqual({ ok: true, text: '', truncated: false });
  });

  it('reports truncated: true for an OpenAI-compatible reply with finish_reason "length"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"name": "Exp' }, finish_reason: 'length' }] }),
          { status: 200 },
        ),
      ),
    );
    const result = await completeOnce(openai, { user: 'hi', maxTokens: 50 });
    expect(result).toEqual({ ok: true, text: '{"name": "Exp', truncated: true });
  });

  it('reports truncated: true for an Anthropic reply with stop_reason "max_tokens"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: '{"name": "Exp' }], stop_reason: 'max_tokens' }),
          { status: 200 },
        ),
      ),
    );
    const result = await completeOnce(anthropic, { user: 'hi', maxTokens: 50 });
    expect(result).toEqual({ ok: true, text: '{"name": "Exp', truncated: true });
  });

  it('formats a non-2xx response with the status, URL and model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 })));
    const result = await completeOnce(openai, { user: 'hi', maxTokens: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('401');
      expect(result.error).toContain('https://llm.test/v1/chat/completions');
      expect(result.error).toContain('m1');
    }
  });

  it('treats a 200 response whose body is an error as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"quota exceeded"}}', { status: 200 })));
    const result = await completeOnce(openai, { user: 'hi', maxTokens: 10 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('quota exceeded');
  });

  it('passes the abort signal to fetch and reports an aborted request as a failure', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = completeOnce(openai, { user: 'hi', maxTokens: 10, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal);
  });
});
