// lib/agent/provider-test.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testProviderConnection } from './provider-test';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('testProviderConnection', () => {
  it('reports ok for a successful OpenAI-compatible response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProviderConnection({
      baseURL: 'https://ark.example.com/api/coding/v3',
      apiKey: 'sk-test',
      model: 'kimi-k2',
      api: 'openai-completions',
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ark.example.com/api/coding/v3/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'kimi-k2', max_tokens: 1, stream: false });
  });

  it('reports ok for a successful Anthropic Messages response, using x-api-key and the /v1/messages URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProviderConnection({
      baseURL: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      api: 'anthropic-messages',
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns a formatted error (with URL and model) for a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"invalid_api_key"}', { status: 401 })));

    const result = await testProviderConnection({
      baseURL: 'https://ark.example.com/api/coding/v3',
      apiKey: 'bad-key',
      model: 'kimi-k2',
      api: 'openai-completions',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('401');
      expect(result.error).toContain('invalid_api_key');
      expect(result.error).toContain('https://ark.example.com/api/coding/v3/chat/completions');
    }
  });

  it('returns a network-failure error (with the request URL) when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await testProviderConnection({
      baseURL: 'https://unreachable.example.com',
      apiKey: 'k',
      model: 'm',
      api: 'openai-completions',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Failed to fetch');
      expect(result.error).toContain('https://unreachable.example.com/chat/completions');
    }
  });

  it('defaults to the OpenAI-compatible protocol when api is undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await testProviderConnection({ baseURL: 'https://example.com/v1', apiKey: 'k', model: 'm', api: undefined });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/v1/chat/completions');
  });
});
