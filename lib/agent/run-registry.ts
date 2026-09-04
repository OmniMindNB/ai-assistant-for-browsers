// agent 运行的核心编排：一个 tabId 同一时刻最多一个 RunState，Agent 实例、活动步骤、
// pending confirmation/question 全部在这里，不再依赖侧边栏面板文档的生命周期
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md）。
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message as AgentLlmMessage } from '@earendil-works/pi-ai';
import { createBrowserAgent } from './agent';
import { createTabSession, type TabSessionController, type TrackedTab } from './tab-session';
import { loadTabSession, saveTabSession } from './tab-session-storage';
import { summarizeToolCallForConfirmation } from './confirm-summary';
import { describeToolActivity } from './activity-description';
import { upsertActivityStep, finishActivityStep, type ActivityStep } from './activity-steps';
import { toolSignature } from './tool-policy';
import { replaceConversationMessages } from '@/lib/db';
import { conversationTitle, toMessageRecords, type ChatMessage } from '@/lib/chat/messages';
import { t } from '@/lib/i18n';
import type { TaskOutcome } from './task-outcome';
import type {
  PendingConfirmation,
  PendingQuestion,
  RunSnapshot,
  StartRunRequest,
} from './run-port-protocol';
import {
  saveRunStateSnapshot,
  clearRunStateSnapshot,
  loadRunStateSnapshot,
  listOrphanRunTabIds,
} from './run-state-storage';
import { setOverlayForTab, clearOverlayForTab } from './tab-overlay-state';
import { clearTakeoverForTab } from './tab-takeover';
import { sendToContentScript } from './content-script-messaging';
import { newMessageId, type SetAgentOverlayPayload } from '@/lib/messaging';

interface RunState {
  tabId: number;
  conversationId: string;
  agent: Agent;
  session: TabSessionController;
  messages: ChatMessage[];
  activitySteps: ActivityStep[];
  busy: boolean;
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
  resolveConfirmation: ((approved: boolean) => void) | null;
  resolveQuestion: ((answer: string) => void) | null;
  pendingToolArgs: Map<string, { toolName: string; args: unknown }>;
  terminatedToolCallIds: Set<string>;
  taskOutcome: TaskOutcome | null;
  /** 本轮上下文窗口是否被重切过；true 时早期历史已被摘要/移出上下文（见 agent.ts 的 onContextTruncated）。 */
  contextTruncated: boolean;
  /**
   * stopRun 会立刻清空 state.activitySteps 换来即时的 UI 反馈（见 stopRun 注释），
   * 这里存一份被清空前的快照，好让 finally 里的存档逻辑仍能拿到"停止那一刻跑到哪了"。
   * null 表示这一轮没有被用户停止过，此时以 finally 里当场读到的 state.activitySteps 为准。
   */
  stoppedActivitySteps: ActivityStep[] | null;
}

const runs = new Map<number, RunState>();

/**
 * 被面板删除过的会话 id（见 run-port-protocol.ts 的 ConversationDeletedMessage）。
 *
 * 落盘现在全在 background 侧，而"这个会话已经被删了"只有面板知道；不记下来的话，
 * 一轮还在飞的 run 结束时会把刚被删掉的会话整行写回 Dexie，用户看到它复活。
 *
 * 生命周期与 service worker 一致（冷启动即清空），这与它取代的那套面板侧 Set
 * （随面板文档销毁而清空）的时效范围是同一量级，够用；再加一个大小上限，
 * 避免长时间不重启的 worker 里这个集合无界增长。
 */
const deletedConversationIds = new Set<string>();
const MAX_TRACKED_DELETED_CONVERSATIONS = 500;

/** 面板删除了一个会话：此后所有针对它的 Dexie 写入都跳过。 */
export function markConversationDeleted(conversationId: string): void {
  deletedConversationIds.add(conversationId);
  while (deletedConversationIds.size > MAX_TRACKED_DELETED_CONVERSATIONS) {
    const oldest: string | undefined = deletedConversationIds.values().next().value;
    if (oldest === undefined) break;
    deletedConversationIds.delete(oldest);
  }
}

/** 那次删除最终失败、会话仍然存在：撤销标记，否则这个会话此后再也写不进 Dexie。 */
export function unmarkConversationDeleted(conversationId: string): void {
  deletedConversationIds.delete(conversationId);
}

export interface PortLike {
  postMessage(message: unknown): void;
}

