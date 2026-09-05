import {
  type CaptureScreenshotPayload,
  type CaptureScreenshotResult,
  type ClickElementPayload,
  type ClickElementResult,
  type FillFormFieldOutcome,
  type FillFormPayload,
  type FillFormResult,
  type FindTextPayload,
  type FindTextResult,
  type FindTextMatch,
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
  type NavigateHistoryResult,
  type OpenNewTabPayload,
  type OpenNewTabResult,
  type CloseTabResult,
  type AgentTakeoverResult,
  type AskSelectionPayload,
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
  type PressKeyPayload,
  type PressKeyResult,
  type ProbeClickTargetPayload,
  type ProbeClickTargetResult,
  type ProbeKeyTargetPayload,
  type QueryDomPayload,
  type QueryDomResult,
  type ScrollPagePayload,
  type ScrollPageResult,
  type SelectOptionPayload,
  type SelectOptionResult,
  type SetAgentOverlayPayload,
  type SetAgentOverlayResult,
  type SetStoragePayload,
  type GetStoragePayload,
  type GetStorageResult,
  type SetStorageResult,
  type SetStylePayload,
  type SetStyleResult,
  type TypeTextPayload,
  type TypeTextResult,
  type WaitForPayload,
  type WaitForResult,
  newMessageId,
  registerLocalDispatcher,
} from '@/lib/messaging';
import { loadRedactionSettings, redactText } from '@/lib/redaction';
import { fetchPageResourceText } from '@/lib/page-resource-fetch';
import { resolveTargetTab } from '@/lib/agent/tab-target';
import { performGoBack, waitForTabLoadComplete, NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS } from '@/lib/agent/history-nav';
import { sendToContentScript } from '@/lib/agent/content-script-messaging';
import { clearOverlayForTab, getOverlayForTab, setOverlayForTab } from '@/lib/agent/tab-overlay-state';
import { clearConversationIdForTab } from '@/lib/agent/tab-conversation';
import { clearPendingAskForTab, setPendingAskForTab } from '@/lib/agent/tab-pending-ask';
import { setTakeoverForTab } from '@/lib/agent/tab-takeover';
import { clearTabSession } from '@/lib/agent/tab-session-storage';
import { AGENT_RUN_PORT_NAME, type PanelToBackground } from '@/lib/agent/run-port-protocol';
import {
  startRun,
  respondConfirm,
  respondQuestion,
  stopRun,
  attachPort,
  detachPort,
  scanForOrphans,
  markConversationDeleted,
  unmarkConversationDeleted,
} from '@/lib/agent/run-registry';
import { loadLocale, applyLocale, LOCALE_KEY } from '@/lib/i18n';
import {
  SIDE_PANEL_PATH,
  enableAndOpenPanelForTab,
  clearPanelOpenedForTab,
  decideTabPanelOptions,
  isPanelOpenedForTab,
  listPanelOpenedTabs,
  markPanelOpenedForTab,
} from '@/lib/tab-panel-scope';
import {
  groupItemsByFrame,
  isChildFrameHandle,
  mergeFillOutcomes,
  planFieldClick,
  planFieldScroll,
  planFormFill,
  planFrameGroupExecution,
  planProbeTarget,
  resolveExpectOrigin,
  skippedFrameGroupOutcomes,
  type FormFillFrameGroup,
} from '@/lib/agent/fill-form-request';
import { DEFAULT_FIND_TEXT_LIMIT, MAX_FIND_TEXT_LIMIT, mergeFindTextHandles } from '@/lib/agent/find-text';
import {
  applyFormFill,
  clickElementInPage,
  collectFormFields,
  pressKeyInPage,
  probeClickTarget,
  probeKeyTarget,
  scrollContainerInPage,
  scrollPageInPage,
  selectOptionInPage,
  typeTextInPage,
  type ApplyFillItem,
  type CollectFormInput,
} from '@/lib/agent/form-dom';
import { findTextInPage, type RawTextMatch } from '@/lib/agent/find-text-dom';
import { findNewFieldIds, sanitizeFieldText, sanitizePageText, toFieldDescriptor, toScrollableContainerDescriptor, type FormFieldPathStep } from '@/lib/agent/form-schema';
import { getFormFieldsForTab, setFormFieldsForTab, type FormFieldHandle } from '@/lib/agent/tab-form-fields';
import { mergeFrameCollections, mergeReadResultsByFrame, type MergedCollection } from '@/lib/agent/frame-merge';
import { decideEnterSubmitIntent, decideSubmitIntent } from '@/lib/agent/form-submit';
import { resolveKeyDescriptor } from '@/lib/agent/key-dispatch';
import { waitForConditionInPage } from '@/lib/agent/wait-dom';
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS } from '@/lib/agent/wait-condition';
import {
  SCREENSHOT_FALLBACK_QUALITY,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_EDGE,
  encodeBase64,
  planScreenshotResize,
} from '@/lib/agent/screenshot-image';

