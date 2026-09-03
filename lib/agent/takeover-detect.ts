// 用户接管的判定条件。放在 lib/ 而不是 entrypoints/content.ts 里，是为了可测——
// vitest 的三个 project 都不匹配 entrypoints/**/*.test.ts（同 fill-form-request.ts 的理由）。

export const TAKEOVER_REPORT_INTERVAL_MS = 1000;

/**
 * 判据有三条，缺一不可：
 *
 * 1. `isTrusted`——我们自己注入的点击/输入全是 `new MouseEvent` / `new PointerEvent` 构造的，
 *    isTrusted 恒为 false，天然和真人操作区分开。这是整个检测的地基，没有它就会自己
 *    把自己判成"用户接管"，每次点击都停下来问一遍。
 * 2. 遮罩挂着——遮罩没挂就说明 agent 没在这一页上执行，用户只是在正常用网页，不是"接管"。
 * 3. 节流——一次真实交互会连着来 click + keydown 若干条，上报一次就够了。
 *
 * 注意调用方只应观察 click / keydown：滚轮和滚动条常常只是用户跟着看，
 * 把"跟着看"判成"抢操作"会让 agent 动不动就停下来问。
 */
export function shouldReportTakeover(
  event: { isTrusted: boolean },
  overlayMounted: boolean,
  now: number,
  lastReportedAt: number,
): boolean {
  if (!event.isTrusted) return false;
  if (!overlayMounted) return false;
  return now - lastReportedAt >= TAKEOVER_REPORT_INTERVAL_MS;
}
