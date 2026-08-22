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

  it('writes a text input and dispatches input/change so frameworks observe it', () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const input = document.querySelector('input')!;
    const seen: string[] = [];
    for (const type of ['focus', 'beforeinput', 'input', 'change', 'blur']) {
      input.addEventListener(type, () => seen.push(type));
    }

    const output = applyFormFill({ url: location.href, items: [item({ value: 'a@b.c' })] });

    expect(output.outcomes[0].status).toBe('ok');
    expect(input.value).toBe('a@b.c');
    expect(seen).toEqual(['focus', 'beforeinput', 'input', 'change', 'blur']);
  });

  it('returns not_found when the path resolves to nothing', () => {
    document.body.innerHTML = `<form></form>`;
    const output = applyFormFill({ url: location.href, items: [item({ value: 'x' })] });
    expect(output.outcomes[0].status).toBe('not_found');
  });

  it('returns mismatch and writes nothing when the field changed since it was read', () => {
    document.body.innerHTML = `<form><input type="text" name="phone" /></form>`;
    const input = document.querySelector('input')!;
    const output = applyFormFill({ url: location.href, items: [item({ value: 'x' })] });
    expect(output.outcomes[0].status).toBe('mismatch');
    expect(input.value).toBe('');
  });

  it('returns not_writable for disabled and readOnly fields', () => {
    document.body.innerHTML = `<form><input type="text" name="email" disabled /></form>`;
    expect(applyFormFill({ url: location.href, items: [item({ value: 'x' })] }).outcomes[0].status).toBe('not_writable');

    document.body.innerHTML = `<form><input type="text" name="email" readonly /></form>`;
    expect(applyFormFill({ url: location.href, items: [item({ value: 'x' })] }).outcomes[0].status).toBe('not_writable');
  });

  it('returns invalid_value when a checkbox is handed a text value', () => {
    document.body.innerHTML = `<form><input type="checkbox" name="agree" /></form>`;
    const output = applyFormFill({
      url: location.href,
      items: [item({ kind: 'checkbox', expect: { tag: 'input', type: 'checkbox', name: 'agree' }, value: 'yes' })],
    });
    expect(output.outcomes[0].status).toBe('invalid_value');
  });

  it('sets checkbox state through the checked property and is idempotent', () => {
    document.body.innerHTML = `<form><input type="checkbox" name="agree" /></form>`;
    const checkbox = document.querySelector('input')!;
    const base = item({ kind: 'checkbox', expect: { tag: 'input', type: 'checkbox', name: 'agree' }, checked: true });

    expect(applyFormFill({ url: location.href, items: [base] }).outcomes[0].status).toBe('ok');
    expect(checkbox.checked).toBe(true);
    // 再写一次 true 不能把它翻回 false
    expect(applyFormFill({ url: location.href, items: [base] }).outcomes[0].status).toBe('ok');
    expect(checkbox.checked).toBe(true);
    // value 属性不能被动过
    expect(checkbox.getAttribute('value')).toBeNull();
  });

  it('selects an option by value and by visible label', () => {
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

    expect(applyFormFill({ url: location.href, items: [{ ...base, value: 'sh' }] }).outcomes[0].status).toBe('ok');
    expect(select.value).toBe('sh');

    expect(applyFormFill({ url: location.href, items: [{ ...base, value: '北京' }] }).outcomes[0].status).toBe('ok');
    expect(select.value).toBe('bj');
  });

  it('refuses an unknown select value before touching the element', () => {
    document.body.innerHTML = `<form><select name="city"><option value="bj">北京</option></select></form>`;
    const select = document.querySelector('select')!;
    const output = applyFormFill({
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

  it('reports invalid_value with the actual value when a framework reverts the write', () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const input = document.querySelector('input')!;
    input.addEventListener('input', () => {
      input.value = '被组件改写';
    });
    const output = applyFormFill({ url: location.href, items: [item({ value: 'a@b.c' })] });
    expect(output.outcomes[0].status).toBe('invalid_value');
    expect(output.outcomes[0].actualValue).toBe('被组件改写');
  });

  it('keeps filling the remaining fields when one of them fails', () => {
    document.body.innerHTML = `<form><input type="text" name="email" /><input type="text" name="phone" /></form>`;
    const output = applyFormFill({
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

  it('writes into an element behind an open shadow root', () => {
    document.body.innerHTML = `<div></div>`;
    const host = document.querySelector('div')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<input type="text" name="email" />`;
    const output = applyFormFill({
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

  it('reports the page as stale when the url no longer matches', () => {
    document.body.innerHTML = `<form><input type="text" name="email" /></form>`;
    const output = applyFormFill({ url: 'https://elsewhere.test/page', items: [item({ value: 'x' })] });
    expect(output.fieldsTableStale).toBe(true);
    expect(output.outcomes).toHaveLength(0);
  });

  it('keeps processing later items when one throws (e.g. writing a value into a file input)', () => {
    document.body.innerHTML = `<form><input type="file" name="doc" /><input type="text" name="phone" /></form>`;
    const output = applyFormFill({
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

  it('fires contenteditable input events after the DOM mutation so listeners observe the new value', () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const host = document.querySelector('div')!;
    let seenAtInput: string | null = null;
    host.addEventListener('input', () => {
      seenAtInput = host.textContent;
    });

    const output = applyFormFill({
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
});
