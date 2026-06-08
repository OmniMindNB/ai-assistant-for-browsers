import { create } from 'zustand';
import {
  sendMessage,
  type MessageResponse,
  type PageContent,
  type PageSelection,
} from '@/lib/messaging';
import { chatStream, type ChatMessage } from '@/lib/llm';
import { ensureDevProvider, getActiveProvider, type ProviderConfig } from '@/lib/settings';
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

const MAX_PAGE_CHARS = 12000;
const MAX_SELECTION_CHARS = 4000;

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
    await runChat(set, get, { role: 'user', content }, content);
  },

  summarizePage: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    let page: PageContent;
    try {
      const res = (await sendMessage('EXTRACT_PAGE')) as MessageResponse<PageContent>;
      if (!res.ok || !res.data) throw new Error(res.error ?? '页面提取失败');
      page = res.data;
    } catch (e) {
      set({ busy: false, error: errMsg(e) });
      return;
    }
    set({ busy: false });
    const display: UIMessage = { role: 'user', content: `📄 总结本页：${page.title}` };
    const prompt =
      `请总结以下网页内容，给出 3-5 个要点和一段简短摘要。\n\n` +
      `标题：${page.title}\nURL：${page.url}\n\n正文：\n${page.text.slice(0, MAX_PAGE_CHARS)}`;
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
    set({ messages: [], error: null, conversationId: genConversationId() });
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
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: llmUserContent },
  ];

  set({
    messages: [...history, display, { role: 'assistant', content: '' }],
    input: '',
    busy: true,
    error: null,
  });

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
