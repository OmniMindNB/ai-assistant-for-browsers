import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSelectionAskBubble } from './selection-ask-bubble';
import { isPdfTextSelection } from './pdf-viewer-source';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('PDF selection ask bubble', () => {
  it('quotes text across PDF pages and ignores selections outside the text layers', () => {
    document.body.innerHTML = `
      <button>Open file</button>
      <div class="pdfViewer">
        <div class="textLayer"><span>First page</span></div>
        <div class="textLayer"><span>Second page</span></div>
      </div>`;
    const root = document.querySelector('.pdfViewer')!;
    const onAsk = vi.fn();
    const attachShadow = vi.spyOn(Element.prototype, 'attachShadow');
    dispose = mountSelectionAskBubble({
      label: 'Ask Runi',
      onAsk,
      acceptsRange: (range) => isPdfTextSelection(root, range),
    });

    const outside = document.createRange();
    outside.selectNodeContents(document.querySelector('button')!);
    document.getSelection()!.addRange(outside);
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(attachShadow).not.toHaveBeenCalled();

    const selected = document.createRange();
    selected.getBoundingClientRect = () => new DOMRect(40, 100, 80, 20);
    const spans = root.querySelectorAll('span');
    selected.setStart(spans[0].firstChild!, 0);
    selected.setEnd(spans[1].firstChild!, 11);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(selected);
    const text = document.getSelection()!.toString().trim();
    document.dispatchEvent(new MouseEvent('mouseup'));

    const shadow = attachShadow.mock.results[0]?.value as ShadowRoot;
    const button = shadow.querySelector('button')!;
    expect(button.textContent).toBe('Ask Runi');
    document.getSelection()!.removeAllRanges();
    button.click();
    expect(onAsk).toHaveBeenCalledExactlyOnceWith({ text });
    expect(shadow.host.isConnected).toBe(false);
  });
});
