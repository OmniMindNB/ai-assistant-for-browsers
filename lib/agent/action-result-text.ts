// lib/agent/action-result-text.ts
// 写/交互类工具返回给模型的那句话。
//
// 模型对下一步的判断几乎完全依赖这句文案：旧版的「已滚动到 (0, 800)。」不含
// 「还剩多少没看」「有没有滚动」这类信息，模型只能盲目重复同一次调用。
// 这里全部是纯函数，与消息通道解耦，便于单测。
import type { BatchClickOutcome, ClickElementResult, FormFieldDescriptor, NavigateHistoryResult, NavigateTabResult, PressKeyResult, ScrollPageResult } from '@/lib/messaging';

/** 新元素最多列举这么多个，其余只报个数——一次展开几十个选项时全列出来会淹没工具结果。 */
const MAX_LISTED_NEW_FIELDS = 8;

/** 「2400px（约 2.0 屏）未查看」；视口高度未知时省略屏数（此时括号不再提供分隔，补一个空格）。 */
function describeRemaining(pixels: number, viewportHeight: number): string {
  return viewportHeight > 0
    ? `${pixels}px（约 ${(pixels / viewportHeight).toFixed(1)} 屏）未查看`
    : `${pixels}px 未查看`;
}

export function describeScrollResult(result: ScrollPageResult): string {
  const { scrolledBy, pixelsAbove, pixelsBelow, viewportHeight, container } = result;
  const atTop = pixelsAbove <= 1;
  const atBottom = pixelsBelow <= 1;
  const place = container ? '容器' : '页面';

  if (scrolledBy === 0) {
    if (atBottom) return `⚠️ ${place}没有滚动：已在底部，无法继续下滚。`;
    if (atTop) return `⚠️ ${place}没有滚动：已在顶部，无法继续上滚。`;
    return `⚠️ ${place}没有发生滚动。上方 ${pixelsAbove}px，下方 ${pixelsBelow}px。`;
  }

  // 有 label 时括注紧贴标签名（"<div>（"聊天记录"）容器"）；没有 label 时用空格断词，
  // 否则 "<div>容器" 会读起来像标签名的一部分。
  const containerLabel = container?.label ? `（"${container.label}"）` : ' ';
  const target = container ? `内层 <${container.tag}>${containerLabel}容器` : undefined;

  const head = result.selector && !container
    ? `✅ 已把 "${result.selector}" 滚动到视口中央。`
    : target
      ? scrolledBy > 0
        ? `✅ 已把${target}下滚 ${scrolledBy}px`
        : `✅ 已把${target}上滚 ${Math.abs(scrolledBy)}px`
      : scrolledBy > 0
        ? `✅ 已下滚 ${scrolledBy}px`
        : `✅ 已上滚 ${Math.abs(scrolledBy)}px`;

  const forwardAtEdge = scrolledBy > 0 ? atBottom : atTop;
  const forwardPixels = scrolledBy > 0 ? pixelsBelow : pixelsAbove;
  const edgeLabel = scrolledBy > 0 ? '底部' : '顶部';
  const sideLabel = scrolledBy > 0 ? '下方' : '上方';

  if (result.selector && !container) {
    return forwardAtEdge ? `${head}已到达页面${edgeLabel}。` : `${head}${sideLabel}还有 ${describeRemaining(forwardPixels, viewportHeight)}。`;
  }
  return forwardAtEdge
    ? `${head}，已到达${place}${edgeLabel}。`
    : `${head}。${sideLabel}还有 ${describeRemaining(forwardPixels, viewportHeight)}。`;
}

export function describeClickResult(result: ClickElementResult, fieldId: string | undefined): string {
  const target = fieldId ? `字段 ${fieldId}` : `匹配 "${result.selector}" 的第 ${result.clickedIndex} 个元素`;
  const label = result.label ? `（"${result.label}"）` : '';
  const newTab = result.opensNewTab
    ? '⚠️ 该链接在新标签页打开，当前标签页内容不会变化，你也无法操作新标签页。'
    : '';
  return `已点击${target}${label}。${newTab}`;
}

/**
 * 批量点击的结果文案。计数放在第一行：模型不必自己数几个成功几个失败，就不会在
 * 「3 个成功 1 个失败」的情况下把整批当成失败重来一遍。
 */