const DEFAULT_TOOL_MAX_CHARS = 12000;
// 以下为模型可见/可调用的消息类型；内部专用消息（如 SET_AGENT_OVERLAY）有意不在此列，以免暴露给模型。
const SUPPORTED_MESSAGE_TYPES = [
  'PING',
  'EXTRACT_PAGE',
  'GET_SELECTION',
  'ASK_SELECTION',
  'GET_ACTIVE_TAB',
  'QUERY_DOM',
  'FIND_TEXT',
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
  'PRESS_KEY',
  'PROBE_KEY_TARGET',
  'SCROLL_PAGE',
  'WAIT_FOR',
  'NAVIGATE_TAB',
  'NAVIGATE_HISTORY',
  'OPEN_NEW_TAB',
  'CLOSE_TAB',
  'SET_STORAGE',
  'GET_STORAGE',
  'CHAT',
] as const;

// Service Worker：消息路由中心（ref: technical-plan.md §3.2）
export default defineBackground(() => {
  // agent 主循环现在跑在 background 自己的执行上下文里，lib/agent/tools.ts、agent.ts 的
  // browser_* 工具调用的 sendMessage() 因此变成了"自己给自己发运行时消息"——按 WebExtensions
  // 规范，runtime.onMessage 不会派发给发消息的那个 frame 自己，继续走消息总线会让这些调用
  // 全部等不到响应。这里注册本地直连出口，让 sendMessage() 绕开总线直接调用 handleMessage。
  registerLocalDispatcher((message) => handleMessage(message, undefined));

  // 每次 Service Worker 启动都重新确立"面板按 tab 绑定"这条约束（见 lib/tab-panel-scope.ts）。
  // 不能只挂在 runtime.onInstalled 上：那只在安装/更新时触发一次，浏览器重启、扩展重新启用
  // 都不会再触发，而 manifest 的 side_panel.default_path 会让全局默认悄悄恢复成"所有 tab 都开"，
  // 于是在 A 标签页打开的面板会跟着切换显示到 B 标签页上。
  syncSidePanelScope().catch((err: unknown) => console.error('[Runi] sidePanel scope sync:', err));

  // background 和面板是两份独立的 lib/i18n 模块实例，各自的 currentLocale 单例互不相通。
  // describeToolActivity/describeEmptyAgentRun 等格式化函数现在跑在 background 里（见
  // lib/agent/run-registry.ts），必须显式把 background 自己这份 currentLocale 与用户在
  // chrome.storage.local 里的语言偏好同步，否则永远停在 service worker 冷启动那一刻的默认值。
  loadLocale().then(applyLocale).catch((err: unknown) => console.error('[Runi] locale sync on startup:', err));
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[LOCALE_KEY]) return;
    loadLocale().then(applyLocale).catch((err: unknown) => console.error('[Runi] locale sync on change:', err));
  });

  // 冷启动孤儿扫描：见 lib/agent/run-registry.ts 的 scanForOrphans 文档注释。这里只是触发，
  // 不需要处理返回值——它已经把 failure 消息写进了 Dexie；面板重连时会走 attachPort 返回
  // undefined -> 面板照常从 Dexie 读历史，自然看到这条 failure 消息，不需要额外的 orphanResolved
  // 推送路径（Task 6 的面板实现相应地不需要特殊处理 orphanResolved 消息类型）。
  scanForOrphans().catch((err: unknown) => console.error('[Runi] scanForOrphans:', err));

  // chrome.alarms 只把事件派发给已注册的监听器；没有监听器时 alarm 触发不会唤醒/续命
  // service worker，run-registry.ts 里那个 20s 周期的保活 alarm 就完全是空转。
  // 这个回调**有意为空**：让 Chrome 有一个事件可派发、从而重置空闲回收计时器，本身就是
  // 保活的全部作用，不需要任何业务逻辑（ref: 实现计划 Task 4 Step 4）。
  browser.alarms.onAlarm.addListener(() => {
    // 有意留空，见上方注释。
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_RUN_PORT_NAME) return;

    // 这条 Port 承载确认闸门的应答（本项目最主要的 human-in-the-loop 安全控制）与
    // startRun/stop，只接受来自本扩展自己的侧边栏文档的连接。用 runtime.getURL 拼出的
    // 完整 chrome-extension:// 前缀做 startsWith 比对，而不是对路径做 includes——
    // 后者会被 https://evil.example/sidepanel.html 这样的页面地址蒙混过关。
    // getURL 的 WXT 类型要求以 `/` 开头的 public path；SIDE_PANEL_PATH 本身是 manifest 里
    // 用的相对写法，这里补上前导斜杠，结果是同一个 chrome-extension://<id>/sidepanel.html。
    const sidePanelUrl = browser.runtime.getURL(`/${SIDE_PANEL_PATH}`);
    if (!port.sender?.url?.startsWith(sidePanelUrl)) {
      console.warn('[Runi] 拒绝非侧边栏来源的 agent-run Port 连接:', port.sender?.url);
      port.disconnect();
      return;
    }

    let boundTabId: number | undefined;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as PanelToBackground;
      if (message.type === 'hello') {
        boundTabId = message.tabId;
        const snapshot = attachPort(message.tabId, port);
        // 没有存活 run 时也必须显式回一条：面板靠这条回包决定"用背景的权威快照重建，
        // 还是回退到从 Dexie 读历史"，沉默会让每次冷挂载都白等一次超时。
        port.postMessage(
          snapshot ? { type: 'snapshot', ...snapshot } : { type: 'noRun', tabId: message.tabId },
        );
        return;
      }

      // hello 是这条连接唯一一次声明身份的机会；此后每条消息都必须指向同一个 tabId，
      // 否则一个面板可以替另一个 tab 批准确认卡片、中止别人的 run。
      if (boundTabId === undefined || message.tabId !== boundTabId) {
        console.warn(
          `[Runi] 忽略与 hello 绑定 tabId(${String(boundTabId)}) 不符的 agent-run 消息：${message.type} tabId=${message.tabId}`,
        );
        return;
      }

      switch (message.type) {
        case 'startRun':
          void startRun(message);
          break;
        case 'respondConfirm':
          respondConfirm(message.tabId, message.toolCallId, message.approved);
          break;
        case 'respondQuestion':
          respondQuestion(message.tabId, message.toolCallId, message.answer);
          break;
        case 'stop':
          stopRun(message.tabId);
          break;
        case 'conversationDeleted':
          // 面板删掉的会话可能正被另一个 tab 上的 run 持有——只有这里能把 conversationId
          // 关联回持有它的 RunState，所以不按 tabId 过滤会话身份本身。
          if (message.deleted) markConversationDeleted(message.conversationId);
          else unmarkConversationDeleted(message.conversationId);
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      if (typeof boundTabId === 'number') detachPort(boundTabId, port);
    });
  });

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

  // 启用 + 打开必须在这一段同步执行里发起，中间不能插入任何 await——手势的有效期只覆盖
  // 监听器的同步执行段，跨过一次 await 就会拿到
  // "`sidePanel.open()` may only be called in response to a user gesture."
  // （2026-09-02 实测：await 只花了 1ms 也照样失效）。约束与理由见
  // lib/tab-panel-scope.ts 的 enableAndOpenPanelForTab。
  const outcome = await enableAndOpenPanelForTab(browser.sidePanel, tabId);
  if (outcome.setOptionsError) {
    console.error('[Runi] sidePanel setOptions (ask-selection):', outcome.setOptionsError);
  }
  if (!outcome.opened) {
    console.error('[Runi] sidePanel open (ask-selection):', outcome.error);
  }

  // 只有真的打开了才记账。失败时若照样记成"这个 tab 开过面板"，这个 tab 就会一直保持
  // enabled:true，用户切到它时面板会跟过来显示——正是 lib/tab-panel-scope.ts 要挡的那个问题。
  if (outcome.opened) await markPanelOpenedForTab(tabId);

  // 待提问的选中文本无论如何都留下：即使这次没打开成功，用户手动点开面板时仍能接上。
  await setPendingAskForTab(tabId, text);
}

