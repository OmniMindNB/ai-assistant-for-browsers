export const MAX_ATTACHMENT_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_PDF_TEXT_CHARS = 60_000;

export type PdfExtractionFailureReason =
  | 'too-large'
  | 'invalid-pdf'
  | 'password-protected'
  | 'no-extractable-text'
  | 'read-failed'
  | 'parse-failed'
  | 'cancelled';

export interface PdfTextItemLike { str: string; hasEOL?: boolean }
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: (PdfTextItemLike | { type: string })[] }> }>;
}
export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void>;
}
export interface PdfDocumentLoader {
  load(data: Uint8Array): PdfLoadingTaskLike;
}
export interface PdfExtractionOptions {
  maxChars: number;
  signal?: AbortSignal;
  onProgress?: (completedPages: number, pageCount: number) => void;
}
export type PdfExtractionResult =
  | { ok: true; value: { text: string; pageCount: number; extractedChars: number; truncated: boolean } }
  | { ok: false; reason: PdfExtractionFailureReason };

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  let onAbort!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, cancellation]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/** 直接读已加载文档的所有页。阅读器与附件共用，附件可另设长度上限。 */
export async function readPdfDocumentText(
  document: PdfDocumentLike,
  { maxChars = Infinity, signal, onProgress }: Partial<PdfExtractionOptions> = {},
): Promise<{ text: string; truncated: boolean }> {
  const pages: string[] = [];
  let length = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await raceWithAbort(document.getPage(pageNumber), signal);
    const content = await raceWithAbort(page.getTextContent(), signal);
    const pageText = content.items
      .map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')
      .join('').trim();
    if (pageText) {
      const section = pages.length ? `\n\n[Page ${pageNumber}]\n\n${pageText}` : pageText;
      pages.push(section);
      length += section.length;
    }
    onProgress?.(pageNumber, document.numPages);
    if (length > maxChars) return { text: pages.join('').slice(0, maxChars), truncated: true };
  }
  return { text: pages.join(''), truncated: false };
}

export async function extractPdfText(
  file: File,
  options: PdfExtractionOptions,
  loader: PdfDocumentLoader,
): Promise<PdfExtractionResult> {
  if (file.size > MAX_ATTACHMENT_PDF_BYTES) return { ok: false, reason: 'too-large' };

  let data: Uint8Array;
  try {
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (new TextDecoder().decode(header) !== '%PDF-') return { ok: false, reason: 'invalid-pdf' };
    data = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  if (options.signal?.aborted) return { ok: false, reason: 'cancelled' };
  const task = loader.load(data);
  let taskDestroyPromise: Promise<void> | undefined;
  const destroyTask = async () => {
    if (!taskDestroyPromise) taskDestroyPromise = task.destroy();
    await taskDestroyPromise;
  };
  const abort = () => { void destroyTask(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const document = await raceWithAbort(task.promise, options.signal);
    const { text, truncated } = await readPdfDocumentText(document, options);
    if (options.signal?.aborted) return { ok: false, reason: 'cancelled' };
    if (!text.trim()) return { ok: false, reason: 'no-extractable-text' };
    return { ok: true, value: { text, pageCount: document.numPages, extractedChars: text.length, truncated } };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { ok: false, reason: 'cancelled' };
    }
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') return { ok: false, reason: 'password-protected' };
    if (['InvalidPDFException', 'MissingPDFException', 'UnexpectedResponseException'].includes(name)) {
      return { ok: false, reason: 'invalid-pdf' };
    }
    return { ok: false, reason: 'parse-failed' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await destroyTask();
  }
}