const listeners = new Map<number, PortLike>();

function broadcast(tabId: number, snapshot: RunSnapshot): void {
  listeners.get(tabId)?.postMessage({ type: 'snapshot', ...snapshot });
  updateActionBadge(tabId, snapshot);
}

/**
 * agent 主循环搬进 background 之后，一个正在运行的 run 不再依赖侧边栏面板文档存活——
 * 但用户把面板切走（Chrome 会连带把 per-tab 面板收起来）时，运行状态和待确认卡片
 * 就完全没有任何外部信号了。用 action 图标的徽标顶替：待确认/待回答优先级最高（用户
 * 现在就要处理），其次是"正在运行"，都没有则清空。tabId 显式传入，徽标只作用于
 * 触发这次运行的那个标签页，不影响其它标签页的图标。
 *
 * 这里跟着 broadcast() 一起调用而不是散落在各个状态迁移点：broadcast 已经是所有状态变化
 * （运行开始/流式输出/工具步骤/待确认待回答的设置与清除/运行结束）共同收敛的唯一出口。
 */
function updateActionBadge(tabId: number, snapshot: RunSnapshot): void {
  try {
    const action = browser.action;
    if (!action) return;
    const needsAttention = Boolean(snapshot.pendingConfirmation || snapshot.pendingQuestion);
    const text = needsAttention ? '!' : snapshot.busy ? '●' : '';
    void action.setBadgeText({ tabId, text })?.catch?.(() => undefined);
    if (text) {
      const color = needsAttention ? '#d97706' : '#2563eb';
      void action.setBadgeBackgroundColor?.({ tabId, color })?.catch?.(() => undefined);
    }
  } catch {
    // 徽标是纯提示：tab 可能已经关闭，或 action API 在当前环境不可用（如单元测试），静默忽略。
  }
}

export function getRunState(tabId: number): RunState | undefined {
  return runs.get(tabId);
}

function snapshotOf(state: RunState): RunSnapshot {
  return {
    tabId: state.tabId,
    conversationId: state.conversationId,
    busy: state.busy,
    messages: state.messages,
    activitySteps: state.activitySteps,
    pendingConfirmation: state.pendingConfirmation,
    pendingQuestion: state.pendingQuestion,
  };
}

function pushAndPersist(state: RunState): void {
  const snapshot = snapshotOf(state);
  broadcast(state.tabId, snapshot);
  void saveRunStateSnapshot(state.tabId, snapshot);
}

async function persistMessages(state: RunState): Promise<void> {
  // 会话已被用户删除：整轮照常收尾（清运行态、清 alarm），只是不再写 Dexie——
  // replaceConversationMessages 是"先删后整体写入"，会把已删除的会话行重新 put 回来。
  if (deletedConversationIds.has(state.conversationId)) return;
  await replaceConversationMessages(
    state.conversationId,
    toMessageRecords(state.conversationId, state.messages),
    conversationTitle(state.messages),
  ).catch((e: unknown) => console.error('[Runi] 持久化会话失败', e));
}

function toAgentMessages(messages: ChatMessage[]): AgentLlmMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content, timestamp: message.createdAt };
    }
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
      api: 'openai-completions',
      provider: 'history',
      model: 'history',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: message.createdAt,
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
      .filter((part): part is { type: 'text'; text: string } => Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'))
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

function isNetworkFetchError(reason: string): boolean {
  return /failed to fetch|network ?error|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET_DISCONNECTED|NETWORK_CHANGED)/i.test(reason);
}

function describeEmptyAgentRun(last: LastAssistantInfo | undefined): string {
  if (last?.stopReason === 'error') {
    const reason = last.errorMessage || t('store.unknownError');
    if (isNetworkFetchError(reason)) return t('store.modelCallNetworkError', { reason });
    return t('store.modelCallFailed', { reason });
  }
  if (last?.stopReason === 'length') return t('store.tokenLimitReached');
  if (last?.stopReason === 'aborted') return t('store.generationAborted');
  const onlyToolCalls =
    Array.isArray(last?.content) && last.content.length > 0 &&
    last.content.every((part) => (part as { type?: unknown })?.type === 'toolCall');
  if (onlyToolCalls) return t('store.onlyToolCalls');
  return t('store.noTextResult');
}

/** 用户点了"停止"（stopRun -> agent.abort()）时 prompt() 抛出的那个 AbortError。 */
function isUserAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

