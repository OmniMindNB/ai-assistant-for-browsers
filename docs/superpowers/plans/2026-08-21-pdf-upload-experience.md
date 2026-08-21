# PDF Upload Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add responsive, local-only PDF text extraction to the existing attachment flow, with compact progress/error chips, drag-and-drop, safe one-turn delivery, and metadata-only persistence.

**Architecture:** Keep PDF parsing behind a small adapter: a pure extraction core consumes a PDF document loader, while a browser runtime module owns PDF.js and its packaged Worker/assets. The sidepanel store owns transient attachment state and a bounded parse queue; only `MessageAttachment` metadata crosses into chat history and IndexedDB.

**Tech Stack:** TypeScript 5.9, React 19, Zustand 5, WXT 0.20/Vite, PDF.js (`pdfjs-dist`), Vitest 4, Testing Library, Tailwind CSS 4, Dexie 4.

**Spec:** `docs/superpowers/specs/2026-08-21-pdf-upload-experience-design.md`

## Global Constraints

- Support PDF only; do not add OCR or Word/Excel/PowerPoint parsing.
- Parse locally in the extension; never upload the raw PDF or load runtime code/assets from a CDN.
- Limit each PDF to exactly 20 MB and exactly 60,000 extracted characters.
- Keep at most 5 total attachments per message and at most 2 PDF parse jobs running concurrently.
- Disable sending while any attachment is queued or parsing; error attachments do not block valid text or ready attachments.
- Persist PDF metadata only: name, MIME type, size, page count, extracted character count, and truncation state.
- PDF bytes and extracted text must remain transient and must be released on send, removal, conversation change, clear, or sidepanel teardown.
- Keep existing text/image attachment behavior and one-turn semantics unchanged.
- Keep Manifest V3 permissions unchanged and Chrome minimum version at 138.
- All new user-facing strings require matching English and Chinese translations and accessible labels.

---

### Task 1: Pure PDF extraction core

**Files:**
- Create: `lib/chat/pdf-extractor.ts`
- Create: `lib/chat/pdf-extractor.test.ts`

**Interfaces:**
- Consumes: browser `File`, `AbortSignal`, and an injected `PdfDocumentLoader`.
- Produces: `MAX_ATTACHMENT_PDF_BYTES`, `MAX_ATTACHMENT_PDF_TEXT_CHARS`, `PdfExtractionFailureReason`, `PdfExtractionResult`, `PdfExtractionOptions`, `PdfDocumentLoader`, and `extractPdfText(file, options, loader)`.

- [ ] **Step 1: Write failing tests for validation, page order, progress, truncation, cancellation, and error mapping**

```ts
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
        getPage: async (pageNumber) => ({
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
      load: () => ({ promise: new Promise(() => undefined), destroy }),
    };
    const extraction = extractPdfText(pdfFile(), { maxChars: 100, signal: controller.signal }, pendingLoader);
    controller.abort();
    await expect(extraction).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(destroy).toHaveBeenCalledOnce();
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
```

- [ ] **Step 2: Run the focused tests and verify the missing module failure**

Run: `pnpm vitest run lib/chat/pdf-extractor.test.ts`

Expected: FAIL because `lib/chat/pdf-extractor.ts` does not exist.

- [ ] **Step 3: Implement the extraction core with injected PDF interfaces**

```ts
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
  getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItemLike[] }> }>;
  destroy(): Promise<void>;
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
```

Implement `extractPdfText` so it reads at most the first five bytes before size/header rejection, races the loading task against abort, normalizes `hasEOL`, inserts `\n\n[Page N]\n\n` between non-empty pages, slices once at `maxChars`, and always destroys the PDF document/loading task in `finally`. Map `PasswordException` to `password-protected`, invalid/missing PDF exceptions to `invalid-pdf`, and all other non-abort parser failures to `parse-failed`.

Use this control flow:

```ts
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
  let taskDestroyed = false;
  const destroyTask = async () => {
    if (taskDestroyed) return;
    taskDestroyed = true;
    await task.destroy();
  };
  const abort = () => { void destroyTask(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  let document: PdfDocumentLike | undefined;
  try {
    document = await Promise.race([
      task.promise,
      new Promise<never>((_resolve, reject) => options.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      )),
    ]);
    let text = '';
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      const pageText = content.items
        .map((item) => item.str + (item.hasEOL ? '\n' : ' '))
        .join('').trim();
      if (pageText) text += `${text ? `\n\n[Page ${pageNumber}]\n\n` : ''}${pageText}`;
      options.onProgress?.(pageNumber, document.numPages);
      if (text.length > options.maxChars) {
        text = text.slice(0, options.maxChars);
        truncated = true;
        break;
      }
    }
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
    if (document) await document.destroy();
    else await destroyTask();
  }
}
```

- [ ] **Step 4: Run the extraction tests**

Run: `pnpm vitest run lib/chat/pdf-extractor.test.ts`

Expected: PASS, including the abort test without hanging.

- [ ] **Step 5: Commit the pure extraction core**

```bash
git add lib/chat/pdf-extractor.ts lib/chat/pdf-extractor.test.ts
git commit -m "feat: add pure PDF text extraction core"
```

---

### Task 2: Package and configure the PDF.js browser runtime

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `wxt.config.ts`
- Create: `lib/chat/pdfjs-runtime.ts`
- Create: `lib/chat/pdfjs-runtime.test.ts`

**Interfaces:**
- Consumes: `extractPdfText`, `PdfExtractionOptions`, and PDF.js `getDocument`.
- Produces: `extractPdfAttachment(file, options): Promise<PdfExtractionResult>` and `buildPdfAssetUrls(extensionRoot)`.

- [ ] **Step 1: Add PDF.js and the static-copy build plugin**

Run: `pnpm add pdfjs-dist && pnpm add -D vite-plugin-static-copy`

Expected: `package.json` and `pnpm-lock.yaml` record both dependencies without peer-dependency errors.

- [ ] **Step 2: Write a failing runtime configuration test**

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'chrome-extension://abc/assets/pdf.worker.mjs' }));
import { buildPdfAssetUrls } from './pdfjs-runtime';

