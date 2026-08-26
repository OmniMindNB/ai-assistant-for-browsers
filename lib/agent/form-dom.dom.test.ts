import { beforeEach, describe, expect, it } from 'vitest';
import { collectFormFields } from './form-dom';
import { applyFormFill, type ApplyFillItem } from './form-dom';

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
});
