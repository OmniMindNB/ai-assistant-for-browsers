// 划词提问气泡的共享纯逻辑：气泡定位裁剪、预填模板拼装、全局开关的读写。
// content script（气泡 UI）、侧边栏 store（消费 pending ask）、设置页（开关）三处共用。
import type { Translate } from './i18n';
import { MAX_SHORTCUT_SELECTION_CHARS } from './chat/shortcut-prompts';
import { MAX_SELECTION_CONTEXT_CHARS } from './agent/context-budget';

/**
 * 引用的来源：page = 网页划词（content script 的气泡），reply = 侧边栏里选中的助手回复（追问）。
 * 两者的提示词模板不同——回复是模型自己说过的话，不能被描述成"页面原文"。
 */
export type QuoteSource = 'page' | 'reply';

export const SELECTION_ASK_ENABLED_KEY = 'runi:selection-ask-enabled';

export async function loadSelectionAskEnabled(): Promise<boolean> {
  const res = await browser.storage.local.get(SELECTION_ASK_ENABLED_KEY);
  return (res[SELECTION_ASK_ENABLED_KEY] as boolean | undefined) ?? true;
}

export async function saveSelectionAskEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [SELECTION_ASK_ENABLED_KEY]: enabled });
}

/** 划词提问引用文本的长度裁剪；与划词快捷指令保持一致的截断长度。 */
export function truncateSelectionText(text: string): string {
  return text.trim().slice(0, MAX_SHORTCUT_SELECTION_CHARS);
}

/**
 * 把裁剪后的选区文字拼成发给 agent 的引用模板；不含用户问题本身，调用方负责拼接。
 * context 是选区所在段落（clipSelectionContext 的结果），有就一起带上。
 */
export function buildSelectionAskTemplate(text: string, translate: Translate, context?: string): string {
  const selection = truncateSelectionText(text);
  return context
    ? translate('store.selectionAskWithContextTemplate', { selection, context })
    : translate('store.selectionAskTemplate', { selection });
}

/**
 * 追问侧边栏回复时的引用模板；不带上下文段落——整条回复本来就在对话历史里。
 * 不脱敏、不加"不可信页面内容"标记：引用的是模型自己的输出，不是页面数据。
 */
export function buildReplyQuoteTemplate(text: string, translate: Translate): string {
  return translate('store.replyQuoteTemplate', { selection: truncateSelectionText(text) });
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** 段落比选区至少多出这么多字才值得带上；少于这个数，"上下文"不过是选区本身。 */
const MIN_EXTRA_CONTEXT_CHARS = 20;

/**
 * 从选区所在块元素的文字里截出给模型的上下文：放得下就整段，放不下就以选区为中心开窗，
 * 两端截断处加省略号。选区本身已经很长（够自带语境）或段落没比选区多出什么时返回 undefined。
 */
export function clipSelectionContext(
  blockText: string,
  selection: string,
  maxChars: number = MAX_SELECTION_CONTEXT_CHARS,
): string | undefined {
  const block = collapseWhitespace(blockText);
  const selected = collapseWhitespace(selection);
  if (!block || !selected || selected.length * 2 >= maxChars) return undefined;
  if (block.length < selected.length + MIN_EXTRA_CONTEXT_CHARS) return undefined;
  if (block.length <= maxChars) return block;

  const index = block.indexOf(selected);
  // 选区跨了好几个块、在合并后的文字里对不上时，退回段首。
  const center = index >= 0 ? index + Math.floor(selected.length / 2) : 0;
  const end = Math.min(block.length, Math.max(0, center - Math.floor(maxChars / 2)) + maxChars);
  const start = Math.max(0, end - maxChars);
  return `${start > 0 ? '…' : ''}${block.slice(start, end)}${end < block.length ? '…' : ''}`;
}

export interface BubbleRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface BubbleSize {
  width: number;
  height: number;
}

/**
 * 计算气泡的 fixed 定位坐标：默认贴在选区上方，选区太靠近视口顶部（放不下）时改贴下方；
 * 左右方向裁剪进视口内，避免气泡跑出屏幕。
 */
export function clampBubblePosition(
  rect: BubbleRect,
  viewport: { width: number; height: number },
  bubbleSize: BubbleSize,
): { top: number; left: number } {
  const margin = 8;
  const edgeGap = 4;
  const above = rect.top - bubbleSize.height - margin;
  const top = above >= edgeGap ? above : rect.bottom + margin;
  const rawLeft = rect.left + (rect.right - rect.left) / 2 - bubbleSize.width / 2;
  const maxLeft = Math.max(edgeGap, viewport.width - bubbleSize.width - edgeGap);
  const left = Math.min(Math.max(edgeGap, rawLeft), maxLeft);
  return { top, left };
}