describe('buildPdfAssetUrls', () => {
  it('resolves every PDF.js support asset inside the extension origin', () => {
    expect(buildPdfAssetUrls('chrome-extension://abc/')).toEqual({
      cMapUrl: 'chrome-extension://abc/pdfjs/cmaps/',
      standardFontDataUrl: 'chrome-extension://abc/pdfjs/standard_fonts/',
      wasmUrl: 'chrome-extension://abc/pdfjs/wasm/',
    });
  });
});
```

- [ ] **Step 3: Run the runtime test and verify it fails**

Run: `pnpm vitest run lib/chat/pdfjs-runtime.test.ts`

Expected: FAIL because `pdfjs-runtime.ts` does not exist.

- [ ] **Step 4: Implement the PDF.js adapter and local asset URLs**

```ts
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { extractPdfText, type PdfExtractionOptions } from './pdf-extractor';

GlobalWorkerOptions.workerSrc = workerUrl;

export function buildPdfAssetUrls(extensionRoot: string) {
  return {
    cMapUrl: new URL('pdfjs/cmaps/', extensionRoot).toString(),
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', extensionRoot).toString(),
    wasmUrl: new URL('pdfjs/wasm/', extensionRoot).toString(),
  };
}

export function extractPdfAttachment(file: File, options: PdfExtractionOptions) {
  const assetUrls = buildPdfAssetUrls(browser.runtime.getURL('/'));
  return extractPdfText(file, options, {
    load: (data) => getDocument({ data, cMapPacked: true, ...assetUrls }),
  });
}
```

Keep the adapter cast localized if PDF.js's structural types are wider than the pure interfaces; do not import PDF.js types into `pdf-extractor.ts`.

- [ ] **Step 5: Copy PDF.js support directories into the extension build**

Add `viteStaticCopy` to `wxt.config.ts` with these exact targets:

```ts
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Inside vite: () => ({ ... })
plugins: [
  tailwindcss(),
  viteStaticCopy({
    targets: [
      { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps' },
      { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts' },
      { src: 'node_modules/pdfjs-dist/wasm/*', dest: 'pdfjs/wasm' },
    ],
  }),
],
```

Keep all existing WXT manifest permissions and build options unchanged.

- [ ] **Step 6: Run runtime tests and a production build**

Run: `pnpm vitest run lib/chat/pdfjs-runtime.test.ts && pnpm build`

Expected: PASS; `.output/chrome-mv3/pdfjs/` contains `cmaps`, `standard_fonts`, and `wasm`, and a bundled PDF Worker asset exists under `.output/chrome-mv3/assets/`.

- [ ] **Step 7: Commit the local PDF.js runtime**

```bash
git add package.json pnpm-lock.yaml wxt.config.ts lib/chat/pdfjs-runtime.ts lib/chat/pdfjs-runtime.test.ts
git commit -m "feat: package PDF.js runtime for local extraction"
```

---

### Task 3: Model transient attachment states and metadata-only persistence

**Files:**
- Modify: `lib/chat/attachments.ts`
- Modify: `lib/chat/attachments.test.ts`
- Modify: `lib/chat/messages.ts`
- Modify: `lib/chat/messages.test.ts`
- Modify: `lib/db.ts`

**Interfaces:**
- Consumes: `PdfExtractionFailureReason` from Task 1.
- Produces: `PdfAttachment`, `PendingAttachment`, `isAttachmentBusy`, `isAttachmentReady`, `toMessageAttachment`, `buildPendingAttachmentText`, and `toPendingImageContent`.

- [ ] **Step 1: Write failing attachment-domain tests**

```ts
import {
  buildPendingAttachmentText,
  isAttachmentBusy,
  toMessageAttachment,
  type PendingAttachment,
} from './attachments';

const readyPdf: PendingAttachment = {
  id: 'pdf-1', name: 'report.pdf', mimeType: 'application/pdf', size: 100, kind: 'pdf',
  status: 'ready',
  attachment: {
    id: 'pdf-1', name: 'report.pdf', mimeType: 'application/pdf', size: 100,
    kind: 'pdf', pageCount: 12, extractedChars: 42_000, truncated: false,
  },
  transientText: 'private extracted text',
};

it('classifies PDF by MIME type or extension', () => {
  expect(classifyFile(new File(['%PDF-'], 'a.pdf', { type: 'application/pdf' }))).toBe('pdf');
  expect(classifyFile(new File(['%PDF-'], 'a.pdf', { type: '' }))).toBe('pdf');
});

it('keeps PDF text transient while projecting metadata', () => {
  expect(toMessageAttachment(readyPdf)).toEqual(readyPdf.attachment);
  expect(JSON.stringify(toMessageAttachment(readyPdf))).not.toContain('private extracted text');
  expect(buildPendingAttachmentText(readyPdf, t)).toContain('private extracted text');
});

it('marks queued and parsing items as busy but errors as non-blocking', () => {
  expect(isAttachmentBusy({ status: 'queued', id: '1', taskId: 't1', file: new File([], 'a.pdf'), name: 'a.pdf', mimeType: 'application/pdf', size: 0, kind: 'pdf' })).toBe(true);
  expect(isAttachmentBusy({ status: 'error', id: '1', file: new File([], 'a.pdf'), name: 'a.pdf', mimeType: 'application/pdf', size: 0, kind: 'pdf', reason: 'invalid-pdf', retryable: false })).toBe(false);
});
```

Add a `toMessageRecords` test that passes a ready PDF display attachment and asserts the record has `pageCount`, `extractedChars`, and `truncated`, but no `transientText`, `file`, `taskId`, `status`, or raw bytes.

```ts
it('persists PDF metadata without transient extraction state', () => {
  const pdf: MessageAttachment = {
    id: 'pdf-1', name: 'report.pdf', mimeType: 'application/pdf', size: 100,
    kind: 'pdf', pageCount: 12, extractedChars: 42_000, truncated: false,
  };
  const records = toMessageRecords('c-1', [{
    id: 'm-1', role: 'user', content: 'Summarize', createdAt: 1, attachments: [pdf],
  }]);
  expect(records[0].attachments).toEqual([pdf]);
  expect(JSON.stringify(records[0])).not.toMatch(/transientText|taskId|private extracted text/);
});
```

- [ ] **Step 2: Run the domain tests and verify type/export failures**

Run: `pnpm vitest run lib/chat/attachments.test.ts lib/chat/messages.test.ts`

Expected: FAIL because the PDF and pending attachment types/functions are missing.

- [ ] **Step 3: Introduce explicit stored and pending unions**

```ts
export interface AttachmentBase {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface TextAttachment extends AttachmentBase {
  kind: 'text';
  textContent: string;
  truncated: boolean;
}
export interface ImageAttachment extends AttachmentBase {
  kind: 'image';
  dataUrl: string;
}
export interface PdfAttachment extends AttachmentBase {
  kind: 'pdf';
  pageCount: number;
  extractedChars: number;
  truncated: boolean;
}

export type MessageAttachment = TextAttachment | ImageAttachment | PdfAttachment;

export interface PendingAttachmentBase {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'text' | 'image' | 'pdf' | 'unsupported';
}
export type ReadyPendingAttachment = PendingAttachmentBase & {
  status: 'ready';
  attachment: MessageAttachment;
  transientText?: string;
};
export type PendingAttachment =
  | ReadyPendingAttachment
  | PendingAttachmentBase & {
      status: 'queued' | 'parsing';
      taskId: string; file: File; kind: 'text' | 'image' | 'pdf';
      completedPages?: number; pageCount?: number;
    }
  | PendingAttachmentBase & {
      status: 'error';
      file?: File;
      reason: AttachmentReadFailureReason | PdfExtractionFailureReason;
      retryable: boolean;
    };

export function isAttachmentBusy(item: PendingAttachment): boolean {
  return item.status === 'queued' || item.status === 'parsing';
}
export function isAttachmentReady(item: PendingAttachment): item is ReadyPendingAttachment {
  return item.status === 'ready';
}
export function toMessageAttachment(item: PendingAttachment): MessageAttachment | null {
  return item.status === 'ready' ? item.attachment : null;
}
export function buildPendingAttachmentText(item: PendingAttachment, translate: Translate): string {
  if (item.status !== 'ready' || item.attachment.kind === 'image') return '';
  const content = item.attachment.kind === 'pdf'
    ? item.transientText ?? ''
    : item.attachment.textContent;
  return translate('store.attachmentTextTemplate', {
    name: item.attachment.name,
    content: JSON.stringify(content),
  });
}
export function toPendingImageContent(item: PendingAttachment): ImageContent | null {
  if (item.status !== 'ready' || item.attachment.kind !== 'image') return null;
  return toImageContent(item.attachment);
}
export function attachmentFailureLabel(
  reason: AttachmentReadFailureReason | PdfExtractionFailureReason,
  name: string,
  translate: Translate,
  kind: PendingAttachmentBase['kind'],
): string {
  const keys = {
    'too-large': kind === 'pdf' ? 'workbench.pdfTooLarge' : 'workbench.attachmentTooLarge',
    'unsupported-type': 'workbench.attachmentUnsupportedType',
    'read-failed': 'workbench.attachmentReadFailed',
    'invalid-pdf': 'workbench.pdfInvalid',
    'password-protected': 'workbench.pdfPasswordProtected',
    'no-extractable-text': 'workbench.pdfNoText',
    'parse-failed': 'workbench.pdfParseFailed',
    cancelled: 'workbench.pdfParseFailed',
  } as const;
  return translate(keys[reason], { name });
}
```

Change `readAttachment(file, id)` to preserve the caller-reserved ID. Add helpers that unwrap only `ready` attachments; text/PDF prompt building reads from ready attachments, image conversion rejects non-ready/non-image inputs, and error/busy entries return no persistent projection.

Update classification before the existing image/text checks:

```ts
export function classifyFile(file: File): 'text' | 'image' | 'pdf' | 'unsupported' {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  if (file.type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || file.type === 'application/json') return 'text';
  return TEXT_EXTENSIONS.has(ext) ? 'text' : 'unsupported';
}
```

- [ ] **Step 4: Make chat persistence accept stored attachments only**

Keep `ChatMessage.attachments` and `ChatMessageRecord.attachments` typed as `MessageAttachment[]`. In the store integration task, only `toMessageAttachment` results may be passed to `makeMessage`; this makes transient fields unrepresentable in the DB path.

- [ ] **Step 5: Run the domain tests and typecheck**

Run: `pnpm vitest run lib/chat/attachments.test.ts lib/chat/messages.test.ts && pnpm compile`

Expected: PASS; any existing attachment fixture is updated to the `status: 'ready'` wrapper only where pending state is required, while history fixtures remain `MessageAttachment`.

- [ ] **Step 6: Commit attachment state and persistence boundaries**

```bash
git add lib/chat/attachments.ts lib/chat/attachments.test.ts lib/chat/messages.ts lib/chat/messages.test.ts lib/db.ts
git commit -m "refactor: separate pending attachments from history metadata"
```

---

### Task 4: Add a bounded, cancellable PDF parse queue

**Files:**
- Create: `lib/chat/pdf-parse-queue.ts`
- Create: `lib/chat/pdf-parse-queue.test.ts`

**Interfaces:**
- Consumes: task IDs and `(signal: AbortSignal) => Promise<T>` job functions.
- Produces: `PdfParseQueue.enqueue(id, run)`, `cancel(id)`, `cancelAll()`, and `activeCount`.

- [ ] **Step 1: Write failing queue tests for concurrency and cancellation**

```ts
import { describe, expect, it, vi } from 'vitest';
import { PdfParseQueue } from './pdf-parse-queue';

it('runs at most two jobs and starts the third after one settles', async () => {
  const queue = new PdfParseQueue(2);
  const releases: Array<() => void> = [];
  const run = vi.fn(() => new Promise<string>((resolve) => releases.push(() => resolve('done'))));
  const jobs = ['a', 'b', 'c'].map((id) => queue.enqueue(id, run));
  expect(run).toHaveBeenCalledTimes(2);
  expect(queue.activeCount).toBe(2);
  releases[0]();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  releases[1]();
  releases[2]();
  await expect(Promise.all(jobs)).resolves.toEqual(['done', 'done', 'done']);
});

it('cancels queued and running jobs without starting removed work', async () => {
  const queue = new PdfParseQueue(1);
  let firstSignal!: AbortSignal;
  const first = queue.enqueue('a', (signal) => {
    firstSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  const neverRun = vi.fn().mockResolvedValue('b');
  const second = queue.enqueue('b', neverRun);
  queue.cancel('b');
  queue.cancel('a');
  await expect(first).rejects.toHaveProperty('name', 'AbortError');
  await expect(second).rejects.toHaveProperty('name', 'AbortError');
  expect(firstSignal.aborted).toBe(true);
  expect(neverRun).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and verify the missing module failure**

Run: `pnpm vitest run lib/chat/pdf-parse-queue.test.ts`

Expected: FAIL because the queue module does not exist.

- [ ] **Step 3: Implement the queue**

Use one `AbortController` per job, a FIFO pending list, and a `Map` keyed by task ID. `enqueue` must reject duplicate live IDs, `cancel` must remove queued jobs or abort active jobs, and a single `pump()` must start work while `activeCount < concurrency`. In `finally`, remove the job, decrement the active count exactly once, and call `pump()`.

```ts
interface QueueJob<T> {
  id: string;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  active: boolean;
}

export class PdfParseQueue {
  private pending: QueueJob<unknown>[] = [];
  private jobs = new Map<string, QueueJob<unknown>>();
  private running = 0;

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be positive');
  }

  get activeCount(): number { return this.running; }

  enqueue<T>(id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.jobs.has(id)) return Promise.reject(new Error(`Duplicate PDF task: ${id}`));
    return new Promise<T>((resolve, reject) => {
      const job: QueueJob<T> = { id, controller: new AbortController(), run, resolve, reject, active: false };
      this.jobs.set(id, job as QueueJob<unknown>);
      this.pending.push(job as QueueJob<unknown>);
      this.pump();
    });
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.active) {
      job.controller.abort(new DOMException('Aborted', 'AbortError'));
      return;
    }
    this.pending = this.pending.filter((candidate) => candidate !== job);
    this.jobs.delete(id);
    job.reject(new DOMException('Aborted', 'AbortError'));
  }

  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      job.active = true;
      this.running += 1;
      void job.run(job.controller.signal).then(job.resolve, job.reject).finally(() => {
        this.running -= 1;
        this.jobs.delete(job.id);
        this.pump();
      });
    }
  }
}
```

- [ ] **Step 4: Run queue tests**

Run: `pnpm vitest run lib/chat/pdf-parse-queue.test.ts`

Expected: PASS with no unhandled promise rejection.

- [ ] **Step 5: Commit the queue**

```bash
git add lib/chat/pdf-parse-queue.ts lib/chat/pdf-parse-queue.test.ts
git commit -m "feat: add bounded PDF parse queue"
```

---

### Task 5: Integrate PDF lifecycle, retry, sending, and cleanup into the store

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/zh.ts`

**Interfaces:**
- Consumes: `PendingAttachment`, Task 3 helpers, `PdfParseQueue`, and `extractPdfAttachment`.
- Produces: `pendingAttachments: PendingAttachment[]`, `retryAttachment(id)`, and existing actions updated with cancellation/persistence guarantees.

- [ ] **Step 1: Mock PDF extraction and write failing store lifecycle tests**

Add a hoisted `extractPdfAttachment` mock and module mock before importing `store.ts`:

```ts
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createBrowserAgent: vi.fn(),
  getActiveProvider: vi.fn(),
  replaceConversationMessages: vi.fn(),
  getConversationMessages: vi.fn(),
  deleteConversation: vi.fn(),
  listConversations: vi.fn(),
  extractPdfAttachment: vi.fn(),
}));
vi.mock('@/lib/chat/pdfjs-runtime', () => ({ extractPdfAttachment: mocks.extractPdfAttachment }));
```

Add tests with a deferred result:

```ts
it('reserves a PDF chip immediately and blocks send until parsing completes', async () => {
  let finish!: (value: any) => void;
  mocks.extractPdfAttachment.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const adding = useChat.getState().addAttachmentFiles([
    new File(['%PDF-body'], 'report.pdf', { type: 'application/pdf' }),
  ]);
  expect(useChat.getState().pendingAttachments[0]).toMatchObject({ status: 'queued', name: 'report.pdf' });
  await expect(useChat.getState().send('summarize')).resolves.toBe(false);
  finish({ ok: true, value: { text: 'private text', pageCount: 3, extractedChars: 12, truncated: false } });
  await adding;
  expect(useChat.getState().pendingAttachments[0]).toMatchObject({
    status: 'ready', attachment: { kind: 'pdf', pageCount: 3, extractedChars: 12 }, transientText: 'private text',
  });
});

it('sends PDF text once but keeps only metadata on the displayed and persisted message', async () => {
  mocks.extractPdfAttachment.mockResolvedValue({
    ok: true,
    value: { text: 'private PDF text', pageCount: 2, extractedChars: 16, truncated: false },
  });
  await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf', { type: 'application/pdf' })]);
  await useChat.getState().send('summarize');
  const agent = mocks.createBrowserAgent.mock.results[0].value;
  expect(agent.prompt.mock.calls[0][0]).toContain('private PDF text');
  const userMessage = useChat.getState().messages.find((message) => message.role === 'user')!;
  expect(userMessage.attachments?.[0]).toMatchObject({ kind: 'pdf', pageCount: 2 });
  expect(JSON.stringify(userMessage)).not.toContain('private PDF text');
  expect(JSON.stringify(mocks.replaceConversationMessages.mock.calls)).not.toContain('private PDF text');
});

it('cancels removed work and ignores a late result', async () => {
  let finish!: (value: any) => void;
  mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
    finish = resolve;
    options.signal.addEventListener('abort', () => undefined);
  }));
  const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);
  const id = useChat.getState().pendingAttachments[0].id;
  useChat.getState().removeAttachment(id);
  finish({ ok: true, value: { text: 'late', pageCount: 1, extractedChars: 4, truncated: false } });
  await adding;
  expect(useChat.getState().pendingAttachments).toEqual([]);
});
```

Add these focused cases as well:

```ts
it('reserves five slots across overlapping add calls', async () => {
  mocks.extractPdfAttachment.mockResolvedValue({ ok: false, reason: 'parse-failed' });
  const first = useChat.getState().addAttachmentFiles([
    new File(['a'], '1.txt'), new File(['b'], '2.txt'), new File(['c'], '3.txt'),
  ]);
  const second = useChat.getState().addAttachmentFiles([
    new File(['d'], '4.txt'), new File(['e'], '5.txt'), new File(['f'], '6.txt'),
  ]);
  await Promise.all([first, second]);
  expect(useChat.getState().pendingAttachments).toHaveLength(5);
});

