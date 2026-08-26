// 侧边栏"只属于用户在其上打开过它的那个标签页"这条约束的事实来源。
//
// 为什么需要它：manifest 里由 sidepanel 入口自动生成的 side_panel.default_path 会让 Chrome
// 默认在每一个标签页上启用侧边栏。仅靠一次性的全局 setOptions({ enabled: false }) 覆盖这个
// 默认值并不可靠——onInstalled 只在安装/更新时触发一次，浏览器重启、扩展重新启用都不会再触发，
// 而 Chrome 也没有文档承诺这份"扩展级"选项跨浏览器会话保留。覆盖一旦失效，用户在 A 标签页
// 打开的面板就会跟着切换显示在 B 标签页上。
// 所以改用 chrome.sidePanel 文档推荐的做法：为每个标签页显式写 enabled，
// 由本模块记录"哪些标签页被用户打开过面板"，background 据此逐个下发。
//
// 持久化到 browser.storage.session：Service Worker 被回收后记录仍在（模块级变量活不过回收），
// 且浏览器重启后自动清空——重启后本来也没有任何面板处于打开状态，空记录正是想要的初始值。

/** 面板文档路径，与 manifest 的 side_panel.default_path 一致。 */
export const SIDE_PANEL_PATH = 'sidepanel.html';

const KEY_PREFIX = 'runi:tab-panel-open:';

export function panelScopeStorageKey(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

/** 传给 browser.sidePanel.setOptions 的参数形状。 */
export interface TabPanelOptions {
  tabId: number;
  path: string;
  enabled: boolean;
}

/**
 * 单个标签页该不该显示面板。没在这个标签页打开过就显式 enabled:false——
 * 不能只是"不设置"，因为不设置时 Chrome 会退回 manifest 的全局默认（启用）。
 */
export function decideTabPanelOptions(tabId: number, opened: boolean): TabPanelOptions {
  return { tabId, path: SIDE_PANEL_PATH, enabled: opened };
}

/** 读失败时按"没打开过"处理：让用户重新点一次图标，好过把面板漏到别的标签页上。 */
export async function isPanelOpenedForTab(tabId: number): Promise<boolean> {
  const key = panelScopeStorageKey(tabId);
  try {
    const result = await browser.storage.session.get(key);
    return result[key] === true;
  } catch {
    return false;
  }
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住。 */
export async function markPanelOpenedForTab(tabId: number): Promise<void> {
  try {
    await browser.storage.session.set({ [panelScopeStorageKey(tabId)]: true });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearPanelOpenedForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(panelScopeStorageKey(tabId));
}

/**
 * 列出所有打开过面板的标签页，供 Service Worker 启动时重建每个标签页的 enabled 状态。
 * 按前缀扫描而不是维护一份数组，避免多处并发写同一个 key 时的读-改-写竞争。
 */
export async function listPanelOpenedTabs(): Promise<number[]> {
  let entries: Record<string, unknown>;
  try {
    entries = await browser.storage.session.get(null);
  } catch {
    return [];
  }
  const tabIds: number[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(KEY_PREFIX) || value !== true) continue;
    const tabId = Number(key.slice(KEY_PREFIX.length));
    if (Number.isInteger(tabId)) tabIds.push(tabId);
  }
  return tabIds;
}
