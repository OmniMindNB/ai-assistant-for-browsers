import { create } from 'zustand';
import {
  sendMessage,
  type ActiveTabInfo,
  type MessageResponse,
  type PageContent,
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
  type ConversationRecord,
} from '@/lib/db';
import {
  findMessageIndex,
  isEditableMessage,
  type ChatMessage,
} from '@/lib/chat/messages';
import {
  buildSystemPrompt,
  DEFAULT_READ_TOOL_CALL_BUDGET,
  DEFAULT_WRITE_TOOL_CALL_BUDGET,
} from '@/lib/agent/system-prompt';
import { buildShortcutExecution, type PagePrefetch } from '@/lib/chat/shortcut-prompts';
import { type ActivityStep } from '@/lib/agent/activity-steps';
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
import {
  AGENT_RUN_PORT_NAME,
  type PanelToBackground,
  type BackgroundToPanel,
  type SnapshotMessage,
  type PendingConfirmation,
  type PendingQuestion,
} from '@/lib/agent/run-port-protocol';

export type UIMessage = ChatMessage;

export type { ActivityStep } from '@/lib/agent/activity-steps';

export type { PendingConfirmation, PendingQuestion };

export type PageContextState =
  | { status: 'loading' }
  | { status: 'available'; tabId: number; title: string; url: string }
  | { status: 'restricted'; tabId: number; title: string; url: string }
  | { status: 'error'; message: string };