it('clears pending jobs when starting a new chat', async () => {
  mocks.extractPdfAttachment.mockImplementation((_file, options) => new Promise((resolve) => {
    options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
  }));
  const adding = useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);
  useChat.getState().clear();
  await adding;
  expect(useChat.getState().pendingAttachments).toEqual([]);
});

it('allows typed text to send while an error chip remains', async () => {
  useChat.setState({ pendingAttachments: [{
    status: 'error', id: 'bad', name: 'bad.pdf', mimeType: 'application/pdf', size: 10,
    kind: 'pdf', reason: 'invalid-pdf', retryable: false,
  }] });
  await expect(useChat.getState().send('continue without it')).resolves.toBe(true);
});

it('retries a parse failure with the same attachment ID', async () => {
  mocks.extractPdfAttachment
    .mockResolvedValueOnce({ ok: false, reason: 'parse-failed' })
    .mockResolvedValueOnce({ ok: true, value: { text: 'ok', pageCount: 1, extractedChars: 2, truncated: false } });
  await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);
  const failed = useChat.getState().pendingAttachments[0];
  expect(failed).toMatchObject({ status: 'error', retryable: true });
  await useChat.getState().retryAttachment(failed.id);
  expect(useChat.getState().pendingAttachments[0]).toMatchObject({ status: 'ready', id: failed.id });
});

