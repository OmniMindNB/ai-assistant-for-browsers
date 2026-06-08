import {
  type InjectScriptPayload,
  type InjectScriptResult,
  type Message,
  type MessageResponse,
  type PageContent,
  type PageSelection,
} from '@/lib/messaging';
import { analyzeScript } from '@/lib/security';

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
      return { pong: true, ts: Date.now() };

    case 'GET_ACTIVE_TAB':
      return getActiveTab();

    case 'EXTRACT_PAGE':
      return extractActivePage();

    case 'GET_SELECTION':
      return getActiveSelection();

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