interface ChatState {
  messages: UIMessage[];
  activitySteps: ActivityStep[];
  /** 每次消费一条划词提问 pending ask 后设为 Date.now()；WorkbenchComposer 据此判断"该聚焦输入框了"。 */
  pendingFocusToken: number;
  /** 划词提问消费到的待引用文字（裁剪后）；作为独立卡片显示在输入框上方，不混入 input。 */
  quotedSelection: string | null;
  /** 待发送附件的瞬态生命周期；只有 ready 元数据会进入历史。 */
  pendingAttachments: PendingAttachment[];
  busy: boolean;
  error: string | null;
  /** 重试上一次导致 `error` 的动作（重新解析 tab/取选区/发送等前置失败），供顶部错误横幅的重试按钮调用；无可重试动作或 error 已清空时为 null。 */
  retryAction: (() => void) | null;
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
  send: (text: string, options?: { withoutBrowserTools?: boolean }) => Promise<boolean>;
  /** 成功发起（截断+提交）返回 true；任一前置校验失败返回 false，调用方据此决定是否关闭编辑框。 */
  editMessage: (id: string, newContent: string) => Promise<boolean>;
  /** 重新生成某条 assistant 回复：找到它前面最近一条 user 消息，原样重发（等价于免打开编辑框的 editMessage）。 */
  regenerate: (assistantId: string) => Promise<boolean>;
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

// 真正的运行状态（Agent 实例、pending confirmation/question 的 resolver、活动步骤）现在都
// 在 background 的 run-registry.ts 里；面板这份 ActiveRun 只剩下"用来过滤过期事件"的身份信息
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md）。
interface ActiveRun {
  id: number;
  origin: ConversationOrigin;
  tabId: number;
}
let activeRun: ActiveRun | null = null;

type RunPort = ReturnType<typeof browser.runtime.connect>;

let runPort: RunPort | null = null;
/** connectRunPort 的入参留存下来，好让 onDisconnect 里的自动重连不需要调用方再传一次。 */
let runPortTabId: number | null = null;
let runPortSet: StoreSet | null = null;
let runPortGet: StoreGet | null = null;
/** Port 暂时不可用期间攒下的消息；重连成功后按序补发，绝不静默丢弃用户动作。
 * 有意不设上限：这里排队的都是用户亲手触发的动作（发送/停止/确认），为了"防止无界增长"
 * 而丢掉其中任何一条，正是本次要修的问题本身；而面板文档本身生命周期很短，
 * 且 runtime.connect() 会顺带把 service worker 唤醒，队列实际上很难堆起来。 */
const pendingPortMessages: PanelToBackground[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** 握手期等待 background 对 `hello` 的回包（snapshot 或 noRun）。 */
let pendingHello: ((snapshot: SnapshotMessage | undefined) => void) | null = null;

/** background 正常情况下会立刻回 `hello`（同进程消息传递），这个超时只是"背景完全不回话"
 * 时的兜底，避免面板挂载被无限期卡住。 */
const HELLO_REPLY_TIMEOUT_MS = 300;
/** 断线后重连的延迟：给 Chrome 一点时间把 service worker 拉起来，也避免背景真的不可达时
 * 变成一个紧凑的重连热循环。 */
const RECONNECT_DELAY_MS = 250;
/** page-scope 快捷方式预取正文的长度上限，与 browser_read_page 工具的默认 maxChars 保持一致
 * （lib/agent/tools.ts makeReadPageTool）。 */
const PAGE_PREFETCH_MAX_CHARS = 12000;

function flushPendingPortMessages(): void {
  if (!runPort) return;
  while (pendingPortMessages.length > 0) {
    const message = pendingPortMessages[0];
    try {
      runPort.postMessage(message);
    } catch {
      // 刚建好的连接又断了：留在队列里等下一次重连，不丢。
      return;
    }
    pendingPortMessages.shift();
  }
}

/** 真正建立连接。成功返回 true；`browser.runtime.connect` 本身抛错（背景不可达）返回 false。 */
function openRunPort(): boolean {
  if (runPortTabId === null) return false;
  const tabId = runPortTabId;
  try {
    const port = browser.runtime.connect({ name: AGENT_RUN_PORT_NAME });
    runPort = port;
    port.onMessage.addListener(handleRunPortMessage);
    port.onDisconnect.addListener(() => {
      // MV3 会定期回收空闲的 service worker，并断开挂在它上面的每一个 Port；扩展更新和
      // 崩溃也是同一条路径。断开不代表 run 结束（background 侧 detachPort 明确不清理
      // RunState），面板要做的只是重新连上去继续订阅。
      if (runPort !== port) return;
      runPort = null;
      scheduleReconnect();
    });
    // 这里直接 postMessage 而不走 postToRunPort：hello 必须是这条连接上的第一条消息，
    // 不能排在队列里补发的那些后面。
    port.postMessage({ type: 'hello', tabId } satisfies PanelToBackground);
    flushPendingPortMessages();
    return true;
  } catch {
    runPort = null;
    return false;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null || runPortTabId === null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (runPort) return;
    if (!openRunPort()) scheduleReconnect();
  }, RECONNECT_DELAY_MS);
}

/**
 * 往 Port 发一条消息。Port 断了就地重连并重发；重连也失败就入队，等下一次重连补发。
 * 绝不能让用户的动作（发送、停止、确认卡片的批准/拒绝）在 Port 恰好处于断开状态时
 * 静默消失，或者抛一个没人接的 "Attempting to use a disconnected port object"。
 */
function postToRunPort(message: PanelToBackground): void {
  if (!runPort && !openRunPort()) {
    pendingPortMessages.push(message);
    scheduleReconnect();
    return;
  }
  try {
    runPort!.postMessage(message);
    return;
  } catch {
    runPort = null;
  }
  if (openRunPort()) {
    try {
      runPort!.postMessage(message);
      return;
    } catch {
      runPort = null;
    }
  }
  pendingPortMessages.push(message);
  scheduleReconnect();
}

/** 把一次会话删除（或删除失败后的撤销）同步给 background 的落盘闸门。 */
function notifyConversationDeleted(conversationId: string, deleted: boolean): void {
  // Port 从未建立过（restoreTabConversation 还没跑）时无从发送，也无从入队——
  // 那种时刻 background 里不可能有本面板发起的 run。
  if (runPortTabId === null) return;
  postToRunPort({ type: 'conversationDeleted', tabId: runPortTabId, conversationId, deleted });
}

function handleRunPortMessage(raw: unknown): void {
  const message = raw as BackgroundToPanel;
  // orphanResolved 目前不会被触发（见 background.ts 的注释），面板不处理这个分支——
  // 孤儿恢复写回 Dexie 后，下次这个 tab 的会话被打开时会照常从历史里读到那条 failure 消息。
  if (message.type !== 'snapshot' && message.type !== 'noRun') return;
  if (pendingHello) {
    // 握手回包：交给 restoreTabConversation 决定是采用这份快照还是走 Dexie 路径，
    // 不在这里 applySnapshot——此刻 activeRun 还没建好，applySnapshot 只会把它丢掉。
    const resolve = pendingHello;
    pendingHello = null;
    resolve(message.type === 'snapshot' ? message : undefined);
    return;
  }
  if (message.type === 'snapshot') applySnapshot(message);
}

/** panelTabId 解析出来之后调用一次（见 restoreTabConversation），建立与 background 的
 * 持久连接。面板文档被销毁时这个 Port 自然断开，不需要显式清理——不影响 background 里
 * 的 run 继续跑，见 lib/agent/run-registry.ts 的 detachPort 文档注释。
 *
 * 返回值是 background 对 `hello` 的回包：有存活 run 时是它的当前快照，没有时是 undefined。
 * 调用方必须等这个回包再决定怎么恢复 UI，否则面板重开后从 Dexie 读到的旧历史会盖掉
 * 正在跑的那一轮（本次修复的 bug 本身）。 */
function connectRunPort(tabId: number, set: StoreSet, get: StoreGet): Promise<SnapshotMessage | undefined> {
  runPortTabId = tabId;
  runPortSet = set;
  runPortGet = get;
  return new Promise<SnapshotMessage | undefined>((resolve) => {
    let settled = false;
    const finish = (snapshot: SnapshotMessage | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingHello === handler) pendingHello = null;
      resolve(snapshot);
    };
    const handler = (snapshot: SnapshotMessage | undefined): void => finish(snapshot);
    const timer = setTimeout(() => finish(undefined), HELLO_REPLY_TIMEOUT_MS);
    pendingHello = handler;
    if (!openRunPort()) {
      // 连不上背景：不必白等超时，直接按"没有存活 run"处理，重连由 scheduleReconnect 继续。
      scheduleReconnect();
      finish(undefined);
    }
  });
}

