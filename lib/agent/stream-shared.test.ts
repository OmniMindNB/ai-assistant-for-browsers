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

  // 评审 F5：撞供应商 400 时，若 detail 命中 context/length/token 关键字，多半是上下文超长
  // 被拒绝，而不是参数格式错误——此前完全没有诊断，原样透传服务端文本。
  it('adds a context-overflow hint for 400 when detail mentions context/length/token', () => {
    const message = describeHttpFailure(
      400,
      'Bad Request',
      "This model's maximum context length is 128000 tokens.",
      'https://example.com/v1',
      'kimi-k2',
    );
    expect(message).toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  it('is case-insensitive when matching the context-overflow keywords', () => {
    const message = describeHttpFailure(400, 'Bad Request', 'CONTEXT_LENGTH_EXCEEDED', 'https://example.com/v1', 'm');
    expect(message).toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });

  it('adds no hint for a 400 unrelated to context length', () => {
    const message = describeHttpFailure(400, 'Bad Request', 'invalid api key', 'https://example.com/v1', 'm');
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
    expect(message).not.toContain('404 通常意味着');
  });

  it('adds no hint for other status codes', () => {
    const message = describeHttpFailure(500, 'Internal Server Error', 'context length exceeded', 'https://example.com/v1', 'm');
    expect(message).not.toContain('大概率是这次请求的上下文超出了该模型的窗口');
  });
});
