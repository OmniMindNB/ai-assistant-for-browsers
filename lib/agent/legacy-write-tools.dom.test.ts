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

  it('dispatches a full hover + pointer/mouse sequence instead of a bare click()', () => {
    document.body.innerHTML = `<button>发送</button>`;
    const button = document.querySelector('button')!;
    const seen: string[] = [];
    for (const type of [
      'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
      'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
    ]) {
      button.addEventListener(type, () => seen.push(type));
    }
    expect(clickElementInPage({ selector: 'button', index: 0 }).status).toBe('ok');
    expect(seen).toEqual([
      'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
      'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
    ]);
  });

  it('dispatches pointerdown/pointerup as real PointerEvent instances, not MouseEvent', () => {
    document.body.innerHTML = `<button>发送</button>`;
    const button = document.querySelector('button')!;
    const seenEvents: Event[] = [];
    for (const type of ['pointerdown', 'pointerup']) {
      button.addEventListener(type, (event) => seenEvents.push(event));
    }
    clickElementInPage({ selector: 'button', index: 0 });
    expect(seenEvents).toHaveLength(2);
    for (const event of seenEvents) {
      expect(event).toBeInstanceOf(PointerEvent);
      expect((event as PointerEvent).pointerType).toBe('mouse');
      expect((event as PointerEvent).isPrimary).toBe(true);
    }
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

  it('flashes a highlight overlay on the clicked element', () => {
    document.body.innerHTML = `<button>发送</button>`;
    const before = document.body.children.length;
    expect(clickElementInPage({ selector: 'button', index: 0 }).status).toBe('ok');
    expect(document.body.children.length).toBe(before + 1);
    const highlight = document.body.lastElementChild as HTMLElement;
    expect(highlight).not.toBe(document.querySelector('button'));
    expect(highlight.style.position).toBe('fixed');
  });

  it('does not flash a highlight when the click is refused', () => {
    document.body.innerHTML = `<button disabled>发送</button>`;
    const before = document.body.children.length;
    clickElementInPage({ selector: 'button', index: 0 });
    expect(document.body.children.length).toBe(before);
  });

  // 结果文案是模型判断下一步的唯一依据：只说「已点击」它无从确认点中的是不是想点的东西。
  it('reports the visible label of the element it clicked', () => {
    document.body.innerHTML = `<button>提交订单</button>`;
    expect(clickElementInPage({ selector: 'button', index: 0 }).label).toBe('提交订单');
  });

  it('prefers aria-label over the visible text when both exist', () => {
    document.body.innerHTML = `<button aria-label="提交并结算">提交</button>`;
    expect(clickElementInPage({ selector: 'button', index: 0 }).label).toBe('提交并结算');
  });

  // 点了 target="_blank" 却以为当前页会变，是多步任务里很常见的一次走偏。
  it('flags a link that opens in a new tab', () => {
    document.body.innerHTML = `<a href="https://a.com" target="_blank">文档</a>`;
    const result = clickElementInPage({ selector: 'a', index: 0 });
    expect(result.opensNewTab).toBe(true);
  });

  it('does not flag an ordinary link as opening a new tab', () => {
    // 用片段地址：jsdom 对真实路径跳转会打印 "Not implemented: navigation" 噪声。
    document.body.innerHTML = `<a href="#docs">文档</a>`;
    expect(clickElementInPage({ selector: 'a', index: 0 }).opensNewTab).toBeFalsy();
  });

  it('scrolls the target into view before dispatching the pointer sequence', () => {
    document.body.innerHTML = `<button>发送</button>`;
    const button = document.querySelector('button')!;
    const order: string[] = [];
    (button as unknown as { scrollIntoView: (options?: ScrollIntoViewOptions) => void }).scrollIntoView = (options) => {
      order.push(`scrollIntoView:${options?.block}`);
    };
    button.addEventListener('pointerdown', () => order.push('pointerdown'));

    expect(clickElementInPage({ selector: 'button', index: 0 }).status).toBe('ok');
    expect(order).toEqual(['scrollIntoView:center', 'pointerdown']);
  });

  // 视口外的元素 rect 是超界坐标：高亮框按 position:fixed + rect 绘制，用滚动前的 rect
  // 会把提示画到屏幕外，事件坐标也对不上真实位置。所以必须滚动之后重测。
  it('measures the rect after scrolling, not before', () => {
    document.body.innerHTML = `<button>发送</button>`;
    const button = document.querySelector('button')!;
    const offScreen = { ...NON_ZERO_RECT, top: 4000, bottom: 4020, y: 4000 } as DOMRect;
    const onScreen = { ...NON_ZERO_RECT, top: 120, bottom: 140, y: 120 } as DOMRect;
    let current = offScreen;
    button.getBoundingClientRect = () => current;
    (button as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      current = onScreen;
    };

    expect(clickElementInPage({ selector: 'button', index: 0 }).status).toBe('ok');
    const highlight = document.body.lastElementChild as HTMLElement;
    expect(highlight.style.top).toBe('120px');
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

  // 与 applyFormFill 的 contenteditable 分支同一条兜底：Slate.js / Quill 一类编辑器
  // 会吞掉直接写 textContent 的操作，回读不符时必须降级到 execCommand。
  it('falls back to execCommand when the editor swallows the direct contenteditable write', () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const host = document.querySelector('div')! as HTMLElement;
    let stored = '';
    Object.defineProperty(host, 'textContent', {
      configurable: true,
      get: () => stored,
      set: () => {
        /* 编辑器吞掉直接写入 */
      },
    });
    const calls: string[] = [];
    const target = document as unknown as { execCommand?: unknown };
    const original = target.execCommand;
    target.execCommand = (command: string, _ui?: boolean, argument?: string) => {
      calls.push(command);
      if (command === 'insertText') stored = argument ?? '';
      return true;
    };

    try {
      const result = typeTextInPage({ selector: 'div', index: 0, text: '内容', replace: true });
      expect(calls).toEqual(['delete', 'insertText']);
      expect(result.status).toBe('ok');
      expect(result.actualValue).toBe('内容');
    } finally {
      target.execCommand = original;
    }
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

  it('flashes a highlight overlay on the selected element', () => {
    document.body.innerHTML = `<select><option value="bj">北京</option><option value="sh">上海</option></select>`;
    const before = document.body.children.length;
    expect(selectOptionInPage({ selector: 'select', index: 0, value: 'sh' }).status).toBe('ok');
    expect(document.body.children.length).toBe(before + 1);
    const highlight = document.body.lastElementChild as HTMLElement;
    expect(highlight).not.toBe(document.querySelector('select'));
    expect(highlight.style.position).toBe('fixed');
  });
});
