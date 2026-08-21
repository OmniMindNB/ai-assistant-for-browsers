import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_PDF_TEXT_CHARS,
  extractPdfText,
  type PdfDocumentLoader,
} from './pdf-extractor';

function pdfFile(body = 'body', name = 'report.pdf'): File {
  return new File([`%PDF-${body}`], name, { type: 'application/pdf' });
}

function loader(pages: Array<Array<{ str: string; hasEOL?: boolean }>>): PdfDocumentLoader {
  return {
    load: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (pageNumber: number) => ({
          getTextContent: async () => ({ items: pages[pageNumber - 1] }),
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    })),
  };
}

describe('extractPdfText', () => {
  it('rejects a spoofed .pdf before loading PDF.js', async () => {
    const load = loader([]);
    const result = await extractPdfText(
      new File(['not pdf'], 'fake.pdf', { type: 'application/pdf' }),
      { maxChars: MAX_ATTACHMENT_PDF_TEXT_CHARS },
      load,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-pdf' });
    expect(load.load).not.toHaveBeenCalled();
  });

  it('preserves page order and reports page progress', async () => {
    const onProgress = vi.fn();
    const result = await extractPdfText(
      pdfFile(),
      { maxChars: MAX_ATTACHMENT_PDF_TEXT_CHARS, onProgress },
      loader([[{ str: 'Page one' }], [{ str: 'Page two' }]]),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        text: 'Page one\n\n[Page 2]\n\nPage two',
        pageCount: 2,
        extractedChars: 28,
        truncated: false,
      },
    });
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('stops at the exact character cap', async () => {
    const result = await extractPdfText(
      pdfFile(),
      { maxChars: 10 },
      loader([[{ str: '123456789012345' }], [{ str: 'never read' }]]),
    );
    expect(result).toMatchObject({ ok: true, value: { text: '1234567890', extractedChars: 10, truncated: true } });
  });

  it('maps empty text and password failures', async () => {
    expect(await extractPdfText(pdfFile(), { maxChars: 100 }, loader([[{ str: '   ' }]])))
      .toEqual({ ok: false, reason: 'no-extractable-text' });

    const passwordLoader: PdfDocumentLoader = {
      load: () => ({
        promise: Promise.reject(Object.assign(new Error('password'), { name: 'PasswordException' })),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
    };
    expect(await extractPdfText(pdfFile(), { maxChars: 100 }, passwordLoader))
      .toEqual({ ok: false, reason: 'password-protected' });
  });

  it('returns cancelled and destroys the loading task after abort', async () => {
    const controller = new AbortController();
    const destroy = vi.fn().mockResolvedValue(undefined);
    const pendingLoader: PdfDocumentLoader = {
      load: () => {
        queueMicrotask(() => controller.abort());
        return { promise: new Promise(() => undefined), destroy };
      },
    };
    const extraction = extractPdfText(pdfFile(), { maxChars: 100, signal: controller.signal }, pendingLoader);
    await expect(extraction).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('returns cancelled before invoking the loader when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const load = loader([]);
    await expect(extractPdfText(pdfFile(), { maxChars: 100, signal: controller.signal }, load))
      .resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(load.load).not.toHaveBeenCalled();
  });

  it('cancels while reading a page and destroys the document', async () => {
    const controller = new AbortController();
    const documentDestroy = vi.fn().mockResolvedValue(undefined);
    const getPage = vi.fn(() => new Promise<never>(() => undefined));
    const pageLoader: PdfDocumentLoader = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage,
          destroy: documentDestroy,
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const extraction = extractPdfText(pdfFile(), { maxChars: 100, signal: controller.signal }, pageLoader);
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce());
    controller.abort();
    await expect(extraction).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(documentDestroy).toHaveBeenCalledOnce();
  });

  it.each(['InvalidPDFException', 'MissingPDFException', 'UnexpectedResponseException'])
    ('maps %s to invalid-pdf', async (name) => {
      const parseLoader: PdfDocumentLoader = {
        load: () => ({
          promise: Promise.reject(Object.assign(new Error(name), { name })),
          destroy: vi.fn().mockResolvedValue(undefined),
        }),
      };
      await expect(extractPdfText(pdfFile(), { maxChars: 100 }, parseLoader))
        .resolves.toEqual({ ok: false, reason: 'invalid-pdf' });
    });

  it('maps generic parser failures to parse-failed', async () => {
    const parseLoader: PdfDocumentLoader = {
      load: () => ({
        promise: Promise.reject(new Error('broken parser')),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
    };
    await expect(extractPdfText(pdfFile(), { maxChars: 100 }, parseLoader))
      .resolves.toEqual({ ok: false, reason: 'parse-failed' });
  });
});

it('defines the 20 MB product limit', () => {
  expect(MAX_ATTACHMENT_PDF_BYTES).toBe(20 * 1024 * 1024);
});

it('rejects a PDF over 20 MB before invoking the loader', async () => {
  const load = loader([]);
  const result = await extractPdfText(
    new File([new Uint8Array(MAX_ATTACHMENT_PDF_BYTES + 1)], 'large.pdf', { type: 'application/pdf' }),
    { maxChars: MAX_ATTACHMENT_PDF_TEXT_CHARS },
    load,
  );
  expect(result).toEqual({ ok: false, reason: 'too-large' });
  expect(load.load).not.toHaveBeenCalled();
});