/**
 * 与 ASK_SELECTION 同类：content script 主动发起、不带 tabId，身份取自 sender.tab.id。
 * 时间戳由这里生成而不是采信页面传上来的值——页面里的一切都是不可信输入。
 */
async function handleAgentTakeover(sender: MessageSender | undefined): Promise<AgentTakeoverResult> {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return { recorded: false };
  await setTakeoverForTab(tabId, Date.now());
  return { recorded: true };
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

    case 'AGENT_TAKEOVER':
      return handleAgentTakeover(sender);

    case 'QUERY_DOM':
      return queryDom(message.payload as QueryDomPayload, requireTabId(message));

    case 'FIND_TEXT':
      return findText(message.payload as FindTextPayload, requireTabId(message));

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

    case 'PRESS_KEY':
      return pressKey(message.payload as PressKeyPayload, requireTabId(message));

    case 'PROBE_KEY_TARGET':
      return probeEnterSubmitIntent(message.payload as ProbeKeyTargetPayload, requireTabId(message));

    case 'SCROLL_PAGE':
      return scrollPage(message.payload as ScrollPagePayload, requireTabId(message));

    case 'WAIT_FOR':
      return waitForCondition(message.payload as WaitForPayload, requireTabId(message));

    case 'NAVIGATE_TAB':
      return navigateTab(message.payload as NavigateTabPayload, requireTabId(message));

    case 'NAVIGATE_HISTORY':
      return navigateHistory(requireTabId(message));

    case 'OPEN_NEW_TAB':
      return openNewTab(message.payload as OpenNewTabPayload, requireTabId(message));

    case 'CLOSE_TAB':
      return closeTab(requireTabId(message));

    case 'SET_STORAGE':
      return setStorage(message.payload as SetStoragePayload, requireTabId(message));

    case 'GET_STORAGE':
      return getStorage(message.payload as GetStoragePayload, requireTabId(message));

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

// 广播注入函数必须自包含：只能引用自己的参数与真实全局（window/document/location），
// 且自己用 window.top 在两份 args 里挑一份（ref: 2026-09-05 final review Critical #1）。
// 这三个只读工具对每一帧下发的输入完全相同，挑哪份都一样，但签名形状必须一致才能直接
// 作为 executeScript 的 func 使用。
const queryDomInPage = (
  mainInput: QueryDomPayload,
  childInput: QueryDomPayload,
): QueryDomResult & { origin: string } => {
  const input = window.top === window ? mainInput : childInput;
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
    origin: location.origin,
  };
};

