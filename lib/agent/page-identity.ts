// 句柄表「还对不对得上当前页面」的唯一判定（发号继承、新元素比对、t* 保留都走这里；
// 注入页面的 applyFormFill / pressKeyInPage / scrollContainerInPage 不能 import，各自内联
// 一份同义的判定——改语义要连那三处一起改）。
//
// 只比地址会误伤单页应用：腾讯云等控制台切标签时，前端路由在渲染之后才 pushState 改地址，
// 而写操作后的内部重采恰好落在改地址之前，模型拿重采发的 fieldId 去点就被判「字段表已失效」
// （ref: 2026-10-07 开放服务器端口会话导出）。所以多认一种「同一页面」：文档没换。
//
// documentId 取 String(performance.timeOrigin)：它属于文档的全局对象，pushState /
// replaceState / 改 hash 都不动它，任何真正的导航都会换一个新值。它只做「放宽」，不做
// 「收紧」——地址相同仍然算同一页面，同地址重载的既有行为不变，元素层面照旧由 path + expect
// 结构指纹逐个兜底。同一文档内的视图切换带来的风险，与本就不改地址的单页应用完全相同。

export interface PageIdentity {
  url: string;
  /** 采集时页面的 String(performance.timeOrigin)；旧版本存下的表没有它。 */
  documentId?: string;
}

export function isSamePage(previous: PageIdentity | undefined, current: PageIdentity): boolean {
  if (!previous) return false;
  if (previous.url === current.url) return true;
  return Boolean(previous.documentId && current.documentId && previous.documentId === current.documentId);
}
