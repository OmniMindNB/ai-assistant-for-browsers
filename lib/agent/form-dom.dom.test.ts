import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectFormFields } from './form-dom';
import { applyFormFill, type ApplyFillItem } from './form-dom';
import { scrollContainerInPage, scrollPageInPage } from './form-dom';
import { pressKeyInPage } from './form-dom';
import { MAX_FIELD_TEXT_CHARS, sanitizeFieldText, toFieldDescriptor } from './form-schema';
import { resolveExpectOrigin } from './fill-form-request';
import type { FormFieldHandle } from './tab-form-fields';

const INPUT = { maxFields: 120, maxOptions: 50 };

function render(html: string): void {
  document.body.innerHTML = html;
}

// jsdom does not run a real layout engine, so every element's getBoundingClientRect()
// always reports a 0x0 rect regardless of its actual CSS (display/visibility/etc).
// collectFormFields treats a 0x0 rect as an early "invisible" signal to match real
// browsers, so without this stub every field in every test below would be filtered
// out as hidden. Stub a plausible non-zero rect so visibility is governed by computed
// style (as in a real browser) instead of this jsdom limitation.
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

// jsdom does not implement document.elementFromPoint at all (it's undefined, not just
// inaccurate). applyFormFill's submit branch uses it to detect whether the target is
// covered by another element; none of the tests below exercise a covered target, so
// stubbing it to always report "nothing on top" is enough (see the identical stub and
// rationale in legacy-write-tools.dom.test.ts).
(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;

// jsdom does not implement window.scrollTo (it logs "Not implemented: Window's scrollTo()
// method" and is otherwise a no-op). scrollPageInPage's window-only branches never read
// window.scrollX/scrollY back after calling it — they compute the reported position
// analytically, precisely so a real async smooth-scroll animation can't be read mid-flight
// — so the call's actual (non-)effect is irrelevant to what's under test here. Stub it to
// silence the console noise, same rationale as the elementFromPoint/getBoundingClientRect
// stubs above.
window.scrollTo = () => {};

describe('collectFormFields', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('collects inputs with their label, value and requiredness', () => {
    render(`
      <form action="/checkout" method="post" name="checkout">
        <label for="email">邮箱</label>
        <input id="email" name="email" type="email" value="a@b.c" required />
      </form>
    `);
    const output = collectFormFields(INPUT);
    const field = output.raws.find((raw) => raw.name === 'email');
    expect(field?.forLabelText).toBe('邮箱');
    expect(field?.value).toBe('a@b.c');
    expect(field?.required).toBe(true);
    expect(output.forms[0]?.action).toContain('/checkout');
    expect(output.forms[0]?.method).toBe('post');
  });

  it('reports the real checked property for checkboxes, not the attribute', () => {
    render(`<form><input type="checkbox" name="agree" /></form>`);
    (document.querySelector('input[name=agree]') as HTMLInputElement).checked = true;
    const field = collectFormFields(INPUT).raws.find((raw) => raw.name === 'agree');
    expect(field?.checked).toBe(true);
  });

  it('collects select options with their labels and selected state', () => {
    render(`
      <form>
        <select name="city">
          <option value="bj">北京</option>
          <option value="sh" selected>上海</option>
        </select>
      </form>
    `);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.name === 'city');
    expect(field?.options).toEqual([
      { value: 'bj', label: '北京', selected: false },
      { value: 'sh', label: '上海', selected: true },
    ]);
  });

  it('pierces open shadow roots and records a shadow step in the path', () => {
    render(`<div id="host"></div>`);
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<input name="inner" type="text" />`;
    const output = collectFormFields(INPUT);
    const field = output.raws.find((raw) => raw.name === 'inner');
    expect(field).toBeDefined();
    expect(field?.path.some((step) => step.kind === 'shadow')).toBe(true);
  });

  it('counts closed shadow roots and iframes as unreachable instead of ignoring them', () => {
    render(`<my-widget id="host"></my-widget><iframe src="about:blank"></iframe>`);
    document.getElementById('host')!.attachShadow({ mode: 'closed' });
    const output = collectFormFields(INPUT);
    expect(output.unreachable.iframes).toBe(1);
    expect(output.unreachable.closedShadowRoots).toBe(1);
  });

  it('does not mutate the page while accounting for shadow roots', () => {
    render(`<my-widget id="host"><span>可见内容</span></my-widget>`);
    collectFormFields(INPUT);
    expect(document.getElementById('host')!.shadowRoot).toBeNull();
    expect(document.getElementById('host')!.textContent).toContain('可见内容');
  });

  it('separates fields that belong to no form', () => {
    render(`<form><input name="inside" /></form><input name="outside" />`);
    const output = collectFormFields(INPUT);
    expect(output.raws.find((raw) => raw.name === 'inside')?.formIndex).toBe(0);
    expect(output.raws.find((raw) => raw.name === 'outside')?.formIndex).toBeUndefined();
  });

  it('marks a button with no explicit type as a submit role', () => {
    render(`<form><button>发送</button><button type="button">取消</button></form>`);
    const roles = collectFormFields(INPUT).raws.filter((raw) => raw.tag === 'button').map((raw) => raw.buttonRole);
    expect(roles).toEqual(['submit', 'button']);
  });

  it('truncates at maxFields and flags it', () => {
    render(`<form>${'<input name="x" />'.repeat(5)}</form>`);
    const output = collectFormFields({ ...INPUT, maxFields: 3 });
    expect(output.raws).toHaveLength(3);
    expect(output.truncated).toBe(true);
  });

  it('reserves headroom for real form fields on a link-heavy page', () => {
    const links = '<a href="/l">link</a>'.repeat(50);
    render(`<nav>${links}</nav><form>${'<input name="x" />'.repeat(5)}</form>`);
    const output = collectFormFields({ ...INPUT, maxFields: 10 });
    const inputCount = output.raws.filter((raw) => raw.tag === 'input').length;
    expect(inputCount).toBe(5); // all 5 real form fields survive despite 50 links appearing first in document order
    expect(output.truncated).toBe(true); // most of the 50 links got dropped by the generic quota
  });

  it('skips hidden fields unless includeHidden is set', () => {
    render(`<form><input name="visible" /><input name="secret" type="hidden" /></form>`);
    expect(collectFormFields(INPUT).raws.some((raw) => raw.name === 'secret')).toBe(false);
    expect(collectFormFields({ ...INPUT, includeHidden: true }).raws.some((raw) => raw.name === 'secret')).toBe(true);
  });

  it('scopes collection to a selector when given', () => {
    render(`<form id="a"><input name="in-a" /></form><form id="b"><input name="in-b" /></form>`);
    const output = collectFormFields({ ...INPUT, selector: '#b' });
    expect(output.raws.map((raw) => raw.name)).toEqual(['in-b']);
  });

  it('collects a navigation link outside any form', () => {
    render(`<nav><a href="/settings">设置</a></nav>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'a');
    expect(field?.href).toBe('/settings');
    expect(field?.elementText).toBe('设置');
  });

  it('does not collect an anchor without an href', () => {
    render(`<a name="top">回到顶部锚点</a>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'a');
    expect(field).toBeUndefined();
  });

  it('collects a role="button" div as a generic interactive element', () => {
    render(`<div role="button" tabindex="0">展开菜单</div>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'div');
    expect(field?.interactive).toBe(true);
    expect(field?.elementText).toBe('展开菜单');
  });

  it('ignores a div with tabindex="-1" (explicitly not focusable)', () => {
    render(`<div tabindex="-1">仅用于程序聚焦</div>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'div');
    expect(field).toBeUndefined();
  });

  it('collects a native button outside any form with its own text as elementText', () => {
    render(`<button>下单</button>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'button');
    expect(field?.elementText).toBe('下单');
  });

  it('does not compute precedingText/trailingText when includeText is not set', () => {
    render(`<form><p>提示文字</p><input name="email" type="text" /></form>`);
    const output = collectFormFields(INPUT);
    expect(output.raws.find((raw) => raw.name === 'email')?.precedingText).toBeUndefined();
    expect(output.trailingText).toBeUndefined();
  });

  it('interleaves preceding and trailing text by document order when includeText is set', () => {
    render(`
      <form>
        <p>欢迎回来，请登录以继续。</p>
        <input name="email" type="text" />
        <p>忘记密码？点此重置。</p>
        <button type="submit">登录</button>
        <p>登录即代表同意服务条款。</p>
      </form>
    `);
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'email')?.precedingText).toBe('欢迎回来，请登录以继续。');
    expect(output.raws.find((raw) => raw.tag === 'button')?.precedingText).toBe('忘记密码？点此重置。');
    expect(output.trailingText).toBe('登录即代表同意服务条款。');
  });

  it('excludes text inside script, style, and option tags from precedingText', () => {
    render(`
      <form>
        <style>.x { color: red; }</style>
        <script>var shouldNotLeak = 1;</script>
        <select name="city"><option value="bj">北京</option></select>
        <p>选择城市</p>
        <input name="email" type="text" />
      </form>
    `);
    const output = collectFormFields({ ...INPUT, includeText: true });
    const emailPreceding = output.raws.find((raw) => raw.name === 'email')?.precedingText;
    expect(emailPreceding).not.toContain('color: red');
    expect(emailPreceding).not.toContain('shouldNotLeak');
    expect(emailPreceding).not.toContain('北京');
    expect(emailPreceding).toContain('选择城市');
  });

  it("does not duplicate a field element's own visible text into the next field's precedingText", () => {
    render(`
      <form>
        <button type="button">展开更多</button>
        <input name="query" type="text" />
      </form>
    `);
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'query')?.precedingText).toBeUndefined();
  });

  it('caps raw precedingText at a defensive 2000 characters (product-level 300-char cap happens downstream)', () => {
    const longText = 'a'.repeat(2500);
    render(`<form><p>${longText}</p><input name="email" type="text" /></form>`);
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'email')?.precedingText?.length).toBe(2000);
  });

  it('does not truncate raw precedingText whose joined length is exactly the 2000-char safety cap (> vs >= boundary)', () => {
    const exactText = 'a'.repeat(2000);
    render(`<form><p>${exactText}</p><input name="email" type="text" /></form>`);
    const output = collectFormFields({ ...INPUT, includeText: true });
    const precedingText = output.raws.find((raw) => raw.name === 'email')?.precedingText;
    expect(precedingText?.length).toBe(2000);
    expect(precedingText).toBe(exactText);
  });

  it('the raw-to-sanitized pipeline correctly caps and truncates real DOM-derived precedingText (seam test)', () => {
    const longText = '字'.repeat(400);
    render(`<form><p>${longText}</p><input name="email" type="text" /></form>`);
    const raw = collectFormFields({ ...INPUT, includeText: true }).raws.find((r) => r.name === 'email')!;
    // 未越过 2000 字的原始安全上限，raw 层原样透传，不做任何截断。
    expect(raw.precedingText?.length).toBe(400);
    expect(raw.precedingText).toBe(longText);

    const descriptor = toFieldDescriptor(raw, 'f1');
    // 产品级 300 字符上限在这里生效：保留尾部、前缀省略号。
    expect(descriptor.precedingText?.length).toBe(MAX_FIELD_TEXT_CHARS + 1);
    expect(descriptor.precedingText?.startsWith('…')).toBe(true);
    expect(descriptor.precedingText).toBe(`…${longText.slice(-MAX_FIELD_TEXT_CHARS)}`);
    expect(sanitizeFieldText(raw.precedingText, 'tail').truncated).toBe(true);
  });

  it('excludes invisible text unless includeHidden is set', () => {
    render(`
      <form>
        <p style="display:none">隐藏提示</p>
        <input name="email" type="text" />
      </form>
    `);
    const shown = collectFormFields({ ...INPUT, includeText: true });
    expect(shown.raws.find((raw) => raw.name === 'email')?.precedingText).toBeUndefined();

    const withHidden = collectFormFields({ ...INPUT, includeText: true, includeHidden: true });
    expect(withHidden.raws.find((raw) => raw.name === 'email')?.precedingText).toBe('隐藏提示');
  });

  it('does not attribute text inside an open shadow root to any field (known limitation)', () => {
    render(`<div id="host"></div><input name="outer" type="text" />`);
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<p>内部说明</p><input name="inner" type="text" />`;
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'inner')?.precedingText).toBeUndefined();
    expect(output.trailingText).toBeUndefined();
  });

  it('does not misattribute light-DOM text to a field inside an open shadow root', () => {
    render(`<div id="host"></div><p>可见提示</p><input name="outer" type="text" />`);
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<input name="inner" type="text" />`;
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'inner')?.precedingText).toBeUndefined();
    expect(output.raws.find((raw) => raw.name === 'outer')?.precedingText).toBe('可见提示');
  });
});

