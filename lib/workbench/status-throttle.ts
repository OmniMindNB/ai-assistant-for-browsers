// header 常驻状态行的换字节流。
//
// 状态文案跟着工具调用走，一次调用至少产生两次变化（running -> done），快工具连成一串时
// 文字会一路抖动，读不清也读不完。对标 alibaba/page-agent 的 Panel：它同样给状态行加了
// 450ms 的最小驻留 + 淡出淡入，让每一句至少能被看清一眼。
//
// 逻辑拆成纯函数是为了可测：定时器和 DOM 留在组件里，什么时候该换字这件事在这里定死。

export const STATUS_MIN_INTERVAL_MS = 450;

export type StatusUpdatePlan =
  /** 无事可做：目标文案就是当前显示的这句。 */
  | { action: 'hold' }
  /** 立刻换字。 */
  | { action: 'swap' }
  /** 还没到最小驻留时间，等 afterMs 之后再来一次。 */
  | { action: 'wait'; afterMs: number };

export function planStatusUpdate(
  displayed: string | null,
  pending: string | null,
  now: number,
  lastChangeAt: number,
  minIntervalMs: number = STATUS_MIN_INTERVAL_MS,
): StatusUpdatePlan {
  if (pending === displayed) return { action: 'hold' };
  // 收尾（跑完了，状态行要消失）不节流：让一句已经过时的"正在点击…"多留 450ms
  // 比抖动更糟——用户会以为它还在跑。
  if (pending === null) return { action: 'swap' };
  const elapsed = now - lastChangeAt;
  if (elapsed >= minIntervalMs) return { action: 'swap' };
  return { action: 'wait', afterMs: minIntervalMs - elapsed };
}
