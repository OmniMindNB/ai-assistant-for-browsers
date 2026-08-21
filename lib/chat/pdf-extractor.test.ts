import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_PDF_TEXT_CHARS,
  extractPdfText,
  type PdfDocumentLoader,
  type PdfLoadingTaskLike,
} from './pdf-extractor';

function pdfFile(body = 'body', name = 'report.pdf'): File {
  return new File([`%PDF-${body}`], name, { type: 'application/pdf' });
}

function loader(pages: Array<Array<{ str: string; hasEOL?: boolean }>>) {
  const destroy = vi.fn().mockResolvedValue(undefined);
  return {
    destroy,
    load: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (pageNumber: number) => ({
          getTextContent: async () => ({ items: pages[pageNumber - 1] }),
        }),
      }),
      destroy,
    })),
  };
}

function tinyPdfBytes(text = 'Hello PDF'): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
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

  it('extracts with a real PDF.js document proxy and destroys its loading task', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    let taskDestroyed = false;
    const realLoader: PdfDocumentLoader = {
      load: (data) => {
        const task = getDocument({
          data,
          standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).toString(),
        });
        const destroy = task.destroy.bind(task);
        return {
          promise: task.promise,
          destroy: async () => {
            taskDestroyed = true;
            await destroy();
          },
        } as unknown as PdfLoadingTaskLike;
      },
    };

    await expect(extractPdfText(
      new File([tinyPdfBytes().buffer as ArrayBuffer], 'tiny.pdf', { type: 'application/pdf' }),
      { maxChars: 100 },
      realLoader,
    )).resolves.toMatchObject({ ok: true, value: { text: 'Hello PDF', pageCount: 1 } });
    expect(taskDestroyed).toBe(true);
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
    const emptyLoader = loader([[{ str: '   ' }]]);
    expect(await extractPdfText(pdfFile(), { maxChars: 100 }, emptyLoader))
      .toEqual({ ok: false, reason: 'no-extractable-text' });
    expect(emptyLoader.destroy).toHaveBeenCalledOnce();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const passwordLoader: PdfDocumentLoader = {
      load: () => ({
        promise: Promise.reject(Object.assign(new Error('password'), { name: 'PasswordException' })),
        destroy,
      }),
    };
    expect(await extractPdfText(pdfFile(), { maxChars: 100 }, passwordLoader))
      .toEqual({ ok: false, reason: 'password-protected' });
    expect(destroy).toHaveBeenCalledOnce();
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

  it('cancels while reading a page and destroys the loading task', async () => {
    const controller = new AbortController();
    const taskDestroy = vi.fn().mockResolvedValue(undefined);
    const getPage = vi.fn(() => new Promise<never>(() => undefined));
    const pageLoader: PdfDocumentLoader = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage,
        }),
        destroy: taskDestroy,
      }),
    };
    const extraction = extractPdfText(pdfFile(), { maxChars: 100, signal: controller.signal }, pageLoader);
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce());
    controller.abort();
    await expect(extraction).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(taskDestroy).toHaveBeenCalledOnce();
  });

  it('removes every abort listener after successful extraction across many pages', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pages = Array.from({ length: 25 }, (_, index) => [{ str: `Page ${index + 1}` }]);

    await expect(extractPdfText(
      pdfFile(),
      { maxChars: MAX_ATTACHMENT_PDF_TEXT_CHARS, signal: controller.signal },
      loader(pages),
    )).resolves.toMatchObject({ ok: true, value: { pageCount: 25 } });

    const added = new Set(add.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener));
    const removed = new Set(remove.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener));
    expect(removed).toEqual(added);
  });

  it('removes every owned abort listener after cancellation', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const getTextContent = vi.fn(() => new Promise<never>(() => undefined));
    const pageLoader: PdfDocumentLoader = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent }),
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const extraction = extractPdfText(pdfFile(), { maxChars: 100, signal: controller.signal }, pageLoader);
    await vi.waitFor(() => expect(getTextContent).toHaveBeenCalledOnce());
    controller.abort();
    await expect(extraction).resolves.toEqual({ ok: false, reason: 'cancelled' });

    const added = new Set(add.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener));
    const removed = new Set(remove.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener));
    expect(removed).toEqual(added);
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
