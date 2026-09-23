import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import type { Translate, TranslationKey } from '@/lib/i18n';
import {
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  describeTrajectoryStep,
  parseTrajectory,
  renderTrajectoryForPrompt,
  type TrajectoryStep,
} from './task-trajectory';

function translator(dict: Record<TranslationKey, string>): Translate {
  return ((key: TranslationKey, vars?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (match, name: string) =>
      vars && name in vars ? String(vars[name]) : match,
    )) as Translate;
}
const t = translator(en);
const zhT = translator(zh);

const URL_A = 'https://example.com/expense/new';

describe('parseTrajectory', () => {
  const valid: TrajectoryStep[] = [
    { tool: 'browser_fill_form', url: URL_A, values: [{ target: '「金额」', value: '280' }, { target: '「密码」', sensitive: true }], sensitive: true },
    { tool: 'browser_click', url: URL_A, target: '「下一步」' },
  ];

  it('accepts a well-formed trajectory and returns a clean copy', () => {
    const withJunk = [{ ...valid[0], extra: 'drop me' }, valid[1]];
    const parsed = parseTrajectory(withJunk);
    expect(parsed).toEqual(valid);
    expect(parsed?.[0]).not.toHaveProperty('extra');
  });

  it('rejects anything that is not a non-empty, capped array of steps', () => {
    expect(parseTrajectory(undefined)).toBeNull();
    expect(parseTrajectory([])).toBeNull();
    expect(parseTrajectory(Array.from({ length: MAX_TRAJECTORY_STEPS + 1 }, () => valid[1]))).toBeNull();
    expect(parseTrajectory([{ tool: '', url: URL_A }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: 3 }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: URL_A, values: 'x' }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: URL_A, values: [{ target: '「a」', value: 'v'.repeat(MAX_TRAJECTORY_VALUE_CHARS + 1) }] }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: URL_A, values: [{ target: '「a」', checked: 'yes' }] }])).toBeNull();
  });

  it('normalizes sensitive values by dropping value and checked, regardless of what storage had', () => {
    const sensitiveWithValue = parseTrajectory([
      {
        tool: 'browser_fill_form',
        url: URL_A,
        values: [{ target: '「支付密码」', value: '1234', checked: true, sensitive: true }],
        sensitive: true,
      },
    ]);
    expect(sensitiveWithValue).not.toBeNull();
    expect(sensitiveWithValue?.[0].values?.[0]).toEqual({ target: '「支付密码」', sensitive: true });
    expect(JSON.stringify(sensitiveWithValue?.[0].values?.[0])).not.toContain('1234');
  });

  it('clips target and detail that exceed MAX_TRAJECTORY_VALUE_CHARS', () => {
    const longTarget = 'x'.repeat(MAX_TRAJECTORY_VALUE_CHARS * 2);
    const longDetail = 'y'.repeat(MAX_TRAJECTORY_VALUE_CHARS * 2);
    const parsed = parseTrajectory([
      {
        tool: 'browser_click',
        url: URL_A,
        target: longTarget,
        detail: longDetail,
      },
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed?.[0].target?.length).toBe(MAX_TRAJECTORY_VALUE_CHARS);
    expect(parsed?.[0].target?.endsWith('…')).toBe(true);
    expect(parsed?.[0].detail?.length).toBe(MAX_TRAJECTORY_VALUE_CHARS);
    expect(parsed?.[0].detail?.endsWith('…')).toBe(true);
  });

  it('clips a url that exceeds MAX_TRAJECTORY_VALUE_CHARS, like target and detail', () => {
    const longUrl = `https://example.com/${'p'.repeat(MAX_TRAJECTORY_VALUE_CHARS * 2)}`;
    const parsed = parseTrajectory([{ tool: 'browser_click', url: longUrl }]);
    expect(parsed?.[0].url.length).toBe(MAX_TRAJECTORY_VALUE_CHARS);
    expect(parsed?.[0].url.endsWith('…')).toBe(true);
    // 空 url 仍是合法值（录制时拿不到地址就是空串），不能被裁剪逻辑弄丢。
    expect(parseTrajectory([{ tool: 'browser_click', url: '' }])?.[0].url).toBe('');
  });

  it('clips value target that exceeds MAX_TRAJECTORY_VALUE_CHARS', () => {
    const longTarget = 'z'.repeat(MAX_TRAJECTORY_VALUE_CHARS * 2);
    const parsed = parseTrajectory([
      {
        tool: 'browser_fill_form',
        url: URL_A,
        values: [{ target: longTarget, value: '123' }],
      },
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed?.[0].values?.[0].target?.length).toBe(MAX_TRAJECTORY_VALUE_CHARS);
    expect(parsed?.[0].values?.[0].target?.endsWith('…')).toBe(true);
  });
});

