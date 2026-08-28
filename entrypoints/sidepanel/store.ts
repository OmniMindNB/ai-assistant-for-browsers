import { create } from 'zustand';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message as AgentLlmMessage } from '@earendil-works/pi-ai';
import {
  sendMessage,
  type ActiveTabInfo,
  type MessageResponse,
  type PageSelection,
} from '@/lib/messaging';
import {
  ensureDevProvider,
  getActiveProvider,
  loadSettings,
  providerModels,
  type ProviderConfig,
} from '@/lib/settings';
import {
  deleteConversation as deleteConversationRecord,
  getConversationMessages,
  listConversations,
  replaceConversationMessages,
  type ConversationRecord,
} from '@/lib/db';
import {
  conversationTitle,
  findMessageIndex,
  isEditableMessage,
  toMessageRecords,
  type ChatMessage,
} from '@/lib/chat/messages';
import { createBrowserAgent } from '@/lib/agent/agent';
import type { TaskOutcome } from '@/lib/agent/task-outcome';
import {
  buildSystemPrompt,
  DEFAULT_READ_TOOL_CALL_BUDGET,
  DEFAULT_WRITE_TOOL_CALL_BUDGET,
} from '@/lib/agent/system-prompt';
import { buildShortcutExecution } from '@/lib/chat/shortcut-prompts';
import { summarizeToolCallForConfirmation } from '@/lib/agent/confirm-summary';
import { describeToolActivity } from '@/lib/agent/activity-description';
import { finishActivityStep, markActivityStepSlow, upsertActivityStep, type ActivityStep } from '@/lib/agent/activity-steps';
import { getConversationIdForTab, setConversationIdForTab } from '@/lib/agent/tab-conversation';
import { clearTabSession, loadTabSession, saveTabSession } from '@/lib/agent/tab-session-storage';
import { createTabSession } from '@/lib/agent/tab-session';
import { clearPendingAskForTab, getPendingAskForTab, pendingAskStorageKey } from '@/lib/agent/tab-pending-ask';
import { buildSelectionAskTemplate, truncateSelectionText } from '@/lib/selection-ask';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  buildPendingAttachmentText,
  classifyFile,
  hasBusyAttachments,
  isAttachmentReady,
  readAttachment,
  toMessageAttachment,
  toPendingImageContent,
  type MessageAttachment,
  type PendingAttachment,
} from '@/lib/chat/attachments';
import { PdfParseQueue } from '@/lib/chat/pdf-parse-queue';
import {
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_PDF_TEXT_CHARS,
  type PdfExtractionResult,
} from '@/lib/chat/pdf-extractor';
import { extractPdfAttachment } from '@/lib/chat/pdfjs-runtime';
import type { ImageContent } from '@earendil-works/pi-ai';
import { getCurrentLocale, t } from '@/lib/i18n';
import { isCurrentTabReadable } from '@/lib/current-tab-readability';
import {
  loadShortcutConfigs,
  resolveShortcut,
  type ShortcutConfig,
} from '@/lib/shortcuts';

const SLOW_ACTIVITY_MS = 6000;
const REQUIRED_AGENT_MESSAGE_TYPES = [
  'GET_PAGE_META',
  'GET_SCRIPTS',
  'GET_STYLESHEETS',
  'QUERY_DOM',
  'GET_HTML',
  'GET_COMPUTED_STYLE',
  'CAPTURE_SCREENSHOT',
  'SET_STYLE',
  'MODIFY_DOM',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'SELECT_OPTION',
  'SCROLL_PAGE',
  'NAVIGATE_TAB',
  'SET_STORAGE',
] as const;

export type UIMessage = ChatMessage;

export type { ActivityStep } from '@/lib/agent/activity-steps';

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  summary: string;
  codePreview?: string;
}

export interface PendingQuestion {
  toolCallId: string;
  question: string;
}

export type PageContextState =
  | { status: 'loading' }
  | { status: 'available'; tabId: number; title: string; url: string }
  | { status: 'restricted'; tabId: number; title: string; url: string }
  | { status: 'error'; message: string };

interface ChatState {
  messages: UIMessage[];
  activitySteps: ActivityStep[];
  input: string;
  /** 每次消费一条划词提问 pending ask 后设为 Date.now()；WorkbenchComposer 据此判断"该聚焦输入框了"。 */
  pendingFocusToken: number;
  /** 划词提问消费到的待引用文字（裁剪后）；作为独立卡片显示在输入框上方，不混入 input。 */
  quotedSelection: string | null;
  /** 待发送附件的瞬态生命周期；只有 ready 元数据会进入历史。 */
  pendingAttachments: PendingAttachment[];
  busy: boolean;
  error: string | null;
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
  provider: ProviderConfig | null;
  /** 全部已配置 Provider（输入框选择器枚举用） */
  providers: ProviderConfig[];
  /** 输入框当前选中的 Provider（运行时覆盖，默认回退到 active） */
  selectedProviderId: string | null;
  /** 输入框当前选中的模型 */
  selectedModel: string;
  conversationId: string;
  conversations: ConversationRecord[];
  shortcuts: ShortcutConfig[];
  shortcutErrors: string[];
  pageContext: PageContextState;
  setInput: (v: string) => void;
  clearQuotedSelection: () => void;
  addAttachmentFiles: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => Promise<void>;
  disposeAttachments: () => void;
  refreshProvider: () => Promise<void>;
  refreshShortcuts: () => Promise<void>;
  refreshPageContext: () => Promise<void>;
  setSelectedProvider: (id: string) => void;
  setSelectedModel: (model: string) => void;
  selectProviderAndModel: (providerId: string, model: string) => void;
  send: (text?: string, options?: { withoutBrowserTools?: boolean }) => Promise<boolean>;
  /** 成功发起（截断+提交）返回 true；任一前置校验失败返回 false，调用方据此决定是否关闭编辑框。 */
  editMessage: (id: string, newContent: string) => Promise<boolean>;
  runShortcut: (shortcut: ShortcutConfig) => Promise<void>;
  stop: () => void;
  clear: () => void;
  refreshConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<boolean>;
  removeConversation: (id: string) => Promise<void>;
  respondToConfirmation: (approved: boolean) => void;
  respondToQuestion: (answer: string) => void;
  restoreTabConversation: () => Promise<void>;
}

interface ConversationOrigin {
  conversationId: string;
  conversationEpoch: number;
}

