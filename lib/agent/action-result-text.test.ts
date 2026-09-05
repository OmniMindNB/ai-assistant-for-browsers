import { describe, expect, it } from 'vitest';
import type { ClickElementResult, FormFieldDescriptor, NavigateHistoryResult, NavigateTabResult, ScrollPageResult } from '@/lib/messaging';
import { describeClickResult, describeGoBackResult, describeNavigateResult, describeNewFields, describeScrollResult } from './action-result-text';

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

  it('names the container that actually scrolled instead of implying the whole page moved', () => {
    expect(
      describeScrollResult(
        scroll({ selector: '#target', scrolledBy: 250, pixelsBelow: 350, container: { tag: 'div', label: '聊天记录' } }),
      ),
    ).toBe('✅ 已把内层 <div>（"聊天记录"）容器下滚 250px。下方还有 350px（约 0.3 屏）未查看。');
  });

  it('names the container without a label when none is available', () => {
    expect(
      describeScrollResult(scroll({ scrolledBy: 300, pixelsBelow: 0, container: { tag: 'div' } })),
    ).toBe('✅ 已把内层 <div> 容器下滚 300px，已到达容器底部。');
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

function fieldDescriptor(fieldId: string, label?: string, kind: FormFieldDescriptor['kind'] = 'button'): FormFieldDescriptor {
  return {
    fieldId,
    kind,
    label,
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    valueState: 'empty',
    sensitive: false,
    writable: false,
    clickable: true,
    fingerprint: `${kind}|${label ?? ''}`,
  };
}

// 写完自动回报新元素，省掉模型「再调一次 get_form 才发现下拉建议弹出来了」的一轮往返。
describe('describeNewFields', () => {
  it('says nothing when no new field appeared', () => {
    expect(describeNewFields([])).toBeUndefined();
  });

  it('lists the new fields with their ids and labels', () => {
    expect(describeNewFields([fieldDescriptor('f2', '北京'), fieldDescriptor('f3', '北海')])).toBe(
      '页面新出现 2 个可交互元素：f2「北京」、f3「北海」。可直接用 browser_click 的 fieldId 参数操作它们。',
    );
  });

  it('falls back to the field kind when a new field has no label', () => {
    expect(describeNewFields([fieldDescriptor('f2', undefined, 'checkbox')])).toBe(
      '页面新出现 1 个可交互元素：f2（checkbox）。可直接用 browser_click 的 fieldId 参数操作它们。',
    );
  });

  // 一次展开出几十个选项时全列出来会淹没工具结果。
  it('caps the enumeration and reports how many were omitted', () => {
    const fields = Array.from({ length: 12 }, (_, index) => fieldDescriptor(`f${index}`, `选项${index}`));
    const result = describeNewFields(fields);
    expect(result).toContain('页面新出现 12 个可交互元素');
    expect(result).toContain('f7「选项7」');
    expect(result).not.toContain('f8「选项8」');
    expect(result).toContain('等，另有 4 个未列出');
  });
});

describe('describeGoBackResult', () => {
  it('reports the page it landed on', () => {
    expect(describeGoBackResult({ url: 'https://a.com/list', title: '列表页', moved: true })).toBe(
      '已后退到 "https://a.com/list"，页面标题 "列表页"。',
    );
  });

  it('warns when nothing moved, and says which page it is still on', () => {
    expect(describeGoBackResult({ url: 'https://a.com/only', moved: false })).toBe(
      '⚠️ 未能后退：当前标签页没有更早的历史记录，或后退操作未在预期时间内生效。当前仍在 "https://a.com/only"。',
    );
  });

  it('omits the "still on" clause when there is no URL to report', () => {
    expect(describeGoBackResult({ url: '', moved: false })).toBe(
      '⚠️ 未能后退：当前标签页没有更早的历史记录，或后退操作未在预期时间内生效。',
    );
  });

  it('warns when it landed on a page the extension cannot operate on', () => {
    expect(describeGoBackResult({ url: 'chrome://extensions/', moved: true })).toBe(
      '已后退到 "chrome://extensions/"。⚠️ 已退回到扩展无法操作的页面，后续的读取或写入工具会持续失败，请改用其它方式继续任务。',
    );
  });
});
