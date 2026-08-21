import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  extractPdfText,
  type PdfExtractionOptions,
  type PdfLoadingTaskLike,
} from './pdf-extractor';

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
    load: (data) => getDocument({ data, cMapPacked: true, ...assetUrls }) as unknown as PdfLoadingTaskLike,
  });
}
