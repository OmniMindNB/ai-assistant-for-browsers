import {
  type CaptureScreenshotPayload,
  type CaptureScreenshotResult,
  type ClickElementPayload,
  type ClickElementResult,
  type FillFormFieldOutcome,
  type FillFormPayload,
  type FillFormResult,
  type FormFieldDescriptor,
  type ScrollableContainerDescriptor,
  type GetComputedStylePayload,
  type GetComputedStyleResult,
  type GetFormPayload,
  type GetFormResult,
  type GetTabUrlResult,
  type GetHtmlPayload,
  type GetHtmlResult,
  type GetScriptsPayload,
  type GetScriptsResult,
  type GetStylesheetsPayload,
  type GetStylesheetsResult,
  type Message,
  type MessageResponse,
  type ModifyDomPayload,
  type ModifyDomResult,
  type NavigateTabPayload,
  type NavigateTabResult,
  type OpenNewTabPayload,
  type OpenNewTabResult,
  type CloseTabResult,
  type AskSelectionPayload,
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
  type ProbeClickTargetPayload,
  type ProbeClickTargetResult,
  type QueryDomPayload,
  type QueryDomResult,
  type ScrollPagePayload,
  type ScrollPageResult,
  type SelectOptionPayload,
  type SelectOptionResult,
  type SetAgentOverlayPayload,
  type SetAgentOverlayResult,
  type SetStoragePayload,
  type SetStorageResult,
  type SetStylePayload,
  type SetStyleResult,
  type TypeTextPayload,
  type TypeTextResult,
  newMessageId,
} from '@/lib/messaging';
import { loadRedactionSettings, redactText } from '@/lib/redaction';
import { fetchPageResourceText } from '@/lib/page-resource-fetch';
import { resolveTargetTab } from '@/lib/agent/tab-target';
import { sendToContentScript } from '@/lib/agent/content-script-messaging';
import { clearOverlayForTab, getOverlayForTab, setOverlayForTab } from '@/lib/agent/tab-overlay-state';
import { clearConversationIdForTab } from '@/lib/agent/tab-conversation';
import { clearPendingAskForTab, setPendingAskForTab } from '@/lib/agent/tab-pending-ask';
import { clearTabSession } from '@/lib/agent/tab-session-storage';
import {
  SIDE_PANEL_PATH,
  clearPanelOpenedForTab,
  decideTabPanelOptions,
  isPanelOpenedForTab,
  listPanelOpenedTabs,
  markPanelOpenedForTab,
} from '@/lib/tab-panel-scope';
import { mergeFillOutcomes, planFieldClick, planFieldScroll, planFormFill } from '@/lib/agent/fill-form-request';
import {
  applyFormFill,
  clickElementInPage,
  collectFormFields,
  probeClickTarget,
  scrollContainerInPage,
  scrollPageInPage,
  selectOptionInPage,
  typeTextInPage,
  type ApplyFillItem,
} from '@/lib/agent/form-dom';
import { findNewFieldIds, sanitizeFieldText, sanitizePageText, toFieldDescriptor, toScrollableContainerDescriptor } from '@/lib/agent/form-schema';
import { getFormFieldsForTab, setFormFieldsForTab, type FormFieldHandle } from '@/lib/agent/tab-form-fields';
import { decideSubmitIntent } from '@/lib/agent/form-submit';

const DEFAULT_TOOL_MAX_CHARS = 12000;
// 以下为模型可见/可调用的消息类型；内部专用消息（如 SET_AGENT_OVERLAY）有意不在此列，以免暴露给模型。
const SUPPORTED_MESSAGE_TYPES = [
  'PING',
  'EXTRACT_PAGE',
  'GET_SELECTION',
  'ASK_SELECTION',
  'GET_ACTIVE_TAB',
  'QUERY_DOM',
  'GET_HTML',
  'GET_SCRIPTS',
  'GET_STYLESHEETS',
  'GET_COMPUTED_STYLE',
  'GET_PAGE_META',
  'GET_FORM',
  'FILL_FORM',
  'PROBE_CLICK_TARGET',
  'CAPTURE_SCREENSHOT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'SELECT_OPTION',
  'SCROLL_PAGE',
  'NAVIGATE_TAB',
  'OPEN_NEW_TAB',
  'CLOSE_TAB',
  'SET_STORAGE',
  'CHAT',
] as const;

