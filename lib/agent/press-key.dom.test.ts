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

  it('submitOnEnter 且未被拦截时调用 requestSubmit，并带上表单的默认提交按钮', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const form = document.querySelector('form')!;
    const submitButton = form.querySelector('button')!;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
    });

    expect(output.submitted).toBe(true);
    expect(requestSubmit).toHaveBeenCalledWith(submitButton);
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

  // fieldId 路径专用的过期/结构漂移校验：与 applyFormFill 的 url 早退 + matchesExpect
  // 语义一致（ref: 最终评审 finding 4）。selector/activeElement 路径不传 url/expect，
  // 这两项检查天然 no-op，不影响上面用 selector 寻址的既有用例。
  describe('fieldId 路径的过期/结构漂移校验', () => {
    it('url 与当前页面不符时返回 not_found + fieldsTableStale，且不派发任何按键事件', () => {
      document.body.innerHTML = `<input id="q" type="text">`;
      const seen: string[] = [];
      document.querySelector('#q')!.addEventListener('keydown', () => seen.push('keydown'));

      const output = pressKeyInPage({
        selector: '#q',
        index: 0,
        url: 'https://stale.example.com/',
        descriptor: enterDescriptor(),
        submitOnEnter: false,
      });

      expect(output.status).toBe('not_found');
      expect(output.fieldsTableStale).toBe(true);
      expect(seen).toEqual([]);
    });

    it('expect 结构与实际元素不符（tag 不匹配）时返回 not_found + fieldsTableStale，且不派发按键事件', () => {
      document.body.innerHTML = `<input id="q" type="text">`;
      const seen: string[] = [];
      document.querySelector('#q')!.addEventListener('keydown', () => seen.push('keydown'));

      const output = pressKeyInPage({
        selector: '#q',
        index: 0,
        expect: { tag: 'select' },
        descriptor: enterDescriptor(),
        submitOnEnter: false,
      });

      expect(output.status).toBe('not_found');
      expect(output.fieldsTableStale).toBe(true);
      expect(seen).toEqual([]);
    });

    it('url 与 expect 都匹配时按键照常派发（不因新增校验而破坏既有行为）', () => {
      document.body.innerHTML = `<input id="q" name="q" type="text">`;
      const output = pressKeyInPage({
        selector: '#q',
        index: 0,
        url: location.href,
        expect: { tag: 'input', type: 'text', name: 'q' },
        descriptor: enterDescriptor(),
        submitOnEnter: false,
      });

      expect(output.status).toBe('ok');
      expect(output.fieldsTableStale).toBeUndefined();
    });
  });

  // requestSubmit() 必须带上表单的默认提交按钮，否则服务端收不到该按钮的 name/value 对，
  // 与真实回车、以及用户在确认卡片上批准的提交对象不符（ref: 最终评审 finding 5）。
  describe('submitOnEnter 的 requestSubmit 提交者', () => {
    it('多个提交按钮时，把第一个未禁用的按钮作为 submitter 传给 requestSubmit', () => {
      document.body.innerHTML = `
        <form action="/s">
          <input id="q" type="text">
          <button type="submit" name="action" value="save">保存</button>
          <button type="submit" name="action" value="delete">删除</button>
        </form>`;
      const form = document.querySelector('form')!;
      const saveButton = form.querySelector('button[value="save"]')!;
      const requestSubmit = vi.fn();
      form.requestSubmit = requestSubmit;

      const output = pressKeyInPage({
        selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
      });

      expect(output.submitted).toBe(true);
      expect(requestSubmit).toHaveBeenCalledWith(saveButton);
    });

    it('默认按钮被禁用时跳过它，选下一个未禁用的按钮作为 submitter', () => {
      document.body.innerHTML = `
        <form action="/s">
          <input id="q" type="text">
          <button type="submit" name="action" value="save" disabled>保存</button>
          <button type="submit" name="action" value="delete">删除</button>
        </form>`;
      const form = document.querySelector('form')!;
      const deleteButton = form.querySelector('button[value="delete"]')!;
      const requestSubmit = vi.fn();
      form.requestSubmit = requestSubmit;

      pressKeyInPage({ selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true });

      expect(requestSubmit).toHaveBeenCalledWith(deleteButton);
    });

    it('所有提交成员都被禁用（或不存在）时，不带 submitter 调用 requestSubmit', () => {
      document.body.innerHTML = `
        <form action="/s">
          <input id="q" type="text">
          <button type="submit" disabled>保存</button>
        </form>`;
      const form = document.querySelector('form')!;
      const requestSubmit = vi.fn();
      form.requestSubmit = requestSubmit;

      const output = pressKeyInPage({
        selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
      });

      expect(output.submitted).toBe(true);
      expect(requestSubmit).toHaveBeenCalledWith();
    });
  });
});
