import {
  type CaptureScreenshotPayload,
  type CaptureScreenshotResult,
  type ClickElementPayload,
  type ClickElementResult,
  type FillFormFieldOutcome,
  type FillFormPayload,
  type FillFormResult,
  type FormFieldDescriptor,
  type GetComputedStylePayload,
  type GetComputedStyleResult,
  type GetFormPayload,
  type GetFormResult,
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
  type AskSelectionPayload,
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
  type QueryDomPayload,
  type QueryDomResult,
  type ScrollPagePayload,
  type ScrollPageResult,
  type SelectOptionPayload,
  type SelectOptionResult,
  type SetStoragePayload,
  type SetStorageResult,
  type SetStylePayload,
  type SetStyleResult,
  type TypeTextPayload,
  type TypeTextResult,
} from '@/lib/messaging';
import { fetchPageResourceText } from '@/lib/page-resource-fetch';
import { resolveTargetTab } from '@/lib/agent/tab-target';
import { sendToContentScript } from '@/lib/agent/content-script-messaging';
import { clearConversationIdForTab } from '@/lib/agent/tab-conversation';
import { clearPendingAskForTab, setPendingAskForTab } from '@/lib/agent/tab-pending-ask';
import { applyFormFill, collectFormFields, type ApplyFillItem } from '@/lib/agent/form-dom';
import { toFieldDescriptor } from '@/lib/agent/form-schema';
import { getFormFieldsForTab, setFormFieldsForTab, type FormFieldHandle } from '@/lib/agent/tab-form-fields';

const DEFAULT_TOOL_MAX_CHARS = 12000;
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
  'CAPTURE_SCREENSHOT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'SELECT_OPTION',
  'SCROLL_PAGE',
  'NAVIGATE_TAB',
  'SET_STORAGE',
  'CHAT',
] as const;

// Service Worker：消息路由中心（ref: technical-plan.md §3.2）
export default defineBackground(() => {
  // 全局侧边栏默认禁用；面板改为按 tab 单独启用（见下方 action.onClicked 监听器），
  // 切到未启用过面板的 tab 时 Chrome 会自动关闭面板文档，不再像全局模式那样
  // 跟着当前激活 tab 到处显示同一个面板实例。
  //
  // openPanelOnActionClick 这个行为设置由 Chrome 按扩展持久化保存，旧版本装过之后
  // 仅仅"这次代码不再调用"不会自动清掉它——老用户升级（onInstalled 的 reason: 'update'）
  // 时若残留 true，点击图标会被 Chrome 直接消费掉去开全局（已禁用的）面板，
  // action.onClicked 根本不会触发。这里显式重置为 false，避免升级路径上图标点击失效。
  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: false })
      .catch((err: unknown) => console.error('[Runi] sidePanel setPanelBehavior:', err));
    browser.sidePanel
      ?.setOptions?.({ enabled: false })
      .catch((err: unknown) => console.error('[Runi] sidePanel:', err));
  });

  // 点击工具栏图标时，只为当前这个 tab 启用并打开侧边栏——面板与这个 tab 强绑定。
  // sidePanel.open() 必须在用户手势的同一个事件循环内同步调用；链在 setOptions()
  // 的 .then() 里会跨过一次 Promise resolve，Chrome 就不再把它算作用户手势触发，
  // 抛出 "sidePanel.open() may only be called in response to a user gesture."
  // 因此这里两个调用都在监听器函数体内同步发起，不互相等待。
  browser.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const tabId = tab.id;
    browser.sidePanel
      ?.setOptions?.({ tabId, path: 'sidepanel.html', enabled: true })
      .catch((err: unknown) => console.error('[Runi] sidePanel setOptions:', err));
    browser.sidePanel
      ?.open?.({ tabId })
      .catch((err: unknown) => console.error('[Runi] sidePanel open:', err));
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
  });
});

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
    ?.setOptions?.({ tabId, path: 'sidepanel.html', enabled: true })
    .catch((err: unknown) => console.error('[Runi] sidePanel setOptions (ask-selection):', err));
  browser.sidePanel
    ?.open?.({ tabId })
    .catch((err: unknown) => console.error('[Runi] sidePanel open (ask-selection):', err));

  await setPendingAskForTab(tabId, text);
}

async function handleMessage(message: Message, sender?: MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { pong: true, ts: Date.now(), agentProtocol: 1, supportedTypes: SUPPORTED_MESSAGE_TYPES };

    case 'GET_ACTIVE_TAB':
      return getActiveTab();

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

    case 'CAPTURE_SCREENSHOT':
      return captureScreenshot(message.payload as CaptureScreenshotPayload, requireTabId(message));

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

    case 'SET_STORAGE':
      return setStorage(message.payload as SetStoragePayload, requireTabId(message));

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

async function extractActivePage(tabId: number): Promise<PageContent> {
  const tab = await resolveTargetTab(tabId);
  const response = await sendToContentScript<PageContent>(tab.id, {
    id: `extract-${Date.now()}`,
    type: 'EXTRACT_PAGE',
  } satisfies Message);

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '页面提取失败');
  }
  return response.data;
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

