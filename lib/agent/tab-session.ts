// 一轮/多轮对话共享的"agent 自己打开过哪些标签页、当前在操作哪个"的状态。
// 只由 browser_open_tab 追加 trackedTabs——不查询、不暴露用户自己开着的其他标签页
// （ref: 2026-08-26-multi-tab-orchestration-design.md §3.2 隐私边界）。

export interface TrackedTab {
  id: number;
  title?: string;
  url?: string;
}

export interface TabSessionSnapshot {
  currentTabId: number;
  trackedTabs: TrackedTab[];
}

export type TabSessionSwitchResult = { ok: true } | { ok: false; error: string };
export type TabSessionCloseResult = { ok: true; fellBackToPanelTab: boolean } | { ok: false; error: string };

export class TabSessionController {
  readonly panelTabId: number;
  currentTabId: number;
  trackedTabs: TrackedTab[];

  constructor(panelTabId: number, snapshot?: TabSessionSnapshot) {
    this.panelTabId = panelTabId;
    const trackedTabs = snapshot?.trackedTabs ?? [];
    // 面板自己绑定的 tab 永远在列表里——它是所有回退路径的落点。
    this.trackedTabs = trackedTabs.some((tab) => tab.id === panelTabId)
      ? trackedTabs
      : [{ id: panelTabId }, ...trackedTabs];
    this.currentTabId = snapshot?.currentTabId ?? panelTabId;
  }

  isTracked(tabId: number): boolean {
    return this.trackedTabs.some((tab) => tab.id === tabId);
  }

  private track(tab: TrackedTab): void {
    const index = this.trackedTabs.findIndex((existing) => existing.id === tab.id);
    if (index >= 0) this.trackedTabs[index] = tab;
    else this.trackedTabs.push(tab);
  }

  /** browser_open_tab 成功后调用：登记新 tab 并把它设为当前操作目标。 */
  openAndSwitch(tab: TrackedTab): void {
    this.track(tab);
    this.currentTabId = tab.id;
  }

  /** browser_switch_tab：只能切到已追踪的 tab，越权切换直接拒绝，不改变当前状态。 */
  switchTo(tabId: number): TabSessionSwitchResult {
    if (!this.isTracked(tabId)) {
      return { ok: false, error: `标签页 ${tabId} 不在可操作列表中，只能切换到 browser_open_tab 打开过的标签页。` };
    }
    this.currentTabId = tabId;
    return { ok: true };
  }

  /** browser_close_tab：不能关面板自己绑定的 tab；关掉的正好是当前目标时自动回退。 */
  close(tabId: number): TabSessionCloseResult {
    if (tabId === this.panelTabId) {
      return { ok: false, error: '不能关闭侧边栏所在的标签页。' };
    }
    if (!this.isTracked(tabId)) {
      return { ok: false, error: `标签页 ${tabId} 不在可操作列表中。` };
    }
    this.trackedTabs = this.trackedTabs.filter((tab) => tab.id !== tabId);
    const fellBackToPanelTab = this.currentTabId === tabId;
    if (fellBackToPanelTab) this.currentTabId = this.panelTabId;
    return { ok: true, fellBackToPanelTab };
  }

  snapshot(): TabSessionSnapshot {
    return { currentTabId: this.currentTabId, trackedTabs: this.trackedTabs.map((tab) => ({ ...tab })) };
  }
}

export function createTabSession(panelTabId: number): TabSessionController {
  return new TabSessionController(panelTabId);
}

/** 供 browser_open_tab/switch_tab/close_tab/list_tabs 的工具返回值使用，让模型看到最新状态。 */
export function formatTabList(session: TabSessionController): string {
  const rows = session.trackedTabs.map((tab) => {
    const marks = [
      tab.id === session.panelTabId ? '面板' : '',
      tab.id === session.currentTabId ? '当前操作目标' : '',
    ]
      .filter(Boolean)
      .join('、');
    return `| ${tab.id} | ${tab.title ?? ''} | ${tab.url ?? ''} | ${marks} |`;
  });
  return ['| tabId | 标题 | URL | 备注 |', '|---|---|---|---|', ...rows].join('\n');
}
