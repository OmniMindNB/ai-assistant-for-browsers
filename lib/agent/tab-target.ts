// 回合级固定 tabId：把"操作目标"从每次现查 chrome.tabs.query({active:true}) 改为
// 校验回合开始时就固定下来的 tabId 是否依然存在，避免用户切换标签页后
// 后续工具调用跟错目标。

export interface ResolvedTab {
  id: number;
  windowId: number;
  active: boolean;
}

export async function resolveTargetTab(tabId: number): Promise<ResolvedTab> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab?.id || tab.windowId === undefined) {
    throw new Error('目标标签页已关闭。');
  }
  return { id: tab.id, windowId: tab.windowId, active: tab.active ?? false };
}