async function getForm(payload: GetFormPayload, tabId: number): Promise<GetFormResult> {
  const collected = await executeInTab(
    tabId,
    {
      selector: payload?.selector,
      includeHidden: payload?.includeHidden,
      maxFields: MAX_FORM_FIELDS,
      maxOptions: MAX_SELECT_OPTIONS,
    },
    collectFormFields,
  );

  const fields: FormFieldDescriptor[] = [];
  const handles: Record<string, FormFieldHandle> = {};
  const orphanFieldIds: string[] = [];

  collected.raws.forEach((raw, index) => {
    const fieldId = `f${index + 1}`;
    const descriptor = toFieldDescriptor(raw, fieldId);
    fields.push(descriptor);
    handles[fieldId] = {
      path: raw.path,
      expect: { tag: raw.tag, type: raw.type, name: raw.name, label: descriptor.label },
      sensitive: descriptor.sensitive,
      kind: descriptor.kind,
    };
    if (!descriptor.formId) orphanFieldIds.push(fieldId);
  });

  await setFormFieldsForTab(tabId, { url: collected.url, fields: handles });

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
  };
}

async function fillForm(payload: FillFormPayload, tabId: number): Promise<FillFormResult> {
  const table = await getFormFieldsForTab(tabId);
  if (!table) {
    return { outcomes: [], fieldsTableStale: true };
  }

  const outcomes: FillFormFieldOutcome[] = [];
  const items: ApplyFillItem[] = [];

  for (const field of payload?.fields ?? []) {
    const handle = table.fields[field.fieldId];
    if (!handle) {
      outcomes.push({ fieldId: field.fieldId, status: 'not_found', detail: '未知的 fieldId，请重新调用 browser_get_form。' });
      continue;
    }
    // 敏感字段在离开 background 之前就被丢弃：值不进注入参数、不进确认卡片、不落库
    // （ref: Spec-0005 §安全与隐私）。
    if (handle.sensitive) {
      outcomes.push({
        fieldId: field.fieldId,
        status: 'blocked_sensitive',
        detail: '出于安全考虑，本扩展不代填密码与支付类字段，请提示用户手动输入。',
      });
      continue;
    }
    items.push({
      fieldId: field.fieldId,
      path: handle.path,
      expect: handle.expect,
      kind: handle.kind,
      value: field.value,
      checked: field.checked,
    });
  }

  const submitHandle = payload?.submit ? table.fields[payload.submit.fieldId] : undefined;
  // submit.fieldId 未知或已过期时，句柄解析不到——必须如实报告 not_found，
  // 不能让 submit 静默从 applyFormFill 的入参里消失，导致模型收不到任何提交失败的信号。
  const submitFieldMissing = Boolean(payload?.submit) && !submitHandle;
  const applied = await executeInTab(
    tabId,
    {
      url: table.url,
      items,
      submit:
        payload?.submit && submitHandle
          ? { fieldId: payload.submit.fieldId, path: submitHandle.path, expect: submitHandle.expect }
          : undefined,
    },
    applyFormFill,
  );

  if (applied.fieldsTableStale) {
    return { outcomes: [], fieldsTableStale: true };
  }

  // 保持模型请求里的字段顺序，便于它逐条核对。
  const byId = new Map(applied.outcomes.map((outcome) => [outcome.fieldId, outcome]));
  const ordered: FillFormFieldOutcome[] = (payload?.fields ?? []).map((field) => {
    const blocked = outcomes.find((outcome) => outcome.fieldId === field.fieldId);
    return blocked ?? byId.get(field.fieldId) ?? { fieldId: field.fieldId, status: 'not_found' };
  });

  const submitted = submitFieldMissing
    ? { fieldId: payload!.submit!.fieldId, status: 'not_found' as const }
    : applied.submitted;

  return { outcomes: ordered, submitted };
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
  func: (input: TInput) => TResult,
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
  return executeInTab(tabId, payload, (input): ClickElementResult => {
    const selector = input?.selector || '';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const index = input?.index ?? 0;
    const target = nodes[index];
    if (target) target.click();
    return { selector, matched: nodes.length, clickedIndex: target ? index : null };
  });
}

async function typeText(payload: TypeTextPayload, tabId: number): Promise<TypeTextResult> {
  return executeInTab(tabId, payload, (input): TypeTextResult => {
    const selector = input?.selector || '';
    const target = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!target) return { selector, matched: false, value: '' };

    const nextValue = input?.replace === false ? `${target.value}${input?.text ?? ''}` : input?.text ?? '';
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(target, nextValue);
    else target.value = nextValue;

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector, matched: true, value: nextValue };
  });
}

async function selectOption(payload: SelectOptionPayload, tabId: number): Promise<SelectOptionResult> {
  return executeInTab(tabId, payload, (input): SelectOptionResult => {
    const selector = input?.selector || '';
    const target = document.querySelector<HTMLSelectElement>(selector);
    if (!target) return { selector, matched: false, value: input?.value ?? '' };
    target.value = input?.value ?? '';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector, matched: true, value: target.value };
  });
}

async function scrollPage(payload: ScrollPagePayload, tabId: number): Promise<ScrollPageResult> {
  return executeInTab(tabId, payload, (input): ScrollPageResult => {
    const behavior = input?.behavior ?? 'auto';
    if (input?.selector) {
      const target = document.querySelector(input.selector);
      target?.scrollIntoView({ behavior, block: 'center' });
    } else {
      window.scrollTo({ left: input?.x ?? window.scrollX, top: input?.y ?? window.scrollY, behavior });
    }
    return { selector: input?.selector, x: window.scrollX, y: window.scrollY };
  });
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

async function navigateTab(payload: NavigateTabPayload, tabId: number): Promise<NavigateTabResult> {
  const url = payload?.url ?? '';
  if (!isNavigableUrl(url)) throw new Error('仅允许跳转到 http/https 地址。');

  const tab = await resolveTargetTab(tabId);

  await browser.tabs.update(tab.id, { url });
  return { url };
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
