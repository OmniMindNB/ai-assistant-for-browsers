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
  'UNDO_SCRIPT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'SELECT_OPTION',
  'SCROLL_PAGE',
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

    case 'UNDO_SCRIPT':
      return undoScript();

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
  if (hasSnapshot(tabId)) return;
  const capture = await executeInActiveTab(
    null,
    (): CapturePageState => ({
      url: location.href,
      bodyHTML: document.body.innerHTML,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  );
  beginSnapshotIfNeeded(tabId, capture);
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

// 脚本注入（ref: technical-plan.md §4.2）。
// 在 MAIN world 中执行，执行前保存 body 快照以支持撤销。
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

  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [code],
    func: (userCode: string) => {
      try {
        // 保存可撤销快照（仅 body 结构，不保留 JS 状态）
        (window as any).__aluminumSnapshot = document.body.innerHTML;
        // eslint-disable-next-line no-new-func
        const fn = new Function(userCode);
        const ret = fn();
        return { ok: true, result: ret === undefined ? '' : String(ret) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const out = frame?.result as { ok: boolean; result?: string; error?: string } | undefined;
  if (!out?.ok) {
    throw new Error(out?.error ?? '脚本执行失败');
  }
  return { result: out.result, snapshotSaved: true };
}

// 撤销上一次注入：从快照还原 body。
async function undoScript(): Promise<InjectScriptResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const snap = (window as any).__aluminumSnapshot as string | undefined;
      if (typeof snap !== 'string') return { ok: false, error: '无可撤销的快照' };
      document.body.innerHTML = snap;
      delete (window as any).__aluminumSnapshot;
      return { ok: true };
    },
  });

  const out = frame?.result as { ok: boolean; error?: string } | undefined;
  if (!out?.ok) throw new Error(out?.error ?? '撤销失败');
  return { snapshotSaved: false };
}