// browser_find_text 发放的 t* 句柄能不能真的被 browser_click 点到——把注入采集
// （findTextInPage）→ 句柄表合并（mergeFindTextHandles）→ 查表（planFieldClick）→
// 页面内解析并点击（applyFormFill 的提交分支）四段真代码串起来跑一遍。
//
// 这条缝正是 2026-09-05 final review Critical #1 漏过去的地方：三个环节各自的单元测试
// 都是绿的，但 find-text-dom.ts 的 buildPath 少产出 html/body 两级步进，而 applyFormFill
// 的 resolve() 从 document 起步，于是每一个 t* 句柄在真实点击时都解析成 not_found。
// 因此这里刻意不重写任何一段逻辑，全部调用真函数。
import { describe, expect, it } from 'vitest';
import { findTextInPage } from './find-text-dom';
import { mergeFindTextHandles } from './find-text';
import { planFieldClick } from './fill-form-request';
import { applyFormFill } from './form-dom';
import type { FormFieldPathStep } from './form-schema';

// jsdom 没有布局引擎，getBoundingClientRect 恒为 0x0，applyFormFill 的提交分支会据此
// 判定 not_clickable。理由与 form-dom.dom.test.ts 顶部那组桩完全相同，此处照搬。
const NON_ZERO_RECT: DOMRect = {
  width: 100,
  height: 20,
  top: 0,
  left: 0,
  right: 100,
  bottom: 20,
  x: 0,
  y: 0,
  toJSON() {
    return this;
  },
};
Element.prototype.getBoundingClientRect = () => NON_ZERO_RECT;

// jsdom 完全没有实现 document.elementFromPoint（是 undefined，不是不准）。提交分支用它
// 做遮挡检测，这里没有被遮挡的用例，恒返回"上面没别的东西"即可。同 form-dom.dom.test.ts。
(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;

// 与 form-dom.dom.test.ts 同一处 jsdom 缺陷的同一个补丁：这个选择器引擎把 Document 的
// :scope 解析成 documentElement 而不是 document 本身，于是 `document.querySelectorAll(
// ':scope > html')` 恒为空，尽管 <html> 确实是 document 唯一的子元素。resolve() 的第一步
// 正好是这个形状，不补就等于在测试环境里人为制造出本次要修的那个 bug。只补 "html" 这一
// 种情形，其它 `:scope > tag` 一律走原实现。
const originalDocumentQuerySelectorAll = Document.prototype.querySelectorAll;
Document.prototype.querySelectorAll = function (this: Document, selectors: string) {
  if (/^:scope\s*>\s*html$/.exec(selectors.trim())) {
    return Array.from(this.children).filter((el) => el.tagName.toLowerCase() === 'html') as unknown as NodeListOf<Element>;
  }
  return originalDocumentQuerySelectorAll.call(this, selectors);
} as typeof originalDocumentQuerySelectorAll;

/** 完整跑一遍 find_text → 句柄表 → planFieldClick，返回第 index 条命中的点击计划。 */
function findThenPlanClick(text: string, index = 0) {
  const input = { text, mode: 'contains' as const };
  const output = findTextInPage(input, input);
  const table = mergeFindTextHandles(
    undefined,
    output.url,
    output.matches.map((raw) => ({
      path: raw.path,
      tag: raw.tag,
      type: raw.type,
      name: raw.name,
      href: raw.href,
      frameId: 0,
      frameOrigin: output.origin,
    })),
  );
  return { output, table, plan: planFieldClick(`t${index + 1}`, table) };
}

describe('find_text 句柄 → browser_click 往返', () => {
  it('resolves and clicks a t* handle end to end', async () => {
    document.body.innerHTML = '<div><p>x</p><p><a href="/detail/1">查看详情</a></p></div>';
    const clicked: string[] = [];
    document.querySelector('a')!.addEventListener('click', () => clicked.push('click'));

    const { output, table, plan } = findThenPlanClick('查看详情');
    expect(output.matches).toHaveLength(1);
    expect(plan.ok).toBe(true);

    const result = await applyFormFill({ url: table.url, items: [], submit: plan.submit! });
    // not_found 就是 buildPath 少了 html/body 两级时的症状；mismatch 则说明 expect 指纹
    // （tag/type/name/href）与实际元素对不上。两条都必须不出现。
    expect(result.submitted).toMatchObject({ fieldId: 't1', status: 'ok', label: '查看详情' });
    expect(clicked).toEqual(['click']);
  });

  it('keeps the expect fingerprint honest: a changed href is reported as mismatch, not silently clicked', async () => {
    document.body.innerHTML = '<div><a href="/detail/1">查看详情</a></div>';
    const { table, plan } = findThenPlanClick('查看详情');
    // 页面在发放句柄之后换掉了这个链接：路径还能解析到元素，但指纹已经不符。
    document.querySelector('a')!.setAttribute('href', '/detail/999');

    const result = await applyFormFill({ url: table.url, items: [], submit: plan.submit! });
    expect(result.submitted).toEqual({ fieldId: 't1', status: 'mismatch' });
  });

  it('resolves a handle for a deeply nested, non-first sibling', async () => {
    document.body.innerHTML =
      '<section><ul><li><button>删除</button></li><li><button name="confirm">确认收货</button></li></ul></section>';
    const { plan, table } = findThenPlanClick('确认收货');
    expect(plan.submit!.expect).toMatchObject({ tag: 'button', name: 'confirm' });

    const result = await applyFormFill({ url: table.url, items: [], submit: plan.submit! });
    expect(result.submitted).toMatchObject({ fieldId: 't1', status: 'ok', label: '确认收货' });
  });

  // 反向钉死本次修复：把 html/body 两级去掉（即修复前 buildPath 的产物）就必然 not_found。
  it('would resolve to not_found if the path were anchored at body instead of the document root', async () => {
    document.body.innerHTML = '<div><a href="/detail/1">查看详情</a></div>';
    const { table, plan } = findThenPlanClick('查看详情');
    const bodyAnchored: FormFieldPathStep[] = plan.submit!.path.filter(
      (step) => step.kind !== 'selector' || (step.selector !== 'html' && step.selector !== 'body'),
    );

    const result = await applyFormFill({
      url: table.url,
      items: [],
      submit: { ...plan.submit!, path: bodyAnchored },
    });
    expect(result.submitted).toEqual({ fieldId: 't1', status: 'not_found' });
  });
});
