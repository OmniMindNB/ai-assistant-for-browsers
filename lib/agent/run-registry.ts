// agent 运行的核心编排：一个 tabId 同一时刻最多一个 RunState，Agent 实例、活动步骤、
// pending confirmation/question 全部在这里，不再依赖侧边栏面板文档的生命周期
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md）。
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message as AgentLlmMessage } from '@earendil-works/pi-ai';
import { createBrowserAgent } from './agent';
import { createTabSession, type TabSessionController } from './tab-session';
import { loadTabSession, saveTabSession } from './tab-session-storage';
import { summarizeToolCallForConfirmation } from './confirm-summary';
import { describeToolActivity } from './activity-description';
import { upsertActivityStep, finishActivityStep, type ActivityStep } from './activity-steps';
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
import { saveRunStateSnapshot, clearRunStateSnapshot } from './run-state-storage';
import { setOverlayForTab, clearOverlayForTab } from './tab-overlay-state';
import { sendToContentScript } from './content-script-messaging';
import { newMessageId, type SetAgentOverlayPayload } from '@/lib/messaging';

export interface PortRegistry {
  push(tabId: number, snapshot: RunSnapshot): void;
}

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
}

const runs = new Map<number, RunState>();

export function getRunState(tabId: number): RunState | undefined {
  return runs.get(tabId);
}

function snapshotOf(state: RunState): RunSnapshot {
  return {
    tabId: state.tabId,
    busy: state.busy,
    messages: state.messages,
    activitySteps: state.activitySteps,
    pendingConfirmation: state.pendingConfirmation,
    pendingQuestion: state.pendingQuestion,
  };
}

function pushAndPersist(state: RunState, ports: PortRegistry): void {
  const snapshot = snapshotOf(state);
  ports.push(state.tabId, snapshot);
  void saveRunStateSnapshot(state.tabId, snapshot);
}

async function persistMessages(state: RunState): Promise<void> {
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

function replaceLastAssistant(state: RunState, content: string): void {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;
  state.messages = [...state.messages.slice(0, -1), { ...last, content }];
}

const STREAM_FLUSH_INTERVAL_MS = 48;

export async function startRun(request: StartRunRequest, ports: PortRegistry): Promise<void> {
  const existing = runs.get(request.tabId);
  if (existing) {
    existing.agent.abort();
    runs.delete(request.tabId);
  }

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
  };
  runs.set(request.tabId, state);

  // 用户消息必须在这里、agent.prompt() 开始之前就落盘——这正是本次迁移要修的
  // bug：过去只在整轮结束的 finally 里持久化一次，面板中途被销毁时刚发出去的
  // 用户消息会跟着丢。
  await persistMessages(state);
  pushAndPersist(state, ports);

  const onConfirm = async (toolCallId: string, toolName: string, args: unknown): Promise<boolean> => {
    const { summary, codePreview } = summarizeToolCallForConfirmation(toolName, args, undefined);
    state.pendingToolArgs.set(toolCallId, { toolName, args });
    state.pendingConfirmation = { toolCallId, toolName, summary, codePreview };
    pushAndPersist(state, ports);
    return new Promise<boolean>((resolve) => { state.resolveConfirmation = resolve; });
  };

  const onAskUser = async (toolCallId: string, question: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) return '';
    state.pendingQuestion = { toolCallId, question };
    pushAndPersist(state, ports);
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
    onAskUser,
    onOverlay: (payload, targetTabId) => {
      void sendAgentOverlay(payload, targetTabId);
    },
    onSessionChange: (updated) => { void saveTabSession(updated).catch(() => undefined); },
    onTaskOutcome: (outcome) => { state.taskOutcome = outcome; },
  });
  state.agent = agent;

  let acc = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    replaceLastAssistant(state, acc);
    pushAndPersist(state, ports);
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
      });
      pushAndPersist(state, ports);
    }

    if (event.type === 'tool_execution_update' && !state.terminatedToolCallIds.has(event.toolCallId)) {
      state.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      const existingStep = state.activitySteps.find((step) => step.id === event.toolCallId);
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
        slow: existingStep?.slow,
      });
      pushAndPersist(state, ports);
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
        pushAndPersist(state, ports);
      }
    }

    if (event.type === 'message_end') {
      // Flush any pending text before persisting, so state.messages reflects the complete message
      flush();
      void persistMessages(state);
    }
  });

  // Fire-and-forget: don't await prompt(), just start it
  void (async () => {
    try {
      await agent.prompt(request.agentUserContent, request.images);
      if (!acc.trim()) {
        const last = findLastAssistant(agent.state.messages);
        acc = extractLastAssistantText(agent.state.messages) || describeEmptyAgentRun(last);
      }
      replaceLastAssistant(state, acc);
    } catch (e) {
      console.error('[Runi] agent.prompt 异常', e);
    } finally {
      unsubscribe();
      if (flushTimer !== null) clearTimeout(flushTimer);
      // Only perform cleanup if this run is still the current one for this tab.
      // If a new run was started for the same tab while this one was in flight,
      // this run's finally block should not clobber the new run's state.
      if (runs.get(state.tabId) === state) {
        if (state.taskOutcome) {
          const last = state.messages[state.messages.length - 1];
          if (last) state.messages = [...state.messages.slice(0, -1), { ...last, taskOutcome: state.taskOutcome }];
        }
        state.busy = false;
        state.activitySteps = [];
        state.pendingConfirmation = null;
        state.pendingQuestion = null;
        await persistMessages(state);
        pushAndPersist(state, ports);
        await clearRunStateSnapshot(state.tabId).catch(() => undefined);
        runs.delete(state.tabId);
      }
    }
  })();
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