// Service Worker：消息路由中心（ref: technical-plan.md §3.2）
export default defineBackground(() => {
  // 每次 Service Worker 启动都重新确立"面板按 tab 绑定"这条约束（见 lib/tab-panel-scope.ts）。
  // 不能只挂在 runtime.onInstalled 上：那只在安装/更新时触发一次，浏览器重启、扩展重新启用
  // 都不会再触发，而 manifest 的 side_panel.default_path 会让全局默认悄悄恢复成"所有 tab 都开"，
  // 于是在 A 标签页打开的面板会跟着切换显示到 B 标签页上。
  syncSidePanelScope().catch((err: unknown) => console.error('[Runi] sidePanel scope sync:', err));

  // 切换标签页时按记录逐个下发 enabled：没在这个 tab 打开过面板就显式 enabled:false，
  // Chrome 会把跟过来的面板关掉（ref: chrome.sidePanel 文档的 per-tab 示例）。
  browser.tabs.onActivated.addListener(({ tabId }) => {
    applyPanelScopeToTab(tabId).catch((err: unknown) =>
      console.error('[Runi] sidePanel setOptions on tab activate:', err),
    );
  });

  // 点击工具栏图标时，只为当前这个 tab 启用并打开侧边栏——面板与这个 tab 强绑定。
  // sidePanel.open() 必须在用户手势的同一个事件循环内同步调用；链在 setOptions()
  // 的 .then() 里会跨过一次 Promise resolve，Chrome 就不再把它算作用户手势触发，
  // 抛出 "sidePanel.open() may only be called in response to a user gesture."
  // 因此这里两个调用都在监听器函数体内同步发起，不互相等待；记录写入排在它们之后，
  // 同样不 await，避免插到手势与 open() 之间。
  browser.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const tabId = tab.id;
    browser.sidePanel
      ?.setOptions?.({ tabId, path: SIDE_PANEL_PATH, enabled: true })
      .catch((err: unknown) => console.error('[Runi] sidePanel setOptions:', err));
    browser.sidePanel
      ?.open?.({ tabId })
      .catch((err: unknown) => console.error('[Runi] sidePanel open:', err));
    markPanelOpenedForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] markPanelOpenedForTab:', err),
    );
  });

  browser.runtime.onMessage.addListener(
    (message: Message, sender, sendResponse: (r: MessageResponse) => void) => {
      handleMessage(message, sender)
        .then((data) => sendResponse({ id: message.id, ok: true, data }))
        .catch((error: unknown) =>
          sendResponse({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // 返回 true 以保持 sendResponse 异步可用
      return true;
    },
  );

  // Tab 关闭后"该 tab 上次展示的会话"记录不再可能被用到，及时清理避免占用 storage 配额。
  browser.tabs.onRemoved.addListener((tabId) => {
    clearConversationIdForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] clearConversationIdForTab on tab close:', err),
    );
    clearPendingAskForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] clearPendingAskForTab on tab close:', err),
    );
    clearTabSession(tabId).catch((err: unknown) =>
      console.error('[Runi] clearTabSession on tab close:', err),
    );
    clearPanelOpenedForTab(tabId).catch((err: unknown) =>
      console.error('[Runi] clearPanelOpenedForTab on tab close:', err),
    );
  });
});

/**
 * 把全局默认关掉，再按记录恢复真正该启用面板的标签页。
 *
 * openPanelOnActionClick 这个行为设置由 Chrome 按扩展持久化保存，旧版本装过之后
 * 仅仅"这次代码不再调用"不会自动清掉它——若残留 true，点击图标会被 Chrome 直接消费掉
 * 去开全局（已禁用的）面板，action.onClicked 根本不会触发。这里每次启动都显式重置为 false。
 */
async function syncSidePanelScope(): Promise<void> {
  try {
    await browser.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
  } catch (err: unknown) {
    console.error('[Runi] sidePanel setPanelBehavior:', err);
  }
  try {
    await browser.sidePanel?.setOptions?.({ enabled: false });
  } catch (err: unknown) {
    console.error('[Runi] sidePanel global disable:', err);
  }

  // 全局默认关掉之后再逐个恢复：Service Worker 被回收重启时，用户已经打开过面板的
  // 标签页不该因为这次同步被误关。单个 tab 失败（例如它已经关掉了）不影响其余 tab。
  for (const tabId of await listPanelOpenedTabs()) {
    await applyPanelScopeToTab(tabId).catch((err: unknown) =>
      console.error('[Runi] sidePanel setOptions on scope sync:', err),
    );
  }
}

/** 单个标签页的面板启用状态：以 lib/tab-panel-scope.ts 的记录为准。 */
async function applyPanelScopeToTab(tabId: number): Promise<void> {
  const opened = await isPanelOpenedForTab(tabId);
  await browser.sidePanel?.setOptions?.(decideTabPanelOptions(tabId, opened));
}

// 回合开始时由侧边栏解析一次并透传的目标标签页 ID；GET_ACTIVE_TAB 之外的每条消息都要带。
function requireTabId(message: Message): number {
  if (typeof message.tabId !== 'number') {
    throw new Error(`消息 ${message.type} 缺少 tabId。`);
  }
  return message.tabId;
}

/** 从 addListener 的回调签名里提取 sender 参数的类型，不依赖猜测具体的 polyfill 类型名。 */
type MessageSender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

/**
 * ASK_SELECTION 是唯一一个由 content script 主动发起、不携带 tabId 的消息——它的语义就是
 * "当前这个 tab 的用户点了划词提问气泡"，tab 身份直接来自 sender.tab.id，不走其它消息类型
 * 依赖的"侧边栏在回合开始时解析并透传 tabId"那套逻辑。
 */
async function handleAskSelection(sender: MessageSender | undefined, payload: AskSelectionPayload | undefined): Promise<void> {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return;
  const text = payload?.text?.trim();
  if (!text) return;

  // 两次 sidePanel 调用必须在这里同步发起、不经过任何 await/.then 链，否则 Chrome 会认为已经
  // 脱离了触发本次消息的用户手势，抛出
  // "sidePanel.open() may only be called in response to a user gesture."
  // ——与上方 action.onClicked 监听器（第 91-100 行）的写法保持一致。
  browser.sidePanel
    ?.setOptions?.({ tabId, path: SIDE_PANEL_PATH, enabled: true })
    .catch((err: unknown) => console.error('[Runi] sidePanel setOptions (ask-selection):', err));
  browser.sidePanel
    ?.open?.({ tabId })
    .catch((err: unknown) => console.error('[Runi] sidePanel open (ask-selection):', err));

  // 划词提问同样算"用户在这个 tab 打开了面板"，否则切走再切回来会被当成未打开过而关掉。
  await markPanelOpenedForTab(tabId);
  await setPendingAskForTab(tabId, text);
}

