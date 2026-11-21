export const PDF_VIEWER_PATH = '/pdf-viewer.html';

interface PdfMimeHandler {
  getStreamInfo(): Promise<{ originalUrl: string; streamUrl: string; tabId: number }>;
  abortAndFallbackToNativeHandler(): Promise<void>;
}

export function getPdfMimeHandler(): PdfMimeHandler | undefined {
  return (browser as typeof browser & { mimeHandler?: PdfMimeHandler }).mimeHandler;
}

/** 旧版浏览器走显式打开流程，仅用 HTTP(S) 地址或用户亲自选择的文件。 */
export function remotePdfUrl(value?: string | null): URL | undefined {
  if (!value) return;
  const url = URL.parse(value);
  if (url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
    return url;
  }
  return undefined;
}

export function hasPdfFilePath(value?: string): boolean {
  const url = value && URL.parse(value);
  return !!url && ['file:', 'http:', 'https:'].includes(url.protocol) && /\.pdf$/i.test(url.pathname);
}

export function isPdfTextSelection(viewer: Element, range: Range): boolean {
  return [range.startContainer, range.endContainer].every((node) => {
    const element = node instanceof Element ? node : node.parentElement;
    const layer = element?.closest('.textLayer');
    return !!layer && viewer.contains(layer);
  });
}