interface ActiveRun {
  id: number;
  origin: ConversationOrigin;
  agent: Agent | null;
  resolveConfirmation: ((approved: boolean) => void) | null;
  resolveQuestion: ((answer: string) => void) | null;
  pendingToolArgs: Map<string, { toolName: string; args: unknown }>;
  terminatedToolCallIds: Set<string>;
  taskOutcome: TaskOutcome | null;
}
let activeRun: ActiveRun | null = null;
let runEpoch = 0;
let conversationEpoch = 0;
/** 侧边栏面板自己绑定的 tabId；挂载时解析一次并缓存，用于把 conversationId 变化写回对应 tab 的映射。 */
let panelTabId: number | null = null;
/** true 只在 restoreTabConversation() 内部恢复已保存对话期间。
 * 这段时间 conversationId 的变化是"面板文档重建后重新挂载同一个对话"，
 * 不是真正的对话切换/清空——useChat.subscribe 靠这个标志跳过 clearTabSession，
 * 否则每次面板因为浏览器切走 tab 焦点而被销毁重建，追踪的标签页列表都会被清空。 */
let restoringSavedConversation = false;
/** 只允许最近一次页面上下文刷新更新 UI，避免慢响应覆盖用户主动重试。 */
let pageContextRequestId = 0;
let providerRequestId = 0;
let conversationOpenRequestId = 0;
const conversationMutationTails = new Map<string, Promise<void>>();
const successfulDeletedConversationIds = new Set<string>();
const pendingDeletionGenerations = new Map<string, number>();
let conversationMutationGeneration = 0;
const pdfParseQueue = new PdfParseQueue(2);

type StoreSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;
type StoreGet = () => ChatState;

function enqueueConversationMutation(id: string, mutation: () => Promise<void>): Promise<void> {
  const previous = conversationMutationTails.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(mutation);
  const tail = next.catch(() => undefined);
  conversationMutationTails.set(id, tail);
  void tail.finally(() => {
    if (conversationMutationTails.get(id) === tail) conversationMutationTails.delete(id);
  });
  return next;
}

function beginConversationDeletion(id: string): Promise<void> {
  const generation = ++conversationMutationGeneration;
  pendingDeletionGenerations.set(id, generation);
  return enqueueConversationMutation(id, async () => {
    try {
      await deleteConversationRecord(id);
      successfulDeletedConversationIds.add(id);
      if (pendingDeletionGenerations.get(id) === generation) pendingDeletionGenerations.delete(id);
    } catch (error) {
      if (pendingDeletionGenerations.get(id) === generation) pendingDeletionGenerations.delete(id);
      throw error;
    }
  });
}

function captureConversationOrigin(get: () => ChatState): ConversationOrigin {
  return { conversationId: get().conversationId, conversationEpoch };
}

function isCurrentOrigin(origin: ConversationOrigin, get: () => ChatState): boolean {
  return conversationEpoch === origin.conversationEpoch && get().conversationId === origin.conversationId;
}

function replacePendingAttachment(
  set: StoreSet,
  id: string,
  taskId: string,
  replace: (current: PendingAttachment) => PendingAttachment,
): void {
  set((state) => ({
    pendingAttachments: state.pendingAttachments.map((item) =>
      item.id === id && 'taskId' in item && item.taskId === taskId ? replace(item) : item,
    ),
  }));
}

function cancelPendingAttachments(items: PendingAttachment[]): void {
  for (const item of items) {
    if (item.status === 'queued' || item.status === 'parsing') pdfParseQueue.cancel(item.taskId);
  }
}

