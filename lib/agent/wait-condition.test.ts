import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOM_IDLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  describeWaitResult,
  parseWaitCondition,
  type WaitCondition,
} from './wait-condition';

describe('parseWaitCondition', () => {
  it('拒绝未知的条件类型', () => {
    const parsed = parseWaitCondition({ kind: 'networkIdle', selector: '.x' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('networkIdle');
  });

  it('appear 缺少 selector 时报错', () => {
    const parsed = parseWaitCondition({ kind: 'appear' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('selector');
  });

  it('disappear 缺少 selector 时报错', () => {
    const parsed = parseWaitCondition({ kind: 'disappear', selector: '   ' });
    expect(parsed.ok).toBe(false);
  });

  it('textContains 缺少 text 时报错', () => {
    const parsed = parseWaitCondition({ kind: 'textContains', selector: 'main' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('text');
  });

  it('appear 带 selector 时补齐默认超时', () => {
    const parsed = parseWaitCondition({ kind: 'appear', selector: '.result' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.condition).toEqual({
        kind: 'appear',
        selector: '.result',
        idleMs: DEFAULT_DOM_IDLE_MS,
        timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
      });
    }
  });

  it('domIdle 不需要 selector', () => {
    const parsed = parseWaitCondition({ kind: 'domIdle' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.condition.idleMs).toBe(DEFAULT_DOM_IDLE_MS);
  });

  it('timeoutMs 超过上限时夹到上限', () => {
    const parsed = parseWaitCondition({ kind: 'domIdle', timeoutMs: 60000 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.condition.timeoutMs).toBe(MAX_WAIT_TIMEOUT_MS);
  });

  it('timeoutMs 低于下限或非数字时回到合法范围', () => {
    const tooSmall = parseWaitCondition({ kind: 'domIdle', timeoutMs: 1 });
    expect(tooSmall.ok).toBe(true);
    if (tooSmall.ok) expect(tooSmall.condition.timeoutMs).toBe(500);

    const notANumber = parseWaitCondition({ kind: 'domIdle', timeoutMs: 'soon' });
    expect(notANumber.ok).toBe(true);
    if (notANumber.ok) expect(notANumber.condition.timeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  it('idleMs 夹到 [100, 5000]', () => {
    const parsed = parseWaitCondition({ kind: 'domIdle', idleMs: 99999 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.condition.idleMs).toBe(5000);
  });
});

describe('describeWaitResult', () => {
  const appear: WaitCondition = { kind: 'appear', selector: '.result', idleMs: 500, timeoutMs: 5000 };

  it('appear 命中时报告匹配数量和耗时', () => {
    const text = describeWaitResult(appear, { met: true, elapsedMs: 320, matched: 3 });
    expect(text).toContain('.result');
    expect(text).toContain('3');
    expect(text).toContain('320');
  });

  it('disappear 命中时不提匹配数量', () => {
    const condition: WaitCondition = { kind: 'disappear', selector: '.spinner', idleMs: 500, timeoutMs: 5000 };
    const text = describeWaitResult(condition, { met: true, elapsedMs: 120, matched: 0 });
    expect(text).toContain('.spinner');
    expect(text).toContain('消失');
  });

  it('domIdle 命中时报告静止时长', () => {
    const condition: WaitCondition = { kind: 'domIdle', idleMs: 800, timeoutMs: 5000 };
    const text = describeWaitResult(condition, { met: true, elapsedMs: 1500 });
    expect(text).toContain('800');
  });

  // 超时不是错误，但必须明确劝阻原样重试——否则模型会反复等同一个条件，
  // 每次都是一整轮 LLM 往返。
  it('超时的文案明确劝阻原样重试', () => {
    const text = describeWaitResult(appear, { met: false, elapsedMs: 5000 });
    expect(text).toContain('超时');
    expect(text).toContain('不要原样重试');
  });

  // domIdle 的超时建议必须是"换个具体元素盯着"，而不是通用的"确认页面当前状态"——
  // 后者对"DOM 一直没静止"这个原因帮不上忙。
  it('domIdle 超时的文案给出针对性建议，而不是通用的确认页面状态', () => {
    const condition: WaitCondition = { kind: 'domIdle', idleMs: 500, timeoutMs: 5000 };
    const text = describeWaitResult(condition, { met: false, elapsedMs: 5000 });
    expect(text).toContain('超时');
    expect(text).toContain('appear');
    expect(text).toContain('disappear');
    expect(text).not.toContain('先用 browser_get_form 或 browser_read_page 确认页面当前状态');
  });

  // 执行环境不可用（页面导航/关闭/CSP 拒绝）和超时是两种不同的"没等到"：
  // 前者页面已经变了，"确认页面当前状态"式的超时建议不适用，得单独措辞。
  it('unavailable 的文案与超时不同，且不建议原地确认页面状态', () => {
    const text = describeWaitResult(appear, { met: false, elapsedMs: 1200, unavailable: true });
    expect(text).not.toContain('超时');
    expect(text).toContain('1200');
    expect(text).toContain('browser_get_active_tab');
  });
});
