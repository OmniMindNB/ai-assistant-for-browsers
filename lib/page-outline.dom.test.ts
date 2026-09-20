import { describe, expect, it } from 'vitest';
import { MAX_OUTLINE_ITEMS, MAX_OUTLINE_TITLE_CHARS, collectOutline } from './page-outline';

function docWith(html: string): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

describe('collectOutline', () => {
  it('keeps h1-h3 in document order with their level', () => {
    const doc = docWith('<h1>标题</h1><p>正文</p><h2>小节</h2><h3>子节</h3>');
    expect(collectOutline(doc)).toEqual([
      { level: 1, title: '标题' },
      { level: 2, title: '小节' },
      { level: 3, title: '子节' },
    ]);
  });

  it('ignores h4 and deeper, and drops empty headings', () => {
    const doc = docWith('<h1>保留</h1><h4>太深</h4><h2>   </h2><h2><span></span></h2>');
    expect(collectOutline(doc)).toEqual([{ level: 1, title: '保留' }]);
  });

  it('collapses whitespace inside a title', () => {
    const doc = docWith('<h2>  第 1 节\n\n  概述 </h2>');
    expect(collectOutline(doc)).toEqual([{ level: 2, title: '第 1 节 概述' }]);
  });

  // 长度截断挪到了 entrypoints/background.ts 的 extractActivePage 里、redactText 之后执行
  // （先截断会把跨界的敏感号码切成两半，脱敏规则就再也匹配不上），collectOutline 只管条数上限，
  // 标题原样透传。
  it('does not truncate a long title (that happens after redaction in background.ts)', () => {
    const doc = docWith(`<h2>${'长'.repeat(MAX_OUTLINE_TITLE_CHARS + 20)}</h2>`);
    expect(collectOutline(doc)[0].title).toBe('长'.repeat(MAX_OUTLINE_TITLE_CHARS + 20));
  });

  it('caps the list so a long table of contents cannot blow up the prompt', () => {
    const doc = docWith('<h2>节</h2>'.repeat(MAX_OUTLINE_ITEMS + 10));
    expect(collectOutline(doc)).toHaveLength(MAX_OUTLINE_ITEMS);
  });

  it('returns an empty list for a missing root', () => {
    expect(collectOutline(null)).toEqual([]);
    expect(collectOutline(undefined)).toEqual([]);
  });
});
