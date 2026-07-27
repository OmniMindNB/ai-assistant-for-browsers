import { describe, expect, it } from 'vitest';
import { BOTTOM_THRESHOLD_PX, isNearBottom } from './scroll';

describe('isNearBottom', () => {
  it('returns true when scrolled exactly to the bottom', () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 })).toBe(true);
  });

  it('returns true when the gap is within the threshold', () => {
    const gap = BOTTOM_THRESHOLD_PX - 1;
    expect(
      isNearBottom({ scrollTop: 600 - 200 - gap, scrollHeight: 600, clientHeight: 200 }),
    ).toBe(true);
  });

  it('returns false when the gap exceeds the threshold', () => {
    const gap = BOTTOM_THRESHOLD_PX + 1;
    expect(
      isNearBottom({ scrollTop: 600 - 200 - gap, scrollHeight: 600, clientHeight: 200 }),
    ).toBe(false);
  });

  it('returns true when content is shorter than the viewport (nothing to scroll)', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 200 }, 100)).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 200 }, 50)).toBe(false);
  });
});
