// lib/agent/action-result-text.ts
// 写/交互类工具返回给模型的那句话。
//
// 模型对下一步的判断几乎完全依赖这句文案：旧版的「已滚动到 (0, 800)。」不含
// 「还剩多少没看」「有没有滚动」这类信息，模型只能盲目重复同一次调用。
// 这里全部是纯函数，与消息通道解耦，便于单测。
import type { ClickElementResult, NavigateTabResult, ScrollPageResult } from '@/lib/messaging';

/** 「2400px（约 2.0 屏）未查看」；视口高度未知时省略屏数（此时括号不再提供分隔，补一个空格）。 */
function describeRemaining(pixels: number, viewportHeight: number): string {
  return viewportHeight > 0
    ? `${pixels}px（约 ${(pixels / viewportHeight).toFixed(1)} 屏）未查看`
    : `${pixels}px 未查看`;
}

export function describeScrollResult(result: ScrollPageResult): string {
  const { scrolledBy, pixelsAbove, pixelsBelow, viewportHeight } = result;
  const atTop = pixelsAbove <= 1;
  const atBottom = pixelsBelow <= 1;

  if (scrolledBy === 0) {
    if (atBottom) return '⚠️ 页面没有滚动：已在底部，无法继续下滚。';
    if (atTop) return '⚠️ 页面没有滚动：已在顶部，无法继续上滚。';
    return `⚠️ 页面没有发生滚动。上方 ${pixelsAbove}px，下方 ${pixelsBelow}px。`;
  }

  const head = result.selector
    ? `✅ 已把 "${result.selector}" 滚动到视口中央。`
    : scrolledBy > 0
      ? `✅ 已下滚 ${scrolledBy}px`
      : `✅ 已上滚 ${Math.abs(scrolledBy)}px`;

  // 按滚动方向报告「前方」还剩多少：下滚关心下方，上滚关心上方。
  const forwardAtEdge = scrolledBy > 0 ? atBottom : atTop;
  const forwardPixels = scrolledBy > 0 ? pixelsBelow : pixelsAbove;
  const edgeLabel = scrolledBy > 0 ? '底部' : '顶部';
  const sideLabel = scrolledBy > 0 ? '下方' : '上方';

  if (result.selector) {
    return forwardAtEdge ? `${head}已到达页面${edgeLabel}。` : `${head}${sideLabel}还有 ${describeRemaining(forwardPixels, viewportHeight)}。`;
  }
  return forwardAtEdge
    ? `${head}，已到达页面${edgeLabel}。`
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
