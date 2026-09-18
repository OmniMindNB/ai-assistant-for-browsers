/**
 * browser_read_page 的取窗层：把"读正文的哪一段"和"截断后该怎么办"从 tools.ts 里抽出来。
 *
 * 抽出来的直接原因是一次线上失效：docsify 文档站的一章正文有 38641 字符，而读取默认上限是
 * 24000，`slice(0, maxChars)` 又永远从 0 开始——用户问的 4.4.3 节落在 29155，模型无论如何
 * 都读不到，最后得出"当前浏览器标签页没有可用的文档内容"这种与事实相反的结论。
 *
 * 两个设计要点：
 * 1. 窗口是 [offset, offset+maxChars)，offset 让超长正文可以分段读完，不再只能读开头；
 * 2. 截断提示必须是**可执行**的。原先只有一句被动的"正文已截断到 24000 字符"，既没说总长，
 *    也没说下一步该做什么，弱模型的实际反应是放弃而不是续读。
 */

import { MAX_TOOL_RESULT_CHARS, resolveReadMaxChars } from './context-budget';

export interface PageReadParams {
  offset?: unknown;
  maxChars?: unknown;
}

export interface PageReadWindow {
  /** 本次窗口起点，已归一到 [0, total]。 */
  offset: number;
  /** 本次窗口终点（不含），已归一到 [offset, total]。 */
  end: number;
  /** 正文总长度。 */
  total: number;
  /** 窗口之后还剩多少字符没返回。 */
  remaining: number;
  /** 还有内容没返回。 */
  truncated: boolean;
  /** offset 已经越过正文末尾，本次窗口必然为空。 */
  exhausted: boolean;
}

/** 负数、小数、超界一律归一；越界不报错，而是返回空窗口并由 exhausted 明示原因。 */
function resolveOffset(raw: unknown, total: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(total, Math.max(0, Math.floor(raw)));
}

export function planPageReadWindow(total: number, params: PageReadParams | undefined | null): PageReadWindow {
  const offset = resolveOffset(params?.offset, total);
  const maxChars = resolveReadMaxChars(params?.maxChars);
  const end = Math.min(total, offset + maxChars);
  const remaining = total - end;
  return {
    offset,
    end,
    total,
    remaining,
    truncated: remaining > 0,
    exhausted: offset >= total && total > 0,
  };
}

/**
 * 面向模型的截断提示。没截断时返回空串，由调用方过滤掉，避免给模型一句无信息的噪音。
 *
 * 分两种情况给不同的下一步，因为它们的最优解不同：整页塞得进单次上限时，一次性调大 maxChars
 * 比分段读更好——分段读会被 compactAgentMessages 的"只保留最后一条只读结果"规则压掉前面几段，
 * 读了后面反而丢了前面。只有整页确实超过 MAX_TOOL_RESULT_CHARS 时才值得分段，那时必须同时
 * 提醒模型这个丢失效应。
 */
export function describePageReadWindow(window: PageReadWindow): string {
  if (window.exhausted) {
    return `注意：offset=${window.offset} 已超出正文范围，正文总长度只有 ${window.total} 字符，本次没有返回任何内容。`;
  }
  if (!window.truncated) return '';

  const head = `注意：本次只返回了第 ${window.offset}–${window.end} 字符，还有 ${window.remaining} 字符未返回（正文总长 ${window.total} 字符）。`;

  if (window.total <= MAX_TOOL_RESULT_CHARS) {
    return `${head}整页未超过单次读取上限，把 maxChars 设为 ${window.total} 再调用一次 browser_read_page 即可一次读完，不要就此认为页面没有内容。`;
  }

  return (
    `${head}整页超过单次读取上限 ${MAX_TOOL_RESULT_CHARS} 字符，必须分段读：用 offset=${window.end} 再调用一次 browser_read_page 读下一段，` +
    '或者用 browser_find_text 直接定位你要找的小节标题或关键词。' +
    '分段读时注意：再调用一次读取工具后，本段正文会被压成一行摘要移出上下文，' +
    '本段里与任务有关的内容请先在回答中记下来再继续往后读。不要因为没读到就认为页面没有内容。'
  );
}