async function handleMessage(message: Message, sender?: MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { pong: true, ts: Date.now(), agentProtocol: 1, supportedTypes: SUPPORTED_MESSAGE_TYPES };

    case 'GET_ACTIVE_TAB':
      return getActiveTab();

    case 'GET_TAB_URL':
      return getTabUrl(requireTabId(message));

    case 'EXTRACT_PAGE':
      return extractActivePage(requireTabId(message));

    case 'GET_SELECTION':
      return getActiveSelection(requireTabId(message));

    case 'ASK_SELECTION':
      return handleAskSelection(sender, message.payload as AskSelectionPayload | undefined);

    case 'QUERY_DOM':
      return queryDom(message.payload as QueryDomPayload, requireTabId(message));

    case 'GET_HTML':
      return getHtml(message.payload as GetHtmlPayload, requireTabId(message));

    case 'GET_SCRIPTS':
      return getScripts(message.payload as GetScriptsPayload, requireTabId(message));

    case 'GET_STYLESHEETS':
      return getStylesheets(message.payload as GetStylesheetsPayload, requireTabId(message));

    case 'GET_COMPUTED_STYLE':
      return getComputedStyleForSelector(message.payload as GetComputedStylePayload, requireTabId(message));

    case 'GET_PAGE_META':
      return getPageMeta(requireTabId(message));

    case 'GET_FORM':
      return getForm(message.payload as GetFormPayload, requireTabId(message));

    case 'FILL_FORM':
      return fillForm(message.payload as FillFormPayload, requireTabId(message));

    case 'PROBE_CLICK_TARGET':
      return probeSubmitIntent(message.payload as ProbeClickTargetPayload, requireTabId(message));

    case 'CAPTURE_SCREENSHOT':
      return captureScreenshotWithoutOverlay(message.payload as CaptureScreenshotPayload, requireTabId(message));

    case 'SET_STYLE':
      return setStyle(message.payload as SetStylePayload, requireTabId(message));

    case 'MODIFY_DOM':
      return modifyDom(message.payload as ModifyDomPayload, requireTabId(message));

    case 'CLICK_ELEMENT':
      return clickElement(message.payload as ClickElementPayload, requireTabId(message));

    case 'TYPE_TEXT':
      return typeText(message.payload as TypeTextPayload, requireTabId(message));

    case 'SELECT_OPTION':
      return selectOption(message.payload as SelectOptionPayload, requireTabId(message));

    case 'SCROLL_PAGE':
      return scrollPage(message.payload as ScrollPagePayload, requireTabId(message));

    case 'NAVIGATE_TAB':
      return navigateTab(message.payload as NavigateTabPayload, requireTabId(message));

    case 'OPEN_NEW_TAB':
      return openNewTab(message.payload as OpenNewTabPayload, requireTabId(message));

    case 'CLOSE_TAB':
      return closeTab(requireTabId(message));

    case 'SET_STORAGE':
      return setStorage(message.payload as SetStoragePayload, requireTabId(message));

    case 'SET_AGENT_OVERLAY':
      return setAgentOverlay(message.payload as SetAgentOverlayPayload, requireTabId(message));

    default:
      throw new Error(`未处理的消息类型: ${message.type}`);
  }
}

// 例外：这是唯一保留"实时查询当前激活标签页"语义的函数，用于 GET_ACTIVE_TAB——
// 它的用途就是让模型知道"用户现在焦点在哪"，和"本回合操作目标"是两个正交的问题。
async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('未找到活动标签页');
  return { id: tab.id, title: tab.title, url: tab.url };
}

// 内部专用：给 agent.ts 探测 browser_click/fill_form/type 之类隐式触发的导航
// （ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.2）。不出现在
// SUPPORTED_MESSAGE_TYPES 里，不是模型可调用的工具。
async function getTabUrl(tabId: number): Promise<GetTabUrlResult> {
  const tab = await browser.tabs.get(tabId);
  return { url: tab.url ?? '', title: tab.title };
}

async function extractActivePage(tabId: number): Promise<PageContent> {
  const tab = await resolveTargetTab(tabId);
  const response = await sendToContentScript<PageContent>(tab.id, {
    id: `extract-${Date.now()}`,
    type: 'EXTRACT_PAGE',
  } satisfies Message);

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '页面提取失败');
  }
  const redactionSettings = await loadRedactionSettings();
  return { ...response.data, text: redactText(response.data.text, redactionSettings) };
}

async function getActiveSelection(tabId: number): Promise<PageSelection> {
  const tab = await resolveTargetTab(tabId);
  const response = await sendToContentScript<PageSelection>(tab.id, {
    id: `selection-${Date.now()}`,
    type: 'GET_SELECTION',
  } satisfies Message);

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '获取选区失败');
  }
  return response.data;
}

