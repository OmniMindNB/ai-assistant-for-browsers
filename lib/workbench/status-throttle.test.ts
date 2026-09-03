import { describe, expect, it } from 'vitest';
import { STATUS_MIN_INTERVAL_MS, planStatusUpdate } from './status-throttle';

describe('planStatusUpdate', () => {
  it('目标与当前一致时什么都不做', () => {
    expect(planStatusUpdate('正在点击', '正在点击', 5_000, 1_000)).toEqual({ action: 'hold' });
  });

  it('从空开始时立刻显示', () => {
    expect(planStatusUpdate(null, '正在点击', 1_000, 0)).toEqual({ action: 'swap' });
  });

  it('已经过了最小驻留时间就立刻换字', () => {
    const last = 1_000;
    expect(planStatusUpdate('A', 'B', last + STATUS_MIN_INTERVAL_MS, last)).toEqual({ action: 'swap' });
  });

  it('没到最小驻留时间就推迟，并给出还要等多久', () => {
    const last = 1_000;
    expect(planStatusUpdate('A', 'B', last + 100, last)).toEqual({
      action: 'wait',
      afterMs: STATUS_MIN_INTERVAL_MS - 100,
    });
  });

  // 让一句过时的"正在点击…"因为节流多留 450ms，用户会以为它还在跑——比抖动更糟。
  it('收尾（目标为空）不受节流限制', () => {
    expect(planStatusUpdate('正在点击', null, 1_010, 1_000)).toEqual({ action: 'swap' });
  });

  it('两边都是空时不做事', () => {
    expect(planStatusUpdate(null, null, 1_010, 1_000)).toEqual({ action: 'hold' });
  });

  it('最小间隔可覆盖', () => {
    expect(planStatusUpdate('A', 'B', 1_100, 1_000, 50)).toEqual({ action: 'swap' });
  });
});
