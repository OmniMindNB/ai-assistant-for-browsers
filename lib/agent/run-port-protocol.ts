// 面板 <-> background 的持久连接（browser.runtime.connect）消息协议。
// 与 lib/messaging.ts 的一次性 sendMessage/响应模型是两套独立机制：那套服务请求-响应，
// 这套服务 background 主动推送的运行态更新（ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md §4）。
import type { ChatMessage } from '@/lib/chat/messages';
import type { ActivityStep } from './activity-steps';
import type { ProviderConfig } from '@/lib/settings';
import type { ImageContent } from '@earendil-works/pi-ai';

export const AGENT_RUN_PORT_NAME = 'agent-run';

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

/** 面板 -> background：挂载/重连时的握手，声明自己绑定的 tabId。 */
export interface HelloMessage {
  type: 'hello';
  tabId: number;
}

/** 面板 -> background：发起一轮新的 agent 运行。tabId 已有存活 run 时，background 先中止旧的再开始新的。 */
export interface StartRunRequest {
  type: 'startRun';
  tabId: number;
  conversationId: string;
  provider: ProviderConfig;
  systemPrompt: string;
  withoutBrowserTools?: boolean;
  /** 提交前的历史（面板已完成截断/编辑逻辑），不含本轮新增的用户消息和占位 assistant。 */
  historyMessages: ChatMessage[];
  /** 本轮用户消息的最终展示形态（含 quotedText/attachments）。 */
  displayMessage: ChatMessage;
  agentUserContent: string;
  images?: ImageContent[];
  readToolCallBudget: number;
  writeToolCallBudget: number;
}

export interface RespondConfirmMessage {
  type: 'respondConfirm';
  tabId: number;
  toolCallId: string;
  approved: boolean;
}

export interface RespondQuestionMessage {
  type: 'respondQuestion';
  tabId: number;
  toolCallId: string;
  answer: string;
}

export interface StopMessage {
  type: 'stop';
  tabId: number;
}

export type PanelToBackground =
  | HelloMessage
  | StartRunRequest
  | RespondConfirmMessage
  | RespondQuestionMessage
  | StopMessage;

/** background 侧运行态的完整快照——格式化好、可以直接渲染，面板不做任何 i18n/文案拼接。 */
export interface RunSnapshot {
  tabId: number;
  conversationId: string;
  busy: boolean;
  messages: ChatMessage[];
  activitySteps: ActivityStep[];
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
}

export interface SnapshotMessage extends RunSnapshot {
  type: 'snapshot';
}

/** 冷启动发现的孤儿 run（见 run-registry.ts 的 scanForOrphans）：这条 tabId 没有存活的 run，
 * 但上次 service worker 死掉时还标着"在跑"。background 已经把 failure 消息写进 Dexie，
 * 这里只是把最终消息数组同步给面板，不需要面板自己再去读一次 Dexie。 */
export interface OrphanResolvedMessage {
  type: 'orphanResolved';
  tabId: number;
  messages: ChatMessage[];
}

export type BackgroundToPanel = SnapshotMessage | OrphanResolvedMessage;