async function parseReservedPdf(
  set: StoreSet,
  get: StoreGet,
  reserved: Extract<PendingAttachment, { status: 'queued' | 'parsing' }>,
  origin: ConversationOrigin,
): Promise<void> {
  const current = get().pendingAttachments.find((item) => item.id === reserved.id);
  if (
    !isCurrentOrigin(origin, get) ||
    !current ||
    !('taskId' in current) ||
    current.taskId !== reserved.taskId
  ) return;

  let result: PdfExtractionResult;
  try {
    result = await pdfParseQueue.enqueue(reserved.taskId, (signal) => {
      replacePendingAttachment(set, reserved.id, reserved.taskId, (item) => ({
        ...item,
        status: 'parsing',
      } as PendingAttachment));
      return extractPdfAttachment(reserved.file, {
        maxChars: MAX_ATTACHMENT_PDF_TEXT_CHARS,
        signal,
        onProgress: (completedPages, pageCount) => replacePendingAttachment(
          set,
          reserved.id,
          reserved.taskId,
          (item) => ({ ...item, status: 'parsing', completedPages, pageCount } as PendingAttachment),
        ),
      });
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    result = { ok: false, reason: 'parse-failed' };
  }

  if (!isCurrentOrigin(origin, get)) return;
  replacePendingAttachment(set, reserved.id, reserved.taskId, (item) => result.ok ? {
    id: item.id,
    name: item.name,
    mimeType: 'application/pdf',
    size: item.size,
    kind: 'pdf',
    status: 'ready',
    attachment: {
      id: item.id,
      name: item.name,
      mimeType: 'application/pdf',
      size: item.size,
      kind: 'pdf',
      pageCount: result.value.pageCount,
      extractedChars: result.value.extractedChars,
      truncated: result.value.truncated,
    },
    transientText: result.value.text,
  } : {
    id: item.id,
    name: item.name,
    mimeType: 'application/pdf',
    size: item.size,
    kind: 'pdf',
    status: 'error',
    file: reserved.file,
    reason: result.reason,
    retryable: result.reason === 'read-failed' || result.reason === 'parse-failed',
  });
}

function isCurrentRun(run: ActiveRun, get: () => ChatState): boolean {
  return activeRun?.id === run.id && isCurrentOrigin(run.origin, get);
}

function settleRun(run: ActiveRun): void {
  if (activeRun?.id !== run.id) return;
  run.resolveConfirmation = null;
  run.resolveQuestion = null;
  run.agent = null;
  activeRun = null;
}

function invalidateActiveRun(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  persist = true,
): void {
  const run = activeRun;
  if (!run) return;
  const messages = isCurrentOrigin(run.origin, get) ? get().messages : [];
  activeRun = null;
  run.resolveConfirmation?.(false);
  run.resolveConfirmation = null;
  run.resolveQuestion?.('');
  run.resolveQuestion = null;
  run.agent?.abort();
  if (isCurrentOrigin(run.origin, get)) {
    clearAllSlowActivityTimers();
    set({ busy: false, pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
  }
  if (persist && messages.length > 0) {
    void persistConversationSnapshot(run.origin.conversationId, messages);
  }
}

const slowActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearSlowActivityTimer(id: string): void {
  const timer = slowActivityTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    slowActivityTimers.delete(id);
  }
}

function clearAllSlowActivityTimers(): void {
  for (const timer of slowActivityTimers.values()) clearTimeout(timer);
  slowActivityTimers.clear();
}

function scheduleSlowActivityTimer(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  id: string,
): void {
  if (slowActivityTimers.has(id)) return;
  const timer = setTimeout(() => {
    slowActivityTimers.delete(id);
    set((s) => ({ activitySteps: markActivityStepSlow(s.activitySteps, id) }));
  }, SLOW_ACTIVITY_MS);
  slowActivityTimers.set(id, timer);
}

/** 返回整个 ActiveTabInfo 而不只是 id：标题和地址会注入系统提示词的 <runtime_context>，省掉一次工具调用。 */
async function resolveActiveTab(): Promise<ActiveTabInfo> {
  const res = (await sendMessage('GET_ACTIVE_TAB')) as MessageResponse<ActiveTabInfo>;
  if (!res.ok || typeof res.data?.id !== 'number') {
    throw new Error(res.error ?? t('store.noActiveTab'));
  }
  return res.data;
}

/**
 * 消费某个 tab 的划词提问 pending 数据：面板挂载时（restoreTabConversation）、以及面板已经打开时
 * 收到新的 pending 写入（下方的 storage.onChanged 监听器）都会调用它。
 * 用 useChat.setState 而不是闭包里的 set，是因为模块级监听器拿不到 set/get；两者等价——
 * 调用发生时 useChat 早已构造完成。
 */
async function consumePendingAskForTab(tabId: number): Promise<void> {
  const pendingAsk = await getPendingAskForTab(tabId);
  if (!pendingAsk) return;
  await clearPendingAskForTab(tabId);
  useChat.setState({ quotedSelection: truncateSelectionText(pendingAsk), pendingFocusToken: Date.now() });
}

function genConversationId(): string {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 单调自增序号：openConversation 会在同一毫秒内为一批消息连续调用 genMessageId，
// 仅靠 Date.now() + 6 位随机 base36 在低概率下会撞车，重复的 React key 是真实的渲染 bug。
// 加一个每次调用必增的序号后缀即可让同一次运行内的 id 严格唯一，代价可以忽略。
let messageIdSeq = 0;

function genMessageId(): string {
  messageIdSeq += 1;
  return `m-${Date.now()}-${messageIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  kind?: 'input' | 'action',
  quotedText?: string,
  attachments?: MessageAttachment[],
): UIMessage {
  return { id: genMessageId(), role, content, createdAt: Date.now(), kind, quotedText, attachments };
}

export const useChat = create<ChatState>((set, get) => ({
  messages: [],
  activitySteps: [],
  input: '',
  pendingFocusToken: 0,
  quotedSelection: null,
  pendingAttachments: [],
  busy: false,
  error: null,
  pendingConfirmation: null,
  pendingQuestion: null,
  provider: null,
  providers: [],
  selectedProviderId: null,
  selectedModel: '',
  conversationId: genConversationId(),
  conversations: [],
  shortcuts: [],
  shortcutErrors: [],
  pageContext: { status: 'loading' },

  setInput: (v) => set({ input: v }),
  clearQuotedSelection: () => set({ quotedSelection: null }),

  addAttachmentFiles: async (files) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const available = MAX_ATTACHMENTS_PER_MESSAGE - get().pendingAttachments.length;
    const selected = list.slice(0, Math.max(0, available));
    const origin = captureConversationOrigin(get);
    const reserved: PendingAttachment[] = selected.map((file) => {
      const id = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      const kind = classifyFile(file);
      const base = {
        id,
        file,
        name: file.name,
        mimeType: file.type || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
        size: file.size,
      };
      if (kind === 'unsupported') {
        return { ...base, kind, status: 'error', reason: 'unsupported-type', retryable: false };
      }
      if (kind === 'pdf' && file.size > MAX_ATTACHMENT_PDF_BYTES) {
        return { ...base, kind, status: 'error', reason: 'too-large', retryable: false };
      }
      return { ...base, kind, taskId, status: 'queued' };
    });
    const limitMessage = list.length > selected.length
      ? t('workbench.attachmentLimitReached', { max: MAX_ATTACHMENTS_PER_MESSAGE })
      : undefined;
    set((s) => ({
      pendingAttachments: [...s.pendingAttachments, ...reserved],
      error: limitMessage ?? s.error,
    }));

    // Give the caller one render turn with stable queued placeholders before
    // a free queue slot promotes any PDF to parsing.
    await Promise.resolve();
    await Promise.all(reserved.map(async (item) => {
      if (item.status === 'error' || item.status === 'ready') return;
      if (item.kind === 'pdf') return parseReservedPdf(set, get, item, origin);

      const result = await readAttachment(item.file, item.id);
      if (!isCurrentOrigin(origin, get)) return;
      replacePendingAttachment(set, item.id, item.taskId, (current) => result.ok ? {
        id: current.id,
        name: current.name,
        mimeType: current.mimeType,
        size: current.size,
        kind: result.attachment.kind,
        status: 'ready',
        attachment: result.attachment,
      } : {
        id: current.id,
        name: current.name,
        mimeType: current.mimeType,
        size: current.size,
        kind: item.kind,
        status: 'error',
        file: item.file,
        reason: result.failure.reason,
        retryable: false,
      });
    }));
  },

  removeAttachment: (id) => {
    const item = get().pendingAttachments.find((candidate) => candidate.id === id);
    if (item && (item.status === 'queued' || item.status === 'parsing')) pdfParseQueue.cancel(item.taskId);
    set((state) => ({
      pendingAttachments: state.pendingAttachments.filter((candidate) => candidate.id !== id),
    }));
  },

  retryAttachment: async (id) => {
    const failed = get().pendingAttachments.find(
      (item): item is Extract<PendingAttachment, { status: 'error' }> =>
        item.id === id && item.status === 'error',
    );
    if (!failed || !failed.retryable || !failed.file || failed.kind !== 'pdf') return;
    const queued: Extract<PendingAttachment, { status: 'queued' | 'parsing' }> = {
      id: failed.id,
      name: failed.name,
      mimeType: 'application/pdf',
      size: failed.size,
      kind: 'pdf',
      status: 'queued',
      taskId: crypto.randomUUID(),
      file: failed.file,
    };
    set((state) => ({
      pendingAttachments: state.pendingAttachments.map((item) => item.id === id ? queued : item),
    }));
    await parseReservedPdf(set, get, queued, captureConversationOrigin(get));
  },

  disposeAttachments: () => {
    const pending = get().pendingAttachments;
    cancelPendingAttachments(pending);
    set({ pendingAttachments: [] });
  },

  refreshProvider: async () => {
    const requestId = ++providerRequestId;
    await ensureDevProvider();
    const settings = await loadSettings();
    if (requestId !== providerRequestId) return;
    const all = settings.providers;
    const active = all.find((p) => p.id === settings.activeProviderId) ?? all[0] ?? null;
    set((s) => {
      const selectedId =
        s.selectedProviderId && all.some((p) => p.id === s.selectedProviderId)
          ? s.selectedProviderId
          : active?.id ?? null;
      const selectedProv = all.find((p) => p.id === selectedId) ?? null;
      const models = selectedProv ? providerModels(selectedProv) : [];
      const keepModel = Boolean(s.selectedModel) && models.includes(s.selectedModel);
      const selectedModel = selectedProv ? (keepModel ? s.selectedModel : selectedProv.model) : '';
      return { providers: all, provider: active, selectedProviderId: selectedId, selectedModel };
    });
  },

  refreshShortcuts: async () => {
    try {
      const loaded = await loadShortcutConfigs();
      set({ shortcuts: loaded.shortcuts, shortcutErrors: loaded.errors });
    } catch (error) {
      set({ shortcutErrors: [errMsg(error)] });
    }
  },

  refreshPageContext: async () => {
    const requestId = ++pageContextRequestId;
    set({ pageContext: { status: 'loading' } });
    try {
      const res = (await sendMessage('GET_ACTIVE_TAB')) as MessageResponse<ActiveTabInfo>;
      if (!res.ok || typeof res.data?.id !== 'number') {
        throw new Error(res.error ?? t('store.noActiveTab'));
      }
      if (!res.data.url) {
        throw new Error(t('store.noActiveTab'));
      }

      const { id: tabId, url } = res.data;
      let protocol = '';
      let hostname = '';
      try {
        const parsed = new URL(url);
        protocol = parsed.protocol;
        hostname = parsed.hostname;
      } catch {
        // 无法解析的 URL 对浏览器工具同样不可用，按受限页显示原始地址。
      }
      const available = isCurrentTabReadable(url);
      const title = res.data.title?.trim() || (available && hostname ? hostname : t('workbench.untitledPage'));
      if (requestId !== pageContextRequestId) return;
      set({
        pageContext: available
          ? { status: 'available', tabId, title, url }
          : { status: 'restricted', tabId, title, url },
      });
    } catch (error) {
      if (requestId !== pageContextRequestId) return;
      set({ pageContext: { status: 'error', message: errMsg(error) } });
    }
  },

  setSelectedProvider: (id) => {
    const prov = get().providers.find((p) => p.id === id);
    if (!prov) return;
    set({ selectedProviderId: id, selectedModel: prov.model });
  },

  setSelectedModel: (model) => set({ selectedModel: model }),

  selectProviderAndModel: (providerId, model) => {
    const prov = get().providers.find((p) => p.id === providerId);
    if (!prov) return;
    set({ selectedProviderId: providerId, selectedModel: model });
  },

  send: async (text, options) => {
    const pending = get().pendingAttachments;
    if (hasBusyAttachments(pending) || get().busy) return false;
    const ready = pending.filter(isAttachmentReady);
    const question = (text ?? get().input).trim();
    if (!question && ready.length === 0) return false;
    const displayText = question || t('store.attachmentOnlyPrompt');
    const quoted = get().quotedSelection;
    return runAgent(
      set,
      get,
      makeMessage('user', displayText, 'input', quoted ?? undefined),
      displayText,
      {
        withoutBrowserTools: options?.withoutBrowserTools,
        clearQuotedSelection: true,
        clearAttachments: true,
        attachmentSubmission: {
          question,
          quoted,
          attachmentIds: ready.map((item) => item.id),
        },
      },
    );
  },

  editMessage: async (id, newContent) => {
    const trimmed = newContent.trim();
    if (!trimmed || get().busy || hasBusyAttachments(get().pendingAttachments)) return false;
    const messages = get().messages;
    const index = findMessageIndex(messages, id);
    if (index < 0 || !isEditableMessage(messages[index])) return false;
    // 传给 runAgent 的是 id 而不是这里算出的下标：runAgent 内部要等待若干 await 之后
    // 才会真正截断，届时会用 id 重新解析下标，避免下标跨 await 失效（见 runAgent 内注释）。
    return runAgent(set, get, makeMessage('user', trimmed, 'input'), trimmed, {
      truncateToId: id,
    });
  },

  runShortcut: async (shortcut) => {
    if (get().busy || hasBusyAttachments(get().pendingAttachments)) return;
    const origin = captureConversationOrigin(get);
    const resolved = resolveShortcut({ ...shortcut }, t);
    let tab: ActiveTabInfo | undefined;
    let selection: PageSelection | undefined;

    if (resolved.scope === 'selection') {
      set({ busy: true, error: null });
      try {
        tab = await resolveActiveTab();
        if (!isCurrentOrigin(origin, get)) return;
        const response = (await sendMessage(
          'GET_SELECTION',
          undefined,
          tab.id,
        )) as MessageResponse<PageSelection>;
        if (!isCurrentOrigin(origin, get)) return;
        if (!response.ok || !response.data) {
          throw new Error(response.error ?? t('store.getSelectionFailed'));
        }
        selection = response.data;
      } catch (error) {
        if (!isCurrentOrigin(origin, get)) return;
        set({ busy: false, error: errMsg(error) });
        return;
      }
      set({ busy: false });
    }

    let execution;
    try {
      execution = buildShortcutExecution(resolved, t, selection?.text);
    } catch (error) {
      if (!isCurrentOrigin(origin, get)) return;
      set({ busy: false, error: errMsg(error) });
      return;
    }

    await runAgent(
      set,
      get,
      makeMessage('user', execution.display, 'action'),
      execution.agentUserContent,
      {
        presetTab: tab,
        withoutBrowserTools: execution.browserTools === 'none',
        systemPromptSuffix: execution.systemPromptSuffix,
        origin,
      },
    );
  },

  stop: () => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(false);
    run.resolveConfirmation = null;
    run.resolveQuestion?.('');
    run.resolveQuestion = null;
    run.agent?.abort();
    for (const step of get().activitySteps) run.terminatedToolCallIds.add(step.id);
    const pendingId = get().pendingConfirmation?.toolCallId ?? get().pendingQuestion?.toolCallId;
    if (pendingId) run.terminatedToolCallIds.add(pendingId);
    clearAllSlowActivityTimers();
    set({ pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
  },

  respondToConfirmation: (approved) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(approved);
    run.resolveConfirmation = null;
    const pending = get().pendingConfirmation;
    set({ pendingConfirmation: null });
    if (!approved && pending) {
      run.terminatedToolCallIds.add(pending.toolCallId);
      const info = run.pendingToolArgs.get(pending.toolCallId);
      const description = describeToolActivity(pending.toolName, info?.args, 'failed');
      set((s) => ({
        activitySteps: upsertActivityStep(s.activitySteps, {
          id: pending.toolCallId,
          description,
          status: 'failed',
        }),
      }));
    }
  },

  respondToQuestion: (answer) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveQuestion?.(answer);
    run.resolveQuestion = null;
    set({ pendingQuestion: null });
  },

  clear: () => {
    get().disposeAttachments();
    clearAllSlowActivityTimers();
    ++conversationOpenRequestId;
    invalidateActiveRun(set, get);
    conversationEpoch += 1;
    set({
      messages: [],
      activitySteps: [],
      error: null,
      busy: false,
      conversationId: genConversationId(),
      pendingConfirmation: null,
      pendingQuestion: null,
    });
  },

  refreshConversations: async () => {
    set({ conversations: await listConversations() });
  },

  openConversation: async (id) => {
    get().disposeAttachments();
    const requestId = ++conversationOpenRequestId;
    invalidateActiveRun(set, get);
    conversationEpoch += 1;
    const records = await getConversationMessages(id).catch(() => null);
    if (records === null) return false;
    if (requestId !== conversationOpenRequestId) return false;
    // A run can start while IndexedDB is loading. Fence it immediately before
    // installing B so its callbacks and finally cannot observe B's state.
    invalidateActiveRun(set, get);
    conversationEpoch += 1;
    const messages: UIMessage[] = records
      .filter((r) => r.role !== 'system')
      .map((r) => ({
        id: genMessageId(),
        role: r.role as 'user' | 'assistant',
        content: r.content,
        createdAt: r.createdAt,
        kind: r.kind,
        quotedText: r.quotedText,
        attachments: r.attachments,
        taskOutcome: r.taskOutcome,
      }));
    clearAllSlowActivityTimers();
    set({
      messages,
      activitySteps: [],
      conversationId: id,
      error: null,
      busy: false,
      pendingConfirmation: null,
      pendingQuestion: null,
    });
    return true;
  },

  restoreTabConversation: async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') return;
    panelTabId = tabId;
    const savedId = await getConversationIdForTab(tabId);
    if (savedId) {
      restoringSavedConversation = true;
      try {
        await get().openConversation(savedId);
      } finally {
        restoringSavedConversation = false;
      }
    } else {
      await setConversationIdForTab(tabId, get().conversationId);
    }

    await consumePendingAskForTab(tabId);
  },

  removeConversation: async (id) => {
    ++conversationOpenRequestId;
    const removingActive = get().conversationId === id;
    if (removingActive) {
      get().disposeAttachments();
      invalidateActiveRun(set, get, false);
      conversationEpoch += 1;
    }
    try {
      await beginConversationDeletion(id);
    } catch (error) {
      if (removingActive && get().conversationId === id) set({ error: errMsg(error) });
      return;
    }
    try {
      await get().refreshConversations();
    } finally {
      if (get().conversationId === id) {
        // A run can start while deletion/list refresh awaits. Do not let it
        // persist the record that has just been deleted. This cleanup is
        // authoritative even when refreshing the drawer fails afterward.
        get().disposeAttachments();
        invalidateActiveRun(set, get, false);
        conversationEpoch += 1;
        clearAllSlowActivityTimers();
        set({
          messages: [],
          activitySteps: [],
          conversationId: genConversationId(),
          busy: false,
          pendingConfirmation: null,
          pendingQuestion: null,
        });
      }
    }
  },
}));

// conversationId 的每次变化（clear() / openConversation() / removeConversation() 的兜底新建）
// 都通过这里统一写回 tabId -> conversationId 映射，不需要在各个 action 里分别插入持久化代码。
useChat.subscribe((state, prevState) => {
  if (state.conversationId === prevState.conversationId) return;
  if (panelTabId === null) return;
  setConversationIdForTab(panelTabId, state.conversationId).catch(() => undefined);
  if (restoringSavedConversation) return;
  clearTabSession(panelTabId).catch(() => undefined);
});

// 面板已经打开时（sidePanel.open() 对已打开的面板是 no-op，不会重新触发挂载时的
// restoreTabConversation），靠这个监听器实时消费新写入的 pending ask——否则用户在已打开的
// 面板前再次点击气泡会看起来毫无反应，直到面板下次被销毁重建才会“迟到”地预填进去。
// 与上面的 subscribe 一样是"绑定在 panelTabId 上、每个面板文档生命周期内注册一次"的模块级副作用，
// 不需要显式移除：Chrome 销毁/重建面板文档时整个模块也随之重建，没有泄漏可言。
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session' || panelTabId === null) return;
  const change = changes[pendingAskStorageKey(panelTabId)];
  // 跳过删除侧的变化——那正是本函数自己 clearPendingAskForTab 触发的回声。
  if (!change || !change.newValue) return;
  void consumePendingAskForTab(panelTabId);
});

interface RunAgentOptions {
  /** 已解析好的目标标签页（选区快捷方式会先取一次），避免 runAgent 里重复查询。 */
  presetTab?: ActiveTabInfo;
  truncateToId?: string;
  withoutBrowserTools?: boolean;
  systemPromptSuffix?: string;
  origin?: ConversationOrigin;
  /** 提交本轮时是否顺带清空 quotedSelection；只有主输入框发送需要，编辑历史消息/运行快捷指令时不动它。 */
  clearQuotedSelection?: boolean;
  images?: ImageContent[];
  /** 提交本轮时是否顺带清空 pendingAttachments；语义与 clearQuotedSelection 完全对称。 */
  clearAttachments?: boolean;
  /**
   * 主输入框发送开始时允许提交的 ready 附件 ID。真正的 prompt 和历史投影在异步
   * 前置检查结束后重建，因此期间被移除/清空的附件不能借旧闭包进入请求或持久化；
   * 期间新添加的附件也不会被并入已经点击发送的这一轮。
   */
  attachmentSubmission?: {
    question: string;
    quoted: string | null;
    attachmentIds: string[];
  };
}

async function runAgent(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  display: UIMessage,
  agentUserContent: string,
  options: RunAgentOptions = {},
): Promise<boolean> {
  const initialState = get();
  if (hasBusyAttachments(initialState.pendingAttachments)) return false;
  const origin = options.origin ?? captureConversationOrigin(get);
  if (origin.conversationId !== initialState.conversationId || origin.conversationEpoch !== conversationEpoch) return false;
  const run: ActiveRun = {
    id: ++runEpoch,
    origin,
    agent: null,
    resolveConfirmation: null,
    resolveQuestion: null,
    pendingToolArgs: new Map(),
    terminatedToolCallIds: new Set(),
    taskOutcome: null,
  };
  activeRun = run;
  const all = initialState.providers;
  const provider =
    all.find((p) => p.id === initialState.selectedProviderId) ??
    (await getActiveProvider()) ??
    null;
  if (!isCurrentRun(run, get)) return false;
  if (!provider) {
    set({ error: t('store.noProviderConfigured') });
    settleRun(run);
    return false;
  }
  if (!provider.apiKey) {
    set({ error: t('store.missingApiKey') });
    settleRun(run);
    return false;
  }

  // 输入框选中的模型覆盖 Provider 默认模型
  const desiredModel = initialState.selectedModel || provider.model;
  const agentProvider: ProviderConfig =
    desiredModel && desiredModel !== provider.model ? { ...provider, model: desiredModel } : provider;

  let tab: ActiveTabInfo;
  try {
    tab = options.presetTab ?? (await resolveActiveTab());
  } catch (e) {
    if (isCurrentRun(run, get)) set({ error: errMsg(e) });
    settleRun(run);
    return false;
  }
  if (!isCurrentRun(run, get)) return false;
  const tabId = tab.id;
  const tabSession = await loadTabSession(tabId).catch(() => createTabSession(tabId));

  // 截断必须放在 Provider 校验与 resolveActiveTabId 之后：那两处失败会 set({ error }) 直接 return，
  // 若此时历史已被截断，用户的消息就被不可恢复地丢弃了，而这是用户完全没有预期的失败路径
  // （ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §4）。
  //
  // 这里用 id 重新解析下标，而不是复用 editMessage 里同步算出的下标：从那里到这里之间
  // 经过了上面两个 await（getActiveProvider / resolveActiveTabId），若用户在这个 10-50ms
  // 窗口内切换到了另一个会话，get().messages 已经变成了另一个会话的数组，此时若仍拿着
  // 「对旧会话算出的下标」去 slice，会把错误的切片当成新历史提交；而 replaceConversationMessages
  // 是先整体删除该会话的消息再整体写入，届时会把用户根本没有编辑的会话静默且不可恢复地截断。
  // 用 id 在这个最后一次 await 之后重新查找，天然规避了这个问题：id 在另一个会话里查不到，
  // 会直接落入下面的「未命中」分支报错退出，不会误伤。
  const current = get().messages;
  let history = current;
  if (options.truncateToId !== undefined) {
    const index = findMessageIndex(current, options.truncateToId);
    if (index < 0) {
      set({ error: t('store.messageNotFound') });
      settleRun(run);
      return false;
    }
    history = current.slice(0, index);
  }
  let committedDisplay = display;
  let committedAgentUserContent = agentUserContent;
  let committedImages = options.images;
  if (options.attachmentSubmission) {
    const { question, quoted, attachmentIds } = options.attachmentSubmission;
    const allowedIds = new Set(attachmentIds);
    const ready = get().pendingAttachments.filter(
      (item) => allowedIds.has(item.id) && isAttachmentReady(item),
    );
    if (!question && ready.length === 0) {
      settleRun(run);
      return false;
    }
    const displayText = question || t('store.attachmentOnlyPrompt');
    const storedAttachments = ready
      .map(toMessageAttachment)
      .filter((item): item is MessageAttachment => item !== null);
    const attachmentText = ready.map((item) => buildPendingAttachmentText(item, t)).join('');
    committedDisplay = {
      ...display,
      content: displayText,
      quotedText: quoted ?? undefined,
      attachments: storedAttachments.length ? storedAttachments : undefined,
    };
    committedAgentUserContent =
      (quoted ? buildSelectionAskTemplate(quoted, t) : '') + attachmentText + displayText;
    const images = ready
      .map(toPendingImageContent)
      .filter((item): item is ImageContent => item !== null);
    committedImages = images.length ? images : undefined;
  }
  if (options.clearAttachments) cancelPendingAttachments(get().pendingAttachments);
  clearAllSlowActivityTimers();
  set({
    messages: [...history, committedDisplay, makeMessage('assistant', '')],
    activitySteps: [],
    input: '',
    ...(options.clearQuotedSelection ? { quotedSelection: null } : {}),
    ...(options.clearAttachments ? { pendingAttachments: [] } : {}),
    busy: true,
    error: null,
    pendingConfirmation: null,
    pendingQuestion: null,
  });
  if (!isCurrentRun(run, get)) return false;

  const onConfirm = async (toolCallId: string, toolName: string, args: unknown, _reason: string): Promise<boolean> => {
    if (!isCurrentRun(run, get)) return false;
    const targetTab =
      tabSession.currentTabId !== tabId
        ? tabSession.trackedTabs.find((t) => t.id === tabSession.currentTabId)
        : undefined;
    const { summary, codePreview } = summarizeToolCallForConfirmation(toolName, args, targetTab);
    run.pendingToolArgs.set(toolCallId, { toolName, args });
    set({ pendingConfirmation: { toolCallId, toolName, summary, codePreview } });
    return new Promise<boolean>((resolve) => {
      run.resolveConfirmation = resolve;
    });
  };

  // ask_user 工具自己就是"停下来问用户"，不走 onConfirm 那条批准/拒绝闸门——
  // 这里只负责把问题投影到 UI、等待 respondToQuestion 把答案送回来。
  const onAskUser = async (toolCallId: string, question: string, signal?: AbortSignal): Promise<string> => {
    if (!isCurrentRun(run, get) || signal?.aborted) return '';
    set({ pendingQuestion: { toolCallId, question } });
    return new Promise<string>((resolve) => {
      run.resolveQuestion = resolve;
    });
  };

  const agent = createBrowserAgent({
    provider: agentProvider,
    tabId,
    session: tabSession,
    systemPrompt: buildSystemPrompt({
      locale: getCurrentLocale(),
      readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
      writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
      now: new Date(),
      // 禁用浏览器工具的快捷方式不注入页面信息：那一轮明确要求不读取当前页面，
      // 注入标题/地址既与该约束矛盾，也是白送给模型的一段网页可控文本。
      page: options.withoutBrowserTools ? undefined : { tabId, title: tab.title, url: tab.url },
      constraints: options.systemPromptSuffix,
    }),
    tools: options.withoutBrowserTools ? [] : undefined,
    messages: toAgentMessages(history),
    readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
    writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
    onConfirm,
    onAskUser,
    onOverlay: (payload, targetTabId) => {
      void sendMessage('SET_AGENT_OVERLAY', payload, targetTabId).catch(() => undefined);
    },
    onSessionChange: (session) => { void saveTabSession(session).catch(() => undefined); },
    onTaskOutcome: (outcome) => {
      if (!isCurrentRun(run, get)) return;
      run.taskOutcome = outcome;
    },
  });
  if (!isCurrentRun(run, get)) return false;
  run.agent = agent;
  let acc = '';
  const unsubscribe = agent.subscribe((event) => {
    if (!isCurrentRun(run, get)) return;
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      acc += event.assistantMessageEvent.delta;
      replaceLastAssistant(set, acc);
    }

    if (event.type === 'tool_execution_start' && !run.terminatedToolCallIds.has(event.toolCallId)) {
      run.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      set((s) => ({
        activitySteps: upsertActivityStep(s.activitySteps, {
          id: event.toolCallId,
          description: describeToolActivity(event.toolName, event.args, 'running'),
          status: 'running',
        }),
      }));
      scheduleSlowActivityTimer(set, event.toolCallId);
    }

    if (event.type === 'tool_execution_update' && !run.terminatedToolCallIds.has(event.toolCallId)) {
      run.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      set((s) => {
        const existing = s.activitySteps.find((step) => step.id === event.toolCallId);
        return {
          activitySteps: upsertActivityStep(s.activitySteps, {
            id: event.toolCallId,
            description: describeToolActivity(event.toolName, event.args, 'running'),
            status: 'running',
            slow: existing?.slow,
          }),
        };
      });
      scheduleSlowActivityTimer(set, event.toolCallId);
    }

    if (event.type === 'tool_execution_end') {
      const blocked = event.isError && isToolGuardBlockResult(event.result);
      // 聊天界面里的活动提示刻意不展示原始 tool result（可能带用户输入的敏感值，见下方
      // "does not expose raw tool payloads" 一类用例），所以失败原因只打到控制台，方便
      // 打开 DevTools 排查，不在 UI 上泄露。
      if (event.isError && !blocked) {
        // event.result 通常是 { content: [{type:'text', text}], details } 这样的对象——
        // console.error 直接打对象在 chrome://extensions 的错误面板里会被字符串化成
        // "[object Object]"（该面板不支持对象展开，只有普通 DevTools 控制台才行），
        // 所以这里尽量把文本消息拆出来打，保证错误面板里也能看到实际原因。
        const result = event.result as unknown;
        const message =
          typeof result === 'string'
            ? result
            : ((result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content?.find(
                (c) => c.type === 'text',
              )?.text ?? result);
        console.error('[Runi] tool execution failed', event.toolName, message);
      }
      const info = run.pendingToolArgs.get(event.toolCallId);
      run.pendingToolArgs.delete(event.toolCallId);
      clearSlowActivityTimer(event.toolCallId);
      if (!run.terminatedToolCallIds.has(event.toolCallId)) {
        const finalStatus = blocked || event.isError ? 'failed' : 'done';
        const description = describeToolActivity(event.toolName, info?.args, finalStatus);
        set((s) => ({
          activitySteps: finishActivityStep(s.activitySteps, event.toolCallId, finalStatus, description),
        }));
      }
    }
  });

  try {
    const missingTypes = await getMissingAgentMessageTypes();
    if (!isCurrentRun(run, get)) return false;
    if (missingTypes.length > 0) {
      acc = t('store.staleBackgroundWarning', { missingTypes: missingTypes.join(', ') });
      replaceLastAssistant(set, acc);
      // 到这里历史已经截断并提交（上面的 set({ messages: ... }) 已执行），
      // 对 editMessage 来说这是「成功发起」，只是后台协议过旧导致本轮没能真正跑起来。
      return true;
    }

    // 不能传 undefined 作为显式第二参数：store-context.test.tsx 里 toHaveBeenCalledWith('...') 断言的是单参数调用，
    // 传两个参数（哪怕第二个是 undefined）会让 vitest 的参数数组比对失败。
    if (committedImages && committedImages.length > 0) {
      await agent.prompt(committedAgentUserContent, committedImages);
    } else {
      await agent.prompt(committedAgentUserContent);
    }
    if (!isCurrentRun(run, get)) return false;
    if (!acc.trim()) {
      // pi-agent-core 不会为流式错误抛异常：agent-loop 遇到 stopReason "error"/"aborted" 时
      // 直接 return，所以 agent.prompt() 正常 resolve。真正的错误信息只存在于最后一条
      // assistant 消息的 errorMessage 上——不读它，任何 HTTP 400 / 中途错误都会退化成
      // 一句无信息量的「没有生成文本结果」。
      const last = findLastAssistant(agent.state.messages);
      acc = extractLastAssistantText(agent.state.messages) || describeEmptyAgentRun(last);
      if (!extractLastAssistantText(agent.state.messages)) {
        // 传对象给 console.error 在 chrome://extensions 错误面板里会被字符串化成
        // "[object Object]"（该面板不支持对象展开），所以这里改成打印可读文本。
        console.error(
          '[Runi] Agent 未产生文本结果',
          compactJson({
            stopReason: last?.stopReason,
            errorMessage: last?.errorMessage,
            lastAssistantContent: last?.content,
          }),
        );
      }
      replaceLastAssistant(set, acc);
    }
  } catch (e) {
    if (!isCurrentRun(run, get)) return false;
    if (e instanceof DOMException && e.name === 'AbortError') {
      // 用户主动停止，保留已生成的部分内容
    } else {
      set({ error: errMsg(e) });
    }
  } finally {
    unsubscribe();
    if (isCurrentRun(run, get)) {
      if (run.taskOutcome) {
        const outcome = run.taskOutcome;
        set((state) => {
          const messages = state.messages.slice();
          const last = messages[messages.length - 1];
          if (!last) return {};
          messages[messages.length - 1] = { ...last, taskOutcome: outcome };
          return { messages };
        });
      }
      const messages = get().messages;
      // The turn is terminal before persistence starts: navigation must not
      // abort an already-complete agent or schedule a second snapshot write.
      settleRun(run);
      clearAllSlowActivityTimers();
      set({ busy: false, activitySteps: [] });
      // 回合结束就撤遮罩。正常完成、模型出错、用户中止三条路径都汇到这个 finally
      // （见下方注释），所以这一处就够。送不到也不要紧——content script 侧有 15s 看门狗兜底。
      // 遮罩此时实际所在的 tab 是 tabSession.currentTabId（轮次里可能已经切换过），不一定是
      // 面板绑定的 tabId。
      void sendMessage('SET_AGENT_OVERLAY', { active: false }, tabSession.currentTabId).catch(() => undefined);
      void saveTabSession(tabSession).catch(() => undefined);
      await persistConversationSnapshot(run.origin.conversationId, messages);
    }
  }
  // 走到这里说明历史已经截断并提交（正常完成 / 模型出错 / 用户中止都在 try/catch 内处理，
  // 不会抛出到这里），对调用方而言就是「成功发起」。
  return true;
}

function replaceLastAssistant(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  content: string,
): void {
  set((state) => {
    const messages = state.messages.slice();
    const last = messages[messages.length - 1];
    if (!last) return { error: null };
    messages[messages.length - 1] = { ...last, content };
    return { messages, error: null };
  });
}

function toAgentMessages(messages: UIMessage[]): AgentLlmMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content, timestamp: Date.now() };
    }
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
      api: 'openai-completions',
      provider: 'history',
      model: 'history',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  });
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    return content
      .filter((part): part is { type: 'text'; text: string } =>
        Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'),
      )
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

interface LastAssistantInfo {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

function findLastAssistant(messages: unknown[]): LastAssistantInfo | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    return message as LastAssistantInfo;
  }
  return undefined;
}

// "Failed to fetch" 是浏览器 fetch() 在网络层失败时的原始报错（断网、DNS 解析失败、连接被拒、CORS 拦截等），
// 与「Base URL / API Key / 模型名填错」是两类完全不同的问题，不能用同一句排查建议糊弄过去。
function isNetworkFetchError(reason: string): boolean {
  return /failed to fetch|network ?error|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET_DISCONNECTED|NETWORK_CHANGED)/i.test(
    reason,
  );
}

// 一轮 Agent 运行结束却没有任何文本时，尽可能说明原因，而不是只丢一句「没有生成文本结果」。
function describeEmptyAgentRun(last: LastAssistantInfo | undefined): string {
  if (last?.stopReason === 'error') {
    const reason = last.errorMessage || t('store.unknownError');
    if (isNetworkFetchError(reason)) {
      return t('store.modelCallNetworkError', { reason });
    }
    return t('store.modelCallFailed', { reason });
  }
  if (last?.stopReason === 'length') {
    return t('store.tokenLimitReached');
  }
  if (last?.stopReason === 'aborted') return t('store.generationAborted');
  const onlyToolCalls =
    Array.isArray(last?.content) &&
    last.content.length > 0 &&
    last.content.every((part) => (part as { type?: unknown })?.type === 'toolCall');
  if (onlyToolCalls) {
    return t('store.onlyToolCalls');
  }
  return t('store.noTextResult');
}

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return String(value);
  }
}

function isToolGuardBlockResult(value: unknown): boolean {
  const text = compactJson(value);
  return (
    text.includes('请停止继续调用工具') ||
    text.includes('工具调用已达到上限') ||
    text.includes('不要重复读取这些宽泛资料')
  );
}

async function getMissingAgentMessageTypes(): Promise<string[]> {
  try {
    const res = (await sendMessage('PING')) as MessageResponse<{
      agentProtocol?: number;
      supportedTypes?: string[];
    }>;
    const supported = new Set(res.ok && res.data?.supportedTypes ? res.data.supportedTypes : []);
    return REQUIRED_AGENT_MESSAGE_TYPES.filter((type) => !supported.has(type));
  } catch {
    return [...REQUIRED_AGENT_MESSAGE_TYPES];
  }
}

/**
 * 用运行开始时捕获的会话 id 和消息快照整体重写该会话。
 * 绝不能在异步 Agent 回调的 finally 里读取全局 store：用户已切换会话时，
 * 那会把旧轮次的数据错误写进新会话。
 */
async function persistConversationSnapshot(conversationId: string, messages: UIMessage[]): Promise<void> {
  // A snapshot created after deletion starts must never queue behind the delete
  // and recreate its conversation. Snapshots already queued remain ahead of
  // the delete in this conversation's lane, making delete authoritative.
  if (successfulDeletedConversationIds.has(conversationId) || pendingDeletionGenerations.has(conversationId)) return;
  try {
    await enqueueConversationMutation(conversationId, async () => {
      await replaceConversationMessages(
        conversationId,
        toMessageRecords(conversationId, messages),
        conversationTitle(messages),
      );
    });
  } catch (e) {
    console.error('[Runi] 持久化会话失败', e);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

if (import.meta.env.DEV) {
  (window as unknown as { __useChat: typeof useChat }).__useChat = useChat;
}