it('uses the localized default prompt for attachment-only send', async () => {
  mocks.extractPdfAttachment.mockResolvedValue({
    ok: true, value: { text: 'pdf text', pageCount: 1, extractedChars: 8, truncated: false },
  });
  await useChat.getState().addAttachmentFiles([new File(['%PDF-x'], 'a.pdf')]);
  await expect(useChat.getState().send()).resolves.toBe(true);
  const agent = mocks.createBrowserAgent.mock.results[0].value;
  expect(agent.prompt.mock.calls[0][0]).toContain('Analyze the attached file.');
});
```

- [ ] **Step 2: Run the store tests and verify failures**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`

Expected: FAIL because the store still uses `MessageAttachment[]` and has no PDF lifecycle/retry action.

- [ ] **Step 3: Add module-level queue ownership and atomic reservation**

Create one `PdfParseQueue(2)` for the sidepanel module. In `addAttachmentFiles`, reserve up to the remaining five slots synchronously with stable IDs before awaiting file reads. Unsupported/oversized files become `error` entries; text/images transition to `ready`; PDFs enqueue `extractPdfAttachment` and update only when attachment ID, task ID, and captured conversation origin still match.

Use these store-level primitives rather than allowing async callbacks to call `set` unguarded:

```ts
const pdfParseQueue = new PdfParseQueue(2);
type StoreSet = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;
type StoreGet = () => ChatState;

function replacePendingAttachment(
  set: StoreSet,
  id: string,
  taskId: string,
  replace: (current: PendingAttachment) => PendingAttachment,
): void {
  set((state) => ({
    pendingAttachments: state.pendingAttachments.map((item) =>
      item.id === id && 'taskId' in item && item.taskId === taskId ? replace(item) : item,
    ),
  }));
}

async function parseReservedPdf(
  set: StoreSet,
  get: StoreGet,
  reserved: Extract<PendingAttachment, { status: 'queued' | 'parsing' }>,
  origin: ConversationOrigin,
): Promise<void> {
  let result: PdfExtractionResult;
  try {
    result = await pdfParseQueue.enqueue(reserved.taskId, (signal) => {
      replacePendingAttachment(set, reserved.id, reserved.taskId, (item) => ({ ...item, status: 'parsing' }));
      return extractPdfAttachment(reserved.file, {
        maxChars: MAX_ATTACHMENT_PDF_TEXT_CHARS,
        signal,
        onProgress: (completedPages, pageCount) => replacePendingAttachment(
          set, reserved.id, reserved.taskId,
          (item) => ({ ...item, status: 'parsing', completedPages, pageCount }),
        ),
      });
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    result = { ok: false, reason: 'parse-failed' };
  }
  if (!isCurrentOrigin(origin, get)) return;
  replacePendingAttachment(set, reserved.id, reserved.taskId, (item) => result.ok ? {
    id: item.id, name: item.name, mimeType: 'application/pdf', size: item.size, kind: 'pdf',
    status: 'ready',
    attachment: {
      id: item.id, name: item.name, mimeType: 'application/pdf', size: item.size, kind: 'pdf',
      pageCount: result.value.pageCount,
      extractedChars: result.value.extractedChars,
      truncated: result.value.truncated,
    },
    transientText: result.value.text,
  } : {
    id: item.id, name: item.name, mimeType: 'application/pdf', size: item.size, kind: 'pdf',
    status: 'error', file: reserved.file,
    reason: result.reason,
    retryable: result.reason === 'read-failed' || result.reason === 'parse-failed',
  });
}
```

