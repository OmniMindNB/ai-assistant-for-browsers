/**
 * 输入区快捷指令胶囊只占一行：放得下的照常显示，放不下的收进行尾的"+N"按钮（打开 / 面板）。
 *
 * 曾经让整条工具条折行，代价是侧栏宽度一变，输入框就被顶上顶下；更早只渲染前 4 条，第 5 条
 * 凭空消失。这里两头都不要：行高固定，但被收起的数量常驻可见，点一下就能看到全部。
 *
 * 纯函数，宽度由调用方量好传进来，便于脱离真实布局测试。
 *
 * @param widths      每个胶囊的宽度（px），按显示顺序
 * @param available   这一行可用的宽度（px）；<= 0 表示还没布局（例如 jsdom），此时全部显示
 * @param moreWidth   "+N" 按钮的宽度（px）
 * @param gap         相邻元素间距（px）
 * @returns 应当显示的胶囊个数
 */
export function fitChipCount(widths: number[], available: number, moreWidth: number, gap: number): number {
  if (available <= 0 || widths.length === 0) return widths.length;
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total <= available) return widths.length;
  let used = moreWidth;
  let count = 0;
  for (const width of widths) {
    if (used + width + gap > available) break;
    used += width + gap;
    count += 1;
  }
  return count;
}
