import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocaleProvider } from '@/lib/i18n';
import { ReasoningBlock } from './ReasoningBlock';

function renderBlock(props: { segments: string[]; omittedChars?: number; live: boolean }) {
  return render(
    <LocaleProvider>
      <ReasoningBlock {...props} />
    </LocaleProvider>,
  );
}

describe('ReasoningBlock', () => {
  // Review Focus #5：存量消息没有推理，渲染必须与今天一致。
  it('renders nothing without segments', () => {
    const { container } = renderBlock({ segments: [], live: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('is expanded with a live title while the model is thinking', () => {
    renderBlock({ segments: ['正在分析页面结构'], live: true });
    const toggle = screen.getByRole('button', { name: /Thinking/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('正在分析页面结构')).toBeVisible();
  });

  it('collapses once finished and shows the segment count', () => {
    renderBlock({ segments: ['a', 'b'], live: false });
    const toggle = screen.getByRole('button', { name: 'Thought process · 2 steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a')).toBeNull();
  });

  it('uses the plain title for a single segment', () => {
    renderBlock({ segments: ['only'], live: false });
    expect(screen.getByRole('button', { name: 'Thought process' })).toBeInTheDocument();
  });

  it('expands on click and labels each segment', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['第一段推理', '第二段推理'], live: false });
    await user.click(screen.getByRole('button', { name: 'Thought process · 2 steps' }));
    expect(screen.getByText('Step 1')).toBeVisible();
    expect(screen.getByText('Step 2')).toBeVisible();
    expect(screen.getByText('第二段推理')).toBeVisible();
  });

  it('collapses automatically when the live phase ends', () => {
    const { rerender } = renderBlock({ segments: ['r'], live: true });
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r']} live={false} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Thought process' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a manual collapse even while new live reasoning arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = renderBlock({ segments: ['r'], live: true });
    await user.click(screen.getByRole('button', { name: /Thinking/ }));
    rerender(
      <LocaleProvider>
        <ReasoningBlock segments={['r more']} live />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: /Thinking/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('r more')).toBeNull();
  });

  it('shows how many earlier characters were omitted', async () => {
    const user = userEvent.setup();
    renderBlock({ segments: ['tail'], omittedChars: 1200, live: false });
    await user.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('1200 earlier characters omitted')).toBeVisible();
  });
});