Catch queue abort rejections and treat them as expected cancellation. `addAttachmentFiles` must perform one synchronous `set` that appends all reserved placeholders before it starts `readAttachment` or `parseReservedPdf` promises.

```ts
addAttachmentFiles: async (files) => {
  const available = MAX_ATTACHMENTS_PER_MESSAGE - get().pendingAttachments.length;
  const selected = Array.from(files).slice(0, Math.max(0, available));
  const origin = captureConversationOrigin(get);
  const reserved: PendingAttachment[] = selected.map((file) => {
    const id = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const kind = classifyFile(file);
    const base = { id, file, name: file.name, mimeType: file.type, size: file.size };
    if (kind === 'unsupported') {
      return { ...base, kind, status: 'error', reason: 'unsupported-type', retryable: false };
    }
    if (kind === 'pdf' && file.size > MAX_ATTACHMENT_PDF_BYTES) {
      return { ...base, kind, status: 'error', reason: 'too-large', retryable: false };
    }
    return { ...base, kind, taskId, status: 'queued' };
  });
  set((state) => ({ pendingAttachments: [...state.pendingAttachments, ...reserved] }));
  await Promise.all(reserved.map(async (item) => {
    if (item.status === 'error' || item.status === 'ready') return;
    if (item.kind === 'pdf') return parseReservedPdf(set, get, item, origin);
    const result = await readAttachment(item.file, item.id);
    replacePendingAttachment(set, item.id, item.taskId, (current) => result.ok ? {
      id: current.id, name: current.name, mimeType: current.mimeType, size: current.size,
      kind: result.attachment.kind, status: 'ready', attachment: result.attachment,
    } : {
      id: current.id, name: current.name, mimeType: current.mimeType, size: current.size,
      kind: item.kind, status: 'error', file: item.file, reason: result.failure.reason,
      retryable: false,
    });
  }));
},
```

