// lib/agent/action-result-text.ts
// 写/交互类工具返回给模型的那句话。
//
// 模型对下一步的判断几乎完全依赖这句文案：旧版的「已滚动到 (0, 800)。」不含
// 「还剩多少没看」「有没有滚动」这类信息，模型只能盲目重复同一次调用。
// 这里全部是纯函数，与消息通道解耦，便于单测。
import type { ClickElementResult, FormFieldDescriptor, NavigateHistoryResult, NavigateTabResult, PressKeyResult, ScrollPageResult } from '@/lib/messaging';

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
    return '⚠️ 未能后退：当前标签页没有更早的历史记录，或后退操作未在预期时间内生效。';
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
