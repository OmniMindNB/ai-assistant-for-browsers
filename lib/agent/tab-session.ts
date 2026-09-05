// 一轮/多轮对话共享的"agent 自己打开过哪些标签页、当前在操作哪个"的状态。
// 只由 browser_open_tab 追加 trackedTabs——不查询、不暴露用户自己开着的其他标签页
// （ref: 2026-08-26-multi-tab-orchestration-design.md §3.2 隐私边界）。

export interface TrackedTab {
  id: number;
  title?: string;
  url?: string;
  /**
   * 'full' = agent 通过 browser_open_tab 自己打开的，读写皆可；
   * 'read' = 用户在 @ 选择器里点选引用进来的，只读。
   * 缺省视为 'full'——兼容本字段出现之前已持久化到 storage.session 的快照。
   */
  access?: 'full' | 'read';
}

/** 一次会话最多引用多少个用户标签页。与 MAX_ATTACHMENTS_PER_MESSAGE 对齐，用户对这个数已有直觉。 */
export const MAX_REFERENCED_TABS = 5;

export function tabAccessOf(tab: TrackedTab): 'full' | 'read' {
  return tab.access === 'read' ? 'read' : 'full';
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

  /**
   * 用户在 @ 选择器里点选的标签页，以只读身份登记（ref: 2026-09-05-cross-tab-context-design.md §4.1）。
   *
   * 语义是**按传入列表全量同步 'read' 项**（新增/更新/移除），'full' 项一律不动：
   * 每一轮 StartRunRequest 都会带上面板当前的完整引用列表，增量语义下"用户移除了某个 chip"
   * 这件事根本传不过来，授权会悄悄留在后台。
   *
   * 不改变 currentTabId——引用不等于把操作目标挪过去。
   */
  reference(tabs: TrackedTab[]): void {
    const isFullTracked = (id: number) =>
      this.trackedTabs.some((tracked) => tracked.id === id && tabAccessOf(tracked) === 'full');
    // 面板 tab 和 agent 自己开的 tab 都已经是 full，点选它们不该降级，直接跳过。
    const accepted = tabs
      .filter((tab) => tab.id !== this.panelTabId && !isFullTracked(tab.id))
      .slice(0, MAX_REFERENCED_TABS);

    const keep = new Set(accepted.map((tab) => tab.id));
    this.trackedTabs = this.trackedTabs.filter(
      (tab) => tabAccessOf(tab) === 'full' || keep.has(tab.id),
    );
    for (const tab of accepted) {
      const entry: TrackedTab = { ...tab, access: 'read' };
      const index = this.trackedTabs.findIndex((tracked) => tracked.id === tab.id);
      if (index >= 0) this.trackedTabs[index] = entry;
      else this.trackedTabs.push(entry);
    }

    // 上一轮 agent 可能已经 switchTo 到某个引用页，而这一轮用户把它移除了——
    // 不回退的话 currentTabId 会指向一个不再被追踪的 tab，后续每个工具调用都会被闸门拒。
    if (!this.isTracked(this.currentTabId)) this.currentTabId = this.panelTabId;
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
      // 不标出来的话，模型会对引用页反复尝试写操作、被拒、再重试，白烧预算。
      tabAccessOf(tab) === 'read' ? '用户引用（只读）' : '',
    ]
      .filter(Boolean)
      .join('、');
    return `| ${tab.id} | ${tab.title ?? ''} | ${tab.url ?? ''} | ${marks} |`;
  });
  return ['| tabId | 标题 | URL | 备注 |', '|---|---|---|---|', ...rows].join('\n');
}
