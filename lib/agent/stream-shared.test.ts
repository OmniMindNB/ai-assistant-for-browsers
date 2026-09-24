import { describe, expect, it, vi } from 'vitest';
import { abortableSleep, describeHttpFailure, describeStreamError, extractImageParts, fetchLlmWithRetry, LLM_RETRY_DELAYS_MS, MAX_RETRY_AFTER_MS } from './stream-shared';

describe('extractImageParts', () => {
  it('returns an empty array for a plain string', () => {
    expect(extractImageParts('hello')).toEqual([]);
  });

  it('returns an empty array for an array with only text parts', () => {
    expect(extractImageParts([{ type: 'text', text: 'hi' }])).toEqual([]);
  });

  it('extracts image parts, preserving order, and ignores non-image parts mixed in', () => {
    const image = { type: 'image', data: 'QUJD', mimeType: 'image/png' };
    expect(extractImageParts([{ type: 'text', text: 'hi' }, image])).toEqual([image]);
  });

  it('returns an empty array for null/undefined', () => {
    expect(extractImageParts(null)).toEqual([]);
    expect(extractImageParts(undefined)).toEqual([]);
  });
});

describe('describeStreamError', () => {
  it('wraps a network-layer TypeError with the request URL and model id', () => {
    const error = new TypeError('Failed to fetch');
    const result = describeStreamError(error, 'https://ark.example.com/v1/chat/completions', 'kimi-k2');
    expect(result).toContain('Failed to fetch');
    expect(result).toContain('https://ark.example.com/v1/chat/completions');
    expect(result).toContain('kimi-k2');
  });

  it('passes a non-network Error through unchanged (already-formatted describeHttpFailure output, or a JSON parse error)', () => {
    const httpFailure = new Error('LLM 请求失败 (404 Not Found)：model not found');
    expect(describeStreamError(httpFailure, 'https://example.com', 'm')).toBe(httpFailure.message);

    const parseError = new SyntaxError('Unexpected token in JSON');
    expect(describeStreamError(parseError, 'https://example.com', 'm')).toBe(parseError.message);
  });

  it('stringifies a non-Error thrown value', () => {
    expect(describeStreamError('boom', 'https://example.com', 'm')).toBe('boom');
  });
});

