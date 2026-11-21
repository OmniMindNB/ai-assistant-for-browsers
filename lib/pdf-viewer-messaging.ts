import { newMessageId, type MessageResponse, type PageContent, type PageSelection } from './messaging';

const PDF_VIEWER_READ = 'runi:pdf-viewer-read';
interface PdfReadData {
  status: { source: 'pdf' };
  document: PageContent;
  selection: PageSelection;
}
type PdfReadKind = keyof PdfReadData;
interface PdfReadRequest {
  id: string;
  type: typeof PDF_VIEWER_READ;
  kind: PdfReadKind;
  tabId: number;
}

/** Chrome 可能把阅读器放在 PDF 标签页的扩展框架里。runtime 消息能到达它，tabs 消息面向内容脚本。 */
export async function requestPdfViewer<K extends PdfReadKind>(
  tabId: number,
  kind: K,
): Promise<MessageResponse<PdfReadData[K]> | undefined> {
  const request: PdfReadRequest = { id: newMessageId(), type: PDF_VIEWER_READ, kind, tabId };
  try {
    return await browser.runtime.sendMessage(request) as MessageResponse<PdfReadData[K]> | undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Receiving end does not exist') || message.includes('message port closed')) return undefined;
    throw error;
  }
}

export function registerPdfViewerReads(
  tabId: number,
  readDocument: () => Promise<PageContent>,
  readSelection: () => PageSelection,
): void {
  const backgroundUrl = browser.runtime.getURL('/background.js');
  browser.runtime.onMessage.addListener((request: PdfReadRequest, sender, respond) => {
    if (request?.type !== PDF_VIEWER_READ || request.tabId !== tabId || sender.url !== backgroundUrl) return false;
    const { id, kind } = request;
    if (kind === 'status') {
      respond({ id, ok: true, data: { source: 'pdf' } });
      return false;
    }
    if (kind === 'selection') {
      respond({ id, ok: true, data: readSelection() });
      return false;
    }
    if (kind !== 'document') return false;
    void readDocument().then(
      (data) => respond({ id, ok: true, data }),
      (error: unknown) => respond({ id, ok: false, error: String(error) }),
    );
    return true;
  });
}
