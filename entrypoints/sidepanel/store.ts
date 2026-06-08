import { create } from 'zustand';
import {
  sendMessage,
  type InjectScriptPayload,
  type InjectScriptResult,
  type MessageResponse,
  type PageContent,
  type PageSelection,
} from '@/lib/messaging';
import { chatStream, type ChatMessage } from '@/lib/llm';
import { ensureDevProvider, getActiveProvider, type ProviderConfig } from '@/lib/settings';
import { analyzeScript } from '@/lib/security';
import {
  db,
  deleteConversation,
  getConversationMessages,
  listConversations,
  type ConversationRecord,
} from '@/lib/db';

const SYSTEM_PROMPT =
  '你是 Aluminum，一个浏览器侧边栏 AI 助手，帮助用户理解、总结和分析当前网页内容。' +
  '请用简洁、准确的中文回答（除非用户使用其他语言）。';

const PAGE_ACTION_SYSTEM_PROMPT =
  '你是 Aluminum 的页面改造执行器。用户要求你直接修改当前网页时，请生成一段将在页面 MAIN world 中直接执行的纯 JavaScript。' +
  '要求：1) 只输出代码本身，不要解释、不要 Markdown 围栏；2) 不要使用 eval、new Function、fetch、XMLHttpRequest、navigator.sendBeacon、importScripts；' +
  '3) 只做用户明确要求的 DOM 或样式改动；4) 尽量返回一段简短字符串说明执行结果。';

const MAX_PAGE_CHARS = 12000;
const MAX_SELECTION_CHARS = 4000;
const PAGE_ACTION_TARGET_HINTS = [
  '页面',
  '网页',
  '当前页',
  '当前页面',
  '这个页面',
  '背景',
  '背景色',
  '字体',
  '字号',
  '颜色',
  '样式',
  '布局',
  '按钮',
  '导航栏',
  '侧边栏',
  '评论区',
  '广告',
  '弹窗',
  '图片',
  '视频',
  '正文',
  '标题',
  '链接',
  '元素',
];
const PAGE_ACTION_VERB_HINTS = [
  '改',
  '修改',
  '改成',
  '改为',
  '换成',
  '切换',
  '设置',
  '变成',
  '隐藏',
  '删除',
  '移除',
  '去掉',
  '清理',
  '关闭',
  '展开',
  '收起',
  '高亮',
  '突出',
  '放大',
  '缩小',
  '美化',
  '重排',
  '对齐',
  '添加',
  '插入',
  '显示',
  '固定',
];

export interface UIMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatState {
  messages: UIMessage[];
  input: string;
  busy: boolean;
  error: string | null;
  provider: ProviderConfig | null;
  conversationId: string;
  conversations: ConversationRecord[];
  showHistory: boolean;
  setInput: (v: string) => void;
  refreshProvider: () => Promise<void>;
  send: (text?: string) => Promise<void>;
  summarizePage: () => Promise<void>;
  explainSelection: () => Promise<void>;
  stop: () => void;
  clear: () => void;
  toggleHistory: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
}

let abortController: AbortController | null = null;