/**
 * `agent.prompt()` 直接抛出（而不是以 stopReason:'error' 正常收尾）时的用户可见文案。
 *
 * 复用 describeEmptyAgentRun 里同一套 i18n 文案与网络错误判定：对用户来说"模型调用失败"
 * 这件事没有区别，区别只在 pi-agent-core 是把失败塞进最后一条 assistant 消息、
 * 还是让 promise reject。
 */
function describeThrownAgentError(error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)) || t('store.unknownError');
  if (isNetworkFetchError(reason)) return t('store.modelCallNetworkError', { reason });
  return t('store.modelCallFailed', { reason });
}

function replaceLastAssistant(state: RunState, content: string): void {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;
  state.messages = [...state.messages.slice(0, -1), { ...last, content }];
}

function keepaliveAlarmName(tabId: number): string {
  return `runi:agent-keepalive:${tabId}`;
}

const KEEPALIVE_PERIOD_MINUTES = 20 / 60; // chrome.alarms 的周期单位是分钟；20 秒 ≈ 1/3 分钟

function startKeepalive(tabId: number): void {
  browser.alarms?.create?.(keepaliveAlarmName(tabId), { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
}

/**
 * 清掉某个 tab 的保活 alarm。
 *
 * 导出是为了给 scanForOrphans 用：service worker 中途死掉时 startRun 的 finally 没跑过，
 * 那个 20s 周期 alarm 会一直留在 chrome.alarms 里空转，冷启动后没人再清它。
 */
export function stopKeepalive(tabId: number): void {
  void browser.alarms?.clear?.(keepaliveAlarmName(tabId));
}

const STREAM_FLUSH_INTERVAL_MS = 48;

/**
 * 当前操作目标 tab，仅当它不是面板自己绑定的 tab 时才返回（同一 tab 上的操作不需要标注，
 * 见 onConfirm/confirm-summary.ts 的既有约定）。供确认卡片和活动步骤标签共用同一份判断。
 */
function currentTargetTab(state: RunState): TrackedTab | undefined {
  if (state.session.currentTabId === state.tabId) return undefined;
  return state.session.trackedTabs.find((tab) => tab.id === state.session.currentTabId);
}

/**
 * 当前实际操作 tab 的顶层 origin，供确认卡片跟表单所在帧的 origin 比对（ref: 设计文档 §5.3）。
 * 不能从 trackedTabs 里取：面板自己绑定的 tab 通常没有被跟踪记录 url（只有 browser_open_tab
 * 打开的 tab 才可靠地带 url），所以这里做一次实时查询；纯装饰性的 UI 增强，任何失败都直接
 * 返回 undefined，绝不能抛出或阻塞确认流程。
 */
async function currentMainOrigin(state: RunState): Promise<string | undefined> {
  try {
    const tab = await browser.tabs.get(state.session.currentTabId);
    if (!tab.url) return undefined;
    const url = new URL(tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** 供活动步骤展示用的标签文本；未命名页面兜底文案与 confirm-summary.ts 保持一致。 */
function currentTabLabel(state: RunState): string | undefined {
  const targetTab = currentTargetTab(state);
  return targetTab ? targetTab.title || '未命名页面' : undefined;
}

export async function startRun(request: StartRunRequest): Promise<void> {
  const existing = runs.get(request.tabId);
  if (existing) {
    existing.agent.abort();
    runs.delete(request.tabId);
  }

  // 上一轮遗留的接管记录不能带进这一轮：用户几分钟前在别的任务里插过手，
  // 不该让新任务的第一个写操作就停下来问"要继续吗"。
  await clearTakeoverForTab(request.tabId).catch(() => undefined);

  const session = await loadTabSession(request.tabId).catch(() => createTabSession(request.tabId));
  const placeholder: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', createdAt: Date.now() };
  const state: RunState = {
    tabId: request.tabId,
    conversationId: request.conversationId,
    agent: null as unknown as Agent, // 下面立刻赋值；先占位是因为 onConfirm/onAskUser 闭包要引用 state
    session,
    messages: [...request.historyMessages, request.displayMessage, placeholder],
    activitySteps: [],
    busy: true,
    pendingConfirmation: null,
    pendingQuestion: null,
    resolveConfirmation: null,
    resolveQuestion: null,
    pendingToolArgs: new Map(),
    terminatedToolCallIds: new Set(),
    taskOutcome: null,
    contextTruncated: false,
    stoppedActivitySteps: null,
  };
  runs.set(request.tabId, state);
  startKeepalive(request.tabId);

  // 用户消息必须在这里、agent.prompt() 开始之前就落盘——这正是本次迁移要修的
  // bug：过去只在整轮结束的 finally 里持久化一次，面板中途被销毁时刚发出去的
  // 用户消息会跟着丢。
  await persistMessages(state);
  pushAndPersist(state);

  const onConfirm = async (toolCallId: string, toolName: string, args: unknown): Promise<boolean> => {
    // 只有当前操作目标不是面板绑定的那个 tab 时才带上标注——同一个 tab 上的操作再标一遍
    // "将操作标签页：《本页》"只是噪音（ref: confirm-summary.ts 的 targetTab 参数说明）。
    // 读的是 state.session 的实时字段而不是 startRun 那一刻的值：browser_open_tab /
    // browser_switch_tab 会在一轮之内改变 currentTabId。
    const targetTab = currentTargetTab(state);
    const mainOrigin = await currentMainOrigin(state);
    const { summary, codePreview } = summarizeToolCallForConfirmation(toolName, args, targetTab, mainOrigin);
    state.pendingToolArgs.set(toolCallId, { toolName, args });
    state.pendingConfirmation = { toolCallId, toolName, summary, codePreview };
    pushAndPersist(state);
    return new Promise<boolean>((resolve) => { state.resolveConfirmation = resolve; });
  };

  // 用户在 agent 操作期间自己点了/敲了页面，而 agent 又要写：停下来问一次。
  // 复用 pendingConfirmation 这条通道（应答走同一个 respondConfirm），靠 kind 区分文案与语义——
  // 另起一套 pending/resolver/快照字段只会把同构的东西写两遍。
  const onTakeover = async (toolCallId: string, toolName: string, args: unknown): Promise<boolean> => {
    const targetTab = currentTargetTab(state);
    const { summary } = summarizeToolCallForConfirmation(toolName, args, targetTab);
    state.pendingConfirmation = { toolCallId, toolName, summary, kind: 'takeover' };
    // 页面上的遮罩也要跟着改口：用户此刻眼睛多半在页面上而不是侧边栏上，
    // 让它还挂着"正在点击…"会与"其实已经停下来等你了"直接矛盾。
    void sendAgentOverlay({ active: true, label: t('agentActivity.takeoverPaused') }, state.session.currentTabId);
    pushAndPersist(state);
    return new Promise<boolean>((resolve) => { state.resolveConfirmation = resolve; });
  };

  const onAskUser = async (toolCallId: string, question: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) return '';
    state.pendingQuestion = { toolCallId, question };
    pushAndPersist(state);
    return new Promise<string>((resolve) => { state.resolveQuestion = resolve; });
  };

  const agent = createBrowserAgent({
    provider: request.provider,
    tabId: request.tabId,
    session,
    systemPrompt: request.systemPrompt,
    tools: request.withoutBrowserTools ? [] : undefined,
    messages: toAgentMessages(request.historyMessages),
    readToolCallBudget: request.readToolCallBudget,
    writeToolCallBudget: request.writeToolCallBudget,
    onConfirm,
    onTakeover,
    onAskUser,
    onOverlay: (payload, targetTabId) => {
      void sendAgentOverlay(payload, targetTabId);
    },
    onSessionChange: (updated) => { void saveTabSession(updated).catch(() => undefined); },
    onBudgetLow: (remaining) => {
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: 'budget-low',
        description: t('agentActivity.budgetLow', { count: String(remaining) }),
        status: 'notice',
      });
      pushAndPersist(state);
    },
    onToolPhaseEnd: (reason) => {
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: 'tool-phase-end',
        description: t(reason === 'budget_exhausted' ? 'agentActivity.budgetExhausted' : 'agentActivity.repeatedlyBlocked'),
        status: 'notice',
      });
      pushAndPersist(state);
    },
    onTaskOutcome: (outcome) => { state.taskOutcome = outcome; },
    onContextTruncated: () => { state.contextTruncated = true; },
  });
  state.agent = agent;

  let acc = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    replaceLastAssistant(state, acc);
    pushAndPersist(state);
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      acc += event.assistantMessageEvent.delta;
      if (flushTimer === null) flushTimer = setTimeout(flush, STREAM_FLUSH_INTERVAL_MS);
    }

    if (event.type === 'tool_execution_start' && !state.terminatedToolCallIds.has(event.toolCallId)) {
      state.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
        tabLabel: currentTabLabel(state),
        // 带上签名，让 upsertActivityStep 能把"同一个调用的又一次尝试"并成一行。
        signature: toolSignature(event.toolName, event.args),
      });
      pushAndPersist(state);
    }

    if (event.type === 'tool_execution_update' && !state.terminatedToolCallIds.has(event.toolCallId)) {
      state.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
        tabLabel: currentTabLabel(state),
        signature: toolSignature(event.toolName, event.args),
      });
      pushAndPersist(state);
    }

    if (event.type === 'tool_execution_end') {
      const info = state.pendingToolArgs.get(event.toolCallId);
      state.pendingToolArgs.delete(event.toolCallId);
      if (!state.terminatedToolCallIds.has(event.toolCallId)) {
        const finalStatus = event.isError ? 'failed' : 'done';
        state.activitySteps = finishActivityStep(
          state.activitySteps,
          event.toolCallId,
          finalStatus,
          describeToolActivity(event.toolName, info?.args, finalStatus),
        );
        pushAndPersist(state);
      }
    }

    if (event.type === 'message_end') {
      // Flush any pending text before persisting, so state.messages reflects the complete message
      flush();
      void persistMessages(state);
    }
  });

  // Fire-and-forget: don't await prompt(), just start it
  let wasUserStopped = false;
  void (async () => {
    try {
      await agent.prompt(request.agentUserContent, request.images);
      if (!acc.trim()) {
        const last = findLastAssistant(agent.state.messages);
        acc = extractLastAssistantText(agent.state.messages) || describeEmptyAgentRun(last);
      }
      replaceLastAssistant(state, acc);
    } catch (e) {
      // 只 console.error 的话（迁移后一度就是这样），占位 assistant 消息会永远停在空内容上：
      // 用户看到轮次结束、busy 熄灭，却没有任何回复也没有任何错误提示。把结果写进消息本身，
      // 复用下面 finally 里已有的 persistMessages/pushAndPersist 通路，不需要给 RunSnapshot
      // 另开一个 error 字段。
      if (isUserAbortError(e)) {
        // 用户主动停止不是故障：保留已经流出来的部分文本（与迁移前 store.ts 的 AbortError
        // 分支行为一致）；一个字都还没出来时给一句明确的"已中止"，而不是留一条空气泡。
        // 但即便有部分文本，也要标 stopped：不然一段中途截断的回答会跟正常说完的回答
        // 长得一模一样，用户没法区分"模型就说到这"和"被我自己掐断了"。
        wasUserStopped = true;
        replaceLastAssistant(state, acc.trim() ? acc : t('store.generationAborted'));
      } else {
        console.error('[Runi] agent.prompt 异常', e);
        const errorText = describeThrownAgentError(e);
        replaceLastAssistant(state, acc.trim() ? `${acc}\n\n${errorText}` : errorText);
      }
    } finally {
      unsubscribe();
      if (flushTimer !== null) clearTimeout(flushTimer);
      // Only perform cleanup if this run is still the current one for this tab.
      // If a new run was started for the same tab while this one was in flight,
      // this run's finally block should not clobber the new run's state.
      if (runs.get(state.tabId) === state) {
        // 存档这一轮实际跑过的步骤，而不是像迁移前那样直接清空丢弃：写/点/填表这类会动页面的
        // 动作，用户事后应该能回看 agent 到底做了什么（ref: [[project-ux-perf-audit-2026-09-01]] P1-6）。
        // stoppedActivitySteps 非空说明这一轮被用户停止过，stopRun 里已经把它冻结成停止那一刻的
        // 快照（含把仍是 running 的步骤标成 failed）；否则用当场的 state.activitySteps。
        const finishedSteps = state.stoppedActivitySteps ?? state.activitySteps;
        const last = state.messages[state.messages.length - 1];
        if (last) {
          state.messages = [
            ...state.messages.slice(0, -1),
            {
              ...last,
              ...(state.taskOutcome ? { taskOutcome: state.taskOutcome } : {}),
              ...(wasUserStopped ? { stopped: true } : {}),
              ...(finishedSteps.length > 0 ? { activitySteps: finishedSteps } : {}),
              ...(state.contextTruncated ? { contextTruncated: true } : {}),
            },
          ];
        }
        state.busy = false;
        state.activitySteps = [];
        state.pendingConfirmation = null;
        state.pendingQuestion = null;
        await persistMessages(state);
        pushAndPersist(state);
        await clearRunStateSnapshot(state.tabId).catch(() => undefined);
        // 遮罩状态只在这里统一收尾：不论正常结束、报错还是被用户停止，操作过的标签页
        // 都不该继续挂着一个陈旧的"正在填写 N 个字段"——它既不会自己消失，页面刷新时
        // background 的 tabs.onUpdated 监听器还会把 storage.session 里这份残留状态重新
        // 推回页面（ref: 用户反馈——停止生成后遮罩卡死，刷新页面也不消失）。
        await sendAgentOverlay({ active: false }, state.session.currentTabId);
        stopKeepalive(state.tabId);
        runs.delete(state.tabId);
      }
    }
  })();
}