async function queryDom(payload: QueryDomPayload, tabId: number): Promise<QueryDomResult> {
  return executeInTab(tabId, payload, (input): QueryDomResult => {
    const selector = input?.selector || 'body';
    const limit = Math.max(1, Math.min(100, input?.limit ?? 20));
    const nodes = Array.from(document.querySelectorAll(selector));
    return {
      selector,
      count: nodes.length,
      truncated: nodes.length > limit,
      nodes: nodes.slice(0, limit).map((node, index) => {
        const element = node as Element;
        const rect = element.getBoundingClientRect();
        const attributes: Record<string, string> = {};
        for (const attr of Array.from(element.attributes)) {
          attributes[attr.name] = attr.value.slice(0, 500);
        }
        const rawClassName = (element as HTMLElement).className;
        return {
          index,
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          className: typeof rawClassName === 'string' ? rawClassName : String(rawClassName || ''),
          text: input?.includeText ? (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) : undefined,
          attributes,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }),
    };
  });
}

const MAX_FORM_FIELDS = 120;
const MAX_SELECT_OPTIONS = 50;

interface FieldSnapshot {
  collected: Awaited<ReturnType<typeof collectFormFields>>;
  fields: FormFieldDescriptor[];
  orphanFieldIds: string[];
  /** 相对上一次快照新出现的字段；首次读取该页面或页面已换地址时为空。 */
  newFields: FormFieldDescriptor[];
  /** collected.trailingText 净化后的结果；未开 includeText 或没有尾部正文时为 undefined。 */
  trailingText: string | undefined;
  /** 任一字段的 precedingText 或 trailingText 是否被截断到 MAX_FIELD_TEXT_CHARS。 */
  textTruncated: boolean;
  /** 页面上发现的可滚动容器；未开 includeScrollable 时为 undefined。 */
  scrollableContainers: ScrollableContainerDescriptor[] | undefined;
}

/**
 * 采一次字段快照：发放新的 fieldId 句柄表、与上一次快照做差集标出新元素，并存回 session。
 *
 * 写操作之后也会调用它——句柄表因此被刷新，模型手上旧的 fieldId 可能指向别的元素。
 * 这是安全的：applyFormFill / planFieldClick 在动手前都会比对 expect，对不上直接报
 * mismatch 而不会误点（ref: Spec-0005 §写入校验矩阵）。
 */
async function snapshotFields(tabId: number, payload: GetFormPayload = {}): Promise<FieldSnapshot> {
  const previous = await getFormFieldsForTab(tabId);
  const collected = await executeInTab(
    tabId,
    {
      selector: payload?.selector,
      includeHidden: payload?.includeHidden,
      includeText: payload?.includeText,
      includeScrollable: payload?.includeScrollable,
      maxFields: MAX_FORM_FIELDS,
      maxOptions: MAX_SELECT_OPTIONS,
    },
    collectFormFields,
  );

  const fields: FormFieldDescriptor[] = [];
  const handles: Record<string, FormFieldHandle> = {};
  const orphanFieldIds: string[] = [];
  let textTruncated = false;

  collected.raws.forEach((raw, index) => {
    const fieldId = `f${index + 1}`;
    const descriptor = toFieldDescriptor(raw, fieldId);
    fields.push(descriptor);
    handles[fieldId] = {
      path: raw.path,
      expect: { tag: raw.tag, type: raw.type, name: raw.name, label: descriptor.label, href: raw.href },
      sensitive: descriptor.sensitive,
      kind: descriptor.kind,
    };
    if (!descriptor.formId) orphanFieldIds.push(fieldId);
    if (sanitizeFieldText(raw.precedingText, 'tail').truncated) textTruncated = true;
  });

  const scrollableContainers: ScrollableContainerDescriptor[] | undefined = collected.scrollables?.map(
    (raw, index) => {
      const fieldId = `s${index + 1}`;
      handles[fieldId] = { path: raw.path, expect: { tag: raw.tag }, sensitive: false, kind: 'scrollable' };
      return toScrollableContainerDescriptor(raw, fieldId);
    },
  );

  const trailingSanitized = sanitizeFieldText(collected.trailingText);
  if (trailingSanitized.truncated) textTruncated = true;

  // 换了地址就不比对：跨页面「全都是新的」没有信息量，只会淹没真正的变化。
  const comparable = previous && previous.url === collected.url ? previous.fingerprints : undefined;
  const newFieldIds = findNewFieldIds(fields, comparable);
  for (const field of fields) {
    if (newFieldIds.has(field.fieldId)) field.isNew = true;
  }

  await setFormFieldsForTab(tabId, {
    url: collected.url,
    fields: handles,
    fingerprints: fields.map((field) => field.fingerprint),
  });

  return {
    collected,
    fields,
    orphanFieldIds,
    newFields: fields.filter((field) => field.isNew),
    trailingText: trailingSanitized.text,
    textTruncated,
    scrollableContainers,
  };
}

async function getForm(payload: GetFormPayload, tabId: number): Promise<GetFormResult> {
  const { collected, fields, orphanFieldIds, trailingText, textTruncated, scrollableContainers } =
    await snapshotFields(tabId, payload);

  return {
    forms: collected.forms.map((form) => ({
      formId: `form${form.formIndex}`,
      name: form.name,
      action: form.action,
      method: form.method,
      submitFieldIds: fields
        .filter((field) => field.kind === 'submit' && field.formId === `form${form.formIndex}`)
        .map((field) => field.fieldId),
    })),
    fields,
    orphanFieldIds,
    unreachable: collected.unreachable,
    truncated: collected.truncated,
    trailingText,
    textTruncated,
    scrollableContainers,
  };
}

async function fillForm(payload: FillFormPayload, tabId: number): Promise<FillFormResult> {
  const table = await getFormFieldsForTab(tabId);
  if (!table) {
    return { outcomes: [], fieldsTableStale: true };
  }

  const plan = planFormFill(payload, table);
  const applied = await executeInTab(
    tabId,
    { url: table.url, items: plan.items, submit: plan.submit },
    applyFormFill,
  );

  if (applied.fieldsTableStale) {
    return { outcomes: [], fieldsTableStale: true };
  }

  return {
    outcomes: mergeFillOutcomes(payload, plan.blocked, applied.outcomes),
    submitted: plan.submitFieldMissing
      ? { fieldId: payload!.submit!.fieldId, status: 'not_found' as const }
      : applied.submitted,
    newFields: await collectNewFieldsAfterWrite(tabId),
  };
}

/**
 * 写操作之后重采一次快照，回报「页面新出现了哪些可交互元素」。
 *
 * 填完输入框弹出的自动补全、点击后展开的菜单都属此类。此前模型必须自己想起来再调一次
 * browser_get_form 才能看见它们，等于每次交互都多一轮往返。
 * 重采失败（页面正在导航、标签页已关闭等）不该把一次成功的写入变成失败，故静默降级为空。
 */
async function collectNewFieldsAfterWrite(tabId: number): Promise<FormFieldDescriptor[] | undefined> {
  try {
    const snapshot = await snapshotFields(tabId);
    return snapshot.newFields.length > 0 ? snapshot.newFields : undefined;
  } catch {
    return undefined;
  }
}

async function probeSubmitIntent(payload: ProbeClickTargetPayload, tabId: number): Promise<ProbeClickTargetResult> {
  const needsTable = Boolean(payload?.submitFieldId || payload?.fieldIds?.length);
  const table = needsTable ? await getFormFieldsForTab(tabId) : undefined;

  // 卡片要展示的 label 从句柄表来，不从页面重新取——句柄表就是读表单那一刻的真相。
  const fieldLabels = payload?.fieldIds?.map((fieldId) => ({
    fieldId,
    label: table?.fields[fieldId]?.expect.label,
  }));

  const handle = payload?.submitFieldId ? table?.fields[payload.submitFieldId] : undefined;
  if (!payload?.selector && !handle) return { isSubmit: false, fieldLabels };

  const probe = await executeInTab(
    tabId,
    { selector: payload?.selector, index: payload?.index, path: handle?.path },
    probeClickTarget,
  );
  if (!probe.found) return { isSubmit: false, fieldLabels };

  return {
    ...decideSubmitIntent({
      tag: probe.tag,
      type: probe.type,
      hasFormOwner: probe.hasFormOwner,
      formAction: probe.formAction,
      textContent: probe.textContent,
      fieldCount: probe.fieldCount,
    }),
    fieldLabels,
  };
}

async function getHtml(payload: GetHtmlPayload, tabId: number): Promise<GetHtmlResult> {
  return executeInTab(tabId, payload, (input): GetHtmlResult => {
    const selector = input?.selector || 'html';
    const maxChars = Math.max(1000, input?.maxChars ?? 12000);
    const nodes = Array.from(document.querySelectorAll(selector));
    const html = nodes.map((node) => (node as Element).outerHTML).join('\n\n');
    return {
      selector,
      count: nodes.length,
      html: html.slice(0, maxChars),
      length: html.length,
      truncated: html.length > maxChars,
    };
  });
}

async function getScripts(payload: GetScriptsPayload, tabId: number): Promise<GetScriptsResult> {
  const input = payload ?? {};
  const maxChars = Math.max(1000, input.maxChars ?? DEFAULT_TOOL_MAX_CHARS);
  const includeInline = input.includeInline ?? true;
  const includeExternal = input.includeExternal ?? true;

  const scripts = await executeInTab(tabId, null, (): PageScriptInfo[] =>
    Array.from(document.scripts).map((script, index) => ({
      index,
      src: script.src || undefined,
      type: script.type || undefined,
      async: script.async,
      defer: script.defer,
      text: script.src ? undefined : script.textContent || '',
      length: script.src ? 0 : (script.textContent || '').length,
      truncated: false,
    })),
  );

  let remaining = maxChars;
  let truncated = false;
  const output: PageScriptInfo[] = [];
  for (const script of scripts) {
    const next = { ...script };
    if (script.src) {
      if (includeExternal && remaining > 0) {
        const fetched = await fetchPageResourceText(script.src, remaining);
        next.text = fetched.text;
        next.length = fetched.length;
        next.truncated = fetched.truncated;
        next.error = fetched.error;
        remaining -= next.text?.length ?? 0;
        truncated ||= fetched.truncated;
      }
    } else if (includeInline) {
      const text = script.text ?? '';
      next.text = text.slice(0, remaining);
      next.length = text.length;
      next.truncated = text.length > next.text.length;
      remaining -= next.text.length;
      truncated ||= next.truncated;
    } else {
      delete next.text;
    }
    output.push(next);
  }

  return { count: scripts.length, scripts: output, truncated };
}

async function getStylesheets(payload: GetStylesheetsPayload, tabId: number): Promise<GetStylesheetsResult> {
  const input = payload ?? {};
  const maxChars = Math.max(1000, input.maxChars ?? DEFAULT_TOOL_MAX_CHARS);
  const includeInline = input.includeInline ?? true;
  const includeExternal = input.includeExternal ?? true;

  const stylesheets = await executeInTab(tabId, null, (): PageStylesheetInfo[] => {
    const fromStyleTags = Array.from(document.querySelectorAll('style')).map((style, index) => ({
      index,
      ownerTag: 'style',
      text: style.textContent || '',
      length: (style.textContent || '').length,
      truncated: false,
    }));
    const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).map((link, offset) => ({
      index: fromStyleTags.length + offset,
      href: (link as HTMLLinkElement).href || undefined,
      ownerTag: 'link',
      length: 0,
      truncated: false,
    }));
    return [...fromStyleTags, ...links];
  });

  let remaining = maxChars;
  let truncated = false;
  const output: PageStylesheetInfo[] = [];
  for (const sheet of stylesheets) {
    const next = { ...sheet };
    if (sheet.href) {
      if (includeExternal && remaining > 0) {
        const fetched = await fetchPageResourceText(sheet.href, remaining);
        next.text = fetched.text;
        next.length = fetched.length;
        next.truncated = fetched.truncated;
        next.error = fetched.error;
        remaining -= next.text?.length ?? 0;
        truncated ||= fetched.truncated;
      }
    } else if (includeInline) {
      const text = sheet.text ?? '';
      next.text = text.slice(0, remaining);
      next.length = text.length;
      next.truncated = text.length > next.text.length;
      remaining -= next.text.length;
      truncated ||= next.truncated;
    } else {
      delete next.text;
    }
    output.push(next);
  }

  return { count: stylesheets.length, stylesheets: output, truncated };
}

