import { describe, expect, it } from 'vitest';
import { allocateFieldIds, fieldIdentity } from './field-id-allocation';
import type { RawFormField } from './form-schema';
import type { FormFieldTable } from './tab-form-fields';

const URL = 'https://exam.example.com/paper/1';

function raw(overrides: Partial<RawFormField> = {}): RawFormField {
  return {
    path: [{ kind: 'selector', selector: 'div', index: 0 }],
    tag: 'input',
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    contentEditable: false,
    ...overrides,
  };
}

/** 用 allocateFieldIds 的输出装一张句柄表，模拟 background 的 snapshotFields 存表。 */
function tableFrom(raws: RawFormField[], url = URL, previous?: FormFieldTable): FormFieldTable {
  const { fieldIds, identities } = allocateFieldIds(raws, previous, url);
  const fields: FormFieldTable['fields'] = {};
  fieldIds.forEach((fieldId, index) => {
    fields[fieldId] = {
      path: raws[index].path,
      expect: { tag: raws[index].tag },
      sensitive: false,
      kind: 'button',
      identity: identities[index],
    };
  });
  return { url, fields };
}

const q1a = raw({ type: 'radio', name: 'q1', value: 'A', ancestorLabelText: 'A' });
const q1b = raw({ type: 'radio', name: 'q1', value: 'B', ancestorLabelText: 'B' });
const q2a = raw({ type: 'radio', name: 'q2', value: 'A', ancestorLabelText: 'A' });
const q2b = raw({ type: 'radio', name: 'q2', value: 'B', ancestorLabelText: 'B' });

describe('allocateFieldIds', () => {
  it('首次采集按文档序发 f1..fN', () => {
    const { fieldIds } = allocateFieldIds([q1a, q1b, q2a], undefined, URL);
    expect(fieldIds).toEqual(['f1', 'f2', 'f3']);
  });

  it('页面中途插入新的可交互元素时，既有元素的 fieldId 不变', () => {
    const before = tableFrom([q1a, q1b, q2a, q2b]);
    const explain = raw({ tag: 'button', elementText: '收起解析', interactive: true });

    // 第 1 题下方插入一段解析，第 2 题的两个选项在文档序里整体后移
    const { fieldIds } = allocateFieldIds([q1a, q1b, explain, q2a, q2b], before, URL);

    expect(fieldIds[3]).toBe('f3'); // 第2题A 仍是 f3
    expect(fieldIds[4]).toBe('f4'); // 第2题B 仍是 f4
  });

  it('新出现的元素拿到一个没被占用的新 fieldId', () => {
    const before = tableFrom([q1a, q1b, q2a, q2b]);
    const explain = raw({ tag: 'button', elementText: '收起解析', interactive: true });

    const { fieldIds } = allocateFieldIds([q1a, q1b, explain, q2a, q2b], before, URL);

    expect(fieldIds[2]).toBe('f5');
    expect(new Set(fieldIds).size).toBe(5);
  });

  it('元素消失后它的 fieldId 不会被别的元素顶替', () => {
    const before = tableFrom([q1a, q1b, q2a, q2b]);

    // 第 1 题被整题移除，剩下第 2 题
    const { fieldIds } = allocateFieldIds([q2a, q2b], before, URL);

    expect(fieldIds).toEqual(['f3', 'f4']);
  });

  it('换了地址就重新编号：旧表对着的是别的页面', () => {
    const before = tableFrom([q1a, q1b, q2a, q2b]);
    const { fieldIds } = allocateFieldIds([q2a, q2b], before, 'https://exam.example.com/paper/2');
    expect(fieldIds).toEqual(['f1', 'f2']);
  });

  it('同一身份出现多次时按出现次序各自继承，不会串号', () => {
    const del = raw({ tag: 'button', elementText: '删除', interactive: true });
    const before = tableFrom([del, del, del]);
    expect(Object.keys(before.fields)).toEqual(['f1', 'f2', 'f3']);

    // 第一个「删除」被点掉了，剩下两个
    const { fieldIds } = allocateFieldIds([del, del], before, URL);
    expect(fieldIds).toEqual(['f1', 'f2']);
  });

  it('旧表没有 identity（升级前存下的）时退回文档序编号', () => {
    const legacy: FormFieldTable = {
      url: URL,
      fields: {
        f1: { path: q1a.path, expect: { tag: 'input' }, sensitive: false, kind: 'radio' },
      },
    };
    const { fieldIds } = allocateFieldIds([q1a, q1b], legacy, URL);
    expect(fieldIds).toEqual(['f1', 'f2']);
  });
});

describe('fieldIdentity', () => {
  it('同一组单选题的不同选项身份不同', () => {
    expect(fieldIdentity(q1a)).not.toBe(fieldIdentity(q1b));
  });

  it('不同题目的同名选项身份不同', () => {
    expect(fieldIdentity(q1a)).not.toBe(fieldIdentity(q2a));
  });

  it('选项被选中后标签文案变化，仍靠 name+value 认出是同一个选项', () => {
    const selected = raw({ type: 'radio', name: 'q1', value: 'A', ancestorLabelText: 'A ✓ 已选' });
    expect(fieldIdentity(selected)).toBe(fieldIdentity(q1a));
  });

  it('文本输入框的身份不含实时值，边打字边重采不会换号', () => {
    const empty = raw({ type: 'text', name: 'email', value: '' });
    const typed = raw({ type: 'text', name: 'email', value: 'a@b.c' });
    expect(fieldIdentity(typed)).toBe(fieldIdentity(empty));
  });
});