export function attachPort(tabId: number, port: PortLike): RunSnapshot | undefined {
  listeners.set(tabId, port);
  const state = runs.get(tabId);
  return state ? snapshotOf(state) : undefined;
}

/** Port 断开只表示"暂时没人在看"，绝不能连带清理 RunState 或调用 agent.abort()——
 * 这正是本次迁移要修的 bug 本身，不能在这里重犯（ref: 设计文档 §4）。*/
export function detachPort(tabId: number, port: PortLike): void {
  if (listeners.get(tabId) === port) listeners.delete(tabId);
}

/** 冷启动时调用一次：找出 storage.session 里残留的、内存中已经没有对应存活 run 的
 * 运行态快照——这正是"上次 service worker 中途死掉，run 没能走到自己的 finally 清理"
 * 的信号。把它们标成失败消息写回 Dexie，并清掉 storage.session 里的残留条目，避免
 * 下次冷启动重复处理。真正推给 Port 的动作在 Task 5 的 attachPort 调用处。 */
export async function scanForOrphans(): Promise<import('./run-port-protocol').OrphanResolvedMessage[]> {
  const tabIds = await listOrphanRunTabIds();
  const resolved: import('./run-port-protocol').OrphanResolvedMessage[] = [];
  for (const tabId of tabIds) {
    if (runs.has(tabId)) continue; // 这个 tab 已经有存活的 run，说明这条快照是它自己刚写的，不是孤儿
    const snapshot = await loadRunStateSnapshot(tabId);
    if (!snapshot) continue;
    const last = snapshot.messages[snapshot.messages.length - 1];
    const messages: ChatMessage[] = last && last.role === 'assistant' && !last.content
      ? [...snapshot.messages.slice(0, -1), { ...last, content: t('store.interruptedByRestart') }]
      : [...snapshot.messages, { id: `orphan-${tabId}-${Date.now()}`, role: 'assistant' as const, content: t('store.interruptedByRestart'), createdAt: Date.now() }];

    // 上一次 worker 死掉时 startRun 的 finally 没跑过，那个 20s 周期的保活 alarm
    // 还留在 chrome.alarms 里空转。这一步与写入成功与否无关，先无条件清掉。
    stopKeepalive(tabId);

    // 会话已被用户删除：不写回 Dexie（写回等于复活），但残留的运行态快照要清掉，
    // 否则每次冷启动都会重复处理同一条孤儿。
    let written = deletedConversationIds.has(snapshot.conversationId);
    if (!written) {
      written = await replaceConversationMessages(
        snapshot.conversationId,
        toMessageRecords(snapshot.conversationId, messages),
        conversationTitle(messages),
      ).then(
        () => true,
        (e: unknown) => {
          console.error('[Runi] 孤儿 run 恢复失败', e);
          return false;
        },
      );
    }

    resolved.push({ type: 'orphanResolved', tabId, messages });

    // 只有写入确实落盘了才清 storage.session 里的快照：写失败时把它留下，
    // 下一次冷启动还能再试一次。无条件清掉的话，用户既看不到失败消息，
    // 也永久失去了这一轮的历史。
    if (written) await clearRunStateSnapshot(tabId).catch(() => undefined);
  }
  return resolved;
}

