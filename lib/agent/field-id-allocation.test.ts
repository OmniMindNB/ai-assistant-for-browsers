import { describe, expect, it } from 'vitest';
import { allocateFieldIds, composeFieldTable, fieldIdentity } from './field-id-allocation';
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
  const { fieldIds, identities, issuedThrough } = allocateFieldIds(raws, previous, url);
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
  return { url, fields, issuedThrough };
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

  it('旧表没有 identity（升级前存下的）时无从继承，但也不复用它发过的号', () => {
    const legacy: FormFieldTable = {
      url: URL,
      fields: {
        f1: { path: q1a.path, expect: { tag: 'input' }, sensitive: false, kind: 'radio' },
      },
    };
    const { fieldIds } = allocateFieldIds([q1a, q1b], legacy, URL);
    expect(fieldIds).toEqual(['f2', 'f3']);
  });

  // 号码最大的那个元素消失（弹窗关了）之后，旧算法只看表里剩下的号，下一个新元素会拿到它的号。
  it('号码最大的元素消失后，它的号也不会发给下一个新元素', () => {
    const dialogButton = raw({ tag: 'button', elementText: '确定', interactive: true });
    const withDialog = tableFrom([q1a, q1b, dialogButton]); // 确定 = f3
    const afterClose = tableFrom([q1a, q1b], URL, withDialog); // f3 不在表里了
    const toast = raw({ tag: 'button', elementText: '撤销', interactive: true });

    const { fieldIds, issuedThrough } = allocateFieldIds([q1a, q1b, toast], afterClose, URL);
    expect(fieldIds).toEqual(['f1', 'f2', 'f4']);
    expect(issuedThrough).toBe(4);
  });
});

// 2026-10-07 第三份开端口导出 #9/#12：模型用 selector 只读弹窗，读到 1 个和 0 个元素，
// 整张句柄表被这一小块覆盖——刚报给它的 f217（端口）/f220（确定）全部作废，下一次完整读取
// 又从小号重编，f107 从「设置多台实例的防火墙？」变成了端口输入框。
describe('composeFieldTable', () => {
  const handle = (label: string) => ({ path: q1a.path, expect: { tag: 'button', label }, sensitive: false, kind: 'button' as const, identity: label });
  const previous: FormFieldTable = {
    url: URL,
    documentId: 'doc-1',
    fields: { f1: handle('控制台'), f2: handle('添加规则'), s1: { path: q1a.path, expect: { tag: 'div' }, sensitive: false, kind: 'scrollable' } },
    fingerprints: ['fp-1', 'fp-2'],
    issuedThrough: 9,
  };
  const page = { url: URL, documentId: 'doc-1' };

  it('同一页面上的范围读取并入旧表：范围外的句柄、新元素基线、已发号都保留', () => {
    const table = composeFieldTable({
      previous, page, scoped: true, issuedThrough: 10,
      handles: { f10: handle('确定') }, fingerprints: ['fp-10'],
    });
    expect(Object.keys(table.fields).sort()).toEqual(['f1', 'f10', 'f2']);
    // 只读了一小块：拿它当「上一次看到的全部」，下一次完整读取会把范围外的一切都标成新元素
    expect(table.fingerprints).toEqual(['fp-1', 'fp-2']);
    expect(table.issuedThrough).toBe(10);
  });

  it('可滚动容器的 s* 是按位置发的号，不跨调用保留', () => {
    const table = composeFieldTable({ previous, page, scoped: true, issuedThrough: 9, handles: {}, fingerprints: [] });
    expect(table.fields).not.toHaveProperty('s1');
  });

  it('完整读取整表替换，但已发号只增不减', () => {
    const table = composeFieldTable({
      previous, page, scoped: false, issuedThrough: 3,
      handles: { f1: handle('控制台') }, fingerprints: ['fp-1'],
    });
    expect(Object.keys(table.fields)).toEqual(['f1']);
    expect(table.fingerprints).toEqual(['fp-1']);
    expect(table.issuedThrough).toBe(9);
  });

  it('换了页面：不合并旧表，号码从这一页重新算', () => {
    const table = composeFieldTable({
      previous, page: { url: 'https://exam.example.com/paper/2', documentId: 'doc-2' }, scoped: true, issuedThrough: 1,
      handles: { f1: handle('下一题') }, fingerprints: ['fp-x'],
    });
    expect(Object.keys(table.fields)).toEqual(['f1']);
    expect(table.fingerprints).toEqual(['fp-x']);
    expect(table.issuedThrough).toBe(1);
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