/**
 * 面板重开时发现 background 手上还有这个 tab 的 run：直接用它的快照重建整个 UI，
 * 并**跳过**从 Dexie 读历史那条路径。
 *
 * 为什么必须跳过：`RunSnapshot.messages` 按协议就是这一轮的完整权威历史，而 Dexie 里那份
 * 可能落后（流式增量还没等到 message_end）；更要命的是 openConversation 会顺手
 * set({ busy:false, activitySteps: [] })，正在跑的那一轮会被"恢复历史"这个动作抹掉。
 */
function adoptLiveRunSnapshot(snapshot: SnapshotMessage, set: StoreSet): void {
  conversationEpoch += 1;
  const run: ActiveRun = {
    id: ++runEpoch,
    origin: { conversationId: snapshot.conversationId, conversationEpoch },
    tabId: snapshot.tabId,
  };
  activeRun = run;
  // 与 openConversation 的恢复路径同一个理由：这是"面板文档重建后重新挂上同一个会话"，
  // 不是用户切换会话，不能让 useChat.subscribe 顺手 clearTabSession —— 那会把正在跑的
  // 这一轮追踪的标签页列表清空。
  restoringSavedConversation = true;
  try {
    set({
      conversationId: snapshot.conversationId,
      messages: snapshot.messages,
      activitySteps: snapshot.activitySteps,
      pendingConfirmation: snapshot.pendingConfirmation,
      pendingQuestion: snapshot.pendingQuestion,
      busy: snapshot.busy,
      error: null,
    });
  } finally {
    restoringSavedConversation = false;
  }
  // 极小的时间窗：run 恰好在我们连上的那一刻收尾完毕，background 回的是一份 busy:false
  // 的终局快照。照常收下最终消息，然后立刻把 activeRun 归位。
  if (!snapshot.busy) settleRun(run);
}