function genConversationId(): string {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useChat = create<ChatState>((set, get) => ({
  messages: [],
  input: '',
  busy: false,
  error: null,
  provider: null,
  conversationId: genConversationId(),
  conversations: [],
  showHistory: false,

  setInput: (v) => set({ input: v }),

  refreshProvider: async () => {
    await ensureDevProvider();
    const provider = (await getActiveProvider()) ?? null;
    set({ provider });
  },

  send: async (text) => {
    const content = (text ?? get().input).trim();
    if (!content || get().busy) return;
    if (await maybeRunPageAction(set, get, content)) return;
    await runChat(set, get, { role: 'user', content }, content);
  },

  summarizePage: async () => {
    if (get().busy) return;
    const display: UIMessage = { role: 'user', content: '📄 总结当前网页' };
    const prompt = '请总结当前网页，给出 3-5 个要点和一段简短摘要。';
    await runChat(set, get, display, prompt);
  },

  explainSelection: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    let selection: PageSelection;
    try {
      const res = (await sendMessage('GET_SELECTION')) as MessageResponse<PageSelection>;
      if (!res.ok || !res.data) throw new Error(res.error ?? '获取选区失败');
      selection = res.data;
    } catch (e) {
      set({ busy: false, error: errMsg(e) });
      return;
    }
    if (!selection.text) {
      set({ busy: false, error: '未检测到选中的文本，请先在页面中划选内容。' });
      return;
    }
    set({ busy: false });
    const preview =
      selection.text.length > 80 ? `${selection.text.slice(0, 80)}…` : selection.text;
    const display: UIMessage = { role: 'user', content: `💬 解释：${preview}` };
    const prompt =
      `请解释以下选中的内容，必要时给出背景、定义或通俗说明：\n\n` +
      `"""${selection.text.slice(0, MAX_SELECTION_CHARS)}"""`;
    await runChat(set, get, display, prompt);
  },

  stop: () => {
    abortController?.abort();
  },

  clear: () => {
    abortController?.abort();
    set({
      messages: [],
      error: null,
      conversationId: genConversationId(),
      showHistory: false,
    });
  },

  toggleHistory: async () => {
    const next = !get().showHistory;
    set({ showHistory: next });
    if (next) await get().refreshConversations();
  },

  refreshConversations: async () => {
    set({ conversations: await listConversations() });
  },

  openConversation: async (id) => {
    abortController?.abort();
    const records = await getConversationMessages(id);
    const messages: UIMessage[] = records
      .filter((r) => r.role !== 'system')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
    set({ messages, conversationId: id, showHistory: false, error: null });
  },

  removeConversation: async (id) => {
    await deleteConversation(id);
    await get().refreshConversations();
    if (get().conversationId === id) {
      set({ messages: [], conversationId: genConversationId() });
    }
  },
}));

async function runChat(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  display: UIMessage,
  llmUserContent: string,
): Promise<void> {
  const provider = get().provider ?? (await getActiveProvider()) ?? null;
  if (!provider) {
    set({ error: '未配置 Provider，请在「设置」中添加 API Key。' });
    return;
  }
  if (!provider.apiKey) {
    set({ error: '当前 Provider 未填写 API Key，请在「设置」中补全。' });
    return;
  }

  const history = get().messages;
  set({
    messages: [...history, display, { role: 'assistant', content: '' }],
    input: '',
    busy: true,
    error: null,
  });

  const pageContext = await getPageContextPrompt();
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(pageContext ? [{ role: 'system' as const, content: pageContext }] : []),
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: llmUserContent },
  ];

  abortController = new AbortController();
  let acc = '';
  try {
    for await (const delta of chatStream(provider, llmMessages, {
      signal: abortController.signal,
    })) {
      acc += delta;
      set((s) => {
        const msgs = s.messages.slice();
        msgs[msgs.length - 1] = { role: 'assistant', content: acc };
        return { messages: msgs };
      });
    }
    await persist(get().conversationId, display.content, acc);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // 用户主动停止，保留已生成的部分内容
    } else {
      set({ error: errMsg(e) });
    }
  } finally {
    set({ busy: false });
    abortController = null;
  }
}

async function maybeRunPageAction(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  userContent: string,
): Promise<boolean> {
  if (!looksLikePageActionRequest(userContent)) return false;

  const provider = get().provider ?? (await getActiveProvider()) ?? null;
  if (!provider) {
    set({ error: '未配置 Provider，请在「设置」中添加 API Key。' });
    return true;
  }
  if (!provider.apiKey) {
    set({ error: '当前 Provider 未填写 API Key，请在「设置」中补全。' });
    return true;
  }

  const history = get().messages;
  const display: UIMessage = { role: 'user', content: userContent };
  set({
    messages: [...history, display, { role: 'assistant', content: '' }],
    input: '',
    busy: true,
    error: null,
  });

  abortController = new AbortController();
  let assistantContent = '';
  try {
    const page = await getPageContent();
    if (!page?.text.trim()) {
      assistantContent = '无法读取当前页面内容，因此未执行页面改造。请切换到普通网页后再试。';
      replaceLastAssistant(set, assistantContent);
      await persist(get().conversationId, display.content, assistantContent);
      return true;
    }

    let code = '';
    for await (const delta of chatStream(
      provider,
      buildPageActionMessages(history, userContent, page),
      { signal: abortController.signal, temperature: 0.2 },
    )) {
      code += delta;
    }

    code = stripCodeFences(code);
    if (!code.trim()) throw new Error('模型没有返回可执行脚本');

    const report = analyzeScript(code);
    if (!report.valid) {
      throw new Error(`生成的脚本存在语法错误：${report.syntaxError ?? '未知错误'}`);
    }

    const dangerIssues = report.issues.filter((issue) => issue.level === 'danger');
    if (dangerIssues.length > 0) {
      assistantContent = `检测到高风险页面改造脚本，已阻止自动执行：${dangerIssues
        .map((issue) => issue.message)
        .join('；')}`;
      replaceLastAssistant(set, assistantContent);
      await persist(get().conversationId, display.content, assistantContent);
      return true;
    }

    const res = (await sendMessage<InjectScriptPayload, InjectScriptResult>('INJECT_SCRIPT', {
      code,
    })) as MessageResponse<InjectScriptResult>;
    if (!res.ok) throw new Error(res.error ?? '页面改造执行失败');

    const warnText = report.issues
      .filter((issue) => issue.level === 'warn')
      .map((issue) => issue.message)
      .join('；');
    assistantContent = `已按你的要求修改当前页面${res.data?.result ? `：${res.data.result}` : '。'}`;
    if (warnText) assistantContent += `\n\n注意：${warnText}`;

    replaceLastAssistant(set, assistantContent);
    await persist(get().conversationId, display.content, assistantContent);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      assistantContent = '已停止本次页面改造。';
    } else {
      assistantContent = `未能完成当前页面改造：${errMsg(e)}`;
    }
    replaceLastAssistant(set, assistantContent);
    await persist(get().conversationId, display.content, assistantContent);
    return true;
  } finally {
    set({ busy: false });
    abortController = null;
  }
}

