import { beforeEach, describe, expect, it } from 'vitest';
import { clickElementInPage, selectOptionInPage, typeTextInPage } from './form-dom';

// jsdom 环境的三个已知能力缺口（与 form-dom.dom.test.ts 里的 getBoundingClientRect
// stub 是同一类问题）：这里补齐到刚好能让下面的行为断言跑起来，不代表真实浏览器的精确布局：
//
// 1. jsdom 不跑真实布局引擎，getBoundingClientRect() 恒为 0x0，clickElementInPage 会把它
//    当成"不可见"提前判 not_clickable，掩盖掉本该测的点击时序/disabled 逻辑。
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

// 2. jsdom 完全没有实现 document.elementFromPoint（是 undefined，不是抛 not-implemented）。
//    clickElementInPage 用它做"是否被遮挡"探测；测试里没有遮挡场景，stub 成 null 即可。
(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;

// 3. jsdom 未实现 HTMLElement.prototype.isContentEditable（读到的是 undefined）。
//    按 contenteditable 属性沿祖先链做一个够用的近似实现。
Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
  configurable: true,
  get(this: HTMLElement) {
    let node: HTMLElement | null = this;
    while (node) {
      const attr = node.getAttribute('contenteditable');
      if (attr === 'true' || attr === '') return true;
      if (attr === 'false') return false;
      node = node.parentElement;
    }
    return false;
  },
});

describe('clickElementInPage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('dispatches a full pointer/mouse sequence instead of a bare click()', () => {
    document.body.innerHTML = `<button>发送</button>`;
    const button = document.querySelector('button')!;
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type));
    }
    expect(clickElementInPage({ selector: 'button', index: 0 }).status).toBe('ok');
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('refuses to report success for a disabled button', () => {
    document.body.innerHTML = `<button disabled>发送</button>`;
    let clicked = false;
    document.querySelector('button')!.addEventListener('click', () => { clicked = true; });
    expect(clickElementInPage({ selector: 'button', index: 0 }).status).toBe('not_clickable');
    expect(clicked).toBe(false);
  });

  it('reports not_found when nothing matches', () => {
    expect(clickElementInPage({ selector: '.missing', index: 0 }).status).toBe('not_found');
  });
});

describe('typeTextInPage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('refuses to write into a password field', () => {
    document.body.innerHTML = `<input type="password" name="pw" />`;
    const result = typeTextInPage({ selector: 'input', index: 0, text: 'hunter2', replace: true });
    expect(result.status).toBe('blocked_sensitive');
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('targets the nth match when index is given', () => {
    document.body.innerHTML = `<input type="text" /><input type="text" />`;
    typeTextInPage({ selector: 'input', index: 1, text: '第二个', replace: true });
    const inputs = document.querySelectorAll('input');
    expect((inputs[0] as HTMLInputElement).value).toBe('');
    expect((inputs[1] as HTMLInputElement).value).toBe('第二个');
  });

  it('reports invalid_value instead of throwing on a contenteditable', () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const result = typeTextInPage({ selector: 'div', index: 0, text: '内容', replace: true });
    expect(['ok', 'invalid_value']).toContain(result.status);
    expect(result.status).not.toBe('error');
  });
});

describe('selectOptionInPage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reports not_writable for a non-select element instead of pretending to succeed', () => {
    document.body.innerHTML = `<div class="fake-select"></div>`;
    expect(selectOptionInPage({ selector: '.fake-select', index: 0, value: 'sh' }).status).toBe('not_writable');
  });

  it('refuses an unknown value without clearing the current one', () => {
    document.body.innerHTML = `<select><option value="bj">北京</option></select>`;
    const select = document.querySelector('select')!;
    expect(selectOptionInPage({ selector: 'select', index: 0, value: '广州' }).status).toBe('invalid_value');
    expect(select.value).toBe('bj');
  });
});
