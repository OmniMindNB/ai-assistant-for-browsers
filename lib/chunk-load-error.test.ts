import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './chunk-load-error';

describe('isChunkLoadError', () => {
  it('recognizes the message Chrome throws when a chunk file no longer exists', () => {
    expect(
      isChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: chrome-extension://x/chunks/Markdown-CO2Pv_lb.js',
        ),
      ),
    ).toBe(true);
  });

  it('recognizes Firefox/Safari-style module script wording', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module script'))).toBe(
      true,
    );
  });

  it('does not match unrelated errors', () => {
    expect(isChunkLoadError(new Error('network error'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
