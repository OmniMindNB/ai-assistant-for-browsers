import { describe, expect, it } from 'vitest';
import { TAKEOVER_REPORT_INTERVAL_MS, shouldReportTakeover } from './takeover-detect';

const trusted = { isTrusted: true };
const synthetic = { isTrusted: false };

describe('shouldReportTakeover', () => {
  it('遮罩挂着时，真人的一次操作算接管', () => {
    expect(shouldReportTakeover(trusted, true, 10_000, -Infinity)).toBe(true);
  });

  // 这是整个检测的地基：我们自己注入的点击/输入 isTrusted 恒为 false。
  // 漏了这条判断，agent 每点一次就会把自己判成"用户接管"。
  it('我们自己派发的合成事件不算接管', () => {
    expect(shouldReportTakeover(synthetic, true, 10_000, -Infinity)).toBe(false);
  });

  it('遮罩没挂时不算接管——那只是用户在正常用网页', () => {
    expect(shouldReportTakeover(trusted, false, 10_000, -Infinity)).toBe(false);
  });

  it('节流窗口内的后续事件不重复上报', () => {
    const last = 10_000;
    expect(shouldReportTakeover(trusted, true, last + TAKEOVER_REPORT_INTERVAL_MS - 1, last)).toBe(false);
  });

  it('节流窗口过后可以再次上报', () => {
    const last = 10_000;
    expect(shouldReportTakeover(trusted, true, last + TAKEOVER_REPORT_INTERVAL_MS, last)).toBe(true);
  });
});
