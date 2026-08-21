import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionOutput = resolve(dirname(fileURLToPath(import.meta.url)), '../../.output/chrome-mv3');

describe('PDF.js build assets', () => {
  it('places support files at the runtime asset URLs', () => {
    expect(existsSync(resolve(extensionOutput, 'pdfjs/cmaps/78-EUC-H.bcmap'))).toBe(true);
    expect(existsSync(resolve(extensionOutput, 'pdfjs/standard_fonts/FoxitDingbats.pfb'))).toBe(true);
    expect(existsSync(resolve(extensionOutput, 'pdfjs/wasm/jbig2.wasm'))).toBe(true);
  });
});
