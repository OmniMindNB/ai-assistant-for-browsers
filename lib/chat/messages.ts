import type { ChatMessageRecord } from '@/lib/db';
import type { MessageAttachment } from './attachments';

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
  /** 上传附件（文本类/图片）；存在时随历史消息一起渲染成只读芯片列表，不重新进入后续轮次的 prompt。 */
  attachments?: MessageAttachment[];
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
  }));
}

/** 会话标题取首条用户消息的前 40 字；没有用户消息时给默认标题 */
export function conversationTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = first?.content.trim();
  return text ? text.slice(0, TITLE_MAX_CHARS) : DEFAULT_TITLE;
}