When `files.length > selected.length`, keep the existing localized five-attachment limit message in `state.error`; individual file failures stay in chips.

- [ ] **Step 4: Implement retry and cleanup hooks**

Add `retryAttachment(id)` to `ChatState`. Only `read-failed` and `parse-failed` are retryable. Retry preserves the attachment ID, allocates a new task ID, and returns to `queued`. Make `removeAttachment`, `clear`, successful `openConversation`, active conversation deletion, and sidepanel teardown cancel corresponding queue jobs and clear transient attachments. Keep the existing agent-run cancellation logic separate.

```ts
function cancelPendingAttachments(items: PendingAttachment[]): void {
  for (const item of items) {
    if (item.status === 'queued' || item.status === 'parsing') pdfParseQueue.cancel(item.taskId);
  }
}

removeAttachment: (id) => {
  const item = get().pendingAttachments.find((candidate) => candidate.id === id);
  if (item && (item.status === 'queued' || item.status === 'parsing')) pdfParseQueue.cancel(item.taskId);
  set((state) => ({ pendingAttachments: state.pendingAttachments.filter((candidate) => candidate.id !== id) }));
},

retryAttachment: async (id) => {
  const failed = get().pendingAttachments.find((item) => item.id === id && item.status === 'error');
  if (!failed || !failed.retryable || !failed.file || failed.kind !== 'pdf') return;
  const taskId = crypto.randomUUID();
  const queued = { ...failed, status: 'queued' as const, taskId, file: failed.file, kind: 'pdf' as const };
  set((state) => ({ pendingAttachments: state.pendingAttachments.map((item) => item.id === id ? queued : item) }));
  await parseReservedPdf(set, get, queued, captureConversationOrigin(get));
},
```

Add `disposeAttachments()` to `ChatState`; it calls `cancelPendingAttachments` and clears the array. Call it synchronously at the start of `clear` and `openConversation`, when removing the active conversation, and from an `App.tsx` unmount effect added in Task 6.

- [ ] **Step 5: Update send composition and persistence projection**

At send time:

```ts
const pending = get().pendingAttachments;
if (pending.some(isAttachmentBusy) || get().busy) return false;
const ready = pending.filter(isAttachmentReady);
const question = (text ?? get().input).trim();
if (!question && ready.length === 0) return false;
const displayText = question || t('store.attachmentOnlyPrompt');
const storedAttachments = ready.map(toMessageAttachment).filter((item): item is MessageAttachment => item !== null);
const attachmentText = ready.map((item) => buildPendingAttachmentText(item, t)).join('');
const images = ready.map(toPendingImageContent).filter((item): item is ImageContent => item !== null);
const agentUserContent = (quoted ? buildSelectionAskTemplate(quoted, t) : '') + attachmentText + displayText;
```

Pass only `storedAttachments` to `makeMessage`, pass ready images to `agent.prompt`, and clear/cancel all transient attachment state at the same commit point where `runAgent` currently clears the composer.

- [ ] **Step 6: Add exact bilingual store strings**

Add matching keys for the attachment-only prompt and normalized errors, including:

```ts
'store.attachmentOnlyPrompt': 'Analyze the attached file.',
'workbench.pdfTooLarge': '“{name}” exceeds the 20 MB PDF limit',
'workbench.pdfInvalid': '“{name}” is not a valid PDF',
'workbench.pdfPasswordProtected': '“{name}” is password-protected',
'workbench.pdfNoText': 'No extractable text found in “{name}”',
'workbench.pdfParseFailed': 'Could not parse “{name}”',
```

Use these exact Chinese equivalents and keep locale key sets identical:

```ts
'store.attachmentOnlyPrompt': '请分析所附文件。',
'workbench.pdfTooLarge': '「{name}」超过 20 MB 的 PDF 上限',
'workbench.pdfInvalid': '「{name}」不是有效的 PDF',
'workbench.pdfPasswordProtected': '「{name}」受密码保护',
'workbench.pdfNoText': '未能从「{name}」提取文字',
'workbench.pdfParseFailed': '无法解析「{name}」',
```

- [ ] **Step 7: Run store and attachment tests**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx lib/chat/attachments.test.ts lib/chat/messages.test.ts`

Expected: PASS; no test leaks a queue job into `afterEach`.

- [ ] **Step 8: Commit store integration**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx lib/i18n/locales/en.ts lib/i18n/locales/zh.ts
git commit -m "feat: integrate PDF attachment lifecycle"
```

---

### Task 6: Build compact PDF states and drag-and-drop UI

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/components/WorkbenchComposer.tsx`
- Modify: `entrypoints/sidepanel/components/AttachmentChip.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`
- Modify: `entrypoints/sidepanel/icons.tsx`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/zh.ts`