describe('collectFormFields — includeScrollable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function stubScrollMetrics(
    el: Element,
    scrollHeight: number,
    clientHeight: number,
    horizontal?: { scrollWidth: number; clientWidth: number; scrollLeft?: number },
  ): void {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    if (horizontal) {
      Object.defineProperty(el, 'scrollWidth', { value: horizontal.scrollWidth, configurable: true });
      Object.defineProperty(el, 'clientWidth', { value: horizontal.clientWidth, configurable: true });
      if (horizontal.scrollLeft !== undefined) {
        Object.defineProperty(el, 'scrollLeft', { value: horizontal.scrollLeft, configurable: true, writable: true });
      }
    }
  }

  it('does not collect scrollables when includeScrollable is not set', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    expect(collectFormFields(INPUT).scrollables).toBeUndefined();
  });

  it('detects an overflow-y:auto container whose content overflows', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables).toHaveLength(1);
    expect(output.scrollables![0]).toMatchObject({ tag: 'div', scrollTop: 0, scrollHeight: 800, clientHeight: 300 });
  });

  it('does not treat overflow-y:visible as scrollable even when content overflows', () => {
    render(`<div id="panel" style="overflow-y:visible"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    expect(collectFormFields({ ...INPUT, includeScrollable: true }).scrollables).toEqual([]);
  });

  it('does not treat a non-overflowing overflow-y:auto container as scrollable', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 300, 300);
    expect(collectFormFields({ ...INPUT, includeScrollable: true }).scrollables).toEqual([]);
  });

  it('excludes body/documentElement even when a selector scope makes them iterable candidates', () => {
    render('<p>content</p>');
    document.documentElement.setAttribute('style', 'overflow-y:auto');
    document.body.setAttribute('style', 'overflow-y:auto');
    stubScrollMetrics(document.documentElement, 2000, 500);
    stubScrollMetrics(document.body, 2000, 500);
    const output = collectFormFields({ ...INPUT, includeScrollable: true, selector: 'html' });
    expect(output.scrollables!.some((s) => s.tag === 'body' || s.tag === 'html')).toBe(false);
  });

  it('discovers a scrollable container nested inside an open shadow root', () => {
    render(`<div id="host"></div>`);
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<div id="inner" style="overflow-y:auto"></div>`;
    const inner = host.shadowRoot!.querySelector('#inner')!;
    stubScrollMetrics(inner, 900, 400);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables).toHaveLength(1);
    expect(output.scrollables![0].path.some((step) => step.kind === 'shadow')).toBe(true);
  });

  it('caps the number of collected scrollable containers at 20', () => {
    render(Array.from({ length: 25 }, (_, i) => `<div id="p${i}" style="overflow-y:auto"></div>`).join(''));
    for (let i = 0; i < 25; i += 1) {
      stubScrollMetrics(document.getElementById(`p${i}`)!, 800, 300);
    }
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables).toHaveLength(20);
  });

  it('records a best-effort label from aria-label', () => {
    render(`<div id="panel" aria-label="聊天记录" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables![0].label).toBe('聊天记录');
  });

  it('also captures horizontal scroll metrics for a vertically-scrollable container', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300, { scrollWidth: 1200, clientWidth: 400, scrollLeft: 50 });
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables![0]).toMatchObject({ scrollWidth: 1200, clientWidth: 400, scrollLeft: 50 });
  });

  it('defaults horizontal scroll metrics to 0 when the container has no horizontal overflow', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables![0]).toMatchObject({ scrollWidth: 0, clientWidth: 0, scrollLeft: 0 });
  });
});

// jsdom's selector engine (@asamuzakjp/dom-selector, as used by jsdom 30) fails to
// resolve `:scope` when the query root is a ShadowRoot: `shadowRoot.querySelectorAll(
// ':scope > x')` and even `shadowRoot.querySelectorAll(':scope x')` always return an
// empty list, even though the shadow root genuinely has a matching direct child
// (verified directly: `sr.children.length` is 1 while `sr.querySelectorAll(':scope > *')`
// is 0, and this reproduces with a bare DocumentFragment too — it is not specific to
// shadow DOM semantics, just this engine's `:scope` root resolution). This is a jsdom
// limitation, not a spec behavior: real browsers resolve `:scope` on a ShadowRoot to
// the shadow root itself. applyFormFill's resolve() relies on `:scope > tag` to walk
// into shadow roots, so without a fix every field behind a shadow root would spuriously
// resolve to not_found in this test environment. Patch just the `:scope > tag` shape
// resolve() actually issues, scoped to ShadowRoot, so the test exercises the real
// resolve() traversal/index logic instead of stubbing around it.
const originalShadowRootQuerySelectorAll = ShadowRoot.prototype.querySelectorAll;
ShadowRoot.prototype.querySelectorAll = function (this: ShadowRoot, selectors: string) {
  const match = /^:scope\s*>\s*(.+)$/.exec(selectors.trim());
  if (match) {
    const tag = match[1];
    return Array.from(this.children).filter((el) => el.matches(tag)) as unknown as NodeListOf<Element>;
  }
  return originalShadowRootQuerySelectorAll.call(this, selectors);
} as typeof originalShadowRootQuerySelectorAll;

// Same jsdom `:scope` root-resolution bug as above, but for Document, and narrower:
// this engine resolves a Document's `:scope` to its documentElement (<html>) rather
// than the document itself (`document.querySelectorAll(':scope > *')` returns HEAD/BODY,
// not HTML — verified directly). buildPath's walk to the real page root always ends in
// a step matching "html" against `document` (every path collectFormFields produces
// starts with an {selector:'html'} step), so `document.querySelectorAll(':scope > html')`
// spuriously returns empty even though `<html>` genuinely is `document`'s only child.
// Patch *only* that exact "html" case for Document — every other `:scope > tag` query
// on Document (notably `:scope > body`, which this file's hand-built `item()` paths
// start from, and which happens to already resolve correctly under this engine's
// documentElement-as-scope quirk) must keep going through the original, unpatched
// behavior, or the many existing hand-built-path tests below would break.
const originalDocumentQuerySelectorAll = Document.prototype.querySelectorAll;
Document.prototype.querySelectorAll = function (this: Document, selectors: string) {
  if (/^:scope\s*>\s*html$/.exec(selectors.trim())) {
    return Array.from(this.children).filter((el) => el.tagName.toLowerCase() === 'html') as unknown as NodeListOf<Element>;
  }
  return originalDocumentQuerySelectorAll.call(this, selectors);
} as typeof originalDocumentQuerySelectorAll;

function item(overrides: Partial<ApplyFillItem> = {}): ApplyFillItem {
  return {
    fieldId: 'f1',
    path: [
      { kind: 'selector', selector: 'body', index: 0 },
      { kind: 'selector', selector: 'form', index: 0 },
      { kind: 'selector', selector: 'input', index: 0 },
    ],
    expect: { tag: 'input', type: 'text', name: 'email', label: '邮箱' },
    kind: 'text',
    ...overrides,
  };
}

describe('applyFormFill', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('writes a text input and dispatches input/change so frameworks observe it', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const input = document.querySelector('input')!;
    const seen: string[] = [];
    for (const type of ['focus', 'beforeinput', 'input', 'change', 'blur']) {
      input.addEventListener(type, () => seen.push(type));
    }

    const output = await applyFormFill({ url: location.href, items: [item({ value: 'a@b.c' })] });

    expect(output.outcomes[0].status).toBe('ok');
    expect(input.value).toBe('a@b.c');
    expect(seen).toEqual(['focus', 'beforeinput', 'input', 'change', 'blur']);
  });

  it('returns not_found when the path resolves to nothing', async () => {
    document.body.innerHTML = `<form></form>`;
    const output = await applyFormFill({ url: location.href, items: [item({ value: 'x' })] });
    expect(output.outcomes[0].status).toBe('not_found');
  });

  it('returns mismatch and writes nothing when the field changed since it was read', async () => {
    document.body.innerHTML = `<form><input type="text" name="phone" /></form>`;
    const input = document.querySelector('input')!;
    const output = await applyFormFill({ url: location.href, items: [item({ value: 'x' })] });
    expect(output.outcomes[0].status).toBe('mismatch');
    expect(input.value).toBe('');
  });

  it('returns not_writable for disabled and readOnly fields', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" disabled /></form>`;
    expect((await applyFormFill({ url: location.href, items: [item({ value: 'x' })] })).outcomes[0].status).toBe('not_writable');

    document.body.innerHTML = `<form><input type="text" name="email" readonly /></form>`;
    expect((await applyFormFill({ url: location.href, items: [item({ value: 'x' })] })).outcomes[0].status).toBe('not_writable');
  });

  it('returns invalid_value when a checkbox is handed a text value', async () => {
    document.body.innerHTML = `<form><input type="checkbox" name="agree" /></form>`;
    const output = await applyFormFill({
      url: location.href,
      items: [item({ kind: 'checkbox', expect: { tag: 'input', type: 'checkbox', name: 'agree' }, value: 'yes' })],
    });
    expect(output.outcomes[0].status).toBe('invalid_value');
  });

  it('sets checkbox state through the checked property and is idempotent', async () => {
    document.body.innerHTML = `<form><input type="checkbox" name="agree" /></form>`;
    const checkbox = document.querySelector('input')!;
    const base = item({ kind: 'checkbox', expect: { tag: 'input', type: 'checkbox', name: 'agree' }, checked: true });

    expect((await applyFormFill({ url: location.href, items: [base] })).outcomes[0].status).toBe('ok');
    expect(checkbox.checked).toBe(true);
    // 再写一次 true 不能把它翻回 false
    expect((await applyFormFill({ url: location.href, items: [base] })).outcomes[0].status).toBe('ok');
    expect(checkbox.checked).toBe(true);
    // value 属性不能被动过
    expect(checkbox.getAttribute('value')).toBeNull();
  });

  it('selects an option by value and by visible label', async () => {
    document.body.innerHTML = `<form><select name="city"><option value="bj">北京</option><option value="sh">上海</option></select></form>`;
    const select = document.querySelector('select')!;
    const base = item({
      kind: 'select',
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'form', index: 0 },
        { kind: 'selector', selector: 'select', index: 0 },
      ],
      expect: { tag: 'select', name: 'city' },
    });

    expect((await applyFormFill({ url: location.href, items: [{ ...base, value: 'sh' }] })).outcomes[0].status).toBe('ok');
    expect(select.value).toBe('sh');

    expect((await applyFormFill({ url: location.href, items: [{ ...base, value: '北京' }] })).outcomes[0].status).toBe('ok');
    expect(select.value).toBe('bj');
  });

  it('refuses an unknown select value before touching the element', async () => {
    document.body.innerHTML = `<form><select name="city"><option value="bj">北京</option></select></form>`;
    const select = document.querySelector('select')!;
    const output = await applyFormFill({
      url: location.href,
      items: [
        item({
          kind: 'select',
          path: [
            { kind: 'selector', selector: 'body', index: 0 },
            { kind: 'selector', selector: 'form', index: 0 },
            { kind: 'selector', selector: 'select', index: 0 },
          ],
          expect: { tag: 'select', name: 'city' },
          value: '广州',
        }),
      ],
    });
    expect(output.outcomes[0].status).toBe('invalid_value');
    expect(select.value).toBe('bj'); // 原值没有被清空
  });

  it('reports invalid_value with the actual value when a framework reverts the write', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const input = document.querySelector('input')!;
    input.addEventListener('input', () => {
      input.value = '被组件改写';
    });
    const output = await applyFormFill({ url: location.href, items: [item({ value: 'a@b.c' })] });
    expect(output.outcomes[0].status).toBe('invalid_value');
    expect(output.outcomes[0].actualValue).toBe('被组件改写');
  });

  it('keeps filling the remaining fields when one of them fails', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /><input type="text" name="phone" /></form>`;
    const output = await applyFormFill({
      url: location.href,
      items: [
        item({ fieldId: 'f1', expect: { tag: 'input', type: 'text', name: 'nope' }, value: 'x' }),
        item({
          fieldId: 'f2',
          path: [
            { kind: 'selector', selector: 'body', index: 0 },
            { kind: 'selector', selector: 'form', index: 0 },
            { kind: 'selector', selector: 'input', index: 1 },
          ],
          expect: { tag: 'input', type: 'text', name: 'phone' },
          value: '13800000000',
        }),
      ],
    });
    expect(output.outcomes.map((outcome) => outcome.status)).toEqual(['mismatch', 'ok']);
    expect((document.querySelector('input[name=phone]') as HTMLInputElement).value).toBe('13800000000');
  });

  it('writes into an element behind an open shadow root', async () => {
    document.body.innerHTML = `<div></div>`;
    const host = document.querySelector('div')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<input type="text" name="email" />`;
    const output = await applyFormFill({
      url: location.href,
      items: [
        item({
          path: [
            { kind: 'selector', selector: 'body', index: 0 },
            { kind: 'selector', selector: 'div', index: 0 },
            { kind: 'shadow' },
            { kind: 'selector', selector: 'input', index: 0 },
          ],
          value: 'a@b.c',
        }),
      ],
    });
    expect(output.outcomes[0].status).toBe('ok');
    expect((host.shadowRoot!.querySelector('input') as HTMLInputElement).value).toBe('a@b.c');
  });

  it('reports the page as stale when the url no longer matches', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const output = await applyFormFill({ url: 'https://elsewhere.test/page', items: [item({ value: 'x' })] });
    expect(output.fieldsTableStale).toBe(true);
    expect(output.outcomes).toHaveLength(0);
  });

  it('keeps processing later items when one throws (e.g. writing a value into a file input)', async () => {
    document.body.innerHTML = `<form><input type="file" name="doc" /><input type="text" name="phone" /></form>`;
    const output = await applyFormFill({
      url: location.href,
      items: [
        item({
          fieldId: 'f1',
          kind: 'file',
          expect: { tag: 'input', type: 'file', name: 'doc' },
          value: 'C:\\fakepath\\resume.pdf',
        }),
        item({
          fieldId: 'f2',
          path: [
            { kind: 'selector', selector: 'body', index: 0 },
            { kind: 'selector', selector: 'form', index: 0 },
            { kind: 'selector', selector: 'input', index: 1 },
          ],
          expect: { tag: 'input', type: 'text', name: 'phone' },
          value: '13800000000',
        }),
      ],
    });
    expect(output.outcomes).toHaveLength(2);
    expect(output.outcomes[0].status).toBe('invalid_value');
    expect(output.outcomes[1].status).toBe('ok');
    expect((document.querySelector('input[name=phone]') as HTMLInputElement).value).toBe('13800000000');
  });

  it('fires contenteditable input events after the DOM mutation so listeners observe the new value', async () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const host = document.querySelector('div')!;
    let seenAtInput: string | null = null;
    host.addEventListener('input', () => {
      seenAtInput = host.textContent;
    });

    const output = await applyFormFill({
      url: location.href,
      items: [
        item({
          kind: 'contenteditable',
          path: [
            { kind: 'selector', selector: 'body', index: 0 },
            { kind: 'selector', selector: 'div', index: 0 },
          ],
          expect: { tag: 'div' },
          value: '新内容',
        }),
      ],
    });

    expect(output.outcomes[0].status).toBe('ok');
    expect(seenAtInput).toBe('新内容');
  });

  // Slate.js / Quill 一类编辑器把 DOM 当受控视图，直接写 textContent 会被它们无视或覆盖。
  // 竞品（alibaba/page-agent）的做法是回读校验后降级到 execCommand，这里对齐。
  function stubSwallowedContentEditable(host: HTMLElement): { read: () => string; write: (text: string) => void } {
    let stored = '';
    Object.defineProperty(host, 'textContent', {
      configurable: true,
      get: () => stored,
      set: () => {
        /* 编辑器吞掉直接写入 */
      },
    });
    return {
      read: () => stored,
      write: (text) => {
        stored = text;
      },
    };
  }

  function stubExecCommand(onInsert: (text: string) => void): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const target = document as unknown as { execCommand?: unknown };
    const original = target.execCommand;
    target.execCommand = (command: string, _ui?: boolean, argument?: string) => {
      calls.push(command);
      if (command === 'insertText') onInsert(argument ?? '');
      return true;
    };
    return { calls, restore: () => { target.execCommand = original; } };
  }

  const CONTENTEDITABLE_ITEM = {
    kind: 'contenteditable' as const,
    path: [
      { kind: 'selector' as const, selector: 'body', index: 0 },
      { kind: 'selector' as const, selector: 'div', index: 0 },
    ],
    expect: { tag: 'div' },
    value: '新内容',
  };

  it('falls back to execCommand when the editor swallows the direct contenteditable write', async () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const host = document.querySelector('div')! as HTMLElement;
    const swallowed = stubSwallowedContentEditable(host);
    const exec = stubExecCommand(swallowed.write);

    try {
      const output = await applyFormFill({ url: location.href, items: [item(CONTENTEDITABLE_ITEM)] });
      expect(exec.calls).toEqual(['delete', 'insertText']);
      expect(output.outcomes[0].status).toBe('ok');
      expect(output.outcomes[0].actualValue).toBe('新内容');
    } finally {
      exec.restore();
    }
  });

  it('does not reach for execCommand when the direct contenteditable write already landed', async () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const exec = stubExecCommand(() => {});

    try {
      const output = await applyFormFill({ url: location.href, items: [item(CONTENTEDITABLE_ITEM)] });
      expect(output.outcomes[0].status).toBe('ok');
      expect(exec.calls).toEqual([]);
    } finally {
      exec.restore();
    }
  });

  it('reports invalid_value when both the direct write and the execCommand fallback fail', async () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const host = document.querySelector('div')! as HTMLElement;
    const swallowed = stubSwallowedContentEditable(host);
    const exec = stubExecCommand(() => {
      /* 连 execCommand 也写不进去 */
    });

    try {
      const output = await applyFormFill({ url: location.href, items: [item(CONTENTEDITABLE_ITEM)] });
      expect(exec.calls).toEqual(['delete', 'insertText']);
      expect(output.outcomes[0].status).toBe('invalid_value');
      expect(swallowed.read()).toBe('');
    } finally {
      exec.restore();
    }
  });

  it('clicks a link submit target when its href still matches, and mismatches when it changed (fingerprint discriminates links)', async () => {
    render(`<nav><a href="/settings">设置</a></nav>`);
    const linkRaw = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'a')!;
    const clicks: string[] = [];
    document.querySelector('a')!.addEventListener('click', (event) => {
      event.preventDefault();
      clicks.push('clicked');
    });

    const okOutput = await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: linkRaw.path, expect: { tag: 'a', href: linkRaw.href } },
    });
    expect(okOutput.submitted?.status).toBe('ok');
    expect(clicks).toEqual(['clicked']);

    const mismatchOutput = await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: linkRaw.path, expect: { tag: 'a', href: '/different-page' } },
    });
    expect(mismatchOutput.submitted?.status).toBe('mismatch');
  });

  it('dispatches a full hover + pointer/mouse sequence for the submit target, with real PointerEvents', async () => {
    render(`<button type="submit">提交</button>`);
    const buttonRaw = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'button')!;
    const button = document.querySelector('button')!;
    const submitExpect = { tag: 'button', type: 'submit' };
    const seen: string[] = [];
    const pointerEvents: Event[] = [];
    for (const type of [
      'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
      'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
    ]) {
      button.addEventListener(type, (event) => {
        seen.push(type);
        if (type === 'pointerdown' || type === 'pointerup') pointerEvents.push(event);
      });
    }

    const output = await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: buttonRaw.path, expect: submitExpect },
    });

    expect(output.submitted?.status).toBe('ok');
    expect(seen).toEqual([
      'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
      'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
    ]);
    expect(pointerEvents).toHaveLength(2);
    for (const event of pointerEvents) {
      expect(event).toBeInstanceOf(PointerEvent);
      expect((event as PointerEvent).pointerType).toBe('mouse');
    }
  });

  it('flashes a highlight overlay on the submit target before dispatching the click', async () => {
    render(`<button type="submit">提交</button>`);
    const buttonRaw = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'button')!;
    const submitExpect = { tag: 'button', type: 'submit' };
    const before = document.body.children.length;

    await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: buttonRaw.path, expect: submitExpect },
    });

    expect(document.body.children.length).toBe(before + 1);
    const highlight = document.body.lastElementChild as HTMLElement;
    expect(highlight.style.position).toBe('fixed');
    expect(highlight.style.pointerEvents).toBe('none');
  });

  it('reports the submit target label and flags a link that opens in a new tab', async () => {
    render(`<nav><a href="#docs" target="_blank" aria-label="打开文档（新窗口）">文档</a></nav>`);
    const linkRaw = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'a')!;

    const output = await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: linkRaw.path, expect: { tag: 'a', href: '#docs' } },
    });

    expect(output.submitted?.status).toBe('ok');
    expect(output.submitted?.label).toBe('打开文档（新窗口）');
    expect(output.submitted?.opensNewTab).toBe(true);
  });

  // 与 clickElementInPage 同一条理由：视口外的 submit 按钮 rect 是超界坐标，
  // 高亮框会画到屏幕外，且遮挡检测（elementFromPoint）在视口外恒为 null 而失效。
  it('scrolls the submit target into view and measures its rect afterwards', async () => {
    render(`<button type="submit">提交</button>`);
    const buttonRaw = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'button')!;
    const button = document.querySelector('button')!;
    const offScreen = { ...NON_ZERO_RECT, top: 4000, bottom: 4020, y: 4000 } as DOMRect;
    const onScreen = { ...NON_ZERO_RECT, top: 120, bottom: 140, y: 120 } as DOMRect;
    let current = offScreen;
    const order: string[] = [];
    button.getBoundingClientRect = () => current;
    (button as unknown as { scrollIntoView: (options?: ScrollIntoViewOptions) => void }).scrollIntoView = (options) => {
      order.push(`scrollIntoView:${options?.block}`);
      current = onScreen;
    };
    button.addEventListener('pointerdown', () => order.push('pointerdown'));

    const output = await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: buttonRaw.path, expect: { tag: 'button', type: 'submit' } },
    });

    expect(output.submitted?.status).toBe('ok');
    expect(order).toEqual(['scrollIntoView:center', 'pointerdown']);
    expect((document.body.lastElementChild as HTMLElement).style.top).toBe('120px');
  });

  // 会让这个用例失败的 production 改动：子帧仍然派发 runi:cursor-move / runi:cursor-click
  // 并等 250ms——顶层的 content script 收不到这两个事件，那 250ms 是纯粹的浪费。
  it('skips the cursor animation and its wait for a child-frame submit click', async () => {
    render(`<button type="submit">提交</button>`);
    const buttonRaw = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'button')!;
    const submitExpect = { tag: 'button', type: 'submit' };
    const seen: string[] = [];
    window.addEventListener('runi:cursor-move', () => seen.push('move'));
    window.addEventListener('runi:cursor-click', () => seen.push('click'));

    const started = Date.now();
    const output = await applyFormFill({
      url: location.href,
      items: [],
      submit: { fieldId: 'f1', path: buttonRaw.path, expect: submitExpect },
      isChildFrame: true,
    });

    expect(output.submitted?.status).toBe('ok');
    expect(seen).toEqual([]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('scrollContainerInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function panel(scrollHeight: number, clientHeight: number, scrollTop = 0): HTMLElement {
    render(`<div id="panel"></div>`);
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  const PATH = [
    { kind: 'selector' as const, selector: 'body', index: 0 },
    { kind: 'selector' as const, selector: 'div', index: 0 },
  ];

  it('scrolls the container to an absolute y and reports container-relative metrics', () => {
    panel(1000, 400, 0);
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, y: 300 });
    expect(output.status).toBe('ok');
    expect(output.y).toBe(300);
    expect(output.scrolledBy).toBe(300);
    expect(output.pixelsAbove).toBe(300);
    expect(output.pixelsBelow).toBe(300); // maxScroll = 1000-400 = 600; 600-300 = 300
    expect(output.viewportHeight).toBe(400);
    expect(output.tag).toBe('div');
  });

  it('scrolls the container to an absolute x and clamps it to scroll range', () => {
    render(`<div id="panel"></div>`);
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(el, 'scrollWidth', { value: 1200, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
    el.scrollLeft = 0;
    el.scrollTop = 0;

    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, x: 500 });
    expect(output.status).toBe('ok');
    expect(output.x).toBe(500);
    expect(output.y).toBe(0);

    // Test clamping: maxScrollX = 1200 - 400 = 800; 9999 gets clamped to 800
    const clampedOutput = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, x: 9999 });
    expect(clampedOutput.x).toBe(800);
  });

  it('clamps the requested y to the container scroll range', () => {
    panel(1000, 400, 0);
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, y: 9999 });
    expect(output.y).toBe(600);
    expect(output.pixelsBelow).toBe(0);
  });

  it('returns not_found when the path resolves to nothing', () => {
    render(`<div></div>`);
    const output = scrollContainerInPage({
      url: location.href,
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'span', index: 0 },
      ],
      expect: { tag: 'span' },
    });
    expect(output.status).toBe('not_found');
  });

  it('returns mismatch when the resolved element no longer matches the expected tag', () => {
    panel(1000, 400);
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'section' } });
    expect(output.status).toBe('mismatch');
  });

  it('reports fieldsTableStale when the page has navigated since the handle was issued', () => {
    panel(1000, 400);
    const output = scrollContainerInPage({ url: 'https://elsewhere.test/', path: PATH, expect: { tag: 'div' } });
    expect(output.fieldsTableStale).toBe(true);
    expect(output.status).toBe('not_found');
  });

  it('reports a best-effort label from aria-label', () => {
    render(`<div id="panel" aria-label="聊天记录"></div>`);
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, y: 100 });
    expect(output.label).toBe('聊天记录');
  });
});