async function getComputedStyleForSelector(
  payload: GetComputedStylePayload,
  tabId: number,
): Promise<GetComputedStyleResult> {
  return executeInTab(tabId, payload, (input): GetComputedStyleResult => {
    const selector = input?.selector || 'body';
    const element = document.querySelector(selector);
    if (!element) return { selector, found: false, styles: {} };
    const computed = getComputedStyle(element);
    const props = input?.props?.length
      ? input.props
      : [
          'display',
          'position',
          'overflow',
          'overflow-x',
          'overflow-y',
          'scroll-behavior',
          'scroll-snap-type',
          'transform',
          'transition',
          'animation',
          'will-change',
          'z-index',
        ];
    const styles: Record<string, string> = {};
    for (const prop of props) styles[prop] = computed.getPropertyValue(prop);
    return { selector, found: true, styles };
  });
}

async function getPageMeta(tabId: number): Promise<PageMetaResult> {
  return executeInTab(tabId, null, (): PageMetaResult => {
    const global = window as any;
    const hints: string[] = [];
    if (global.React || global.__REACT_DEVTOOLS_GLOBAL_HOOK__) hints.push('react');
    if (global.Vue || global.__VUE_DEVTOOLS_GLOBAL_HOOK__) hints.push('vue');
    if (global.ng || document.querySelector('[ng-version]')) hints.push('angular');
    if (document.querySelector('[data-svelte-h]')) hints.push('svelte');
    if (document.querySelector('#__next')) hints.push('nextjs');
    if (document.querySelector('#root')) hints.push('root-container');
    return {
      title: document.title,
      url: location.href,
      lang: document.documentElement.lang || 'unknown',
      charset: document.characterSet,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || undefined,
      scripts: document.scripts.length,
      stylesheets: document.styleSheets.length,
      frameworkHints: [...new Set(hints)],
    };
  });
}

