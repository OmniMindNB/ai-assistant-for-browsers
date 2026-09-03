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
  /**
   * 这次询问属于哪一类。'submit'（默认，可缺省以兼容已持久化的旧快照）是结构检测出的
   * 表单提交，问的是"要不要放行这次提交"；'takeover' 是用户在执行期间自己动了手，
   * 问的是"人已经插手了，还要不要接着做"。两者共用同一条应答通道（respondConfirm），
   * 但文案、配色和按钮语义完全不同，所以必须由这个字段区分而不是靠 toolName 猜。
   */
  kind?: 'submit' | 'takeover';
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

/**
 * 面板 -> background：某个会话已被用户删除（或那次删除最终失败、需要撤销标记）。
 *
 * 持久化现在完全发生在 background（run-registry.ts 的 persistMessages / scanForOrphans），
 * 而"这个会话已经被删掉了"这件事只有面板知道——不同步过去的话，一轮还在飞的 run 结束时
 * 会用 replaceConversationMessages 把刚被删掉的会话整行重新写回 Dexie，用户看到它复活
 * （CLAUDE.md 里"delete tombstones，迟到的快照不能复活已删除会话"这条既有约束的跨进程版本）。
 *
 * 不限定"必须是本面板当前打开的那个会话"：历史抽屉里删掉的会话可能正在另一个 tab 上跑，
 * 只有 background 能把 conversationId 关联回持有它的 RunState。
 */
export interface ConversationDeletedMessage {
  type: 'conversationDeleted';
  tabId: number;
  conversationId: string;
  /** true=已删除，落盘要跳过；false=删除失败、会话还在，撤销之前的标记。 */
  deleted: boolean;
}

export type PanelToBackground =
  | HelloMessage
  | StartRunRequest
  | RespondConfirmMessage
  | RespondQuestionMessage
  | StopMessage
  | ConversationDeletedMessage;

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

/**
 * background -> 面板：`hello` 的否定回包——这个 tabId 当前没有任何存活的 run。
 *
 * 必须显式回一条而不是"沉默即没有"：面板重开时要先知道"背景手上有没有正在跑的 run"，
 * 才能决定是采用背景推来的权威快照、还是回退到从 Dexie 读历史那条老路径
 * （见 store.ts 的 restoreTabConversation）。沉默的话面板只能靠超时猜，
 * 而超时猜测会让每一次正常的冷面板挂载都白等一次超时。
 */
export interface NoRunMessage {
  type: 'noRun';
  tabId: number;
}

export type BackgroundToPanel = SnapshotMessage | OrphanResolvedMessage | NoRunMessage;