describe('scrollPageInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.scrollTo(0, 0);
  });

  it('scrolls the window to explicit x/y coordinates (unchanged from before)', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const output = scrollPageInPage({ y: 500 });
    expect(output.y).toBe(500);
    expect(output.scrolledBy).toBe(500);
    expect(output.pixelsAbove).toBe(500);
    expect(output.pixelsBelow).toBe(1700);
    expect(output.container).toBeUndefined();
  });

  it('falls back to window-only reporting when the selector target has no scrollable ancestor', () => {
    render(`<button id="target">目标</button>`);
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const target = document.getElementById('target')!;
    // 窗口分支按 rect 解析终点，不读滚动后的 window.scrollY（异步 smooth 滚动读不到最终值），
    // 所以这里要给一个非零 rect，而不是靠 scrollIntoView 的 stub 去移动 window.scrollY。
    target.getBoundingClientRect = () => ({ ...NON_ZERO_RECT, top: 1000, height: 20, bottom: 1020 } as DOMRect);
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    const output = scrollPageInPage({ selector: '#target' });
    expect(output.container).toBeUndefined();
    // finalY = clamp(startY(0) + rect.top(1000) + rect.height/2(10) - viewportHeight/2(400)) = 610
    expect(output.scrolledBy).toBe(610);
    expect(output.pixelsAbove).toBe(610);
    expect(output.pixelsBelow).toBe(1590); // maxScroll = 3000-800 = 2200; 2200-610 = 1590
  });

  it('reports the inner scrollable container that actually moved instead of the unchanged window', () => {
    render(`<div id="panel" style="overflow-y:auto"><button id="target">目标</button></div>`);
    const panel = document.getElementById('panel')!;
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
    const target = document.getElementById('target')!;
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      panel.scrollTop = 250; // 模拟真实浏览器把内层容器滚到位，窗口本身没动
    };

    const output = scrollPageInPage({ selector: '#target' });

    expect(output.container).toEqual({ tag: 'div', label: 'panel' });
    expect(output.scrolledBy).toBe(250);
    expect(output.pixelsAbove).toBe(250);
    expect(output.pixelsBelow).toBe(350); // maxScroll = 900-300 = 600; 600-250 = 350
    expect(output.viewportHeight).toBe(300);
  });

  it('walks past a non-scrollable wrapper to find the real scrollable ancestor', () => {
    render(`<div id="panel" style="overflow-y:auto"><div id="wrapper"><button id="target">目标</button></div></div>`);
    const panel = document.getElementById('panel')!;
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
    const target = document.getElementById('target')!;
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      panel.scrollTop = 100;
    };
    const output = scrollPageInPage({ selector: '#target' });
    expect(output.container?.tag).toBe('div');
    expect(output.scrolledBy).toBe(100);
  });

  it('reports zero movement with the selector echoed back when the selector matches nothing', () => {
    const output = scrollPageInPage({ selector: '#missing' });
    expect(output.scrolledBy).toBe(0);
    expect(output.container).toBeUndefined();
    expect(output.selector).toBe('#missing');
  });

  it('reports a best-effort label for the moved container from aria-label', () => {
    render(`<div id="panel" aria-label="聊天记录" style="overflow-y:auto"><button id="target">目标</button></div>`);
    const panel = document.getElementById('panel')!;
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
    const target = document.getElementById('target')!;
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      panel.scrollTop = 50;
    };
    const output = scrollPageInPage({ selector: '#target' });
    expect(output.container?.label).toBe('聊天记录');
  });
});

