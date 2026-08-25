import { describe, expect, it } from 'vitest';
import type { ClickElementResult, NavigateTabResult, ScrollPageResult } from '@/lib/messaging';
import { describeClickResult, describeNavigateResult, describeScrollResult } from './action-result-text';

function scroll(overrides: Partial<ScrollPageResult> = {}): ScrollPageResult {
  return { x: 0, y: 800, scrolledBy: 800, pixelsAbove: 800, pixelsBelow: 2400, viewportHeight: 1200, ...overrides };
}

describe('describeScrollResult', () => {
  // 模型对下一步的判断完全依赖这句话：旧文案「已滚动到 (0, 800)。」不含任何
  // 「还有多少没看」的信息，模型只能盲目再滚一次。
  it('reports how far it scrolled and how much is left below', () => {
    expect(describeScrollResult(scroll())).toBe('✅ 已下滚 800px。下方还有 2400px（约 2.0 屏）未查看。');
  });

  it('says it reached the bottom instead of reporting leftover pixels', () => {
    expect(describeScrollResult(scroll({ pixelsBelow: 0 }))).toBe('✅ 已下滚 800px，已到达页面底部。');
  });

  it('reports an upward scroll and reaching the top', () => {
    expect(describeScrollResult(scroll({ scrolledBy: -800, pixelsAbove: 0, pixelsBelow: 3200 }))).toBe(
      '✅ 已上滚 800px，已到达页面顶部。',
    );
  });

  it('reports an upward scroll that has not reached the top yet', () => {
    expect(describeScrollResult(scroll({ scrolledBy: -500, pixelsAbove: 300, pixelsBelow: 2900 }))).toBe(
      '✅ 已上滚 500px。上方还有 300px（约 0.3 屏）未查看。',
    );
  });

  // 没滚动时必须说清「为什么没动」，否则模型会一直重复同一次调用。
  it('warns that nothing moved because the page is already at the bottom', () => {
    expect(describeScrollResult(scroll({ scrolledBy: 0, pixelsBelow: 0 }))).toBe('⚠️ 页面没有滚动：已在底部，无法继续下滚。');
  });

  it('warns that nothing moved because the page is already at the top', () => {
    expect(describeScrollResult(scroll({ scrolledBy: 0, pixelsAbove: 0 }))).toBe('⚠️ 页面没有滚动：已在顶部，无法继续上滚。');
  });

  it('warns that nothing moved mid-page and states the current position', () => {
    expect(describeScrollResult(scroll({ scrolledBy: 0 }))).toBe('⚠️ 页面没有发生滚动。上方 800px，下方 2400px。');
  });

  it('describes a scroll-into-view by selector', () => {
    expect(describeScrollResult(scroll({ selector: '#footer', scrolledBy: 1200, pixelsBelow: 200 }))).toBe(
      '✅ 已把 "#footer" 滚动到视口中央。下方还有 200px（约 0.2 屏）未查看。',
    );
  });

  it('omits the screen-count hint when the viewport height is unknown', () => {
    expect(describeScrollResult(scroll({ viewportHeight: 0 }))).toBe('✅ 已下滚 800px。下方还有 2400px 未查看。');
  });
});

function click(overrides: Partial<ClickElementResult> = {}): ClickElementResult {
  return { selector: 'button', matched: 1, clickedIndex: 0, status: 'ok', ...overrides };
}

describe('describeClickResult', () => {
  it('names the selector target it clicked', () => {
    expect(describeClickResult(click(), undefined)).toBe('已点击匹配 "button" 的第 0 个元素。');
  });

  it('names the fieldId target it clicked', () => {
    expect(describeClickResult(click(), 'f12')).toBe('已点击字段 f12。');
  });

  it('includes the element label so the model can tell what it hit', () => {
    expect(describeClickResult(click({ label: '提交订单' }), 'f12')).toBe('已点击字段 f12（"提交订单"）。');
  });

  // 点了 target="_blank" 却以为当前页会变，是多步任务里很常见的一次走偏。
  it('warns when the click opened a new tab so the model stops waiting for this one to change', () => {
    expect(describeClickResult(click({ opensNewTab: true }), 'f12')).toBe(
      '已点击字段 f12。⚠️ 该链接在新标签页打开，当前标签页内容不会变化，你也无法操作新标签页。',
    );
  });
});

describe('describeNavigateResult', () => {
  it('reports a plain navigation', () => {
    expect(describeNavigateResult({ url: 'https://a.com/' })).toBe('已跳转到 "https://a.com/"。');
  });

  it('includes the page title when it is known', () => {
    expect(describeNavigateResult({ url: 'https://a.com/', title: '首页' })).toBe('已跳转到 "https://a.com/"，页面标题 "首页"。');
  });

  // 重定向到登录页是最典型的一种：不点破的话模型会以为自己已经在目标页上。
  it('points out that the final URL differs from the requested one', () => {
    expect(describeNavigateResult({ url: 'https://a.com/login', requestedUrl: 'https://a.com/orders', title: '登录' })).toBe(
      '已跳转到 "https://a.com/orders"，经重定向最终停在 "https://a.com/login"，页面标题 "登录"。',
    );
  });
});
