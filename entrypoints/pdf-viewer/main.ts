import { AnnotationMode, PermissionFlag, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import './viewer.css';
import { loadPdfDocument } from '@/lib/chat/pdfjs-runtime';
import { readPdfDocumentText } from '@/lib/chat/pdf-extractor';
import { applyLocale, loadLocale, t } from '@/lib/i18n';
import type { PageContent } from '@/lib/messaging';
import { registerPdfViewerReads } from '@/lib/pdf-viewer-messaging';
import { getPdfMimeHandler, isPdfTextSelection, PDF_VIEWER_PATH, remotePdfUrl } from '@/lib/pdf-viewer-source';
import { initSelectionAskBubble } from '@/lib/selection-ask-bubble';

async function initViewer(): Promise<void> {
  applyLocale(await loadLocale().catch(() => 'auto' as const));
  const container = document.querySelector<HTMLDivElement>('#viewer-container')!;
  const pages = document.querySelector<HTMLDivElement>('#viewer')!;
  const name = document.querySelector<HTMLElement>('#file-name')!;
  const pageTools = document.querySelector<HTMLFieldSetElement>('#page-tools')!;
  const page = document.querySelector<HTMLInputElement>('#page')!;
  const count = document.querySelector<HTMLElement>('#page-count')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const openFile = document.querySelector<HTMLButtonElement>('#open-file')!;
  const picker = document.querySelector<HTMLInputElement>('#file-picker')!;
  const nativeViewer = document.querySelector<HTMLButtonElement>('#native-viewer')!;
  const zoomIn = document.querySelector<HTMLButtonElement>('#zoom-in')!;
  const zoomOut = document.querySelector<HTMLButtonElement>('#zoom-out')!;
  openFile.textContent = t('pdfViewer.openFile');
  nativeViewer.textContent = t('pdfViewer.nativeViewer');
  page.setAttribute('aria-label', t('pdfViewer.page'));
  zoomIn.setAttribute('aria-label', t('pdfViewer.zoomIn'));
  zoomOut.setAttribute('aria-label', t('pdfViewer.zoomOut'));

  const events = new EventBus();
  const viewer = new PDFViewer({
    container, viewer: pages, eventBus: events,
    annotationMode: AnnotationMode.DISABLE,
    enablePermissions: true,
    enableAutoLinking: false,
  });
  let activeDocument: {
    pdf: PDFDocumentProxy;
    title: string;
    url: string;
    copyAllowed: boolean;
    text?: ReturnType<typeof readPdfDocumentText>;
  } | undefined;
  let currentTask: PDFDocumentLoadingTask | undefined;
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let requestId = 0;
  let startPage = 1;

  void initSelectionAskBubble({
    acceptsRange: (range) => !!activeDocument?.copyAllowed && isPdfTextSelection(pages, range),
    includeContext: false,
  });

  async function readDocument(): Promise<PageContent> {
    const current = activeDocument;
    const result: PageContent = {
      source: 'pdf', lang: document.documentElement.lang,
      title: current?.title ?? document.title, url: current?.url ?? '',
      text: '', length: 0,
    };
    if (!current) return { ...result, pdfError: t('pdfViewer.noDocument') };
    if (!current.copyAllowed) return { ...result, pdfError: t('pdfViewer.copyRestricted') };

    try {
      // 多次读取超长 PDF 的正文窗口时复用同一份全文，直到打开另一份文档。
      const { text } = await (current.text ??= readPdfDocumentText(current.pdf));
      if (current !== activeDocument) return { ...result, pdfError: t('pdfViewer.documentChanged') };
      if (!text) return { ...result, pdfError: t('pdfViewer.noText') };
      return { ...result, text, length: text.length };
    } catch {
      current.text = undefined;
      return { ...result, pdfError: t(current === activeDocument ? 'pdfViewer.readFailed' : 'pdfViewer.documentChanged') };
    }
  }

  function readSelection() {
    const selection = window.getSelection();
    const text = activeDocument?.copyAllowed && selection?.rangeCount && isPdfTextSelection(pages, selection.getRangeAt(0))
      ? selection.toString().trim()
      : '';
    return { text };
  }

  function setStatus(message: string) {
    status.textContent = message;
    status.hidden = !message;
  }

  events.on('pagesinit', () => {
    const total = viewer.pagesCount;
    viewer.currentScaleValue = 'auto';
    viewer.currentPageNumber = Math.min(startPage, total);
    page.value = String(viewer.currentPageNumber);
    page.max = String(total);
    count.textContent = `/ ${total}`;
    pageTools.disabled = false;
    setStatus('');
  });
  events.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
    page.value = String(pageNumber);
  });
  page.addEventListener('change', () => {
    const value = page.valueAsNumber;
    if (Number.isInteger(value)) {
      viewer.currentPageNumber = Math.max(1, Math.min(value, viewer.pagesCount));
    }
    page.value = String(viewer.currentPageNumber);
  });
  zoomIn.addEventListener('click', () => viewer.increaseScale());
  zoomOut.addEventListener('click', () => viewer.decreaseScale());
  window.addEventListener('resize', () => {
    if (viewer.currentScaleValue === 'auto') viewer.currentScaleValue = 'auto';
  });
  openFile.addEventListener('click', () => picker.click());

  async function showPdf(
    source: () => Promise<Parameters<typeof loadPdfDocument>[0]>,
    fileName: string,
    url: string,
    initialPage = 1,
  ): Promise<boolean> {
    const id = ++requestId;
    void loadingTask?.destroy().catch(() => undefined);
    loadingTask = undefined;
    setStatus(t('pdfViewer.loading'));

    try {
      const input = await source();
      if (id !== requestId) return false;
      const task = loadPdfDocument(input);
      loadingTask = task;
      const pdf = await task.promise;
      const [permissions] = await Promise.all([pdf.getPermissions(), pdf.getPage(1)]);
      if (id !== requestId) return false;

      viewer.clearSelection();
      startPage = initialPage;
      viewer.setDocument(pdf);
      void currentTask?.destroy().catch(() => undefined);
      currentTask = task;
      loadingTask = undefined;
      activeDocument = { pdf, title: fileName, url, copyAllowed: permissions === null || permissions.includes(PermissionFlag.COPY) };
      name.textContent = fileName;
      document.title = fileName;
      return true;
    } catch {
      if (id !== requestId) return false;
      void loadingTask?.destroy().catch(() => undefined);
      loadingTask = undefined;
      setStatus(t('pdfViewer.loadFailed'));
      return false;
    }
  }

  const mime = getPdfMimeHandler();
  const stream = await mime?.getStreamInfo().catch(() => undefined);
  const tabId = stream?.tabId ?? (await browser.tabs.getCurrent())?.id;
  if (typeof tabId === 'number' && tabId >= 0) registerPdfViewerReads(tabId, readDocument, readSelection);
  if (mime && stream) {
    const useNativeViewer = () => mime.abortAndFallbackToNativeHandler().catch(() => {
      setStatus(t('pdfViewer.loadFailed'));
    });
    nativeViewer.addEventListener('click', () => { void useNativeViewer(); });
    const opened = await showPdf(async () => {
      // 流只能读取一次。完整读取后，原生阅读器可用 Chrome 缓存的响应。
      const response = await fetch(stream.streamUrl);
      if (!response.ok) throw new Error('PDF stream failed');
      const data = new Uint8Array(await response.arrayBuffer());
      nativeViewer.hidden = false;
      return { data };
    }, pdfName(stream.originalUrl), stream.originalUrl, pageFromUrl(stream.originalUrl));
    if (!opened) await useNativeViewer();
    return;
  }

  openFile.hidden = false;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file) void showPdf(
      async () => ({ data: new Uint8Array(await file.arrayBuffer()) }),
      file.name,
      browser.runtime.getURL(PDF_VIEWER_PATH),
    );
  });
  const url = remotePdfUrl(new URL(location.href).searchParams.get('file'));
  if (url) void showPdf(async () => ({ url: url.href }), pdfName(url.href), url.href, pageFromUrl(url.href));
}

function pdfName(source: string): string {
  const name = URL.parse(source)?.pathname.split('/').pop();
  try {
    return name ? decodeURIComponent(name) : 'PDF';
  } catch {
    return name ?? 'PDF';
  }
}

function pageFromUrl(source: string): number {
  const hash = URL.parse(source)?.hash.slice(1);
  const page = Number(new URLSearchParams(hash).get('page'));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

void initViewer().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>('#status')!;
  status.textContent = t('pdfViewer.loadFailed');
  status.hidden = false;
  console.error('[Runi] PDF viewer:', error);
});