describe('collectFormFields cursor signal', () => {
  // jsdom 对 CSS 继承的支持不完整，getComputedStyle 未必会把祖先的 cursor 继承给后代。
  // 因此测试一律在需要"计算值为 pointer"的元素上直接写 inline style —— 这与真实浏览器里
  // 继承后的结果等价，且不依赖 jsdom 的级联实现。
  it('collects a listener-only div that has a pointer cursor', () => {
    render('<div style="cursor: pointer" class="card">下单</div>');
    const out = collectFormFields(INPUT);
    expect(out.raws).toHaveLength(1);
    expect(out.raws[0].byCursor).toBe(true);
    expect(out.raws[0].interactive).toBe(true);
    expect(toFieldDescriptor(out.raws[0], 'f1').kind).toBe('button');
  });

  it('ignores an ordinary div with the default cursor', () => {
    render('<div class="card">下单</div>');
    expect(collectFormFields(INPUT).raws).toHaveLength(0);
  });

  it('does not mark a real button as cursor-detected even when it has a pointer cursor', () => {
    render('<button style="cursor: pointer">提交</button>');
    const out = collectFormFields(INPUT);
    expect(out.raws).toHaveLength(1);
    expect(out.raws[0].byCursor).toBeUndefined();
  });

  it('never collects body or html through the cursor signal', () => {
    document.body.setAttribute('style', 'cursor: pointer');
    try {
      render('<span>仅文本</span>');
      const out = collectFormFields(INPUT);
      expect(out.raws).toHaveLength(0);
    } finally {
      document.body.removeAttribute('style');
    }
  });

  it('skips a near-fullscreen element so an overlay cannot swallow the page', () => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if ((this as HTMLElement).classList?.contains('overlay')) {
        return { ...NON_ZERO_RECT, width: window.innerWidth, height: window.innerHeight } as DOMRect;
      }
      return NON_ZERO_RECT;
    };
    try {
      render('<div class="overlay" style="cursor: pointer"><span>x</span></div>');
      expect(collectFormFields(INPUT).raws).toHaveLength(0);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('does not leak shadow content when its host is a rejected near-fullscreen element', () => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if ((this as HTMLElement).classList?.contains('overlay')) {
        return { ...NON_ZERO_RECT, width: window.innerWidth, height: window.innerHeight } as DOMRect;
      }
      return NON_ZERO_RECT;
    };
    try {
      render('<div class="overlay" style="cursor: pointer"></div>');
      const host = document.querySelector('.overlay')!;
      host.attachShadow({ mode: 'open' }).innerHTML = '<span style="cursor: pointer">仅文本</span>';
      const out = collectFormFields(INPUT);
      expect(out.raws).toHaveLength(0);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('does not let a near-fullscreen semantically-detected element suppress cursor descendants', () => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if ((this as HTMLElement).classList?.contains('overlay')) {
        return { ...NON_ZERO_RECT, width: window.innerWidth, height: window.innerHeight } as DOMRect;
      }
      return NON_ZERO_RECT;
    };
    try {
      render('<div class="overlay" role="button"><span style="cursor: pointer">下单</span></div>');
      const out = collectFormFields(INPUT);
      expect(out.raws).toHaveLength(2);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('gives one handle to a clickable card, not one per descendant', () => {
    // cursor 是继承属性：真实浏览器里卡片内的每个后代计算值都是 pointer。
    // 这里在后代上也显式写出，模拟继承后的结果（见本 describe 顶部注释）。
    render(
      '<div style="cursor: pointer" class="card">' +
        '<span style="cursor: pointer">商品名</span>' +
        '<span style="cursor: pointer">￥99</span>' +
        '</div>',
    );
    const out = collectFormFields(INPUT);
    expect(out.raws).toHaveLength(1);
    expect(out.raws[0].tag).toBe('div');
  });

  it('still collects a real button nested inside a clickable card', () => {
    render(
      '<div style="cursor: pointer" class="card">' +
        '<span style="cursor: pointer">商品名</span>' +
        '<button style="cursor: pointer">加入购物车</button>' +
        '</div>',
    );
    const tags = collectFormFields(INPUT).raws.map((field) => field.tag);
    expect(tags).toEqual(['div', 'button']);
  });

  it('does not suppress a cursor element whose collected ancestor is unrelated', () => {
    render(
      '<button>提交</button>' + '<div style="cursor: pointer">卡片</div>',
    );
    expect(collectFormFields(INPUT).raws).toHaveLength(2);
  });
});

describe('collectFormFields root container exclusion', () => {
  // React (and similar frameworks) attach delegated event listeners at the app mount
  // point, which can make it look interactive (an explicit tabindex for focus trapping,
  // or occasionally a role) even though it is never a real click target itself — only
  // its descendants are. permissions.ts already denies "#root"/"#app" as selector
  // fallback targets for browser_click/browser_modify_dom, but that catches it only
  // after it has already taken a raws slot and the model has already decided to act on
  // it. Excluding it at collection time (here) is strictly earlier.
  it('never collects a #root container even when it carries an interactive role/tabindex', () => {
    render('<div id="root" role="button" tabindex="0"><span>内容</span></div>');
    expect(collectFormFields(INPUT).raws).toHaveLength(0);
  });

  it('never collects a #root container via the cursor signal either', () => {
    // jsdom 的 cursor 继承并不总生效（同文件顶部"collectFormFields cursor signal"
    // describe 已注明这一限制），这里只断言 #root 本身不入选——不断言它内部
    // 是否独立继承到 cursor:pointer，那是另一回事，不是本测试要覆盖的行为。
    render('<div id="root" style="cursor: pointer"><span>内容</span></div>');
    expect(collectFormFields(INPUT).raws.some((raw) => raw.id === 'root')).toBe(false);
  });

  it('excludes #app the same way as #root', () => {
    render('<div id="app" role="button" tabindex="0"><span>内容</span></div>');
    expect(collectFormFields(INPUT).raws).toHaveLength(0);
  });

  it('still collects real interactive descendants inside a #root container', () => {
    render('<div id="root"><button>点击</button></div>');
    const out = collectFormFields(INPUT);
    expect(out.raws.map((raw) => raw.tag)).toEqual(['button']);
  });

  it('does not exclude an unrelated div that merely has an id containing "root"', () => {
    render('<div id="root-panel" role="button" tabindex="0">内容</div>');
    expect(collectFormFields(INPUT).raws).toHaveLength(1);
  });
});

describe('collectFormFields scope', () => {
  // 会让这个用例失败的 production 改动：子帧也走通用可交互元素采集分支——
  // 那样广告 iframe 里的几十个链接会把真正的目标字段挤出截断线。
  it('collects only writable fields and submits in child scope', () => {
    render(`
      <form>
        <input name="card" type="text" />
        <button type="submit">支付</button>
      </form>
      <a href="https://ad.example.com">广告链接</a>
      <div role="button" tabindex="0">自定义按钮</div>
    `);

    const child = collectFormFields({ ...INPUT, scope: 'child' });
    const main = collectFormFields({ ...INPUT, scope: 'main' });

    expect(child.raws.map((item) => item.tag)).toEqual(['input', 'button']);
    expect(main.raws.some((item) => item.tag === 'a')).toBe(true);
  });

  // 会让这个用例失败的 production 改动：不上报 origin——
  // 那样写入前的 frameId 复用比对（Task 4）就没有可比的东西。
  it('reports the document origin', () => {
    render('<input name="q" />');
    expect(collectFormFields({ ...INPUT }).origin).toBe(location.origin);
  });
});

// 逐字段扫光：fill_form 一次可能改十几个字段，值瞬间全部出现的话，用户看不出到底动了哪几个。
describe('applyFormFill 逐字段扫光', () => {
  const listeners: Array<() => void> = [];

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    while (listeners.length) listeners.pop()!();
  });

  function watchCursorMoves(): Array<{ x: number; y: number }> {
    const seen: Array<{ x: number; y: number }> = [];
    const handler = (e: Event) => seen.push((e as CustomEvent<{ x: number; y: number }>).detail);
    window.addEventListener('runi:cursor-move', handler);
    listeners.push(() => window.removeEventListener('runi:cursor-move', handler));
    return seen;
  }

  function stubRect(el: Element, rect: Partial<DOMRect>): void {
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, ...rect, toJSON: () => ({}) }) as DOMRect;
  }

  it('写入前把光标移到字段中心，并在页面上画出高亮框', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const input = document.querySelector('input')!;
    stubRect(input, { left: 100, top: 40, width: 60, height: 20, right: 160, bottom: 60 });
    const seen = watchCursorMoves();

    const output = await applyFormFill({ url: location.href, items: [item({ value: 'a@b.c' })] });

    expect(output.outcomes[0].status).toBe('ok');
    expect(seen).toEqual([{ x: 130, y: 50 }]);

    const highlight = document.body.lastElementChild as HTMLElement;
    expect(highlight.tagName).toBe('DIV');
    expect(highlight.style.position).toBe('fixed');
    expect(highlight.style.left).toBe('100px');
    expect(highlight.style.top).toBe('40px');
    // 高亮不拦截输入：与执行期遮罩同一条硬约束，用户随时可以接管。
    expect(highlight.style.pointerEvents).toBe('none');
  });

  it('没有可见布局盒的字段不画高亮，也不为它停顿', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    // 本文件顶部把 Element.prototype.getBoundingClientRect 统一 stub 成非零盒，
    // 这里显式覆盖回 0×0，才是真正的"不可见字段"这一情形（display:none、尚未展开的折叠区）。
    stubRect(document.querySelector('input')!, {});
    const seen = watchCursorMoves();

    const output = await applyFormFill({ url: location.href, items: [item({ value: 'a@b.c' })] });

    expect(output.outcomes[0].status).toBe('ok');
    expect(seen).toHaveLength(0);
    expect(document.body.querySelectorAll('div')).toHaveLength(0);
  });

  it('压根没写成的字段不扫光', async () => {
    document.body.innerHTML = `<form><input type="text" name="phone" /></form>`;
    const input = document.querySelector('input')!;
    stubRect(input, { left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30 });
    const seen = watchCursorMoves();

    const output = await applyFormFill({ url: location.href, items: [item({ value: 'x' })] });

    expect(output.outcomes[0].status).toBe('mismatch');
    expect(seen).toHaveLength(0);
    expect(document.body.querySelectorAll('div')).toHaveLength(0);
  });

  it('多字段依次点亮，每个字段一次光标移动', async () => {
    document.body.innerHTML = `<form><input type="text" name="email" /><input type="text" name="city" /></form>`;
    const [first, second] = Array.from(document.querySelectorAll('input'));
    stubRect(first, { left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20 });
    stubRect(second, { left: 0, top: 100, width: 40, height: 20, right: 40, bottom: 120 });
    const seen = watchCursorMoves();

    const output = await applyFormFill({
      url: location.href,
      items: [
        item({ fieldId: 'f1', value: 'a@b.c' }),
        item({
          fieldId: 'f2',
          value: '北京',
          path: [
            { kind: 'selector', selector: 'body', index: 0 },
            { kind: 'selector', selector: 'form', index: 0 },
            { kind: 'selector', selector: 'input', index: 1 },
          ],
          expect: { tag: 'input', type: 'text', name: 'city', label: '城市' },
        }),
      ],
    });

    expect(output.outcomes.map((o) => o.status)).toEqual(['ok', 'ok']);
    expect(seen).toEqual([{ x: 20, y: 10 }, { x: 20, y: 110 }]);
    // 两个高亮框同时在场：后一个亮起时前一个还没淡出，用户才能看到完整的一组改动。
    expect(document.body.querySelectorAll('div')).toHaveLength(2);
  });
});