// 只读裸选择器广播到全部帧：同一选择器在多帧命中对读取是有用信息，与写工具的
// 单帧原则（见 clickElement 等处注释）不同（ref: spec §4.6）。
async function queryDom(payload: QueryDomPayload, tabId: number): Promise<QueryDomResult> {
  const frames = await executeInAllFrames(tabId, () => payload, queryDomInPage);
  return mergeReadResultsByFrame(frames, (output) => output.count > 0);
}

async function findText(payload: FindTextPayload, tabId: number): Promise<FindTextResult> {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  const mode: 'contains' | 'exact' = payload?.mode === 'exact' ? 'exact' : 'contains';
  const rawLimit = payload?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(MAX_FIND_TEXT_LIMIT, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_FIND_TEXT_LIMIT;

  const frames = await executeInAllFrames(tabId, () => ({ text, mode }), findTextInPage);
  const main = frames.find((frame) => frame.isMain);
  const children = frames.filter((frame) => !frame.isMain);
  const ordered = main ? [main, ...children] : children;

  const flat: { frameId: number; frameOrigin: string; raw: RawTextMatch }[] = [];
  for (const frame of ordered) {
    for (const raw of frame.output.matches) {
      flat.push({ frameId: frame.frameId, frameOrigin: frame.origin, raw });
    }
  }
  const truncated = frames.some((frame) => frame.output.truncated) || flat.length > limit;
  const kept = flat.slice(0, limit);

  // 主框架缺席（CSP 拒绝注入、帧在调用途中销毁）时退到第一个可用帧的 URL，与
  // mergeFrameCollections 的 `main?.output.url ?? collections[0]?.output.url ?? ''`
  // 同一条兜底链：空串会让 mergeFindTextHandles 发出一张 url 为空的句柄表，接着任何
  // 写入都因 url 不符判为 stale（ref: 2026-09-05 final review Minor #6）。
  const currentUrl = main?.output.url ?? frames[0]?.output.url ?? '';
  const existingTable = await getFormFieldsForTab(tabId);
  const table = mergeFindTextHandles(
    existingTable,
    currentUrl,
    kept.map((entry) => ({
      path: entry.raw.path,
      tag: entry.raw.tag,
      type: entry.raw.type,
      name: entry.raw.name,
      href: entry.raw.href,
      frameId: entry.frameId,
      frameOrigin: entry.frameOrigin,
    })),
  );
  await setFormFieldsForTab(tabId, table);

  const matches: FindTextMatch[] = kept.map((entry, index) => ({
    fieldId: `t${index + 1}`,
    tag: entry.raw.tag,
    text: sanitizeFieldText(entry.raw.text).text ?? '',
    visible: entry.raw.visible,
    clickable: entry.raw.clickable,
    context: sanitizeFieldText(entry.raw.context).text,
    frameOrigin: entry.frameId === 0 ? undefined : entry.frameOrigin,
  }));

  return { matches, truncated };
}

const MAX_FORM_FIELDS = 120;
const MAX_SELECT_OPTIONS = 50;

interface FieldSnapshot {
  collected: MergedCollection;
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
  const frames = await executeInAllFrames(
    tabId,
    (isMain): CollectFormInput => ({
      // selector 是「把范围收窄到这个容器」，跨帧的容器概念不成立：传了就只采主框架。
      selector: payload?.selector,
      includeHidden: payload?.includeHidden,
      includeText: payload?.includeText,
      includeScrollable: payload?.includeScrollable,
      maxFields: MAX_FORM_FIELDS,
      maxOptions: MAX_SELECT_OPTIONS,
      scope: isMain ? 'main' : 'child',
    }),
    collectFormFields,
  );
  const scoped = payload?.selector ? frames.filter((frame) => frame.isMain) : frames;
  const collected = mergeFrameCollections(scoped);

  const fields: FormFieldDescriptor[] = [];
  const handles: Record<string, FormFieldHandle> = {};
  const orphanFieldIds: string[] = [];
  let textTruncated = false;

  collected.raws.forEach((raw, index) => {
    const fieldId = `f${index + 1}`;
    // FormFieldDescriptor.frameOrigin 是「模型该把这个字段当子帧」的分组信号，只在真的是子帧
    // 时才传：mergeFrameCollections 给主框架的 raw 也挂了 frameOrigin（值为主站自己的 origin，
    // 供下面 handles 表的写入前 origin 比对使用），如果原样转发给 toFieldDescriptor，主框架
    // 字段会被 renderFormResultForModel 误判成子帧、套上一个多余的「嵌入框架 <主站 origin>」
    // 标题。主框架固定是 frameId 0（与 executeInAllFrames 的 isMain 判定同一约定）。
    const descriptor = toFieldDescriptor(
      raw.frameId === 0 ? { ...raw, frameOrigin: undefined } : raw,
      fieldId,
    );
    fields.push(descriptor);
    handles[fieldId] = {
      path: raw.path,
      expect: { tag: raw.tag, type: raw.type, name: raw.name, label: descriptor.label, href: raw.href },
      sensitive: descriptor.sensitive,
      kind: descriptor.kind,
      // mergeFrameCollections 已经把每条 raw 挂上了它所在帧的 frameId/origin
      // （主框架也不例外，值为 0/主框架 origin）——写入前的 origin 比对靠这两个字段。
      frameId: raw.frameId,
      frameOrigin: raw.frameOrigin,
    };
    if (!descriptor.formId) orphanFieldIds.push(fieldId);
    if (sanitizeFieldText(raw.precedingText, 'tail').truncated) textTruncated = true;
  });

  const scrollableContainers: ScrollableContainerDescriptor[] | undefined = collected.scrollables?.map(
    (raw, index) => {
      const fieldId = `s${index + 1}`;
      // 有意不带 frameId/frameOrigin：mergeFrameCollections 的 scrollables 只来自主框架的
      // 采集输出（见该函数），可滚动容器目前是主框架专属的采集能力，不存在子帧句柄。
      // scrollContainerInPage 的 origin 校验因此在生产中永远不会被这条路径触发——
      // 只受它自己的单元测试保护（ref: 2026-09-04 review Minor）。
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
    droppedFrames: collected.droppedFrames,
    droppedChildFields: collected.droppedChildFields,
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
  // 一次 fill_form 天然可能横跨多个帧（主框架字段 + 支付 iframe 里的卡号，都来自同一次
  // browser_get_form 快照）：按每个字段/提交句柄各自的 frameId 分组，每组独立一次
  // executeInTab + 独立的 origin 校验，不能只用"代表整批"的一个句柄
  // （ref: 设计文档 §3.3，2026-09-04 review Critical #2）。未混帧的常见情形（所有字段
  // 和提交都在主框架）分组后仍恰好是一组，行为与此前完全一致。
  const groups = groupItemsByFrame(plan.items, plan.submit, table);
  const runGroup = (group: FormFillFrameGroup) =>
    executeInTab(
      tabId,
      {
        url: table.url,
        items: group.items,
        submit: group.submit,
        expectOrigin: group.frameOrigin,
        // 子帧写操作跳过顶层执行遮罩的光标动画/等待——该动画的自定义事件是通过 window
        // CustomEvent 派发的，从子帧永远到不了顶层的 content script（ref: Task 9）。
        isChildFrame: isChildFrameHandle(group),
      },
      applyFormFill,
      { frameId: group.frameId },
    );

  // 提交必须排在所有纯写入之后：并发的 executeScript 之间没有完成顺序保证，把提交组和
  // 写入组一起 Promise.all，完全可能在别的帧的字段还没写完时就把表单提交出去
  // （ref: 2026-09-05 final review Critical #2）。未混帧的常见情形（字段与提交同属一组）
  // 拆分后 writeGroups 为空、只跑提交组这一次调用，行为与此前完全一致。
  const { writeGroups, submitGroup } = planFrameGroupExecution(groups);
  const writeResults = await Promise.all(writeGroups.map(runGroup));
  const writesStale = writeResults.some((applied) => applied.fieldsTableStale);

  // 前面任一帧已过期就不再提交：宁可让模型重新 get_form，也不能对一张字段没填全的表单
  // 按下提交。提交组自己的字段合成 mismatch 结果，而不是让它们静默变成 not_found。
  const submitResult = submitGroup && !writesStale ? await runGroup(submitGroup) : undefined;
  const skippedOutcomes = submitGroup && writesStale ? skippedFrameGroupOutcomes(submitGroup) : [];

  const allOutcomes = [
    ...writeResults.flatMap((applied) => applied.outcomes),
    ...(submitResult?.outcomes ?? []),
    ...skippedOutcomes,
  ];
  // 任一帧过期就如实标记 stale（模型据此重新 get_form），但不再把已经落地的那些帧的
  // outcomes 一并抹成空数组——那等于隐瞒了真实发生过的写入。
  const fieldsTableStale = writesStale || submitResult?.fieldsTableStale === true;

  return {
    outcomes: mergeFillOutcomes(payload, plan.blocked, allOutcomes),
    submitted: plan.submitFieldMissing
      ? { fieldId: payload!.submit!.fieldId, status: 'not_found' as const }
      : submitResult?.submitted,
    fieldsTableStale: fieldsTableStale || undefined,
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

  // 提交探测必须跟着句柄的 frameId 走：子帧字段若还是只打主框架，探测会找不到目标，
  // 而"探测失败⇒当作非提交放行"的既有降级会让子帧里的每一次表单提交都绕过确认闸门
  // （ref: 设计文档 §5.2，这是整个设计里唯一能静默打穿确认闸门的地方）。
  const target = planProbeTarget(payload?.submitFieldId, table);
  if (!payload?.selector && !target.path) return { isSubmit: false, fieldLabels };

  const probe = await executeInTab(
    tabId,
    { selector: payload?.selector, index: payload?.index, path: target.path },
    probeClickTarget,
    { frameId: target.frameId },
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
    frameOrigin: target.expectOrigin,
    fieldLabels,
  };
}

/** Enter 的隐式提交探测。与 probeSubmitIntent 并列而非合并：判据与输入形状都不同。 */
async function probeEnterSubmitIntent(
  payload: ProbeKeyTargetPayload,
  tabId: number,
): Promise<ProbeClickTargetResult> {
  const needsTable = Boolean(payload?.fieldId || payload?.fieldIds?.length);
  const table = needsTable ? await getFormFieldsForTab(tabId) : undefined;

  const fieldLabels = payload?.fieldIds?.map((fieldId) => ({
    fieldId,
    label: table?.fields[fieldId]?.expect.label,
  }));

  // 同 probeSubmitIntent：探测必须跟着句柄的 frameId 走，否则子帧字段的 Enter 隐式
  // 提交探测永远探不到目标，会被降级为「非提交」放行，绕过确认闸门（ref: 设计文档 §5.2）。
  const target = planProbeTarget(payload?.fieldId, table);
  if (!target.path && !payload?.selector && !payload?.useActiveElement) {
    return { isSubmit: false, fieldLabels };
  }

  const probe = await executeInTab(
    tabId,
    {
      path: target.path,
      selector: payload?.selector,
      index: payload?.index,
      useActiveElement: payload?.useActiveElement,
    },
    probeKeyTarget,
    { frameId: target.frameId },
  );
  if (!probe.found) return { isSubmit: false, fieldLabels };

  return {
    ...decideEnterSubmitIntent({
      tag: probe.tag,
      type: probe.type,
      hasFormOwner: probe.hasFormOwner,
      formAction: probe.formAction,
      fieldCount: probe.fieldCount,
      hasSubmitButton: probe.hasSubmitButton,
      textLikeFieldCount: probe.textLikeFieldCount,
    }),
    frameOrigin: target.expectOrigin,
    fieldLabels,
  };
}

// 自包含 + 自选参数，理由同 queryDomInPage 上方的注释。
const getHtmlInPage = (
  mainInput: GetHtmlPayload,
  childInput: GetHtmlPayload,
): GetHtmlResult & { origin: string } => {
  const input = window.top === window ? mainInput : childInput;
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
    origin: location.origin,
  };
};

// 只读裸选择器广播到全部帧，理由同 queryDom 上方的注释。
async function getHtml(payload: GetHtmlPayload, tabId: number): Promise<GetHtmlResult> {
  const frames = await executeInAllFrames(tabId, () => payload, getHtmlInPage);
  return mergeReadResultsByFrame(frames, (output) => output.count > 0 && output.html.trim().length > 0);
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

// 自包含 + 自选参数，理由同 queryDomInPage 上方的注释。
const getComputedStyleInPage = (
  mainInput: GetComputedStylePayload,
  childInput: GetComputedStylePayload,
): GetComputedStyleResult & { origin: string } => {
  const input = window.top === window ? mainInput : childInput;
  const selector = input?.selector || 'body';
  const element = document.querySelector(selector);
  if (!element) return { selector, found: false, styles: {}, origin: location.origin };
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
  return { selector, found: true, styles, origin: location.origin };
};

// 只读裸选择器广播到全部帧，理由同 queryDom 上方的注释。
async function getComputedStyleForSelector(
  payload: GetComputedStylePayload,
  tabId: number,
): Promise<GetComputedStyleResult> {
  const frames = await executeInAllFrames(tabId, () => payload, getComputedStyleInPage);
  return mergeReadResultsByFrame(frames, (output) => output.found);
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
): Promise<{ dataUrl: string }> {
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
  options?: { frameId?: number },
): Promise<TResult> {
  const tab = await resolveTargetTab(tabId);
  const [frame] = await browser.scripting.executeScript({
    // frameId 缺省即主框架，与改动前的 { tabId } 等价。
    target: options?.frameId === undefined ? { tabId: tab.id } : { tabId: tab.id, frameIds: [options.frameId] },
    world: 'MAIN',
    args: [input],
    func,
  });
  return frame.result as TResult;
}

/**
 * 广播注入并按帧收集结果。跨源子帧靠 host_permissions '<all_urls>' 覆盖，
 * 不需要 webNavigation：每条 InjectionResult 自带 frameId。
 * 单帧注入失败（CSP 拒绝、帧已销毁）不该让整次采集失败——result 为空的帧直接跳过。
 */
async function executeInAllFrames<TInput, TResult extends { origin: string }>(
  tabId: number,
  buildInput: (isMain: boolean) => TInput,
  // func 必须是自包含的顶层函数：内部自己用 window.top === window 在 mainInput/childInput
  // 两份参数里挑一份用。不能像过去那样在这里包一层引用外部变量的闭包再转调——
  // executeScript 序列化会丢失所有闭包绑定，那层包装函数在页面里执行时，
  // 它引用的外部变量早已不存在（ref: 2026-09-05 final review Critical #1）。
  func: (mainInput: TInput, childInput: TInput) => TResult | Promise<TResult>,
): Promise<{ frameId: number; origin: string; isMain: boolean; output: TResult }[]> {
  const tab = await resolveTargetTab(tabId);
  const results = await browser.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    // executeScript 无法给不同帧传不同 args：两份输入都发下去，由 func 自己挑。
    args: [buildInput(true), buildInput(false)],
    func,
  });
  return results
    .filter((entry) => entry.result)
    .map((entry) => {
      const output = entry.result as TResult;
      return { frameId: entry.frameId, origin: output.origin, isMain: entry.frameId === 0, output };
    });
}

async function setStyle(payload: SetStylePayload, tabId: number): Promise<SetStyleResult> {
  // 有意不广播到所有帧：写入必须单帧可预期，跨帧写入需要 browser_get_form + fieldId
  // 句柄（带写入前后校验），裸选择器兜底只作用于主框架（ref: spec §4.6）。
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
  // 有意不广播到所有帧：理由同 setStyle 上方的注释。
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
  // 有意不广播到所有帧：没有 fieldId 的裸选择器点击只作用于主框架，理由同 setStyle 上方的注释。
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

  const handle = table?.fields[fieldId];
  const applied = await executeInTab(
    tabId,
    {
      url: table!.url,
      items: [],
      submit: plan.submit,
      expectOrigin: resolveExpectOrigin(handle),
      // 同上：子帧点击跳过顶层执行遮罩的光标动画/等待。
      isChildFrame: isChildFrameHandle(handle),
    },
    applyFormFill,
    { frameId: handle?.frameId },
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
  // 有意不广播到所有帧：裸选择器输入只作用于主框架，理由同 setStyle 上方的注释。
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
  // 有意不广播到所有帧：裸选择器下拉选择只作用于主框架，理由同 setStyle 上方的注释。
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

async function pressKey(payload: PressKeyPayload, tabId: number): Promise<PressKeyResult> {
  const resolved = resolveKeyDescriptor(payload?.key, payload?.modifiers);
  if (!resolved.ok) {
    return { status: 'not_found', key: String(payload?.key ?? ''), defaultPrevented: false, submitted: false, detail: resolved.error };
  }

  let path: FormFieldPathStep[] | undefined;
  let url: string | undefined;
  let expect: { tag: string; type?: string; name?: string } | undefined;
  let handle: FormFieldHandle | undefined;
  if (payload?.fieldId) {
    const table = await getFormFieldsForTab(tabId);
    const plan = planFieldClick(payload.fieldId, table);
    if (!plan.ok || !plan.submit) {
      return {
        status: 'not_found',
        key: resolved.descriptor.key,
        defaultPrevented: false,
        submitted: false,
        detail:
          plan.reason === 'wrong_kind'
            ? '该 fieldId 是一个可滚动容器，不能对它按键。'
            : '未知的 fieldId，请重新调用 browser_get_form。',
        fieldsTableStale: plan.reason === 'no_table',
      };
    }
    path = plan.submit.path;
    url = table?.url;
    expect = plan.submit.expect;
    handle = table?.fields[payload.fieldId];
  }

  // Enter 是否提交由这里决定，页面侧不自行判断：确认闸门已经在 beforeToolCall
  // 里就同一份探测结果征得用户同意，这里必须用同一份判定，否则会出现
  // "确认时说不提交、执行时却提交了"的错位。
  let submitOnEnter = false;
  if (resolved.descriptor.key === 'Enter') {
    const intent = await probeEnterSubmitIntent(
      {
        fieldId: payload?.fieldId,
        selector: payload?.selector,
        index: payload?.index,
        useActiveElement: !payload?.fieldId && !payload?.selector,
      },
      tabId,
    );
    submitOnEnter = intent.isSubmit;
  }

  const result = await executeInTab(
    tabId,
    {
      path,
      selector: path ? undefined : payload?.selector,
      index: payload?.index,
      useActiveElement: !path && !payload?.selector,
      descriptor: resolved.descriptor,
      submitOnEnter,
      url,
      expect,
      expectOrigin: resolveExpectOrigin(handle),
    },
    pressKeyInPage,
    { frameId: handle?.frameId },
  );

  return {
    status: result.status,
    key: resolved.descriptor.key,
    target: result.target,
    defaultPrevented: result.defaultPrevented,
    submitted: result.submitted,
    fieldsTableStale: result.fieldsTableStale,
    newFields: result.status === 'ok' ? await collectNewFieldsAfterWrite(tabId) : undefined,
  };
}

async function scrollPage(payload: ScrollPagePayload, tabId: number): Promise<ScrollPageResult> {
  if (payload?.fieldId) {
    return scrollContainerByFieldId(payload, tabId);
  }
  // 有意不广播到所有帧：坐标滚动只作用于主框架——跨帧滚动没有共同坐标系，
  // 跨帧场景应改用 browser_get_form 拿到 fieldId 句柄后走 scrollContainerByFieldId。
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

  const handle = table?.fields[payload.fieldId!];
  const result = await executeInTab(
    tabId,
    {
      url: table!.url,
      path: plan.target.path,
      expect: plan.target.expect,
      x: payload.x,
      y: payload.y,
      behavior: payload.behavior,
      expectOrigin: resolveExpectOrigin(handle),
    },
    scrollContainerInPage,
    { frameId: handle?.frameId },
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

/**
 * 注入函数自己带超时，正常路径不会挂住；这里再加一层略长的兜底，是防注入上下文
 * 因导航被销毁而使 executeScript 的 promise 永远不结算。executeScript 本身的
 * 失败（页面已关闭、被 CSP 拒绝等）收敛成 unavailable:true 的"没等到"，而不是
 * 让整轮任务报错——这属于基础设施失败，和超时是同一档严重程度，都不该比
 * "选择器写错了"（页面内报告的 error，模型可以自己修正）更重。两者不共用
 * error 字段：error 专指后者。
 */
async function waitForCondition(payload: WaitForPayload, tabId: number): Promise<WaitForResult> {
  const timeoutMs = clampWaitTimeoutMs(payload.timeoutMs);
  const guardMs = timeoutMs + 2000;
  const startedAt = Date.now();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<WaitForResult>((resolve) => {
    guardTimer = setTimeout(
      () => resolve({ met: false, elapsedMs: Date.now() - startedAt }),
      guardMs,
    );
  });

  try {
    return await Promise.race([
      executeInTab(tabId, { ...payload, timeoutMs }, waitForConditionInPage).catch(
        (): WaitForResult => ({
          met: false,
          elapsedMs: Date.now() - startedAt,
          unavailable: true,
        }),
      ),
      guard,
    ]);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}

// WAIT_FOR 走 SUPPORTED_MESSAGE_TYPES 的通用分发，handleMessage 不按调用方类型区分校验；
// 正常路径的载荷都经过 parseWaitCondition 夹好范围，但这里独立兜底一次，防止一个缺
// timeoutMs 的畸形载荷把 guardMs 算成 NaN（NaN 定时器立即触发，等于静默空等）。
// 与 permissions.ts/isNavigableUrl 对 http(s) scheme 的独立校验是同一种纵深防御模式。
function clampWaitTimeoutMs(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, Math.floor(value)));
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

async function navigateHistory(tabId: number): Promise<NavigateHistoryResult> {
  const tab = await resolveTargetTab(tabId);
  return performGoBack({
    goBack: () => browser.tabs.goBack(tab.id),
    getTab: () => browser.tabs.get(tab.id).catch(() => undefined),
    onceLoadComplete: () => waitForTabLoadComplete(tab.id, NAVIGATE_HISTORY_SETTLE_TIMEOUT_MS),
  });
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

/**
 * 注入函数只把 key/value 原样搬出来，一个判断都不做——它会被 executeScript 序列化，
 * 引用不到 lib/agent/storage-read.ts 里的敏感词表。敏感屏蔽、截断、渲染全在工具层完成。
 */
async function getStorage(payload: GetStoragePayload, tabId: number): Promise<GetStorageResult> {
  return executeInTab(tabId, payload, (input): GetStorageResult => {
    const wanted = input?.area ? [input.area] : (['local', 'session'] as const);
    const areas = wanted.map((area) => {
      try {
        const store = area === 'session' ? sessionStorage : localStorage;
        const entries: { key: string; value: string }[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key === null) continue;
          entries.push({ key, value: store.getItem(key) ?? '' });
        }
        return { area, entries };
      } catch (err) {
        // 隐私模式或第三方 cookie 拦截下访问 storage 会直接抛错，另一个区可能仍然可读。
        return { area, entries: [], error: err instanceof Error ? err.message : String(err) };
      }
    });
    return { areas };
  });
}

async function setAgentOverlay(
  payload: SetAgentOverlayPayload,
  tabId: number,
): Promise<SetAgentOverlayResult> {
  if (payload.active) {
    await setOverlayForTab(tabId, payload.label ?? '', payload.cursor);
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
    await pushOverlayToTab(tabId, { active: true, label: state.label, cursor: state.cursor });
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
  if (!state) return shrinkScreenshot(await captureScreenshot(payload, tabId));

  await pushOverlayToTab(tabId, { active: false });
  try {
    return shrinkScreenshot(await captureScreenshot(payload, tabId));
  } finally {
    await pushOverlayToTab(tabId, { active: true, label: state.label, cursor: state.cursor });
  }
}

/**
 * captureVisibleTab 在高分屏上会吐出数 MB 的 PNG，直接送进上下文会让 token
 * 成本和延迟失控。这里缩放到最长边 1280 并转成 JPEG。
 *
 * 注意：service worker 里没有 FileReader，blob → base64 只能走 arrayBuffer +
 * 分块 btoa（见 encodeBase64）。
 */
async function shrinkScreenshot(captured: { dataUrl: string }): Promise<CaptureScreenshotResult> {
  const sourceBlob = await (await fetch(captured.dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const plan = planScreenshotResize(bitmap.width, bitmap.height, SCREENSHOT_MAX_EDGE);
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建离屏画布上下文');
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);

    let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_JPEG_QUALITY });
    if (blob.size > SCREENSHOT_MAX_BYTES) {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_FALLBACK_QUALITY });
    }
    if (blob.size > SCREENSHOT_MAX_BYTES) {
      throw new Error(`截图压缩后仍有 ${Math.round(blob.size / 1024)}KB，超过上限，已放弃。`);
    }

    const base64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
    return {
      dataUrl: `data:image/jpeg;base64,${base64}`,
      base64,
      mimeType: 'image/jpeg',
      width: plan.width,
      height: plan.height,
    };
  } finally {
    bitmap.close();
  }
}
