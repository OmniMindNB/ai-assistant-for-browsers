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

  // 路径必须从真正的文档根（html）起步：applyFormFill 的 resolve() 从 document 出发，
  // 第一步只能靠 `document.querySelectorAll(':scope > html')` 命中。少了 html/body
  // 两级，t* 句柄给 browser_click 时会一律 not_found——见 find-text-click-roundtrip.dom.test.ts
  // 里那条真正跑通 resolve 的往返测试（ref: 2026-09-05 final review Critical #1/#2）。
  it('returns a root-anchored path that resolves back to the same element via :scope selectors', () => {
    document.body.innerHTML = '<div><p>x</p><p>总计</p></div>';
    const output = run('总计');
    expect(output.matches[0].path).toEqual([
      { kind: 'selector', selector: 'html', index: 0 },
      { kind: 'selector', selector: 'body', index: 0 },
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

// 2026-10-07 第五份开端口导出 #8/#9：find_text 找到了规则列表里的「6000」，但上下文只有父元素——
// 表格单元格的父元素就是这一格，模型看不出这条规则的协议和策略，只好再 read_page 一遍。
describe('findTextInPage：表格行与列表项的上下文', () => {
  it('命中在表格行里时，上下文是整行，逐格用 | 分开', () => {
    document.body.innerHTML =
      '<table><tbody><tr><td>自定义</td><td>全部IPv4地址</td><td>TCP</td><td><span>6000</span></td><td>允许</td></tr></tbody></table>';
    const [match] = run('6000').matches;
    expect(match.text).toBe('6000');
    expect(match.context).toBe('自定义 | 全部IPv4地址 | TCP | 6000 | 允许');
  });

  it('命中在列表项里时，上下文是整个列表项', () => {
    document.body.innerHTML = '<ul><li><b>A123</b><i>已发货</i></li><li><b>B456</b><i>待付款</i></li></ul>';
    const [match] = run('已发货').matches;
    expect(match.context).toBe('A123 | 已发货');
  });

  it('ARIA 表格（div role=row）同样取整行', () => {
    document.body.innerHTML =
      '<div role="table"><div role="row"><div role="cell">TCP</div><div role="cell"><span>6000</span></div></div></div>';
    expect(run('6000').matches[0].context).toBe('TCP | 6000');
  });

  it('不在行里时照旧取父元素', () => {
    document.body.innerHTML = '<div><span>总计</span> ¥1,280.00</div>';
    expect(run('总计').matches[0].context).toBe('总计 ¥1,280.00');
  });
});

// 同一份导出里「命中 3 个（可见 1 个）」：另外两个是 <script> 里的配置文字，永远不会显示在页面上。
describe('findTextInPage：不搜脚本、样式这类不显示的内容', () => {
  it('script / style / noscript / template 里的文字不算命中', () => {
    document.body.innerHTML =
      '<span>端口 3000</span><script>var cfg = { timeout: 6000 };</script><style>.a{width:6000px}</style>' +
      '<noscript>6000</noscript><template><b>6000</b></template>';
    expect(run('6000').matches).toHaveLength(0);
    expect(run('3000').matches.map((match) => match.text)).toEqual(['端口 3000']);
  });

  it('容器只因为里面有脚本才含这段文字时，容器也不算命中', () => {
    document.body.innerHTML = '<div id="app"><p>hello</p><script>var a = 6000;</script></div>';
    expect(run('6000').matches).toHaveLength(0);
  });

  it('容器自己的可见文字命中时照常返回，脚本的文字不混进命中文本', () => {
    document.body.innerHTML = '<div>开放 6000 端口<script>var a = 1;</script></div>';
    const [match] = run('6000').matches;
    expect(match.text).toBe('开放 6000 端口');
  });
});