describe('applyFormFill origin guard', () => {
  // 会让这个用例失败的 production 改动：删掉 expectOrigin 比对分支——
  // 那样 frameId 被 Chrome 复用给另一个帧时，这次写入会落到完全无关的页面上。
  it('refuses to write when the frame origin no longer matches the handle', async () => {
    render('<input name="card" value="" />');
    const items: ApplyFillItem[] = [
      {
        fieldId: 'f1',
        value: '4111111111111111',
        path: [{ kind: 'selector', selector: 'input', index: 0 }],
        expect: { tag: 'input', type: 'text', name: 'card' },
        kind: 'text',
      },
    ];

    const result = await applyFormFill({ items, expectOrigin: 'https://not-this-origin.example.com', url: '' });

    expect(result.fieldsTableStale).toBe(true);
    expect(result.outcomes[0].status).toBe('mismatch');
    expect(document.querySelector('input')!.value).toBe('');
  });

  // 会让这个用例失败的 production 改动：把 expectOrigin 的比对条件从「不等于当前
  // origin」误改成「存在就拒绝」之类的过度收紧——那样任何带 expectOrigin 的子帧写入
  // 都会被无差别挡下，即便 origin 明明匹配（这正是本轮修的 Critical #1：子帧写入
  // 曾经因为另一条 url 检查而恒报 stale，永远无法真正落地）。
  it('writes through when the frame origin matches the handle', async () => {
    render('<input type="text" name="card" value="" />');
    const items: ApplyFillItem[] = [
      {
        fieldId: 'f1',
        value: '4111111111111111',
        path: [
          { kind: 'selector', selector: 'body', index: 0 },
          { kind: 'selector', selector: 'input', index: 0 },
        ],
        expect: { tag: 'input', type: 'text', name: 'card' },
        kind: 'text',
      },
    ];

    const result = await applyFormFill({ items, expectOrigin: location.origin, url: '' });

    expect(result.fieldsTableStale).toBeUndefined();
    expect(result.outcomes[0].status).toBe('ok');
    expect(document.querySelector('input')!.value).toBe('4111111111111111');
  });

  // 会让这个用例失败的 production 改动：把 `expectOrigin === 'null'` 的特判删掉，
  // 只留 `!== location.origin` 比对——两个不同的不透明帧（sandboxed iframe 缺
  // allow-same-origin、data:/about:blank）的 location.origin 都是字面字符串 "null"，
  // "null" !== "null" 为 false，会被误判成同一帧，frameId 复用到另一个不透明帧时
  // 这道锁就形同虚设。测试环境的 location.origin 不是字符串 "null"（不需要伪造成
  // 那样），所以这条用例已经足以证明「等于 'null' 就必拒」是一条独立生效的规则，
  // 不依赖当前帧本身也恰好是不透明的。
  it('treats a "null" (opaque) expectOrigin as always stale, never a match', async () => {
    render('<input name="card" value="" />');
    const items: ApplyFillItem[] = [
      {
        fieldId: 'f1',
        value: '4111111111111111',
        path: [{ kind: 'selector', selector: 'input', index: 0 }],
        expect: { tag: 'input', type: 'text', name: 'card' },
        kind: 'text',
      },
    ];

    const result = await applyFormFill({ items, expectOrigin: 'null', url: '' });

    expect(result.fieldsTableStale).toBe(true);
    expect(result.outcomes[0].status).toBe('mismatch');
    expect(document.querySelector('input')!.value).toBe('');
  });

  // 会让这个用例失败的 production 改动：调用方（entrypoints/background.ts 的
  // fillForm/clickElementByFieldId/pressKey/scrollContainerByFieldId，或
  // fill-form-request.ts 的 groupItemsByFrame）不再经过 resolveExpectOrigin 的
  // frameId 真值判断，直接把主框架句柄的 handle.frameOrigin 当作 expectOrigin 转发——
  // 那样这个用例会看到 fieldsTableStale 变成 undefined、写入"误判成功"：table.url 已经
  // 跟 location.href 不一致（页面已经同源换页，比如分步 SPA 流程），但因为 expectOrigin
  // 恰好等于 location.origin，applyFormFill 里"存在 expectOrigin 就跳过 url 检查"的
  // 分支会被命中，放过这次本该被判定为 stale 的写入（2026-09-04 review 第二轮发现：
  // round 1 修 Critical #1 时引入的缺陷——expectOrigin 并非子帧写入独有，
  // mergeFrameCollections 给主框架句柄挂的 frameId 也是 0/主框架 origin 而非
  // undefined，不能被无差别当作"这是子帧调用"的信号）。
  it('reports stale for a main-frame handle whose url no longer matches, instead of wrongly succeeding via a same-origin expectOrigin', async () => {
    render('<input name="card" value="" />');
    const mainFrameHandle: FormFieldHandle = {
      path: [{ kind: 'selector', selector: 'input', index: 0 }],
      expect: { tag: 'input', type: 'text', name: 'card' },
      sensitive: false,
      kind: 'text',
      frameId: 0, // 主框架——frameId 是假值，但 frameOrigin 仍然是一个真实字符串
      frameOrigin: location.origin, // 与当前 location.origin 一致：若被误转发，会"通过"origin 比对
    };
    const items: ApplyFillItem[] = [
      {
        fieldId: 'f1',
        value: '4111111111111111',
        path: mainFrameHandle.path,
        expect: mainFrameHandle.expect,
        kind: 'text',
      },
    ];

    const result = await applyFormFill({
      items,
      url: 'https://elsewhere.test/page', // 与 location.href 不一致：整个主页面已经导航走了
      // 调用方真实的决策路径，而不是直接拿 handle.frameOrigin——这正是本轮修复所在的位置。
      expectOrigin: resolveExpectOrigin(mainFrameHandle),
    });

    expect(result.fieldsTableStale).toBe(true);
    expect(result.outcomes).toHaveLength(0);
    expect(document.querySelector('input')!.value).toBe('');
  });
});