describe('describeTrajectoryStep', () => {
  it('describes a single-value fill without a list prefix', () => {
    expect(describeTrajectoryStep({ tool: 'browser_fill_form', url: URL_A, values: [{ target: '「Amount」', value: '280' }] }, t))
      .toBe('Set 「Amount」 to "280"');
  });

  it('lists several values of one fill call', () => {
    const step: TrajectoryStep = {
      tool: 'browser_fill_form',
      url: URL_A,
      values: [{ target: '「Amount」', value: '280' }, { target: '「Travel」', checked: true }, { target: '「Memo」', checked: false }],
    };
    expect(describeTrajectoryStep(step, t)).toBe('Fill in the form: Set 「Amount」 to "280"; Check 「Travel」; Uncheck 「Memo」');
  });

  it('tells the user to fill sensitive fields themselves instead of claiming they were filled', () => {
    const step: TrajectoryStep = { tool: 'browser_fill_form', url: URL_A, values: [{ target: '「支付密码」', sensitive: true }], sensitive: true };
    expect(describeTrajectoryStep(step, zhT)).toBe('🔒 敏感字段「支付密码」需由用户自己填写（未记录）');
  });

  it('describes clicks, with a fallback when the target is unknown', () => {
    expect(describeTrajectoryStep({ tool: 'browser_click', url: URL_A, target: '「下一步」' }, zhT)).toBe('点击「下一步」');
    expect(describeTrajectoryStep({ tool: 'browser_click', url: URL_A }, zhT)).toBe('点击页面上的一个元素');
  });

  it('describes navigation and key presses from their detail', () => {
    expect(describeTrajectoryStep({ tool: 'browser_navigate', url: URL_A, detail: 'https://a.test/x' }, t)).toBe('Go to https://a.test/x');
    expect(describeTrajectoryStep({ tool: 'browser_press_key', url: URL_A, detail: 'Enter' }, t)).toBe('Press Enter');
  });

  it('falls back to the raw tool name for tools it has no wording for', () => {
    expect(describeTrajectoryStep({ tool: 'browser_future_tool', url: URL_A, detail: 'x' }, t)).toBe('browser_future_tool: x');
  });
});

describe('renderTrajectoryForPrompt', () => {
  it('numbers steps and collapses repeated pages', () => {
    const steps: TrajectoryStep[] = [
      { tool: 'browser_fill_form', url: URL_A, values: [{ target: '「报销金额」', value: '280' }] },
      { tool: 'browser_click', url: URL_A, target: '「下一步」' },
      { tool: 'browser_click', url: 'https://example.com/expense/confirm', target: '「确认」' },
      { tool: 'browser_close_tab', url: '' },
    ];
    expect(renderTrajectoryForPrompt(steps, zhT)).toBe([
      `1. [${URL_A}] 「报销金额」填入 "280"`,
      '2. [同上] 点击「下一步」',
      '3. [https://example.com/expense/confirm] 点击「确认」',
      '4. 关闭当前标签页',
    ].join('\n'));
  });
});
