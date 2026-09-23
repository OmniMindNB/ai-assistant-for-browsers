import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import type { FormFieldTable } from './tab-form-fields';
import {
  MAX_TRAJECTORY_LABEL_CHARS,
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  type TrajectoryStep,
} from './task-trajectory';
import { appendTrajectorySteps, buildTrajectorySteps, isRecordableTool } from './trajectory-recorder';

const redaction = defaultRedactionSettings();
const PAGE = 'https://example.com/expense/new?order=123#top';

function table(fields: Record<string, { label?: string; text?: string; sensitive?: boolean }>): FormFieldTable {
  return {
    url: PAGE,
    fields: Object.fromEntries(
      Object.entries(fields).map(([id, f]) => [
        id,
        { path: [], expect: { tag: 'input', label: f.label, text: f.text }, sensitive: f.sensitive ?? false, kind: 'text' as never },
      ]),
    ),
  };
}

function build(toolName: string, args: unknown, extra: Partial<Parameters<typeof buildTrajectorySteps>[0]> = {}) {
  return buildTrajectorySteps({ toolName, args, table: undefined, redaction, ...extra });
}

describe('isRecordableTool', () => {
  it('records page writes, never reads, page-location changes, or the outcome report', () => {
    expect(isRecordableTool('browser_click')).toBe(true);
    expect(isRecordableTool('browser_modify_dom')).toBe(true);
    // 保存的指令不绑定具体页面：换页、开关/切换标签页都不录。
    for (const tool of ['browser_navigate', 'browser_go_back', 'browser_open_tab', 'browser_switch_tab', 'browser_close_tab']) {
      expect(isRecordableTool(tool)).toBe(false);
    }
    expect(isRecordableTool('browser_read_page')).toBe(false);
    expect(isRecordableTool('browser_get_form')).toBe(false);
    expect(isRecordableTool('report_task_outcome')).toBe(false);
  });
});

