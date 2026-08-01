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
