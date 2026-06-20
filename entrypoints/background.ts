import {
  type CaptureScreenshotPayload,
  type CaptureScreenshotResult,
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
  type PageContent,
  type PageMetaResult,
  type PageScriptInfo,
  type PageStylesheetInfo,
  type PageSelection,
  type QueryDomPayload,
  type QueryDomResult,
} from '@/lib/messaging';
import { analyzeScript } from '@/lib/security';

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

async function fetchText(
  url: string,
  maxChars: number,
): Promise<{ text?: string; length: number; truncated: boolean; error?: string }> {
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