describe('buildTrajectorySteps', () => {
  it('turns a fill_form call into labelled values', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '280' }, { fieldId: 'f2', checked: true }] },
      { table: table({ f1: { label: '报销金额' }, f2: { label: '差旅' } }) },
    );
    expect(steps).toEqual([
      {
        tool: 'browser_fill_form',
        values: [
          { target: '「报销金额」', value: '280' },
          { target: '「差旅」', checked: true },
        ],
      },
    ]);
  });

  it('never records a sensitive field value, only that the user must fill it in', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: 'hunter2' }] },
      { table: table({ f1: { label: '支付密码', sensitive: true } }) },
    );
    expect(steps).toEqual([
      { tool: 'browser_fill_form', values: [{ target: '「支付密码」', sensitive: true }], sensitive: true },
    ]);
    expect(JSON.stringify(steps)).not.toContain('hunter2');
  });

  it('redacts written values before storing them', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '13812345678' }] },
      { table: table({ f1: { label: '手机' } }) },
    );
    expect(JSON.stringify(steps)).not.toContain('13812345678');
  });

  it('splits the submit click of a fill_form call into its own step', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '280' }], submit: { fieldId: 'f9' } },
      { table: table({ f1: { label: '报销金额' }, f9: { text: '提交' } }) },
    );
    expect(steps.map((step) => step.tool)).toEqual(['browser_fill_form', 'browser_click']);
    expect(steps[1].target).toBe('「提交」');
  });

  it('drops fill_form fields whose outcome did not land, and a submit that did not click', () => {
    // browser_fill_form 只要有一个字段落地就返回 isError:false；只看 isError 会把
    // invalid_value/not_writable 的字段也录成"已填"。
    const steps = build(
      'browser_fill_form',
      {
        fields: [{ fieldId: 'f1', value: '280' }, { fieldId: 'f2', value: 'abc' }, { fieldId: 'f3', value: 'x' }],
        submit: { fieldId: 'f9' },
      },
      {
        table: table({ f1: { label: '报销金额' }, f2: { label: '日期' }, f3: { label: '备注' }, f9: { text: '提交' } }),
        details: {
          outcomes: [
            { fieldId: 'f1', status: 'ok' },
            { fieldId: 'f2', status: 'invalid_value' },
            { fieldId: 'f3', status: 'not_writable' },
          ],
          submitted: { fieldId: 'f9', status: 'not_clickable' },
        },
      },
    );
    expect(steps).toEqual([
      { tool: 'browser_fill_form', values: [{ target: '「报销金额」', value: '280' }] },
    ]);
  });

  it('keeps the submit step when it clicked, even if no field landed', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '280' }], submit: { fieldId: 'f9' } },
      {
        table: table({ f1: { label: '报销金额' }, f9: { text: '提交' } }),
        details: { outcomes: [{ fieldId: 'f1', status: 'mismatch' }], submitted: { fieldId: 'f9', status: 'ok' } },
      },
    );
    expect(steps).toEqual([{ tool: 'browser_click', target: '「提交」' }]);
  });

  it('still records the sensitive-field hint even though its outcome is blocked_sensitive', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: 'hunter2' }, { fieldId: 'f2', value: '280' }] },
      {
        table: table({ f1: { label: '支付密码', sensitive: true }, f2: { label: '金额' } }),
        details: { outcomes: [{ fieldId: 'f1', status: 'blocked_sensitive' }, { fieldId: 'f2', status: 'ok' }] },
      },
    );
    expect(steps[0].values).toEqual([{ target: '「支付密码」', sensitive: true }, { target: '「金额」', value: '280' }]);
  });

  it('records only the targets of a batch click that actually landed', () => {
    const t = table({ f3: { text: 'A 选项' }, f4: { text: 'B 选项' } });
    const steps = build(
      'browser_click',
      { fieldIds: ['f3', 'f4'] },
      { table: t, details: { outcomes: [{ fieldId: 'f3', status: 'mismatch' }, { fieldId: 'f4', status: 'ok' }] } },
    );
    expect(steps[0].target).toBe('「B 选项」');
  });

  it('labels a click by its handle, and falls back to the selector when the handle is unknown', () => {
    const t = table({ f3: { text: '下一步' } });
    expect(build('browser_click', { fieldId: 'f3' }, { table: t })[0].target).toBe('「下一步」');
    expect(build('browser_click', { fieldId: 'f404', selector: 'button.next' }, { table: t })[0].target).toBe('`button.next`');
    expect(build('browser_click', { fieldIds: ['f3', 'f3'] }, { table: t })[0].target).toBe('「下一步」、「下一步」');
    expect(build('browser_click', { fieldId: 'f404' }, { table: t })[0].target).toBeUndefined();
  });

  it('records selector-based typing and selection as a single value', () => {
    expect(build('browser_type', { selector: '#q', text: 'runi' })[0]).toEqual({
      tool: 'browser_type', target: '`#q`', values: [{ target: '`#q`', value: 'runi' }],
    });
    expect(build('browser_select', { selector: 'select.city', value: 'SH' })[0].values).toEqual([{ target: '`select.city`', value: 'SH' }]);
  });

  it('records no page address at all: no navigation steps and no per-step url', () => {
    expect(build('browser_navigate', { url: 'https://a.test/x' })).toEqual([]);
    expect(build('browser_open_tab', { url: 'https://b.test/y' })).toEqual([]);
    expect(build('browser_switch_tab', { tabId: 5 })).toEqual([]);
    expect(JSON.stringify(build('browser_click', { selector: '#go' }))).not.toContain('example.com');
  });

  it('never records storage values or injected markup', () => {
    const storage = build('browser_set_storage', { area: 'local', key: 'draft', value: 'TOKEN-abc' });
    expect(storage[0].detail).toBe('localStorage.draft');
    expect(JSON.stringify(storage)).not.toContain('TOKEN-abc');

    const dom = build('browser_modify_dom', { selector: '.ad', action: 'setHtml', value: '<b>secret</b>' });
    expect(dom[0].detail).toBe('setHtml `.ad`');
    expect(JSON.stringify(dom)).not.toContain('secret');

    // setAttribute / class 操作的属性名和值就是这一步的全部做法，丢了它回放时无从照做。
    const attr = build('browser_modify_dom', { selector: 'video', action: 'setAttribute', attribute: 'data-rate', value: '10' });
    expect(attr[0].detail).toBe('setAttribute `video` data-rate="10"');
    const cls = build('browser_modify_dom', { selector: 'body', action: 'addClass', value: 'dark' });
    expect(cls[0].detail).toBe('addClass `body` "dark"');
    const attrPhone = build('browser_modify_dom', { selector: 'a', action: 'setAttribute', attribute: 'title', value: '13812345678' });
    expect(attrPhone[0].detail).not.toContain('13812345678');

    const style = build('browser_set_style', { selector: 'body', styles: { color: 'red', background: 'url(x)' } });
    expect(style[0].detail).toBe('`body` { color, background }');
  });

  it('describes key presses with their modifiers', () => {
    expect(build('browser_press_key', { key: 'Enter', modifiers: { ctrl: true } })[0].detail).toBe('Ctrl+Enter');
  });

  it('clips long labels and values to their caps', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: 'v'.repeat(MAX_TRAJECTORY_VALUE_CHARS * 2) }] },
      { table: table({ f1: { label: 'L'.repeat(MAX_TRAJECTORY_LABEL_CHARS * 2) } }) },
    );
    const value = steps[0].values![0];
    expect(value.value!.length).toBe(MAX_TRAJECTORY_VALUE_CHARS);
    // 书名号两个字符不计入标签上限。
    expect(value.target.length).toBe(MAX_TRAJECTORY_LABEL_CHARS + 2);
  });

  it('survives a malformed handle table instead of throwing', () => {
    const broken = { url: PAGE, fields: null } as unknown as FormFieldTable;
    expect(() => build('browser_click', { fieldId: 'f1' }, { table: broken })).not.toThrow();
  });

  it('fails closed on fill_form when handle cannot be resolved: records target but no value', () => {
    // 无表时：只记 target，不记值
    const noTable = build('browser_fill_form', { fields: [{ fieldId: 'f1', value: 'secret' }] }, { table: undefined });
    expect(noTable[0].values).toEqual([{ target: '「f1」' }]);
    expect(JSON.stringify(noTable)).not.toContain('secret');

    // 表里没这个 fieldId 时：只记 target，不记值
    const missingId = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f999', value: 'secret' }, { fieldId: 'f1', checked: true }] },
      { table: table({ f1: { label: '手机' } }) },
    );
    expect(missingId[0].values).toEqual([{ target: '「f999」' }, { target: '「手机」', checked: true }]);
    expect(JSON.stringify(missingId)).not.toContain('secret');
  });

  it('ignores non-object args', () => {
    expect(build('browser_click', undefined)).toEqual([{ tool: 'browser_click' }]);
  });
});

describe('appendTrajectorySteps', () => {
  it('keeps only the most recent steps once the cap is exceeded', () => {
    const make = (n: number): TrajectoryStep => ({ tool: 'browser_click', detail: String(n) });
    const existing = Array.from({ length: MAX_TRAJECTORY_STEPS }, (_, i) => make(i));
    const next = appendTrajectorySteps(existing, [make(999)]);
    expect(next).toHaveLength(MAX_TRAJECTORY_STEPS);
    expect(next.at(-1)?.detail).toBe('999');
    expect(next[0].detail).toBe('1');
  });
});
