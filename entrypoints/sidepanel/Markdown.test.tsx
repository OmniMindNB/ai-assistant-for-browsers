// entrypoints/sidepanel/Markdown.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown from './Markdown';

const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');

describe('Markdown table rendering', () => {
  it('wraps tables in a horizontally scrollable container', () => {
    const { container } = render(<Markdown content={TABLE} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.parentElement).toHaveClass('md-table-wrap');
  });

  it('keeps the table contents intact through the wrapper', () => {
    const { container } = render(<Markdown content={TABLE} />);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('does not wrap non-table content', () => {
    const { container } = render(<Markdown content={'普通段落\n\n- 一项\n- 两项'} />);
    expect(container.querySelector('.md-table-wrap')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('still renders fenced code blocks with a language class', () => {
    const { container } = render(<Markdown content={'```css\na { color: red; }\n```'} />);
    const code = container.querySelector('pre code');
    expect(code?.className).toContain('css');
  });
});

describe('Markdown link rendering', () => {
  it('opens reply links outside the extension side panel', () => {
    render(<Markdown content={'[Chrome 文档](https://developer.chrome.com/docs/extensions/)'} />);

    expect(screen.getByRole('link', { name: 'Chrome 文档' })).toHaveAttribute('target', '_blank');
  });
});

describe('Markdown math rendering', () => {
  it('renders inline and display formulas with KaTeX', () => {
    const { container } = render(<Markdown content={'质能方程 $E=mc^2$\n\n$$\n\\frac{a}{b}\n$$'} />);
    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('renders LaTeX-style \\( \\) delimiters', () => {
    const { container } = render(<Markdown content={'其中 \\(x^2\\) 为平方'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('keeps currency amounts as plain text', () => {
    const { container } = render(<Markdown content={'价格从 $5 到 $10 不等'} />);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toBe('价格从 $5 到 $10 不等');
  });
});

describe('Markdown soft line break rendering', () => {
  // 划词翻译/润色场景：选中文本常是单换行分隔的多行/多段（selection.toString()
  // 不会插入空行），CommonMark 默认把段内单换行当空格处理，不加 remark-breaks
  // 会把这些行挤成一段话，丢失原文的换行/段落结构。
  it('renders a single newline within a paragraph as a line break', () => {
    const { container } = render(<Markdown content={'第一行\n第二行\n第三行'} />);
    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.querySelectorAll('br')).toHaveLength(2);
    expect(paragraph?.textContent).toBe('第一行\n第二行\n第三行');
  });
});
