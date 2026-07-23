import {
  type CaptureScreenshotPayload,
  type CaptureScreenshotResult,
  type ClickElementPayload,
  type ClickElementResult,
  type GetComputedStylePayload,
  type GetComputedStyleResult,
  type GetHtmlPayload,
  type GetHtmlResult,
  type GetScriptsPayload,
  type GetScriptsResult,
  type GetStylesheetsPayload,
  type GetStylesheetsResult,
  type InjectScriptPayload,
  type InjectScriptResult,
  type Message,
  type MessageResponse,
  type ModifyDomPayload,
  type ModifyDomResult,
  type NavigateTabPayload,
  type NavigateTabResult,
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
  type QueryDomPayload,
  type QueryDomResult,
  type RevertChangesResult,
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
import { analyzeScript } from '@/lib/security';
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
  type CapturePageState,
} from '@/lib/agent/turn-snapshot';

const DEFAULT_TOOL_MAX_CHARS = 12000;
const SUPPORTED_MESSAGE_TYPES = [
  'PING',
  'EXTRACT_PAGE',
  'GET_SELECTION',
  'GET_ACTIVE_TAB',
  'QUERY_DOM',
  'GET_HTML',
  'GET_SCRIPTS',
  'GET_STYLESHEETS',
  'GET_COMPUTED_STYLE',
  'GET_PAGE_META',
  'CAPTURE_SCREENSHOT',
  'INJECT_SCRIPT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'SELECT_OPTION',
  'SCROLL_PAGE',
  'NAVIGATE_TAB',
  'SET_STORAGE',
  'RESET_TURN_SNAPSHOT',
  'REVERT_CHANGES',
  'CHAT',
] as const;

// Service Worker：消息路由中心（ref: technical-plan.md §3.2）
export default defineBackground(() => {
  // 点击工具栏图标时打开侧边栏
  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[Aluminum] sidePanel:', err));
  });

  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
      handleMessage(message)
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
});

async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { pong: true, ts: Date.now(), agentProtocol: 1, supportedTypes: SUPPORTED_MESSAGE_TYPES };

    case 'GET_ACTIVE_TAB':
      return getActiveTab();

    case 'EXTRACT_PAGE':
      return extractActivePage();

    case 'GET_SELECTION':
      return getActiveSelection();

    case 'QUERY_DOM':
      return queryDom(message.payload as QueryDomPayload);

    case 'GET_HTML':
      return getHtml(message.payload as GetHtmlPayload);

    case 'GET_SCRIPTS':
      return getScripts(message.payload as GetScriptsPayload);

    case 'GET_STYLESHEETS':
      return getStylesheets(message.payload as GetStylesheetsPayload);

    case 'GET_COMPUTED_STYLE':
      return getComputedStyleForSelector(message.payload as GetComputedStylePayload);

    case 'GET_PAGE_META':
      return getPageMeta();

    case 'CAPTURE_SCREENSHOT':
      return captureScreenshot(message.payload as CaptureScreenshotPayload);

    case 'SET_STYLE':
      return setStyle(message.payload as SetStylePayload);

    case 'MODIFY_DOM':
      return modifyDom(message.payload as ModifyDomPayload);

    case 'CLICK_ELEMENT':
      return clickElement(message.payload as ClickElementPayload);

    case 'TYPE_TEXT':
      return typeText(message.payload as TypeTextPayload);

    case 'SELECT_OPTION':
      return selectOption(message.payload as SelectOptionPayload);

    case 'SCROLL_PAGE':
      return scrollPage(message.payload as ScrollPagePayload);

    case 'INJECT_SCRIPT':
      return injectScript(message.payload as InjectScriptPayload);

    case 'RESET_TURN_SNAPSHOT':
      return resetTurnSnapshot();

    case 'REVERT_CHANGES':
      return revertChanges();

    case 'NAVIGATE_TAB':
      return navigateTab(message.payload as NavigateTabPayload);

    case 'SET_STORAGE':
      return setStorage(message.payload as SetStoragePayload);

    default:
      throw new Error(`未处理的消息类型: ${message.type}`);
  }
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('未找到活动标签页');
  return { id: tab.id, title: tab.title, url: tab.url };
}