**Interfaces:**
- Consumes: `PendingAttachment[]`, `isAttachmentBusy`, `isAttachmentReady`, `retryAttachment(id)`, and existing add/remove actions.
- Produces: accessible compact chips for every state and a file-only composer drop target.

- [ ] **Step 1: Write failing component tests for chip states and send gating**

```tsx
const readyPdf: PendingAttachment = {
  id: 'ready-pdf', name: 'ready.pdf', mimeType: 'application/pdf', size: 10, kind: 'pdf',
  status: 'ready',
  attachment: {
    id: 'ready-pdf', name: 'ready.pdf', mimeType: 'application/pdf', size: 10,
    kind: 'pdf', pageCount: 2, extractedChars: 20, truncated: false,
  },
  transientText: 'ready text',
};
const retryablePdfError: PendingAttachment = {
  id: 'failed-pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 10, kind: 'pdf',
  status: 'error', file: new File(['%PDF-x'], 'report.pdf'), reason: 'parse-failed', retryable: true,
};

it('shows PDF progress and disables send while parsing', () => {
  render(<ComposerHarness
    initialInput="summarize"
    attachments={[{
      status: 'parsing', id: 'a', taskId: 't', file: new File([], 'report.pdf'),
      name: 'report.pdf', mimeType: 'application/pdf', size: 10, kind: 'pdf', completedPages: 2, pageCount: 4,
    }]}
  />);
  expect(screen.getByText('50%')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

it('enables attachment-only send for a ready PDF', () => {
  render(<ComposerHarness initialInput="" attachments={[readyPdf]} />);
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

it('shows retry only for retryable errors', async () => {
  const user = userEvent.setup();
  const onRetryAttachment = vi.fn();
  render(<ComposerHarness attachments={[retryablePdfError]} onRetryAttachment={onRetryAttachment} />);
  await user.click(screen.getByRole('button', { name: 'Retry report.pdf' }));
  expect(onRetryAttachment).toHaveBeenCalledWith(retryablePdfError.id);
});
```

- [ ] **Step 2: Write failing drag-and-drop tests**

```tsx
it('highlights file drag without intercepting text drag and submits dropped files', () => {
  const onAddAttachmentFiles = vi.fn();
  render(<ComposerHarness onAddAttachmentFiles={onAddAttachmentFiles} />);
  const zone = screen.getByTestId('composer-drop-zone');
  fireEvent.dragEnter(zone, { dataTransfer: { types: ['text/plain'] } });
  expect(screen.queryByText('Drop to add PDF')).toBeNull();

  const pdf = new File(['%PDF-x'], 'report.pdf', { type: 'application/pdf' });
  fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], files: [pdf] } });
  expect(screen.getByText('Drop to add PDF')).toBeVisible();
  fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [pdf] } });
  expect(onAddAttachmentFiles).toHaveBeenCalledWith([pdf]);
  expect(screen.queryByText('Drop to add PDF')).toBeNull();
});
```

- [ ] **Step 3: Run component tests and verify failures**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`

Expected: FAIL because the composer does not accept pending states, retry, or drop events.

- [ ] **Step 4: Render pending and historical chips separately**

Change `AttachmentChip` to accept either `{ pending: PendingAttachment }` or `{ attachment: MessageAttachment }`. Pending chips show:

```ts
export type AttachmentChipProps =
  | { pending: PendingAttachment; attachment?: never; onRemove(id: string): void; onRetry(id: string): void }
  | { attachment: MessageAttachment; pending?: never; onRemove?: never; onRetry?: never };
```

- queued/parsing: spinner, filename, rounded page percentage, remove;
- ready PDF: success icon, filename, page count, remove;
- truncated PDF: warning icon and localized truncated label/tooltip;
- error: inline normalized reason, remove, and retry only when `retryable`.

Historical `MessageAttachment` chips remain read-only and never show retry/remove. Preserve compact wrapping, visible focus rings, dark mode, and `max-w` filename truncation.

Implement a single normalized view before JSX so state branches cannot disagree on labels/actions:

```tsx
const pending = 'pending' in props ? props.pending : null;
const historical = 'attachment' in props ? props.attachment : null;
const status = pending?.status ?? 'history';
const name = pending?.name ?? historical!.name;
const progress = pending?.status === 'parsing' && pending.pageCount
  ? Math.round(((pending.completedPages ?? 0) / pending.pageCount) * 100)
  : null;
const readyPdf = pending?.status === 'ready' && pending.attachment.kind === 'pdf'
  ? pending.attachment
  : historical?.kind === 'pdf' ? historical : null;
const error = pending?.status === 'error' ? pending : null;
const onRetry = 'onRetry' in props ? props.onRetry : undefined;
const onRemove = 'onRemove' in props ? props.onRemove : undefined;

