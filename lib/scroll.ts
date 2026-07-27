export const BOTTOM_THRESHOLD_PX = 48;

/** 滚动容器是否已（近似）处于底部，容忍亚像素/滚动吸附造成的误差 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx: number = BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}
