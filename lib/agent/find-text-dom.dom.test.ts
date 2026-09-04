import { beforeEach, describe, expect, it } from 'vitest';
import { findTextInPage } from './find-text-dom';

beforeEach(() => {
  document.body.innerHTML = '';
});

function run(text: string, mode: 'contains' | 'exact' = 'contains') {
  const input = { text, mode };
  return findTextInPage(input, input);
}

describe('findTextInPage', () => {
  it('finds an element whose text contains the query', () => {
    document.body.innerHTML = '<div class="total">总计 ¥1,280.00</div>';
    const output = run('总计');
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0].tag).toBe('div');
    expect(output.matches[0].text).toBe('总计 ¥1,280.00');
  });

  it('normalizes whitespace before matching', () => {
    document.body.innerHTML = '<div>  总计   \n ¥1,280.00  </div>';
    expect(run('总计 ¥1,280.00').matches).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    document.body.innerHTML = '<span>Shipped</span>';
    expect(run('shipped').matches).toHaveLength(1);
  });

  it('exact mode does not match a superstring', () => {
    document.body.innerHTML = '<span>已发货了</span>';
    expect(run('已发货', 'exact').matches).toHaveLength(0);
    expect(run('已发货了', 'exact').matches).toHaveLength(1);
  });

  it('returns no matches when nothing contains the text', () => {
    document.body.innerHTML = '<div>hello</div>';
    expect(run('goodbye').matches).toHaveLength(0);
  });

  // 最深匹配：祖先容器不该进结果，只有真正最贴近文字的那个元素才算数。
  it('keeps only the deepest matching element, not its ancestor containers', () => {
    document.body.innerHTML = '<div id="outer"><section><span id="inner">总计</span></section></div>';
    const output = run('总计');
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0].tag).toBe('span');
  });

  it('keeps siblings independently when both match at their own level', () => {
    document.body.innerHTML = '<ul><li>总计 A</li><li>总计 B</li></ul>';
    const output = run('总计');
    expect(output.matches).toHaveLength(2);
    expect(output.matches.map((m) => m.text)).toEqual(['总计 A', '总计 B']);
  });

  it('keeps a parent match when no descendant individually matches (text split across children)', () => {
    document.body.innerHTML = '<div>总计 <span>¥1,280.00</span></div>';
    const output = run('总计 ¥1,280.00');
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0].tag).toBe('div');
  });

  it('reports visible:false for a hidden element', () => {
    document.body.innerHTML = '<div style="display:none">总计</div>';
    const output = run('总计');
    expect(output.matches[0].visible).toBe(false);
  });

  it('reports visible:true for a normal element', () => {
    document.body.innerHTML = '<div>总计</div>';
    expect(run('总计').matches[0].visible).toBe(true);
  });

  it('marks a link and a button as clickable', () => {
    document.body.innerHTML = '<a href="/x">已发货</a><button>已发货</button>';
    const output = run('已发货');
    expect(output.matches.every((m) => m.clickable)).toBe(true);
  });

  it('does not mark a plain span as clickable', () => {
    document.body.innerHTML = '<span>已发货</span>';
    expect(run('已发货').matches[0].clickable).toBe(false);
  });

  it('captures the parent element text as context', () => {
    document.body.innerHTML = '<div>订单状态：<span>已发货</span></div>';
    const output = run('已发货');
    expect(output.matches[0].context).toBe('订单状态：已发货');
  });

  it('captures type/name/href for use as an expect fingerprint', () => {
    document.body.innerHTML = '<a href="/detail/1">查看详情</a>';
    const output = run('查看详情');
    expect(output.matches[0].href).toBe('/detail/1');
  });

  it('returns a path that resolves back to the same element via :scope selectors', () => {
    document.body.innerHTML = '<div><p>x</p><p>总计</p></div>';
    const output = run('总计');
    expect(output.matches[0].path).toEqual([
      { kind: 'selector', selector: 'div', index: 0 },
      { kind: 'selector', selector: 'p', index: 1 },
    ]);
  });

  it('reports the current page url and origin', () => {
    const output = run('nothing-matches-anything-xyz');
    expect(output.url).toBe(window.location.href);
    expect(output.origin).toBe(window.location.origin);
  });
});