return (
  <div role={error ? 'alert' : undefined} aria-live={error ? undefined : 'polite'} className={chipClass(status)}>
    <AttachmentStatusIcon status={status} truncated={readyPdf?.truncated ?? false} />
    <span className="max-w-[120px] truncate">{name}</span>
    {progress !== null && <span>{progress}%</span>}
    {readyPdf && <span>{t('workbench.pdfPages', { count: readyPdf.pageCount })}</span>}
    {error && <span>{attachmentFailureLabel(error.reason, name, t, error.kind)}</span>}
    {error?.retryable && <button type="button" aria-label={t('workbench.retryNamedAttachment', { name })} onClick={() => onRetry?.(error.id)}>{t('common.retry')}</button>}
    {onRemove && pending && <button type="button" onClick={() => onRemove(pending.id)} aria-label={t('workbench.removeNamedAttachment', { name })}><IconClose /></button>}
  </div>
);
```

Keep `attachmentFailureLabel` in `lib/chat/attachments.ts` as a pure translation-key mapper so store and chip tests assert the same normalized reasons.

- [ ] **Step 5: Add the composer drop target and correct send predicate**

Use a drag-depth counter so child enter/leave events do not flicker. Only call `preventDefault()` for `dataTransfer.types.includes('Files')`. Add `.pdf,application/pdf` to the existing file input `accept` value. Compute:

```ts
const hasBusyAttachment = attachments.some(isAttachmentBusy);
const hasReadyAttachment = attachments.some(isAttachmentReady);
const canSend = !busy && !hasBusyAttachment && (input.trim().length > 0 || hasReadyAttachment);
```

While file drag is active, add the approved indigo border/background and replace the textarea placeholder with `workbench.dropPdfPrompt`; do not add a permanent drop panel.

- [ ] **Step 6: Wire retry and update bilingual accessible text**

Pass `retryAttachment` from `App.tsx` to `WorkbenchComposer`. Add matching English/Chinese keys for parsing, queued, progress, page count, retry, drop prompt, truncation explanation, and per-file remove/retry labels. Use `aria-live="polite"` for status changes and `role="alert"` only for error chips.

```ts
// en.ts
'workbench.attachmentQueued': 'Waiting to parse',
'workbench.attachmentParsing': 'Parsing',
'workbench.pdfPages': '{count} pages',
'workbench.pdfTruncatedDetail': 'Limited to the first 60,000 extracted characters',
'workbench.dropPdfPrompt': 'Drop to add PDF',
'workbench.retryNamedAttachment': 'Retry {name}',
'workbench.removeNamedAttachment': 'Remove {name}',

// zh.ts
'workbench.attachmentQueued': '等待解析',
'workbench.attachmentParsing': '正在解析',
'workbench.pdfPages': '{count} 页',
'workbench.pdfTruncatedDetail': '仅提取前 60,000 个字符',
'workbench.dropPdfPrompt': '松开即可添加 PDF',
'workbench.retryNamedAttachment': '重试 {name}',
'workbench.removeNamedAttachment': '移除 {name}',
```

Also release module-owned work when the sidepanel document unmounts:

```tsx
const disposeAttachments = useChat((state) => state.disposeAttachments);
useEffect(() => () => disposeAttachments(), [disposeAttachments]);
```

- [ ] **Step 7: Run UI tests, locale parity, and typecheck**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/i18n.test.ts && pnpm compile`

Expected: PASS in jsdom; English and Chinese key sets match exactly.

- [ ] **Step 8: Commit the PDF attachment UI**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/WorkbenchComposer.tsx entrypoints/sidepanel/components/AttachmentChip.tsx entrypoints/sidepanel/components/workbench-components.test.tsx entrypoints/sidepanel/icons.tsx lib/i18n/locales/en.ts lib/i18n/locales/zh.ts
git commit -m "feat: add compact PDF upload experience"
```

---

### Task 7: Documentation, full verification, and manual acceptance

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/PROGRESS.md`
- Verify: `.output/chrome-mv3/**`

**Interfaces:**
- Consumes: all completed tasks and the approved spec.
- Produces: documented PDF limits/behavior and a release-ready verified build.

- [ ] **Step 1: Update user-facing documentation**

Add one concise attachment bullet to both READMEs stating: local PDF text extraction, 20 MB/60,000-character limits, no OCR, and one-turn-only context. Add a dated `docs/PROGRESS.md` entry linking the spec and plan and noting metadata-only persistence.

Use these exact facts, translated naturally in each README:

```md
- 📎 **Local file context**: Attach text, images, or PDFs. PDF text is extracted locally (20 MB / 60,000 characters, no OCR), used for one turn, and only file metadata remains in history.
```

Add this progress entry:

```md
- 2026-08-21: Added local PDF attachment parsing with Worker-backed progress, drag-and-drop, bounded concurrency, and metadata-only history persistence ([design](superpowers/specs/2026-08-21-pdf-upload-experience-design.md), [plan](superpowers/plans/2026-08-21-pdf-upload-experience.md)).
```

- [ ] **Step 2: Run the full automated verification suite**

Run: `pnpm test && pnpm compile && pnpm build`

Expected: all Vitest projects pass, TypeScript reports no errors, and WXT completes the Chrome MV3 production build.

- [ ] **Step 3: Verify packaged assets and remote-code compliance**

Run in PowerShell:

```powershell
Get-ChildItem '.output\chrome-mv3\pdfjs\cmaps' | Select-Object -First 1
Get-ChildItem '.output\chrome-mv3\pdfjs\standard_fonts' | Select-Object -First 1
Get-ChildItem '.output\chrome-mv3\pdfjs\wasm' | Select-Object -First 1
rg -n "https?://|cdn\." '.output\chrome-mv3' -g '*.js' -g '*.mjs'
```

Expected: all three local directories contain files; the Worker bundle exists; any URL matches are existing provider/user-navigation strings, not PDF.js runtime imports or CDN script loads.

- [ ] **Step 4: Complete manual Chrome acceptance**

Load `.output/chrome-mv3` unpacked and verify this exact matrix:

1. English PDF and Chinese PDF extract text and answer in the same turn.
2. A long PDF stops at 60,000 characters and shows the truncated state.
3. A file over 20 MB shows a non-retryable error chip.
4. Scanned/blank, password-protected, corrupt, and spoofed `.pdf` files show their normalized errors.
5. Two PDFs parse concurrently while a third waits; the sidepanel remains responsive.
6. Removing a parsing PDF, starting a new chat, and switching history never resurrects a late chip.
7. Text, image, and PDF attachments coexist within the five-item total cap.
8. Dragging files highlights the composer; dragging selected text does not.
9. Parsing disables send; an error chip does not block typed text or another ready attachment.
10. Sending with only a ready PDF uses the localized attachment-only prompt.
11. Reopening history shows PDF name/page metadata but cannot reveal or resend extracted text.
12. Light/dark themes and narrow sidepanel widths preserve wrapping, readable errors, and keyboard focus.

- [ ] **Step 5: Commit documentation after verification**

```bash
git add README.md README.en.md docs/PROGRESS.md
git commit -m "docs: document local PDF attachments"
```

- [ ] **Step 6: Record final evidence**

Run: `git status --short && git log -7 --oneline`

Expected: clean worktree and one focused commit per task deliverable.