export function respondConfirm(tabId: number, toolCallId: string, approved: boolean): void {
  const state = runs.get(tabId);
  if (!state || state.pendingConfirmation?.toolCallId !== toolCallId) return;
  const resolve = state.resolveConfirmation;
  const kind = state.pendingConfirmation.kind ?? 'submit';
  state.resolveConfirmation = null;

  if (kind === 'takeover') {
    // 继续也好结束也好，都留一条痕迹：回合结束时它会被归档进 assistant 消息的步骤明细，
    // 用户事后翻回来能看到"这里我插过手"。这正是原先缺的那一环——接管发生过却无迹可寻。
    state.activitySteps = upsertActivityStep(state.activitySteps, {
      id: `takeover-${toolCallId}`,
      description: t(approved ? 'agentActivity.takeoverResumed' : 'agentActivity.takeoverStopped'),
      status: approved ? 'done' : 'failed',
      tabLabel: currentTabLabel(state),
    });
    if (!approved) state.terminatedToolCallIds.add(toolCallId);
  } else if (!approved) {
    state.terminatedToolCallIds.add(toolCallId);
    const info = state.pendingToolArgs.get(toolCallId);
    state.activitySteps = upsertActivityStep(state.activitySteps, {
      id: toolCallId,
      description: describeToolActivity(state.pendingConfirmation.toolName, info?.args, 'failed'),
      status: 'failed',
      tabLabel: currentTabLabel(state),
    });
  }
  state.pendingConfirmation = null;
  broadcast(tabId, snapshotOf(state));
  void saveRunStateSnapshot(tabId, snapshotOf(state));
  resolve?.(approved);
}