async function captureScreenshot(
  payload: CaptureScreenshotPayload,
  tabId: number,
): Promise<CaptureScreenshotResult> {
  const tab = await resolveTargetTab(tabId);
  if (!tab.active) {
    // chrome.tabs.captureVisibleTab 只能截取"当前可见"的标签页，没有按 tabId 截图的 API；
    // 如果回合固定的目标标签页当前不可见（比如用户切去了别的标签页），
    // 与其静默截到错误的页面，不如明确报错。
    throw new Error('目标标签页当前不是可见标签页，无法截图（Chrome 只能截取当前可见标签页）。请切换回该标签页后重试。');
  }
  const format = payload?.format ?? 'png';
  const quality = payload?.quality;
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
    format,
    quality: format === 'jpeg' ? quality : undefined,
  });
  return { dataUrl };
}

async function executeInTab<TInput, TResult>(
  tabId: number,
  input: TInput,
  func: (input: TInput) => TResult | Promise<TResult>,
): Promise<TResult> {
  const tab = await resolveTargetTab(tabId);
  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [input],
    func,
  });
  return frame.result as TResult;
}

async function setStyle(payload: SetStylePayload, tabId: number): Promise<SetStyleResult> {
  return executeInTab(tabId, payload, (input): SetStyleResult => {
    const selector = input?.selector || '';
    const styles = input?.styles || {};
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      for (const [prop, value] of Object.entries(styles)) {
        node.style.setProperty(prop, value);
      }
    }
    return { selector, matched: nodes.length };
  });
}

async function modifyDom(payload: ModifyDomPayload, tabId: number): Promise<ModifyDomResult> {
  return executeInTab(tabId, payload, (input): ModifyDomResult => {
    const selector = input?.selector || '';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      switch (input?.action) {
        case 'remove':
          node.remove();
          break;
        case 'setText':
          node.textContent = input?.value ?? '';
          break;
        case 'setHtml':
          node.innerHTML = input?.value ?? '';
          break;
        case 'setAttribute':
          if (input?.attribute) node.setAttribute(input.attribute, input?.value ?? '');
          break;
        case 'addClass':
          if (input?.value) node.classList.add(input.value);
          break;
        case 'removeClass':
          if (input?.value) node.classList.remove(input.value);
          break;
      }
    }
    return { selector, matched: nodes.length, action: input?.action ?? 'remove' };
  });
}

async function clickElement(payload: ClickElementPayload, tabId: number): Promise<ClickElementResult> {
  if (payload?.fieldId) {
    return clickElementByFieldId(payload.fieldId, tabId);
  }
  const selector = payload?.selector || '';
  const index = payload?.index ?? 0;
  const result = await executeInTab(tabId, { selector, index }, clickElementInPage);
  return {
    selector,
    // clickElementInPage 只回报「给定 index 上的目标元素」的结果，不再统计选择器命中的总数；
    // matched/clickedIndex 保留字段是为了不破坏旧的结果形状，语义收窄为「该 index 上是否存在/点中了元素」。
    matched: result.status === 'not_found' ? 0 : 1,
    clickedIndex: result.status === 'ok' ? index : null,
    status: result.status,
    detail: result.detail,
    label: result.label,
    opensNewTab: result.opensNewTab,
    newFields: result.status === 'ok' ? await collectNewFieldsAfterWrite(tabId) : undefined,
  };
}

