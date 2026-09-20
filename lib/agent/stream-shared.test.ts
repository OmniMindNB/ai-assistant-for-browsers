import { describe, expect, it } from 'vitest';
import { describeHttpFailure, describeStreamError, extractImageParts } from './stream-shared';

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