export function describeBatchClickResult(outcomes: BatchClickOutcome[]): string {
  const succeeded = outcomes.filter((outcome) => outcome.status === 'ok').length;
  const failed = outcomes.length - succeeded;
  const head =
    failed === 0
      ? `已批量点击 ${outcomes.length} 个目标：全部成功。`
      : `已批量点击 ${outcomes.length} 个目标：成功 ${succeeded} 个，失败 ${failed} 个。`;

  const lines = outcomes.map((outcome) => {
    const label = outcome.label ? `（"${outcome.label}"）` : '';
    if (outcome.status !== 'ok') {
      return `- ${outcome.fieldId}${label}：失败——${outcome.detail ?? outcome.status}`;
    }
    // 新标签页必须点破：当前标签页不会变化，否则模型会一直等它变（同 describeClickResult）。
    const newTab = outcome.opensNewTab ? '（在新标签页打开，当前标签页内容不会变化）' : '';
    return `- ${outcome.fieldId}${label}：已点击${newTab}`;
  });

  return [head, ...lines].join('\n');
}

export function describeNavigateResult(result: NavigateTabResult): string {
  const redirected = result.requestedUrl !== undefined && result.requestedUrl !== result.url;
  const destination = redirected
    ? `"${result.requestedUrl}"，经重定向最终停在 "${result.url}"`
    : `"${result.url}"`;
  const title = result.title ? `，页面标题 "${result.title}"` : '';
  return `已跳转到 ${destination}${title}。`;
}

export function describeGoBackResult(result: NavigateHistoryResult): string {
  if (!result.moved) {
    // 带上当前 URL：没有它，模型只知道"没退成"，不知道自己还站在哪一页，
    // 很容易接着盲目重试（ref: 2026-09-05 final review Minor #7）。
    const stillAt = result.url ? `当前仍在 "${result.url}"。` : '';
    return `⚠️ 未能后退：当前标签页没有更早的历史记录，或后退操作未在预期时间内生效。${stillAt}`;
  }

  const title = result.title ? `，页面标题 "${result.title}"` : '';
  let isHttpUrl = false;
  try {
    isHttpUrl = /^https?:$/.test(new URL(result.url).protocol);
  } catch {
    isHttpUrl = false;
  }
  if (!isHttpUrl) {
    return `已后退到 "${result.url}"${title}。⚠️ 已退回到扩展无法操作的页面，后续的读取或写入工具会持续失败，请改用其它方式继续任务。`;
  }
  return `已后退到 "${result.url}"${title}。`;
}

/**
 * 写/交互动作之后「页面新出现了哪些可交互元素」。
 *
 * 填完输入框弹出的下拉建议、点开的菜单项都是这一类。附在工具结果尾部，省掉模型
 * 「再调一次 browser_get_form 才发现它们」的一轮往返（ref: form-schema.ts 的 findNewFieldIds）。
 * label 由页面控制，已在 collectFormFields 阶段压空白并截断。
 */
export function describeNewFields(appeared: FormFieldDescriptor[]): string | undefined {
  if (appeared.length === 0) return undefined;

  const listed = appeared
    .slice(0, MAX_LISTED_NEW_FIELDS)
    .map((field) => (field.label ? `${field.fieldId}「${field.label}」` : `${field.fieldId}（${field.kind}）`))
    .join('、');
  const omitted = appeared.length - Math.min(appeared.length, MAX_LISTED_NEW_FIELDS);
  const tail = omitted > 0 ? `等，另有 ${omitted} 个未列出` : '';

  return `页面新出现 ${appeared.length} 个可交互元素：${listed}${tail}。可直接用 browser_click 的 fieldId 参数操作它们。`;
}

/**
 * 落地页清单最多列这么多个元素。比 MAX_LISTED_NEW_FIELDS 宽得多：那里是「这一步多出来的」，
 * 这里是「整个新页面」，列少了模型照样要再调一次 browser_get_form。写工具结果不进上下文压缩
 * （见 agent.ts 的 compactAgentMessages），所以上限也不能放开——40 个约一两千字符。
 */
