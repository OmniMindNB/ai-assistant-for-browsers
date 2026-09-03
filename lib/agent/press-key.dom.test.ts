import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressKeyInPage, probeKeyTarget } from './form-dom';
import { resolveKeyDescriptor } from './key-dispatch';

function enterDescriptor() {
  const resolved = resolveKeyDescriptor('Enter', undefined);
  if (!resolved.ok) throw new Error('Enter 应该是合法按键');
  return resolved.descriptor;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('probeKeyTarget', () => {
  it('报告输入框所属表单的提交按钮与文本字段数', () => {
    document.body.innerHTML = `
      <form action="/search">
        <input id="q" name="q" type="search">
        <input name="tag" type="text">
        <button type="submit">搜索</button>
      </form>`;
    const output = probeKeyTarget({ selector: '#q', index: 0 });
    expect(output.found).toBe(true);
    expect(output.tag).toBe('input');
    expect(output.type).toBe('search');
    expect(output.hasFormOwner).toBe(true);
    expect(output.hasSubmitButton).toBe(true);
    expect(output.textLikeFieldCount).toBe(2);
  });

  it('没有提交按钮的单字段表单如实上报', () => {
    document.body.innerHTML = `<form action="/go"><input id="q" type="text"></form>`;
    const output = probeKeyTarget({ selector: '#q', index: 0 });
    expect(output.hasSubmitButton).toBe(false);
    expect(output.textLikeFieldCount).toBe(1);
  });

  it('表单外的输入框报告 hasFormOwner:false', () => {
    document.body.innerHTML = `<input id="loose" type="text">`;
    const output = probeKeyTarget({ selector: '#loose', index: 0 });
    expect(output.found).toBe(true);
    expect(output.hasFormOwner).toBe(false);
  });

  it('useActiveElement 时探测当前焦点元素', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    document.querySelector<HTMLInputElement>('#q')!.focus();
    const output = probeKeyTarget({ useActiveElement: true });
    expect(output.found).toBe(true);
    expect(output.hasSubmitButton).toBe(true);
  });

  it('找不到目标时返回 found:false', () => {
    const output = probeKeyTarget({ selector: '#missing', index: 0 });
    expect(output.found).toBe(false);
  });
});

describe('pressKeyInPage', () => {
  it('派发 keydown/keypress/keyup，keyCode 正确', () => {
    document.body.innerHTML = `<input id="q" type="text">`;
    const seen: { type: string; key: string; keyCode: number }[] = [];
    const input = document.querySelector<HTMLInputElement>('#q')!;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(type, (event) => {
        const e = event as KeyboardEvent;
        seen.push({ type: e.type, key: e.key, keyCode: e.keyCode });
      });
    }

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: false,
    });

    expect(output.status).toBe('ok');
    expect(seen.map((entry) => entry.type)).toEqual(['keydown', 'keypress', 'keyup']);
    expect(seen[0].key).toBe('Enter');
    expect(seen[0].keyCode).toBe(13);
  });

  it('非 Enter 按键不派发 keypress', () => {
    document.body.innerHTML = `<input id="q" type="text">`;
    const resolved = resolveKeyDescriptor('Escape', undefined);
    if (!resolved.ok) throw new Error('Escape 应该是合法按键');
    const types: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.querySelector('#q')!.addEventListener(type, (event) => types.push(event.type));
    }

    pressKeyInPage({ selector: '#q', index: 0, descriptor: resolved.descriptor, submitOnEnter: false });
    expect(types).toEqual(['keydown', 'keyup']);
  });

  it('submitOnEnter 且未被拦截时调用 requestSubmit', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const form = document.querySelector('form')!;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
    });

    expect(output.submitted).toBe(true);
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  // 页面自己 preventDefault 了 Enter，说明它要自行处理；此时再强行提交就是
  // 覆盖页面意图，会造成双重提交。
  it('keydown 被 preventDefault 时不提交', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const form = document.querySelector('form')!;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;
    document.querySelector('#q')!.addEventListener('keydown', (event) => event.preventDefault());

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
    });

    expect(output.defaultPrevented).toBe(true);
    expect(output.submitted).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('submitOnEnter 为 false 时即使能提交也不提交', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const requestSubmit = vi.fn();
    document.querySelector('form')!.requestSubmit = requestSubmit;

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: false,
    });

    expect(output.submitted).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('没有焦点也没给目标时返回 no_focus', () => {
    document.body.innerHTML = `<div>无焦点</div>`;
    const output = pressKeyInPage({
      useActiveElement: true, descriptor: enterDescriptor(), submitOnEnter: false,
    });
    expect(output.status).toBe('no_focus');
  });

  it('目标不存在时返回 not_found', () => {
    const output = pressKeyInPage({
      selector: '#missing', index: 0, descriptor: enterDescriptor(), submitOnEnter: false,
    });
    expect(output.status).toBe('not_found');
  });
});
