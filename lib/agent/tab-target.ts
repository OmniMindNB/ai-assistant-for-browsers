// 回合级固定 tabId：把"操作目标"从每次现查 chrome.tabs.query({active:true}) 改为
// 校验回合开始时就固定下来的 tabId 是否依然存在。避免等待「允许用户脚本」开关期间
// 用户打开 chrome://extensions 等操作改变了"当前激活标签页"，导致后续重试跟错目标。
// ref: docs/superpowers/specs/2026-07-23-turn-tabid-pinning-and-userscripts-wait-design.md

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
