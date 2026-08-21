import { describe, expect, it } from 'vitest';
import { extractImageParts } from './stream-shared';

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