// fieldId 路径复用 applyFormFill 的「解析 path → 比对 expect → 派发点击 → 回读」逻辑，
// 把这次调用当成「零字段、只点一个提交目标」的 FILL_FORM 请求——不新增任何注入函数，
// 避免和 applyFormFill 的 submit 分支重复实现同一段点击派发代码。
async function clickElementByFieldId(fieldId: string, tabId: number): Promise<ClickElementResult> {
  const table = await getFormFieldsForTab(tabId);
  const plan = planFieldClick(fieldId, table);
  if (!plan.ok || !plan.submit) {
    return {
      selector: '',
      matched: 0,
      clickedIndex: null,
      status: 'not_found',
      detail:
        plan.reason === 'wrong_kind'
          ? '该 fieldId 是一个可滚动容器，不是可点击元素，请改用 browser_scroll。'
          : '未知的 fieldId，请重新调用 browser_get_form。',
      fieldsTableStale: plan.reason === 'no_table',
    };
  }

  const applied = await executeInTab(
    tabId,
    { url: table!.url, items: [], submit: plan.submit },
    applyFormFill,
  );

  if (applied.fieldsTableStale) {
    return {
      selector: '',
      matched: 0,
      clickedIndex: null,
      status: 'not_found',
      detail: '页面已导航，字段表已失效，请重新调用 browser_get_form。',
      fieldsTableStale: true,
    };
  }

  const submitted = applied.submitted;
  if (!submitted || submitted.status === 'not_found' || submitted.status === 'mismatch') {
    return {
      selector: '',
      matched: 0,
      clickedIndex: null,
      status: 'not_found',
      detail:
        submitted?.status === 'mismatch'
          ? '该位置的元素与读取时不一致，页面可能已变化，请重新调用 browser_get_form。'
          : '定位路径已解析不到元素，请重新调用 browser_get_form。',
    };
  }

  return {
    selector: '',
    matched: 1,
    clickedIndex: submitted.status === 'ok' ? 0 : null,
    status: submitted.status,
    label: submitted.label,
    opensNewTab: submitted.opensNewTab,
    newFields: submitted.status === 'ok' ? await collectNewFieldsAfterWrite(tabId) : undefined,
  };
}

async function typeText(payload: TypeTextPayload, tabId: number): Promise<TypeTextResult> {
  const selector = payload?.selector || '';
  const index = payload?.index ?? 0;
  const result = await executeInTab(
    tabId,
    { selector, index, text: payload?.text ?? '', replace: payload?.replace ?? true },
    typeTextInPage,
  );
  return {
    selector,
    matched: result.status !== 'not_found',
    value: result.actualValue ?? '',
    status: result.status,
    detail: result.detail,
    actualValue: result.actualValue,
    // 输入触发自动补全下拉是这里最典型的收益场景。
    newFields: result.status === 'ok' ? await collectNewFieldsAfterWrite(tabId) : undefined,
  };
}

async function selectOption(payload: SelectOptionPayload, tabId: number): Promise<SelectOptionResult> {
  const selector = payload?.selector || '';
  const index = payload?.index ?? 0;
  const result = await executeInTab(tabId, { selector, index, value: payload?.value ?? '' }, selectOptionInPage);
  return {
    selector,
    matched: result.status !== 'not_found',
    value: result.actualValue ?? payload?.value ?? '',
    status: result.status,
    detail: result.detail,
    actualValue: result.actualValue,
  };
}

async function scrollPage(payload: ScrollPagePayload, tabId: number): Promise<ScrollPageResult> {
  if (payload?.fieldId) {
    return scrollContainerByFieldId(payload, tabId);
  }
  return executeInTab(tabId, { selector: payload?.selector, x: payload?.x, y: payload?.y, behavior: payload?.behavior }, scrollPageInPage);
}

// fieldId 路径复用 clickElementByFieldId 的模式：查表 → 校验 kind → 注入解析+滚动。
async function scrollContainerByFieldId(payload: ScrollPagePayload, tabId: number): Promise<ScrollPageResult> {
  const table = await getFormFieldsForTab(tabId);
  const plan = planFieldScroll(payload.fieldId!, table);
  if (!plan.ok || !plan.target) {
    return {
      x: 0,
      y: 0,
      scrolledBy: 0,
      pixelsAbove: 0,
      pixelsBelow: 0,
      viewportHeight: 0,
      status: 'not_found',
      fieldsTableStale: plan.reason === 'no_table',
    };
  }

  const result = await executeInTab(
    tabId,
    { url: table!.url, path: plan.target.path, expect: plan.target.expect, x: payload.x, y: payload.y, behavior: payload.behavior },
    scrollContainerInPage,
  );

  return {
    x: result.x,
    y: result.y,
    scrolledBy: result.scrolledBy,
    pixelsAbove: result.pixelsAbove,
    pixelsBelow: result.pixelsBelow,
    viewportHeight: result.viewportHeight,
    container: result.status === 'ok' ? { tag: result.tag!, label: result.label } : undefined,
    status: result.status,
    fieldsTableStale: result.fieldsTableStale,
  };
}

