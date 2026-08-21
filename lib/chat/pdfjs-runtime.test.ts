import { describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'chrome-extension://abc/assets/pdf.worker.mjs' }));

import { getDocument } from 'pdfjs-dist';
import { buildPdfAssetUrls, extractPdfAttachment } from './pdfjs-runtime';

describe('buildPdfAssetUrls', () => {
  it('resolves every PDF.js support asset inside the extension origin', () => {
    expect(buildPdfAssetUrls('chrome-extension://abc/')).toEqual({
      cMapUrl: 'chrome-extension://abc/pdfjs/cmaps/',
      standardFontDataUrl: 'chrome-extension://abc/pdfjs/standard_fonts/',
      wasmUrl: 'chrome-extension://abc/pdfjs/wasm/',
    });
  });

  it('loads an attachment with extension-local PDF.js assets', async () => {
    vi.stubGlobal('browser', {
      runtime: { getURL: vi.fn(() => 'chrome-extension://abc/') },
    });
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'Extracted text' }] }),
        }),
        destroy: async () => {},
      }),
      destroy: async () => {},
    } as never);

    await expect(extractPdfAttachment(
      new File(['%PDF- test'], 'attachment.pdf', { type: 'application/pdf' }),
      { maxChars: 100 },
    )).resolves.toEqual({
      ok: true,
      value: { text: 'Extracted text', pageCount: 1, extractedChars: 14, truncated: false },
    });

    expect(getDocument).toHaveBeenCalledWith({
      data: expect.any(Uint8Array),
      cMapPacked: true,
      cMapUrl: 'chrome-extension://abc/pdfjs/cmaps/',
      standardFontDataUrl: 'chrome-extension://abc/pdfjs/standard_fonts/',
      wasmUrl: 'chrome-extension://abc/pdfjs/wasm/',
    });
  });
});
