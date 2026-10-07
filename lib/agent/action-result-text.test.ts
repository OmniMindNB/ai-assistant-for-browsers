import { describe, expect, it } from 'vitest';
import type { BatchClickOutcome, ClickElementResult, FormFieldDescriptor, NavigateHistoryResult, NavigateTabResult, ScrollPageResult } from '@/lib/messaging';
import { describeBatchClickResult, describeClickResult, describeGoBackResult, describeLandingFields, describeNavigateResult, describePageLocation, describeNewFields, describeScrollResult, MAX_LANDING_FIELDS, MAX_LISTED_NEW_FIELDS } from './action-result-text';

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
    const total = MAX_LISTED_NEW_FIELDS + 4;
    const fields = Array.from({ length: total }, (_, index) => fieldDescriptor(`f${index}`, `选项${index}`));
    const result = describeNewFields(fields);
    expect(result).toContain(`页面新出现 ${total} 个可交互元素`);
    expect(result).toContain(`f${MAX_LISTED_NEW_FIELDS - 1}「选项${MAX_LISTED_NEW_FIELDS - 1}」`);
    expect(result).not.toContain(`f${MAX_LISTED_NEW_FIELDS}「`);
    expect(result).toContain('等，另有 4 个未列出');
  });

  // 2026-10-07 开端口会话：点开「添加规则」弹窗后模型又调了一次 get_form——一个弹窗里的端口、
  // 协议、来源、备注、确定、取消早就超过旧上限 8，列不全它只能再去读一遍。
  it('lists a whole typical dialog without truncation', () => {
    expect(MAX_LISTED_NEW_FIELDS).toBeGreaterThanOrEqual(15);
  });

  // 只给 placeholder 当标签时（「如53,80,443或80-90」），不标类型看不出它是输入框还是按钮。
  it('annotates fillable fields with their kind, like the landing-page listing', () => {
    expect(describeNewFields([fieldDescriptor('f6', '如53,80,443或80-90', 'text'), fieldDescriptor('f9', '确定', 'submit')])).toBe(
      '页面新出现 2 个可交互元素：f6「如53,80,443或80-90」（text）、f9「确定」。可直接用 browser_click 的 fieldId 参数操作它们。',
    );
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

describe('describeBatchClickResult', () => {
  const outcome = (overrides: Partial<BatchClickOutcome> = {}): BatchClickOutcome => ({
    fieldId: 'f1',
    status: 'ok',
    ...overrides,
  });

  it('先给出成败计数，模型不必自己数', () => {
    const text = describeBatchClickResult([
      outcome({ fieldId: 'f1', label: 'A. 甲' }),
      outcome({ fieldId: 'f2', label: 'B. 乙' }),
      outcome({ fieldId: 'f3', status: 'mismatch', detail: '该位置的元素与读取时不一致。' }),
    ]);
    expect(text.split('\n')[0]).toBe('已批量点击 3 个目标：成功 2 个，失败 1 个。');
  });

  it('逐条列出目标与结果，失败的带上原因', () => {
    const text = describeBatchClickResult([
      outcome({ fieldId: 'f1', label: 'A. 甲' }),
      outcome({ fieldId: 'f3', status: 'mismatch', detail: '该位置的元素与读取时不一致。' }),
    ]);
    expect(text.split('\n').slice(1)).toEqual([
      '- f1（"A. 甲"）：已点击',
      '- f3：失败——该位置的元素与读取时不一致。',
    ]);
  });

  it('全部成功时不写「失败 0 个」这种噪声', () => {
    const text = describeBatchClickResult([outcome({ fieldId: 'f1' }), outcome({ fieldId: 'f2' })]);
    expect(text.split('\n')[0]).toBe('已批量点击 2 个目标：全部成功。');
  });

  it('把新标签页警告带出来：当前页不会变化这件事必须点破', () => {
    const text = describeBatchClickResult([outcome({ fieldId: 'f1', opensNewTab: true })]);
    expect(text).toContain('新标签页');
  });
});

// 点击/提交跳到新页面后直接附上落地页的元素清单，省掉模型
// 「wait_for domIdle → find_text → get_form」三轮摸索（ref: 2026-10-07 开放服务器端口会话导出）。
describe('describeLandingFields', () => {
  it('lists the visible, enabled elements of the landed page with their ids', () => {
    const text = describeLandingFields([
      fieldDescriptor('f1', '概要'),
      fieldDescriptor('f2', '防火墙', 'link'),
      fieldDescriptor('f3', '如53,80,443', 'text'),
    ]);
    expect(text).toBe(
      '[跳转后页面] 已重新读取页面，3 个可交互元素：f1「概要」、f2「防火墙」、f3「如53,80,443」（text）。' +
        '这些 fieldId 现在就能直接用于 browser_click / browser_fill_form；需要选项、必填、周边文字等细节时再调用 browser_get_form。',
    );
  });

  // 不可见和禁用的元素点不了，列出来只会诱导模型去点。
  it('leaves out hidden and disabled elements, but counts them', () => {
    const text = describeLandingFields([
      fieldDescriptor('f1', '确定'),
      { ...fieldDescriptor('f2', '隐藏菜单'), visible: false },
      { ...fieldDescriptor('f3', '灰按钮'), disabled: true },
    ]);
    expect(text).toContain('1 个可交互元素：f1「确定」');
    expect(text).not.toContain('f2');
    expect(text).not.toContain('f3');
    expect(text).toContain('另有 2 个不可见或已禁用');
  });

  it('caps the enumeration and reports how many were omitted', () => {
    const fields = Array.from({ length: MAX_LANDING_FIELDS + 5 }, (_, index) => fieldDescriptor(`f${index + 1}`, `项${index + 1}`));
    const text = describeLandingFields(fields)!;
    expect(text).toContain(`${MAX_LANDING_FIELDS + 5} 个可交互元素`);
    expect(text).toContain(`f${MAX_LANDING_FIELDS}「项${MAX_LANDING_FIELDS}」`);
    expect(text).not.toContain(`f${MAX_LANDING_FIELDS + 1}「`);
    expect(text).toContain('等，另有 5 个未列出');
  });

  it('says nothing when the landed page has no usable element', () => {
    expect(describeLandingFields([])).toBeUndefined();
    expect(describeLandingFields([{ ...fieldDescriptor('f1', 'x'), visible: false }])).toBeUndefined();
  });
});

// 2026-10-07 第三份开端口导出 #4/#11/#17：清单的 40 个名额全被顶栏和侧边栏占了（控制台、我的收藏、
// 云服务器……Hermes Agent ×2），主内容区的「管理防火墙规则」「添加规则」都在被截掉的六七十个里。
// 单页应用跳转前后是同一个文档，哪些元素是新出现的本来就知道。
describe('describeLandingFields：新出现的元素优先', () => {
  const isNew = (field: FormFieldDescriptor): FormFieldDescriptor => ({ ...field, isNew: true });

  it('有新出现的元素时只列它们，跳转前就在的只报个数', () => {
    const text = describeLandingFields([
      fieldDescriptor('f3', '控制台', 'link'),
      fieldDescriptor('f27', 'Hermes Agent', 'link'),
      isNew(fieldDescriptor('f95', '管理防火墙规则')),
      isNew(fieldDescriptor('f96', '概要', 'link')),
    ])!;
    expect(text).toContain('共 4 个可交互元素');
    expect(text).toContain('跳转后新出现 2 个：f95「管理防火墙规则」、f96「概要」');
    expect(text).toContain('另有 2 个跳转前就在');
    expect(text).not.toContain('控制台');
    expect(text).not.toContain('Hermes Agent');
  });

  it('新元素超过上限时截断并报数', () => {
    const fields = Array.from({ length: MAX_LANDING_FIELDS + 3 }, (_, index) => isNew(fieldDescriptor(`f${index + 1}`, `项${index + 1}`)));
    const text = describeLandingFields([fieldDescriptor('f900', '控制台'), ...fields])!;
    expect(text).toContain(`跳转后新出现 ${MAX_LANDING_FIELDS + 3} 个`);
    expect(text).toContain('等，另有 3 个未列出');
    expect(text).toContain('另有 1 个跳转前就在');
  });

  it('没有任何元素被标为新出现（整页跳转，旧页面没有可比的基线）：照旧按文档序列出', () => {
    const text = describeLandingFields([fieldDescriptor('f1', '登录'), fieldDescriptor('f2', '注册')])!;
    expect(text).toContain('2 个可交互元素：f1「登录」、f2「注册」');
    expect(text).not.toContain('跳转后新出现');
  });
});

describe('describePageLocation', () => {
  // 第 3 条修复之后，同一文档里改地址不再让句柄失效；已经附上落地页清单时，「fieldId 可能已经失效、
  // 请重新获取」只会把模型推回去再调一次 get_form（第三份开端口导出 #5/#6、#12/#13）。
  it('附了落地页清单时说句柄已刷新，不再说可能失效', () => {
    const text = describePageLocation('https://a/1', 'https://a/2', true, true)!;
    expect(text).toContain('从 "https://a/1" 跳转到 "https://a/2"');
    expect(text).toContain('[跳转后页面]');
    expect(text).not.toContain('可能已经失效');
  });

  it('没附清单时照旧提醒可能失效', () => {
    expect(describePageLocation('https://a/1', 'https://a/2', true)).toContain('可能已经失效');
  });
});
