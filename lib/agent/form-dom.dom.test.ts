import { beforeEach, describe, expect, it } from 'vitest';
import { collectFormFields } from './form-dom';

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
