import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { REPLY_QUOTE_SETTLE_MS, ReplyQuoteBubble } from './ReplyQuoteBubble';

function Harness({ onQuote }: { onQuote: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <LocaleProvider>
      <div ref={ref}>
        <div data-reply-body="">
          <p data-testid="reply">The agent runs in a Docker sandbox.</p>
        </div>
        <div data-reply-body="">
          <p data-testid="reply-2">Second reply.</p>
        </div>
        <p data-testid="user">My own question.</p>
      </div>
      <ReplyQuoteBubble containerRef={ref} onQuote={onQuote} />
    </LocaleProvider>
  );
}

function select(start: Node, startOffset: number, end: Node = start, endOffset: number = startOffset) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(REPLY_QUOTE_SETTLE_MS);
  });
}

const button = () => screen.queryByRole('button', { name: en['workbench.quoteReplyButton'] });

describe('ReplyQuoteBubble', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    vi.useRealTimers();
  });

  it('offers a follow-up button for a selection inside an assistant reply and quotes it on click', () => {
    const onQuote = vi.fn();
    render(<Harness onQuote={onQuote} />);
    const text = screen.getByTestId('reply').firstChild!;

    select(text, 20, text, 34);
    fireEvent.click(button()!);

    expect(onQuote).toHaveBeenCalledWith('Docker sandbox');
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(button()).toBeNull();
  });

  it('keeps the selection when the button is pressed, so the click still sees it', () => {
    render(<Harness onQuote={vi.fn()} />);
    const text = screen.getByTestId('reply').firstChild!;
    select(text, 0, text, 9);

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button()!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('shows nothing for selections outside replies, across two replies, or collapsed', () => {
    render(<Harness onQuote={vi.fn()} />);

    select(screen.getByTestId('user').firstChild!, 0, screen.getByTestId('user').firstChild!, 6);
    expect(button()).toBeNull();

    select(screen.getByTestId('reply').firstChild!, 4, screen.getByTestId('reply-2').firstChild!, 3);
    expect(button()).toBeNull();

    select(screen.getByTestId('reply').firstChild!, 4);
    expect(button()).toBeNull();
  });

  it('hides when the selection is cleared or Escape is pressed', () => {
    render(<Harness onQuote={vi.fn()} />);
    const text = screen.getByTestId('reply').firstChild!;

    select(text, 0, text, 9);
    expect(button()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button()).toBeNull();

    select(text, 0, text, 9);
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(REPLY_QUOTE_SETTLE_MS);
    });
    expect(button()).toBeNull();
  });
});