export const MAX_LANDING_FIELDS = 40;

/** 只有标签说不清「能往里写」的元素才补上类型；按钮、链接的标签本身就够了。 */
const SELF_EVIDENT_KINDS = new Set<FormFieldDescriptor['kind']>(['button', 'submit', 'link']);

/**
 * 点击/提交/回车跳到新页面后，由 agent.ts 的 afterToolCall 重读一次元素并附在工具结果里：
 * 此前模型落地后要 wait_for domIdle → find_text → get_form 三轮才摸清新页面
 * （ref: 2026-10-07 开放服务器端口会话导出）。这里只给 fieldId + 标签的精简清单，细节
 * （下拉选项、必填、周边文字）仍归 browser_get_form。label 由页面控制，调用方负责脱敏。
 */
export function describeLandingFields(fields: FormFieldDescriptor[]): string | undefined {
  const usable = fields.filter((field) => field.visible && !field.disabled);
  if (usable.length === 0) return undefined;

  const listed = usable
    .slice(0, MAX_LANDING_FIELDS)
    .map((field) => {
      if (!field.label) return `${field.fieldId}（${field.kind}）`;
      return SELF_EVIDENT_KINDS.has(field.kind)
        ? `${field.fieldId}「${field.label}」`
        : `${field.fieldId}「${field.label}」（${field.kind}）`;
    })
    .join('、');
  const omitted = usable.length - Math.min(usable.length, MAX_LANDING_FIELDS);
  const tail = omitted > 0 ? `等，另有 ${omitted} 个未列出` : '';
  const unusable = fields.length - usable.length;
  const unusableNote = unusable > 0 ? `另有 ${unusable} 个不可见或已禁用，未列出。` : '';

  return (
    `[跳转后页面] 已重新读取页面，${usable.length} 个可交互元素：${listed}${tail}。${unusableNote}` +
    '这些 fieldId 现在就能直接用于 browser_click / browser_fill_form；需要选项、必填、周边文字等细节时再调用 browser_get_form。'
  );
}

export function describePressKeyResult(result: PressKeyResult): string {
  const target = result.target ? `在 ${result.target} 上` : '在当前焦点元素上';
  const lines = [`已${target}按下 ${result.key}。`];

  if (result.submitted) {
    lines.push('该按键触发了表单提交。');
  } else if (result.defaultPrevented) {
    // 被拦截不等于失败：页面自行处理了这次按键，很可能已经生效。
    lines.push('页面对这次按键调用了 preventDefault，已按页面自身的处理逻辑生效，未额外触发表单提交。');
  }

  if (result.key === 'Tab') {
    lines.push('注意：焦点不会因此移动——派发的事件不触发浏览器原生行为。要操作另一个元素请直接用它的 fieldId。');
  }
  if (result.key === 'Escape' && !result.defaultPrevented) {
    lines.push('注意：弹层不会因此自动关闭——派发的事件不触发浏览器原生行为。页面没有自己监听 Escape 时，这次按键没有任何效果。');
  }

  return lines.join('\n');
}

/**
 * 写工具执行后的页面位置，追加在工具结果末尾（由 agent.ts 的 afterToolCall 拼上）。
 * 地址变了一律报告；没变时只有 alwaysReport 才报——点击/按键最常隐式导航，模型拿不到
 * "没跳"的信号就会再调一次 browser_get_active_tab 去确认。
 * previousUrl 未知时不声称"变了"或"没变"，只报当前地址。
 */
export function describePageLocation(
  previousUrl: string | undefined,
  currentUrl: string,
  alwaysReport: boolean,
): string | undefined {
  if (previousUrl !== undefined && previousUrl !== currentUrl) {
    return `[页面位置] 地址已变化：从 "${previousUrl}" 跳转到 "${currentUrl}"。页面可能仍在加载，原有的 fieldId 与表单状态可能已经失效，请视情况重新获取页面信息。`;
  }
  if (!alwaysReport) return undefined;
  if (previousUrl === undefined) return `[页面位置] 当前地址："${currentUrl}"。`;
  return `[页面位置] 地址未变化，仍为 "${currentUrl}"；无需再调用 browser_get_active_tab 确认。单页应用可能只更新了局部内容。`;
}