describe('pressKeyInPage origin guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 会让这个用例失败的 production 改动：删掉 expectOrigin 比对分支——
  // 那样 frameId 被 Chrome 复用给另一个帧时，这次按键会打在完全无关的页面上。
  it('refuses to press a key when the frame origin no longer matches the handle', () => {
    render('<form><input type="text" name="q" /></form>');
    const input = document.querySelector('input')!;
    let sawKeydown = false;
    input.addEventListener('keydown', () => {
      sawKeydown = true;
    });

    const result = pressKeyInPage({
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'form', index: 0 },
        { kind: 'selector', selector: 'input', index: 0 },
      ],
      descriptor: {
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        emitsKeypress: false,
      },
      submitOnEnter: false,
      expectOrigin: 'https://not-this-origin.example.com',
    });

    expect(result.fieldsTableStale).toBe(true);
    expect(result.status).toBe('not_found');
    expect(result.defaultPrevented).toBe(false);
    expect(result.submitted).toBe(false);
    expect(sawKeydown).toBe(false);
  });

  // 会让这个用例失败的 production 改动：把 expectOrigin 比对条件从「不等于当前 origin」
  // 误改成「存在就拒绝」——那样带 expectOrigin 的子帧按键永远无法真正落地（同 Critical #1
  // 修的那类问题：子帧写入曾经因另一条检查而恒报 stale）。
  it('presses the key through when the frame origin matches the handle', () => {
    render('<form><input type="text" name="q" /></form>');
    const input = document.querySelector('input')!;
    let sawKeydown = false;
    input.addEventListener('keydown', () => {
      sawKeydown = true;
    });

    const result = pressKeyInPage({
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'form', index: 0 },
        { kind: 'selector', selector: 'input', index: 0 },
      ],
      descriptor: {
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        emitsKeypress: false,
      },
      submitOnEnter: false,
      expectOrigin: location.origin,
    });

    expect(result.fieldsTableStale).toBeUndefined();
    expect(result.status).toBe('ok');
    expect(sawKeydown).toBe(true);
  });
});

