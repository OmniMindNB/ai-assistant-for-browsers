import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  extractPdfText,
  type PdfExtractionOptions,
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
  return extractPdfText(file, options, {
    load: (data) => loadPdfDocument({ data }),
  });
}

export function loadPdfDocument(source: { data: Uint8Array } | { url: string }) {
  const assetUrls = buildPdfAssetUrls(browser.runtime.getURL('/'));
  return getDocument({ ...source, cMapPacked: true, ...assetUrls });
}
