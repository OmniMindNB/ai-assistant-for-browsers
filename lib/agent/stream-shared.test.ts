import { describe, expect, it } from 'vitest';
import { describeStreamError, extractImageParts } from './stream-shared';

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
