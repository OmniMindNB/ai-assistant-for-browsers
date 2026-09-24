import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REASONING_SEGMENT_HEAD_CHARS } from '@/lib/agent/reasoning';
import { LocaleProvider } from '@/lib/i18n';
import { ReasoningBlock } from './ReasoningBlock';

type BlockProps = {
  segments: string[];
  trimmedChars?: number[];
  droppedSegments?: number;
  omittedChars?: number;
  running: boolean;
  autoExpand: boolean;
};

function renderBlock(props: BlockProps) {
  return render(
    <LocaleProvider>
      <ReasoningBlock {...props} />
    </LocaleProvider>,
  );
}

const idle = { running: false, autoExpand: false };
const thinking = { running: true, autoExpand: true };

describe('ReasoningBlock', () => {
  it('renders nothing without segments', () => {
    const { container } = renderBlock({ segments: [], ...idle });
    expect(container).toBeEmptyDOMElement();
  });

  it('is expanded with a live title while the model is thinking', () => {
    renderBlock({ segments: ['正在分析页面结构'], ...thinking });
    const toggle = screen.getByRole('button', { name: 'Thinking…' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('正在分析页面结构')).toBeVisible();
  });

  it('shows the current step number while running with several steps', () => {
    renderBlock({ segments: ['a', 'b'], droppedSegments: 3, ...thinking });
    expect(screen.getByRole('button', { name: 'Thinking · step 5' })).toBeInTheDocument();
  });

  // Review Focus #5：正文出来之后折叠，但标题仍是进行时。
  it('keeps the running title but collapses once body text appears', () => {
    renderBlock({ segments: ['a', 'b'], running: true, autoExpand: false });
    const toggle = screen.getByRole('button', { name: 'Thinking · step 2' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses once finished and counts dropped steps too', () => {
    renderBlock({ segments: ['a', 'b'], droppedSegments: 2, ...idle });
    const toggle = screen.getByRole('button', { name: 'Thought process · 4 steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a')).toBeNull();
  });

  it('uses the plain title for a single segment', () => {
    renderBlock({ segments: ['only'], ...idle });
    expect(screen.getByRole('button', { name: 'Thought process' })).toBeInTheDocument();
  });

  it('numbers steps from the dropped offset', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['第一段推理', '第二段推理'], droppedSegments: 3, omittedChars: 900, ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process · 5 steps' }));
    expect(screen.getByText('3 earlier steps omitted (about 900 characters)')).toBeVisible();
    expect(screen.getByText('Step 4')).toBeVisible();
    expect(screen.getByText('Step 5')).toBeVisible();
    expect(screen.getByText('第二段推理')).toBeVisible();
  });

  it('shows dropped steps without a char count when it is unknown', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['x'], droppedSegments: 2, ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process · 3 steps' }));
    expect(screen.getByText('2 earlier steps omitted')).toBeVisible();
  });

  it('marks the trimmed middle of a segment at the fixed head length', async () => {
    const user = userEvent.setup();
    const head = 'H'.repeat(REASONING_SEGMENT_HEAD_CHARS);
    renderBlock({ segments: [`${head}TAIL`], trimmedChars: [321], ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('… 321 characters omitted …')).toBeVisible();
    expect(screen.getByText(head)).toBeVisible();
    expect(screen.getByText('TAIL')).toBeVisible();
  });

  it('collapses automatically when the live phase ends', () => {
    const { rerender } = renderBlock({ segments: ['r'], ...thinking });
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r']} {...idle} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Thought process' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a manual collapse even while new live reasoning arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = renderBlock({ segments: ['r'], ...thinking });
    await user.click(screen.getByRole('button', { name: 'Thinking…' }));
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r more']} {...thinking} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Thinking…' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('r more')).toBeNull();
  });

  describe('auto-follow scrolling', () => {
    const scrollTops: number[] = [];
    function stubScrolling() {
      scrollTops.length = 0;
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
      vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation((value: number) => { scrollTops.push(value); });
    }
    afterEach(() => vi.restoreAllMocks());

    it('follows new reasoning to the bottom while auto-expanded', () => {
      stubScrolling();
      const { rerender } = renderBlock({ segments: ['r'], ...thinking });
      scrollTops.length = 0;
      rerender(
        <LocaleProvider>
          <ReasoningBlock segments={['r more']} {...thinking} />
        </LocaleProvider>,
      );
      expect(scrollTops).toContain(500);
    });

    // 终审 Minor 4（升级）：正文出来后用户自己展开回看，新一轮推理不能把视图拽到底部。
    it('does not yank a block the user opened after body text appeared', async () => {
      stubScrolling();
      const user = userEvent.setup();
      const reading = { running: true, autoExpand: false };
      const { rerender } = renderBlock({ segments: ['a', 'b'], ...reading });
      await user.click(screen.getByRole('button', { name: 'Thinking · step 2' }));
      scrollTops.length = 0;
      rerender(
        <LocaleProvider>
          <ReasoningBlock segments={['a', 'b', 'c']} {...reading} />
        </LocaleProvider>,
      );
      expect(scrollTops).not.toContain(500);
    });
  });

  // Review Focus #4：存量记录只有旧的字数字段。
  it('keeps the legacy char-count notice for old records', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['tail'], omittedChars: 1200, ...idle });
    await user.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('1200 earlier characters omitted')).toBeVisible();
  });
});
