import { describe, expect, it } from 'vitest';
import { fitChipCount } from './chip-overflow';

describe('fitChipCount', () => {
  it('全部放得下时全部显示，不预留"+N"的位置', () => {
    // 3×100 + 2×8 = 316，恰好放下
    expect(fitChipCount([100, 100, 100], 316, 40, 8)).toBe(3);
  });

  it('放不下时给"+N"按钮留出位置后能放几个算几个', () => {
    // 40 + (100+8) + (100+8) = 256 <= 300；再加一个就是 364
    expect(fitChipCount([100, 100, 100, 100], 300, 40, 8)).toBe(2);
  });

  it('不会因为给"+N"留位而多藏一个本来放得下的', () => {
    expect(fitChipCount([100, 100, 100], 320, 40, 8)).toBe(3);
  });

  it('一个都放不下时返回 0，只剩"+N"', () => {
    expect(fitChipCount([200, 200], 150, 40, 8)).toBe(0);
  });

  // jsdom 或首帧尚未布局时宽度量出来是 0：不能因此把胶囊全藏掉。
  it('可用宽度未知时全部显示', () => {
    expect(fitChipCount([100, 100], 0, 40, 8)).toBe(2);
  });

  it('没有胶囊时返回 0', () => {
    expect(fitChipCount([], 300, 40, 8)).toBe(0);
  });
});