// 拒绝非 http(s) 协议的跳转目标，防止 agent 被诱导跳转到 javascript:/file:/chrome: 等敏感 scheme。
// 这与 Task 4 在 decideToolPermission 中已加入的 scheme 校验重复，属于后端纵深防御，
// 与 isFetchUrlAllowed 采用的模式一致。
function isNavigableUrl(rawUrl: string): boolean {
  try {
    return /^https?:$/.test(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/** 等待跳转落地的上限。超时不算失败——照常回报当时读到的地址，由模型自己判断。 */
const NAVIGATE_SETTLE_TIMEOUT_MS = 10_000;
const MAX_PAGE_TITLE_CHARS = 120;

/** 等标签页加载完成；超时或标签页消失都静默返回，调用方随后自己读一次当前状态。 */
async function waitForTabLoad(tabId: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, NAVIGATE_SETTLE_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

async function navigateTab(payload: NavigateTabPayload, tabId: number): Promise<NavigateTabResult> {
  const requestedUrl = payload?.url ?? '';
  if (!isNavigableUrl(requestedUrl)) throw new Error('仅允许跳转到 http/https 地址。');

  const tab = await resolveTargetTab(tabId);

  await browser.tabs.update(tab.id, { url: requestedUrl });
  // 等落地再回读：不等的话最终地址永远等于请求地址，重定向（典型如被踢到登录页）
  // 对模型完全不可见，它会以为自己已经站在目标页上。
  await waitForTabLoad(tab.id!);

  const settled = await browser.tabs.get(tab.id!).catch(() => undefined);
  return {
    url: settled?.url || requestedUrl,
    requestedUrl,
    // 标题由网页控制，属于不可信数据，按纯文本净化并截断后才交给模型。
    title: settled?.title ? sanitizePageText(settled.title, MAX_PAGE_TITLE_CHARS) : undefined,
  };
}

/**
 * 在面板绑定 tab 所在的同一窗口里开一个新 tab，但不抢前台焦点（active: false）。
 *
 * @important 不能设 active: true。侧边栏在「按 tab 单独启用」模式下，浏览器切换活动 tab 到
 * 面板未绑定的 tab 时会整个销毁面板文档（ref: lib/agent/tab-conversation.ts 顶部注释）——
 * 如果这里把新 tab 设为前台，会在 browser_open_tab 执行的瞬间销毁正在运行这次回合的
 * 面板文档本身，直接杀死整个 agent 回合。遮罩依然会正确显示在后台 tab 上（后台 tab
 * 照常渲染，只是不是当前可见的那个），用户手动切过去就能看到，不需要靠抢焦点来实现
 * §3.4 的"遮罩跟随"目标。（Task 8 review 发现，2026-08-26。）
 */
async function openNewTab(payload: OpenNewTabPayload, panelTabId: number): Promise<OpenNewTabResult> {
  const requestedUrl = payload?.url ?? '';
  if (!isNavigableUrl(requestedUrl)) throw new Error('仅允许打开 http/https 地址。');

  const panelTab = await resolveTargetTab(panelTabId);
  const created = await browser.tabs.create({ windowId: panelTab.windowId, url: requestedUrl, active: false });
  if (typeof created.id !== 'number') throw new Error('新标签页创建失败。');

  await waitForTabLoad(created.id);

  const settled = await browser.tabs.get(created.id).catch(() => undefined);
  return {
    id: created.id,
    url: settled?.url || requestedUrl,
    title: settled?.title ? sanitizePageText(settled.title, MAX_PAGE_TITLE_CHARS) : undefined,
  };
}

/**
 * 关闭一个 tab。是否允许关闭（不能关面板自己绑定的 tab、只能关 tracked 列表里的）
 * 在工具层的 TabSessionController.close() 里已经把关，这里是纯 I/O，不重复校验——
 * 协议里 tabId 是单值字段，background 这一层拿不到"哪个是面板 tab"这个上下文
 * （ref: 设计文档 §3.6 的取舍说明）。
 */
async function closeTab(tabId: number): Promise<CloseTabResult> {
  await browser.tabs.remove(tabId);
  return { closed: true, tabId };
}

async function setStorage(payload: SetStoragePayload, tabId: number): Promise<SetStorageResult> {
  return executeInTab(tabId, payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key };
  });
}

async function setAgentOverlay(
  payload: SetAgentOverlayPayload,
  tabId: number,
): Promise<SetAgentOverlayResult> {
  if (payload.active) {
    await setOverlayForTab(tabId, payload.label ?? '');
  } else {
    await clearOverlayForTab(tabId);
  }
  await pushOverlayToTab(tabId, payload);
  return { active: payload.active };
}

/**
 * 下发失败一律吞掉：页面可能是 chrome:// 这类注入不进去的地址，也可能正在卸载。
 * 遮罩是纯视觉功能，绝不能让它的失败把一次真正的写操作变成失败。
 */
async function pushOverlayToTab(tabId: number, payload: SetAgentOverlayPayload): Promise<void> {
  try {
    await sendToContentScript(tabId, {
      id: newMessageId(),
      type: 'SET_AGENT_OVERLAY',
      payload,
    });
  } catch {
    // 忽略
  }
}

// 跳转后重建遮罩。
// 注意这里由 background 而非 content script 自查：storage.session 默认只对扩展内可信
// 上下文开放，content script 读不到，放宽访问级别等于把会话态暴露给每个页面的隔离世界。
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const state = await getOverlayForTab(tabId);
    if (!state) return;
    await pushOverlayToTab(tabId, { active: true, label: state.label });
  })();
});

// 标签页关掉后清掉它的遮罩状态，避免 tabId 被复用时错误重建。
browser.tabs.onRemoved.addListener((tabId) => {
  void clearOverlayForTab(tabId);
});

/**
 * 截图前先撤遮罩、拍完再恢复。
 * browser_screenshot 是只读工具，但遮罩起来之后模型照样能截图，会把光晕和光标一起
 * 拍进去当成页面内容——模型会据此推断页面上有个它没见过的紫色边框和箭头。
 */
async function captureScreenshotWithoutOverlay(
  payload: CaptureScreenshotPayload,
  tabId: number,
): Promise<CaptureScreenshotResult> {
  const state = await getOverlayForTab(tabId);
  if (!state) return captureScreenshot(payload, tabId);

  await pushOverlayToTab(tabId, { active: false });
  try {
    return await captureScreenshot(payload, tabId);
  } finally {
    await pushOverlayToTab(tabId, { active: true, label: state.label });
  }
}