function applySnapshot(snapshot: SnapshotMessage): void {
  const set = runPortSet;
  const get = runPortGet;
  if (!set || !get) return;
  const run = activeRun;
  if (!run || run.tabId !== snapshot.tabId || !isCurrentOrigin(run.origin, get)) return;
  set({
    messages: snapshot.messages,
    activitySteps: snapshot.activitySteps,
    pendingConfirmation: snapshot.pendingConfirmation,
    pendingQuestion: snapshot.pendingQuestion,
    busy: snapshot.busy,
  });
  if (!snapshot.busy) settleRun(run);
}
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
  activeRun = null;
}

function invalidateActiveRun(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
): void {
  const run = activeRun;
  if (!run) return;
  activeRun = null;
  postToRunPort({ type: 'stop', tabId: run.tabId });
  if (isCurrentOrigin(run.origin, get)) {
    set({ busy: false, pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
  }
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
  pendingFocusToken: 0,
  quotedSelection: null,
  pendingAttachments: [],
  busy: false,
  error: null,
  retryAction: null,
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
    const question = text.trim();
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
        retry: () => { void get().send(text, options); },
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
      retry: () => { void get().editMessage(id, newContent); },
    });
  },

  regenerate: async (assistantId) => {
    const messages = get().messages;
    const assistantIndex = findMessageIndex(messages, assistantId);
    if (assistantIndex < 0) return false;
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0) return false;
    const userMessage = messages[userIndex];
    return get().editMessage(userMessage.id, userMessage.content);
  },

  runShortcut: async (shortcut) => {
    if (get().busy || hasBusyAttachments(get().pendingAttachments)) return;
    const origin = captureConversationOrigin(get);
    const resolved = resolveShortcut({ ...shortcut }, t);
    let tab: ActiveTabInfo | undefined;
    let selection: PageSelection | undefined;
    let pagePrefetch: PagePrefetch | undefined;

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
        set({ busy: false, error: errMsg(error), retryAction: () => { void get().runShortcut(shortcut); } });
        return;
      }
      set({ busy: false });
    } else if (resolved.scope === 'page') {
      // 预取页面正文并直接塞进首轮 user turn：不预取的话，"总结本页"这类最高频 page-scope
      // 快捷方式要先让模型发起 browser_read_page 才能拿到内容，白白多花一整轮 LLM 往返
      // （ref: [[project-sidepanel-perf-profile]]，减少轮数是目前唯一真正的提速杠杆）。
      // resolveActiveTab 失败是真错误，走跟 selection 分支一致的失败路径；EXTRACT_PAGE
      // 本身失败（受限页、内容脚本未注入等）则静默降级——不设置 pagePrefetch，
      // buildShortcutExecution 退回原本"不预取"的路径，模型仍可自己调用 browser_read_page 兜底。
      set({ busy: true, error: null });
      try {
        tab = await resolveActiveTab();
      } catch (error) {
        if (!isCurrentOrigin(origin, get)) return;
        set({ busy: false, error: errMsg(error), retryAction: () => { void get().runShortcut(shortcut); } });
        return;
      }
      if (!isCurrentOrigin(origin, get)) return;
      try {
        const response = (await sendMessage(
          'EXTRACT_PAGE',
          undefined,
          tab.id,
        )) as MessageResponse<PageContent>;
        if (!isCurrentOrigin(origin, get)) return;
        if (response.ok && response.data) {
          pagePrefetch = {
            title: response.data.title,
            url: response.data.url,
            // 与 browser_read_page 工具的默认上限保持一致，模型认得这种量级的正文。
            text: response.data.text.slice(0, PAGE_PREFETCH_MAX_CHARS),
          };
        }
      } catch {
        // 静默降级，见上方注释。
      }
      set({ busy: false });
    }

    let execution;
    try {
      execution = buildShortcutExecution(resolved, t, selection?.text, pagePrefetch);
    } catch (error) {
      if (!isCurrentOrigin(origin, get)) return;
      set({ busy: false, error: errMsg(error), retryAction: () => { void get().runShortcut(shortcut); } });
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
        retry: () => { void get().runShortcut(shortcut); },
      },
    );
  },

  // stop/respondToConfirmation/respondToQuestion 不再本地 resolve 任何东西——那些 resolver
  // 现在活在 background 的 run-registry.ts 里。这里把用户的动作转发成 Port 消息，并顺带做一次
  // 乐观的本地 UI 清理（清空 pending 状态/活动步骤），让按钮反馈是即时的；权威状态仍然是随后
  // 推回来的 snapshot，走 applySnapshot 那条统一路径覆盖
  // （ref: lib/agent/run-registry.ts 的 respondConfirm/respondQuestion/stopRun，它们处理完
  // 都会 broadcast(tabId, snapshotOf(state))）。
  stop: () => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    postToRunPort({ type: 'stop', tabId: run.tabId });
    set({ pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
  },

  respondToConfirmation: (approved) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    const pending = get().pendingConfirmation;
    if (!pending) return;
    postToRunPort({
      type: 'respondConfirm',
      tabId: run.tabId,
      toolCallId: pending.toolCallId,
      approved,
    });
    set({ pendingConfirmation: null });
  },

  respondToQuestion: (answer) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    const pending = get().pendingQuestion;
    if (!pending) return;
    postToRunPort({
      type: 'respondQuestion',
      tabId: run.tabId,
      toolCallId: pending.toolCallId,
      answer,
    });
    set({ pendingQuestion: null });
  },

  clear: () => {
    get().disposeAttachments();
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
        stopped: r.stopped,
        activitySteps: r.activitySteps,
        contextTruncated: r.contextTruncated,
      }));
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
    // 先握手、再决定怎么恢复：Chrome 销毁面板文档不会终止 background 里的 run，重开的这个
    // 面板必须先问一句"这个 tab 现在还有没有在跑的 run"。有的话它的快照就是权威状态，
    // 从 Dexie 读历史那条路径会把它盖掉（openConversation 会顺手 busy:false + 清活动步骤）。
    const liveSnapshot = await connectRunPort(tabId, set, get);
    if (liveSnapshot) {
      adoptLiveRunSnapshot(liveSnapshot, set);
      await setConversationIdForTab(tabId, liveSnapshot.conversationId);
    } else {
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
    }

    await consumePendingAskForTab(tabId);
  },

  removeConversation: async (id) => {
    ++conversationOpenRequestId;
    const removingActive = get().conversationId === id;
    if (removingActive) {
      get().disposeAttachments();
      invalidateActiveRun(set, get);
      conversationEpoch += 1;
    }
    // 落盘现在完全在 background；不把"这个会话被删了"同步过去，一轮还在飞的 run 结束时
    // 会用 replaceConversationMessages 把刚删掉的会话整行写回去，用户看到它复活
    // （CLAUDE.md 的 delete tombstone 约束，跨进程版本）。
    // 无条件发送、且发在删除动作之前：历史抽屉里删掉的会话可能正在另一个 tab 上跑，
    // 只有 background 能把 conversationId 关联回持有它的 RunState；而等删除完成再发的话，
    // 这段等待窗口正好是最容易被迟到快照复活的那一段。
    notifyConversationDeleted(id, true);
    try {
      await beginConversationDeletion(id);
    } catch (error) {
      // 删除最终失败 = 会话还在。撤销上面的标记，否则这个会话此后再也写不进 Dexie。
      notifyConversationDeleted(id, false);
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
        invalidateActiveRun(set, get);
        conversationEpoch += 1;
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

// pageContext 只在面板挂载时取过一次快照；submitMessage 用它的 status 决定
// withoutBrowserTools（见 App.tsx 的 resolvePageAttached）。面板绑定的 tab 导航后不刷新的话，
// 快照会一直停在旧页面上，导致新页面的这一轮 browser_* 工具被静默摘掉且没有任何提示。
// 只关心面板自己绑定的这一个 tab；其余 tab 的更新与本面板无关。
browser.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (tabId !== panelTabId) return;
  if (changeInfo.status !== 'complete' && changeInfo.url === undefined) return;
  void useChat.getState().refreshPageContext();
});

