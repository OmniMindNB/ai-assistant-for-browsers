import type { ChatMessageRecord } from '@/lib/db';
import type { MessageAttachment } from './attachments';
import type { TaskOutcome } from '@/lib/agent/task-outcome';
import type { ActivityStep } from '@/lib/agent/activity-steps';

// 侧边栏消息的形状与派生规则（ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §3）。
// 本功能的全部可测逻辑集中在这里：vitest 只覆盖 lib/**，entrypoints/ 没有测试基建。

export interface ChatMessage {
  /** 客户端生成的稳定标识：React key + 编辑定位。不落库。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** 仅用户消息有意义：input = 普通输入（可编辑），action = 快捷操作（不可编辑） */
  kind?: 'input' | 'action';
  /** 划词提问时被引用的选区原文（裁剪后）；存在时渲染成独立的引用卡片而不是拼进 content。 */
  quotedText?: string;
  /** 已就绪附件的历史安全投影（文本/图片/PDF 元数据）；不重新进入后续轮次的 prompt。 */
  attachments?: MessageAttachment[];
  /** 本轮任务成败信号；仅当模型在一个动过页面的回合里调用了 report_task_outcome 才会有值。 */
  taskOutcome?: TaskOutcome;
  /** 本轮是否被用户点了"停止"中断；仅 assistant 消息可能为 true，用于跟正常完成区分开渲染。 */
  stopped?: boolean;
  /**
   * 本轮实际跑过的工具步骤（成功/失败/被中断都保留），随消息一起持久化供事后回看。
   * 运行期间的实时步骤条（ActivityStepList）是另一份易失状态，这里是它在轮次结束时的存档快照。
   */
  activitySteps?: ActivityStep[];
  /** 本轮是否触发过上下文窗口重切（早期历史被摘要/移出上下文）；仅 assistant 消息可能为 true。 */
  contextTruncated?: boolean;
}

const TITLE_MAX_CHARS = 40;
const DEFAULT_TITLE = '新对话';

/**
 * 只有普通输入的用户消息可编辑。
 * 快捷操作消息展示的是标签（如「📄 总结当前网页」），真正的 prompt 是另一段文字且未持久化，
 * 编辑它会把标签本身当 prompt 发出去，所以直接禁掉。
 * 存量记录没有 kind，按 input 处理。
 */
export function isEditableMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.kind !== 'action';
}

/** 返回 id 对应消息的下标；未找到返回 -1 */
export function findMessageIndex(messages: ChatMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id);
}

/** 从指定 assistant 消息往前找最近一条 user 消息；未找到（消息不存在/前面没有 user 消息）返回 undefined */
export function findPrecedingUserMessage(messages: ChatMessage[], assistantId: string): ChatMessage | undefined {
  const assistantIndex = findMessageIndex(messages, assistantId);
  if (assistantIndex < 0) return undefined;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i];
  }
  return undefined;
}

/**
 * regenerate 复用 editMessage 的截断重发逻辑，原样重发最近一条 user 消息的 content。
 * 这要求那条消息可编辑：快捷操作消息展示的是标签（如「📄 总结当前网页」），真正发给模型的
 * prompt 是另一段文字且未持久化，原样重发标签文本语义就是错的——isEditableMessage 已经
 * 挡住了这条路径，这里只是把同一条件也用在"要不要展示重新生成按钮"上，避免展示一个
 * 点了没反应的按钮。
 */
export function canRegenerateMessage(messages: ChatMessage[], assistantId: string): boolean {
  const userMessage = findPrecedingUserMessage(messages, assistantId);
  return userMessage !== undefined && isEditableMessage(userMessage);
}

/** 编辑该条消息后将被一并丢弃的后续消息条数；id 未命中时返回 0 */
export function discardedCount(messages: ChatMessage[], id: string): number {
  const index = findMessageIndex(messages, id);
  if (index < 0) return 0;
  return messages.length - index - 1;
}

/**
 * UI 消息 → DB 记录。
 * 丢弃末尾 content 为空的 assistant 占位：一轮出错或被中止时 UI 会留下这个占位，
 * 落库后重开会话会渲染成一个空气泡。中间的空 assistant 保留，因为它承载了轮次结构。
 */
export function toMessageRecords(
  conversationId: string,
  messages: ChatMessage[],
): ChatMessageRecord[] {
  const last = messages[messages.length - 1];
  const end = last && last.role === 'assistant' && !last.content ? messages.length - 1 : messages.length;
  return messages.slice(0, end).map((message) => ({
    conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    kind: message.kind,
    quotedText: message.quotedText,
    attachments: message.attachments,
    taskOutcome: message.taskOutcome,
    stopped: message.stopped,
    activitySteps: message.activitySteps,
    contextTruncated: message.contextTruncated,
  }));
}

/** 会话标题取首条用户消息的前 40 字；没有用户消息时给默认标题 */
export function conversationTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = first?.content.trim();
  return text ? text.slice(0, TITLE_MAX_CHARS) : DEFAULT_TITLE;
}