describe('scrollContainerInPage origin guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 会让这个用例失败的 production 改动：删掉 expectOrigin 比对分支——
  // 那样 frameId 被 Chrome 复用给另一个帧时，这次滚动会作用到完全无关的页面上。
  it('refuses to scroll when the frame origin no longer matches the handle', () => {
    render('<div id="panel"></div>');
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 0;

    const result = scrollContainerInPage({
      url: location.href,
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'div', index: 0 },
      ],
      expect: { tag: 'div' },
      y: 300,
      expectOrigin: 'https://not-this-origin.example.com',
    });

    expect(result.fieldsTableStale).toBe(true);
    expect(result.status).toBe('not_found');
    expect(el.scrollTop).toBe(0);
  });

  // 会让这个用例失败的 production 改动：把 expectOrigin 比对条件从「不等于当前 origin」
  // 误改成「存在就拒绝」——那样带 expectOrigin 的滚动请求永远无法真正落地。
  it('scrolls through when the frame origin matches the handle', () => {
    render('<div id="panel"></div>');
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 0;

    const result = scrollContainerInPage({
      url: location.href,
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'div', index: 0 },
      ],
      expect: { tag: 'div' },
      y: 300,
      expectOrigin: location.origin,
    });

    expect(result.fieldsTableStale).toBeUndefined();
    expect(result.status).toBe('ok');
    expect(el.scrollTop).toBe(300);
  });
});
