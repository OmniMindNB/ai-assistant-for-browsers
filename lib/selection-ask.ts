// 划词提问气泡的共享纯逻辑：气泡定位裁剪、预填模板拼装、全局开关的读写。
// content script（气泡 UI）、侧边栏 store（消费 pending ask）、设置页（开关）三处共用。
import type { Translate } from './i18n';
import { MAX_SHORTCUT_SELECTION_CHARS } from './chat/shortcut-prompts';

export const SELECTION_ASK_ENABLED_KEY = 'runi:selection-ask-enabled';

export async function loadSelectionAskEnabled(): Promise<boolean> {
  const res = await browser.storage.local.get(SELECTION_ASK_ENABLED_KEY);
  return (res[SELECTION_ASK_ENABLED_KEY] as boolean | undefined) ?? true;
}

export async function saveSelectionAskEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [SELECTION_ASK_ENABLED_KEY]: enabled });
}

/** 把 pending 选区文字拼成预填到聊天输入框的引用文本；截断长度与划词快捷指令保持一致。 */
export function buildSelectionAskTemplate(text: string, translate: Translate): string {
  const truncated = text.trim().slice(0, MAX_SHORTCUT_SELECTION_CHARS);
  return translate('store.selectionAskTemplate', { selection: truncated });
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