describe('describeHttpFailure', () => {
  it('adds the path/model-name hint for 404', () => {
    const message = describeHttpFailure(404, 'Not Found', 'model not found', 'https://example.com/v1', 'kimi-k2');
    expect(message).toContain('404 通常意味着请求路径或模型名不存在');
  });

  // 评审 F5：撞供应商 400 时，若 detail 同时带"上下文语义词"和"超限语义词"，多半是
  // 上下文超长被拒绝，而不是参数格式错误——此前完全没有诊断，原样透传服务端文本。
  it('adds a context-overflow hint for 400 when detail names context and a limit together', () => {
    const message = describeHttpFailure(
      400,
      'Bad Request',
      "This model's maximum context length is 128000 tokens.",
      'https://example.com/v1',
      'kimi-k2',
    );
    expect(message).toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  // OpenAI 系标准错误码，下划线分隔、全大写，本身已是明确信号，单独识别。
  it('is case-insensitive when matching the CONTEXT_LENGTH_EXCEEDED error code', () => {
    const message = describeHttpFailure(400, 'Bad Request', 'CONTEXT_LENGTH_EXCEEDED', 'https://example.com/v1', 'm');
    expect(message).toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  it('adds no hint for a 400 unrelated to context length', () => {
    const message = describeHttpFailure(400, 'Bad Request', 'invalid api key', 'https://example.com/v1', 'm');
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
    expect(message).not.toContain('404 通常意味着');
  });

  // 复审 F5 追加：上一版正则是任一命中 context|length|token 就触发，`token` 在鉴权错误里
  // 是常用词，`length` 也会出现在与上下文无关的参数校验错误里——命中就给"换模型/减少引用"
  // 的建议，会把该去查 API Key 或请求参数的用户引向错误方向。这三条是收紧后必须不再误报的
  // 反例。
  it('does not fire on an auth error mentioning "token" in isolation', () => {
    const message = describeHttpFailure(400, 'Bad Request', 'invalid token', 'https://example.com/v1', 'm');
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  it('does not fire on an expired-credential error mentioning "token" in isolation', () => {
    const message = describeHttpFailure(400, 'Bad Request', 'access token expired', 'https://example.com/v1', 'm');
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  it('does not fire on a param-validation error mentioning "length" in isolation', () => {
    const message = describeHttpFailure(
      400,
      'Bad Request',
      'string length must be <= 100',
      'https://example.com/v1',
      'm',
    );
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  it('adds no hint for other status codes', () => {
    const message = describeHttpFailure(500, 'Internal Server Error', 'context length exceeded', 'https://example.com/v1', 'm');
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });
});

describe('fetchLlmWithRetry', () => {
  const url = 'https://llm.example/v1/chat/completions';

  function harness(responses: Array<Response | Error>) {
    const calls: number[] = [];
    const sleeps: number[] = [];
    const deps = {
      fetch: vi.fn(async () => {
        calls.push(calls.length);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response('ok', { status: 200 });
      }),
      sleep: vi.fn(async (ms: number) => {
        sleeps.push(ms);
      }),
    };
    return { deps, calls, sleeps };
  }

  it('429 之后按退避间隔重试，拿到 2xx 就返回', async () => {
    const { deps, sleeps } = harness([new Response('', { status: 429 }), new Response('ok', { status: 200 })]);
    const response = await fetchLlmWithRetry(url, {}, deps);
    expect(response.status).toBe(200);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([LLM_RETRY_DELAYS_MS[0]]);
  });

  it('5xx 连续失败时重试次数封顶，把最后一次响应原样交回', async () => {
    const { deps, sleeps } = harness([
      new Response('', { status: 503 }),
      new Response('', { status: 502 }),
      new Response('overloaded', { status: 529 }),
    ]);
    const response = await fetchLlmWithRetry(url, {}, deps);
    expect(response.status).toBe(529);
    expect(deps.fetch).toHaveBeenCalledTimes(LLM_RETRY_DELAYS_MS.length + 1);
    expect(sleeps).toEqual([...LLM_RETRY_DELAYS_MS]);
  });

  it('4xx 配置错误（401/404/400）不重试', async () => {
    for (const status of [400, 401, 404]) {
      const { deps } = harness([new Response('', { status })]);
      const response = await fetchLlmWithRetry(url, {}, deps);
      expect(response.status).toBe(status);
      expect(deps.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('遵守 Retry-After 秒数', async () => {
    const { deps, sleeps } = harness([
      new Response('', { status: 429, headers: { 'Retry-After': '5' } }),
      new Response('ok', { status: 200 }),
    ]);
    await fetchLlmWithRetry(url, {}, deps);
    expect(sleeps).toEqual([5000]);
  });

  it('Retry-After 超过上限时不干等，直接交回 429', async () => {
    const { deps, sleeps } = harness([
      new Response('', { status: 429, headers: { 'Retry-After': String(MAX_RETRY_AFTER_MS / 1000 + 1) } }),
    ]);
    const response = await fetchLlmWithRetry(url, {}, deps);
    expect(response.status).toBe(429);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('网络层失败（TypeError）也重试，全部失败则抛出最后一个错误', async () => {
    const { deps } = harness([new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), new TypeError('boom')]);
    await expect(fetchLlmWithRetry(url, {}, deps)).rejects.toThrow('boom');
    expect(deps.fetch).toHaveBeenCalledTimes(LLM_RETRY_DELAYS_MS.length + 1);
  });

  it('用户停止（AbortError）不重试', async () => {
    const { deps } = harness([new DOMException('aborted', 'AbortError')]);
    await expect(fetchLlmWithRetry(url, {}, deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('退避等待期间用户停止，立即以 AbortError 结束且不再发请求', async () => {
    const controller = new AbortController();
    const deps = {
      fetch: vi.fn(async () => new Response('', { status: 503 })),
      sleep: vi.fn(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    };
    await expect(fetchLlmWithRetry(url, { signal: controller.signal }, deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('abortableSleep', () => {
  it('signal 触发时提前以 AbortError 结束', async () => {
    const controller = new AbortController();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