interface RunAgentOptions {
  /** 已解析好的目标标签页（选区快捷方式会先取一次），避免 runAgent 里重复查询。 */
  presetTab?: ActiveTabInfo;
  truncateToId?: string;
  withoutBrowserTools?: boolean;
  systemPromptSuffix?: string;
  origin?: ConversationOrigin;
  /** 本轮若在前置校验阶段失败，赋给 `retryAction` 供错误横幅的重试按钮重新发起同一个动作。 */
  retry?: () => void;
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
    // tabId 在这里还不知道（要等下面 resolveActiveTab() 完成）——先用占位值让 isCurrentRun
    // 在此之前的 await（getActiveProvider 等）期间能正常按 id/origin 判断race，
    // tab 解析出来后立刻用真实 tabId 覆盖（见下面 `run.tabId = tabId;`）。
    tabId: -1,
  };
  activeRun = run;
  const all = initialState.providers;
  const provider =
    all.find((p) => p.id === initialState.selectedProviderId) ??
    (await getActiveProvider()) ??
    null;
  if (!isCurrentRun(run, get)) return false;
  if (!provider) {
    set({ error: t('store.noProviderConfigured'), retryAction: options.retry ?? null });
    settleRun(run);
    return false;
  }
  if (!provider.apiKey) {
    set({ error: t('store.missingApiKey'), retryAction: options.retry ?? null });
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
    if (isCurrentRun(run, get)) set({ error: errMsg(e), retryAction: options.retry ?? null });
    settleRun(run);
    return false;
  }
  if (!isCurrentRun(run, get)) return false;
  const tabId = tab.id;
  run.tabId = tabId;
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
      set({ error: t('store.messageNotFound'), retryAction: options.retry ?? null });
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
  set({
    messages: [...history, committedDisplay, makeMessage('assistant', '')],
    activitySteps: [],
    ...(options.clearQuotedSelection ? { quotedSelection: null } : {}),
    ...(options.clearAttachments ? { pendingAttachments: [] } : {}),
    busy: true,
    error: null,
    retryAction: null,
    pendingConfirmation: null,
    pendingQuestion: null,
  });
  activeRun = { id: run.id, origin: run.origin, tabId };
  postToRunPort({
    type: 'startRun',
    tabId,
    conversationId: run.origin.conversationId,
    provider: agentProvider,
    systemPrompt: buildSystemPrompt({
      locale: getCurrentLocale(),
      readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
      writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
      now: new Date(),
      page: options.withoutBrowserTools ? undefined : { tabId, title: tab.title, url: tab.url },
      constraints: options.systemPromptSuffix,
    }),
    withoutBrowserTools: options.withoutBrowserTools,
    // history 是提交前的历史，不含本轮新增的用户消息——run-registry.ts 的 startRun 会自己
    // 拼接 [...historyMessages, displayMessage, 占位 assistant]。这里传 history 而不是
    // 上面 set({messages:[...history, committedDisplay, ...]}) 用过的那个拼接结果，否则
    // committedDisplay 会在 run-registry.ts 那边被重复拼接一次。
    historyMessages: history,
    displayMessage: committedDisplay,
    agentUserContent: committedAgentUserContent,
    images: committedImages,
    readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
    writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
  });
  return true;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

if (import.meta.env.DEV) {
  (window as unknown as { __useChat: typeof useChat }).__useChat = useChat;
}