export function respondQuestion(tabId: number, toolCallId: string, answer: string): void {
  const state = runs.get(tabId);
  if (!state || state.pendingQuestion?.toolCallId !== toolCallId) return;
  const resolve = state.resolveQuestion;
  state.resolveQuestion = null;
  state.pendingQuestion = null;
  broadcast(tabId, snapshotOf(state));
  void saveRunStateSnapshot(tabId, snapshotOf(state));
  resolve?.(answer);
}

export function stopRun(tabId: number): void {
  const state = runs.get(tabId);
  if (!state) return;
  state.resolveConfirmation?.(false);
  state.resolveConfirmation = null;
  state.resolveQuestion?.('');
  state.resolveQuestion = null;
  state.agent.abort();
  // 还在 running 的步骤没等到 tool_execution_end 就被掐断，存档前把它们标成 failed——
  // 一个永远停在"进行中"的步骤比明确标"未完成"更容易让人误以为它其实跑完了。
  state.stoppedActivitySteps = state.activitySteps.map((step) =>
    step.status === 'running' ? { ...step, status: 'failed' } : step,
  );
  for (const step of state.activitySteps) state.terminatedToolCallIds.add(step.id);
  const pendingId = state.pendingConfirmation?.toolCallId ?? state.pendingQuestion?.toolCallId;
  if (pendingId) state.terminatedToolCallIds.add(pendingId);
  state.pendingConfirmation = null;
  state.pendingQuestion = null;
  state.activitySteps = [];
  broadcast(tabId, snapshotOf(state));
  void saveRunStateSnapshot(tabId, snapshotOf(state));
}