async function extractActivePage(): Promise<PageContent> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const response = (await browser.tabs.sendMessage(tab.id, {
    id: `extract-${Date.now()}`,
    type: 'EXTRACT_PAGE',
  } satisfies Message)) as MessageResponse<PageContent>;

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '页面提取失败');
  }
  return response.data;
}

async function getActiveSelection(): Promise<PageSelection> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const response = (await browser.tabs.sendMessage(tab.id, {
    id: `selection-${Date.now()}`,
    type: 'GET_SELECTION',
  } satisfies Message)) as MessageResponse<PageSelection>;

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '获取选区失败');
  }
  return response.data;
}

async function queryDom(payload: QueryDomPayload): Promise<QueryDomResult> {
  return executeInActiveTab(payload, (input): QueryDomResult => {
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

async function getHtml(payload: GetHtmlPayload): Promise<GetHtmlResult> {
  return executeInActiveTab(payload, (input): GetHtmlResult => {
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

async function getScripts(payload: GetScriptsPayload): Promise<GetScriptsResult> {
  const input = payload ?? {};
  const maxChars = Math.max(1000, input.maxChars ?? DEFAULT_TOOL_MAX_CHARS);
  const includeInline = input.includeInline ?? true;
  const includeExternal = input.includeExternal ?? true;

  const scripts = await executeInActiveTab(null, (): PageScriptInfo[] =>
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
        const fetched = await fetchText(script.src, remaining);
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

async function getStylesheets(payload: GetStylesheetsPayload): Promise<GetStylesheetsResult> {
  const input = payload ?? {};
  const maxChars = Math.max(1000, input.maxChars ?? DEFAULT_TOOL_MAX_CHARS);
  const includeInline = input.includeInline ?? true;
  const includeExternal = input.includeExternal ?? true;

  const stylesheets = await executeInActiveTab(null, (): PageStylesheetInfo[] => {
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
        const fetched = await fetchText(sheet.href, remaining);
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
): Promise<GetComputedStyleResult> {
  return executeInActiveTab(payload, (input): GetComputedStyleResult => {
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

async function getPageMeta(): Promise<PageMetaResult> {
  return executeInActiveTab(null, (): PageMetaResult => {
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
): Promise<CaptureScreenshotResult> {
  const format = payload?.format ?? 'png';
  const quality = payload?.quality;
  const dataUrl = await browser.tabs.captureVisibleTab({
    format,
    quality: format === 'jpeg' ? quality : undefined,
  });
  return { dataUrl };
}

async function executeInActiveTab<TInput, TResult>(
  input: TInput,
  func: (input: TInput) => TResult,
): Promise<TResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [input],
    func,
  });
  return frame.result as TResult;
}

// 拒绝内网/回环/链路本地地址与非 http(s) 协议，防止页面通过 script/link 的
// src/href 诱导扩展（拥有 <all_urls> 权限、可绕过 CORS）探测内网服务（SSRF）。
function isDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0') return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10 || a === 0) return true; // loopback / 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (incl. cloud metadata)
    return false;
  }

  if (host === '::1') return true; // loopback
  if (host.startsWith('fe80')) return true; // link-local
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 unique local
  return false;
}

function isFetchUrlAllowed(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !isDisallowedHost(parsed.hostname);
}

async function fetchText(
  url: string,
  maxChars: number,
): Promise<{ text?: string; length: number; truncated: boolean; error?: string }> {
  if (!isFetchUrlAllowed(url)) {
    return {
      length: 0,
      truncated: false,
      error: '已阻止：目标地址不允许访问（非 http/https 协议，或指向内网/回环/链路本地地址）',
    };
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { length: 0, truncated: false, error: `${response.status} ${response.statusText}` };
    }
    const text = await response.text();
    return { text: text.slice(0, maxChars), length: text.length, truncated: text.length > maxChars };
  } catch (error) {
    return {
      length: 0,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureTurnSnapshot(tabId: number): Promise<void> {
  if (await hasSnapshot(tabId)) return;
  const capture = await executeInActiveTab(
    null,
    (): CapturePageState => ({
      url: location.href,
      bodyHTML: document.body.innerHTML,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  );
  await beginSnapshotIfNeeded(tabId, capture);
}

async function setStyle(payload: SetStylePayload): Promise<SetStyleResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): SetStyleResult => {
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

async function modifyDom(payload: ModifyDomPayload): Promise<ModifyDomResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): ModifyDomResult => {
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

async function clickElement(payload: ClickElementPayload): Promise<ClickElementResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): ClickElementResult => {
    const selector = input?.selector || '';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const index = input?.index ?? 0;
    const target = nodes[index];
    if (target) target.click();
    return { selector, matched: nodes.length, clickedIndex: target ? index : null };
  });
}

async function typeText(payload: TypeTextPayload): Promise<TypeTextResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): TypeTextResult => {
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

async function selectOption(payload: SelectOptionPayload): Promise<SelectOptionResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): SelectOptionResult => {
    const selector = input?.selector || '';
    const target = document.querySelector<HTMLSelectElement>(selector);
    if (!target) return { selector, matched: false, value: input?.value ?? '' };
    target.value = input?.value ?? '';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector, matched: true, value: target.value };
  });
}

async function scrollPage(payload: ScrollPagePayload): Promise<ScrollPageResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  return executeInActiveTab(payload, (input): ScrollPageResult => {
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

// 脚本注入（ref: technical-plan.md §4.2、Spec-0002）。
// 使用 chrome.userScripts.execute（Chrome MV3 官方认可的动态脚本执行通道）而非 eval/new Function，
// 满足 Remote Hosted Code 政策；用 IIFE 包裹以保留旧版 new Function 的 return 语义。
async function injectScript(
  payload: InjectScriptPayload,
): Promise<InjectScriptResult> {
  const code = payload?.code ?? '';
  if (!code.trim()) throw new Error('脚本为空');

  // 后端二次校验：语法非法直接拒绝（安全纵深）
  const report = analyzeScript(code);
  if (!report.valid) {
    throw new Error(`脚本语法错误：${report.syntaxError ?? '未知'}`);
  }

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const wrapped = `(function(){\n${code}\n})()`;
  let results;
  try {
    results = await browser.userScripts.execute({
      target: { tabId: tab.id },
      world: 'MAIN',
      js: [{ code: wrapped }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `脚本注入失败：${message}。请在 chrome://extensions 打开本扩展详情页，开启「允许用户脚本」（Allow User Scripts）开关后重试。`,
    );
  }

  const out = results[0];
  if (!out || out.error) {
    throw new Error(out?.error ?? '脚本执行失败');
  }
  return {
    result: out.result === undefined ? '' : String(out.result),
    snapshotSaved: true,
  };
}

// 撤销"本轮"全部改动：若本轮发生过跳转，直接跳回原 URL（跳转前的 DOM 已不可复原，
// 也没有意义）；否则依次恢复 storage、body.innerHTML、滚动位置。撤销后清空该 tab 的快照。
async function revertChanges(): Promise<RevertChangesResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const snapshot = await getSnapshot(tab.id);
  if (!snapshot) return { reverted: false };

  const currentUrl = await executeInActiveTab(null, (): string => location.href);
  if (currentUrl !== snapshot.url) {
    await browser.tabs.update(tab.id, { url: snapshot.url });
    await clearSnapshot(tab.id);
    return { reverted: true, navigatedBack: true };
  }

  await executeInActiveTab(snapshot, (snap): void => {
    for (const entry of snap.storageEntries) {
      const store = entry.area === 'session' ? sessionStorage : localStorage;
      if (entry.previousValue === null) store.removeItem(entry.key);
      else store.setItem(entry.key, entry.previousValue);
    }
    document.body.innerHTML = snap.bodyHTML;
    window.scrollTo(snap.scrollX, snap.scrollY);
  });
  await clearSnapshot(tab.id);
  return { reverted: true, navigatedBack: false };
}

async function resetTurnSnapshot(): Promise<{ ok: true }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await clearSnapshot(tab.id);
  return { ok: true };
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

async function navigateTab(payload: NavigateTabPayload): Promise<NavigateTabResult> {
  const url = payload?.url ?? '';
  if (!isNavigableUrl(url)) throw new Error('仅允许跳转到 http/https 地址。');

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  await browser.tabs.update(tab.id, { url });
  return { url };
}

async function setStorage(payload: SetStoragePayload): Promise<SetStorageResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const result = await executeInActiveTab(payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    const previousValue = store.getItem(key);
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key, previousValue };
  });

  await recordStorageEntryIfAbsent(tab.id, { area: result.area, key: result.key, previousValue: result.previousValue });
  return result;
}