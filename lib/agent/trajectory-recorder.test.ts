import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import type { FormFieldTable } from './tab-form-fields';
import {
  MAX_TRAJECTORY_LABEL_CHARS,
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  type TrajectoryStep,
} from './task-trajectory';
import { appendTrajectorySteps, buildTrajectorySteps, isRecordableTool, stripUrl } from './trajectory-recorder';

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
  return buildTrajectorySteps({ toolName, args, url: PAGE, table: undefined, redaction, ...extra });
}

describe('isRecordableTool', () => {
  it('records writes and tab switches, never reads or the outcome report', () => {
    expect(isRecordableTool('browser_click')).toBe(true);
    expect(isRecordableTool('browser_navigate')).toBe(true);
    expect(isRecordableTool('browser_switch_tab')).toBe(true);
    expect(isRecordableTool('browser_read_page')).toBe(false);
    expect(isRecordableTool('browser_get_form')).toBe(false);
    expect(isRecordableTool('report_task_outcome')).toBe(false);
  });
});

describe('stripUrl', () => {
  it('keeps only origin and pathname', () => {
    expect(stripUrl(PAGE)).toBe('https://example.com/expense/new');
    expect(stripUrl(undefined)).toBe('');
    expect(stripUrl('not a url')).toBe('');
  });
});

describe('buildTrajectorySteps', () => {
  it('turns a fill_form call into labelled values on a stripped url', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '280' }, { fieldId: 'f2', checked: true }] },
      { table: table({ f1: { label: '报销金额' }, f2: { label: '差旅' } }) },
    );
    expect(steps).toEqual([
      {
        tool: 'browser_fill_form',
        url: 'https://example.com/expense/new',
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
      { tool: 'browser_fill_form', url: 'https://example.com/expense/new', values: [{ target: '「支付密码」', sensitive: true }], sensitive: true },
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

  it('labels a click by its handle, and falls back to the selector when the handle is unknown', () => {
    const t = table({ f3: { text: '下一步' } });
    expect(build('browser_click', { fieldId: 'f3' }, { table: t })[0].target).toBe('「下一步」');
    expect(build('browser_click', { fieldId: 'f404', selector: 'button.next' }, { table: t })[0].target).toBe('`button.next`');
    expect(build('browser_click', { fieldIds: ['f3', 'f3'] }, { table: t })[0].target).toBe('「下一步」、「下一步」');
    expect(build('browser_click', { fieldId: 'f404' }, { table: t })[0].target).toBeUndefined();
  });

  it('records selector-based typing and selection as a single value', () => {
    expect(build('browser_type', { selector: '#q', text: 'runi' })[0]).toEqual({
      tool: 'browser_type', url: 'https://example.com/expense/new', target: '`#q`', values: [{ target: '`#q`', value: 'runi' }],
    });
    expect(build('browser_select', { selector: 'select.city', value: 'SH' })[0].values).toEqual([{ target: '`select.city`', value: 'SH' }]);
  });

  it('keeps navigation targets without their query strings', () => {
    expect(build('browser_navigate', { url: 'https://a.test/x?token=s3cret' })[0].detail).toBe('https://a.test/x');
    expect(build('browser_open_tab', { url: 'https://b.test/y#frag' })[0].detail).toBe('https://b.test/y');
    expect(build('browser_switch_tab', { tabId: 5 }, { afterUrl: 'https://c.test/z?q=1' })[0].detail).toBe('https://c.test/z');
  });

  it('never records storage values or injected markup', () => {
    const storage = build('browser_set_storage', { area: 'local', key: 'draft', value: 'TOKEN-abc' });
    expect(storage[0].detail).toBe('localStorage.draft');
    expect(JSON.stringify(storage)).not.toContain('TOKEN-abc');

    const dom = build('browser_modify_dom', { selector: '.ad', action: 'setHtml', value: '<b>secret</b>' });
    expect(dom[0].detail).toBe('setHtml `.ad`');
    expect(JSON.stringify(dom)).not.toContain('secret');

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
    expect(build('browser_click', undefined)).toEqual([{ tool: 'browser_click', url: 'https://example.com/expense/new' }]);
  });
});

describe('appendTrajectorySteps', () => {
  it('keeps only the most recent steps once the cap is exceeded', () => {
    const make = (n: number): TrajectoryStep => ({ tool: 'browser_click', url: '', detail: String(n) });
    const existing = Array.from({ length: MAX_TRAJECTORY_STEPS }, (_, i) => make(i));
    const next = appendTrajectorySteps(existing, [make(999)]);
    expect(next).toHaveLength(MAX_TRAJECTORY_STEPS);
    expect(next.at(-1)?.detail).toBe('999');
    expect(next[0].detail).toBe('1');
  });
});