// 遮罩的真正落地逻辑（entrypoints/background.ts 里的 setAgentOverlay）本身就只是拼装
// 两个 lib 级原语：tab-overlay-state.ts 的 setOverlayForTab/clearOverlayForTab（写
// storage.session）和 content-script-messaging.ts 的 sendToContentScript（推给内容脚本
// 渲染）。run-registry.ts 直接调用这两个原语，不必绕经 background.ts 的消息处理器——
// 那条路径本来就是给"外部消息"用的，onOverlay 回调现在就运行在 background 进程里，
// 直接调用是同一件事的更短路径，不是另起一套逻辑。
async function sendAgentOverlay(payload: SetAgentOverlayPayload, targetTabId: number): Promise<void> {
  if (payload.active) {
    await setOverlayForTab(targetTabId, payload.label ?? '');
  } else {
    await clearOverlayForTab(targetTabId);
  }
  try {
    await sendToContentScript(targetTabId, { id: newMessageId(), type: 'SET_AGENT_OVERLAY', payload });
  } catch {
    // 遮罩是纯视觉功能，下发失败（页面是 chrome:// 之类注入不进去的地址、或正在卸载）
    // 一律吞掉，不能让它的失败影响真正的写操作（同 background.ts 原 pushOverlayToTab 的约定）。
  }
}