function buildPageActionMessages(
  history: UIMessage[],
  userContent: string,
  page: PageContent,
): ChatMessage[] {
  return [
    { role: 'system', content: PAGE_ACTION_SYSTEM_PROMPT },
    {
      role: 'system',
      content: [
        '以下是用户当前页面的上下文，请据此生成脚本。',
        `标题：${page.title}`,
        `URL：${page.url}`,
        `语言：${page.lang}`,
        '正文：',
        page.text.slice(0, MAX_PAGE_CHARS),
      ].join('\n'),
    },
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];
}

function replaceLastAssistant(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  content: string,
): void {
  set((state) => {
    const messages = state.messages.slice();
    messages[messages.length - 1] = { role: 'assistant', content };
    return { messages, error: null };
  });
}

function looksLikePageActionRequest(content: string): boolean {
  const normalized = content.replace(/\s+/g, '');
  if (!normalized) return false;
  if (/(如何|怎么|为什么|原理|总结|解释|分析|介绍|能不能|可以吗|是否)/.test(normalized)) {
    return false;
  }
  const hasTarget = PAGE_ACTION_TARGET_HINTS.some((hint) => normalized.includes(hint));
  const hasVerb = PAGE_ACTION_VERB_HINTS.some((hint) => normalized.includes(hint));
  return hasTarget && hasVerb;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:[a-zA-Z]*)?\n([\s\S]*?)\n```$/);
  return (match ? match[1] : trimmed).trim();
}

async function getPageContent(): Promise<PageContent | null> {
  try {
    const res = (await sendMessage('EXTRACT_PAGE')) as MessageResponse<PageContent>;
    if (!res.ok || !res.data) return null;
    return res.data;
  } catch {
    return null;
  }
}

async function getPageContextPrompt(): Promise<string | null> {
  const page = await getPageContent();
  if (!page) return null;

  const text = page.text.trim().slice(0, MAX_PAGE_CHARS);
  if (!text) return null;

  return [
    '以下是用户当前正在浏览的网页内容。回答涉及“当前网页”“本文”“这个页面”等指代时，优先依据这些内容回答；若信息不足，再明确说明缺失部分。',
    `标题：${page.title}`,
    `URL：${page.url}`,
    `语言：${page.lang}`,
    '正文：',
    text,
  ].join('\n');
}

async function persist(
  conversationId: string,
  userContent: string,
  assistantContent: string,
): Promise<void> {
  if (!assistantContent) return;
  const now = Date.now();
  const existing = await db.conversations.get(conversationId);
  if (!existing) {
    await db.conversations.put({
      id: conversationId,
      title: userContent.slice(0, 40),
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db.conversations.update(conversationId, { updatedAt: now });
  }
  await db.messages.add({ conversationId, role: 'user', content: userContent, createdAt: now });
  await db.messages.add({
    conversationId,
    role: 'assistant',
    content: assistantContent,
    createdAt: now + 1,
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
