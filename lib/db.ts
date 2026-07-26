import Dexie, { type Table } from 'dexie';

// 本地持久化（ref: technical-plan.md §2.4）
// 对话历史 / Skill 定义存 IndexedDB；API Key 等配置走 chrome.storage（见 settings.ts）。

export interface ChatMessageRecord {
  id?: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  /**
   * 仅用户消息有意义：input = 普通输入（可编辑），action = 快捷操作（不可编辑）。
   * 不建索引，因此无需 Dexie 版本迁移；存量记录无此字段，按 input 处理。
   */
  kind?: 'input' | 'action';
}

export interface ConversationRecord {
  id: string;
  title: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

class AluminumDB extends Dexie {
  conversations!: Table<ConversationRecord, string>;
  messages!: Table<ChatMessageRecord, number>;

  constructor() {
    super('aluminum');
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: '++id, conversationId, createdAt',
    });
  }
}

export const db = new AluminumDB();

/** 按更新时间倒序列出会话 */
export async function listConversations(): Promise<ConversationRecord[]> {
  return db.conversations.orderBy('updatedAt').reverse().toArray();
}

/** 读取某会话的全部消息（按时间正序） */
export async function getConversationMessages(
  conversationId: string,
): Promise<ChatMessageRecord[]> {
  return db.messages.where('conversationId').equals(conversationId).sortBy('createdAt');
}

/** 删除会话及其消息 */
export async function deleteConversation(conversationId: string): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.where('conversationId').equals(conversationId).delete();
    await db.conversations.delete(conversationId);
  });
}

/**
 * 用给定记录整体替换某会话的全部消息，并同步标题与 updatedAt。
 *
 * UI 是唯一真相，DB 是它的投影：这样「编辑历史消息」的截断就退化为纯内存的 slice，
 * store 不需要维护 UI 数组与 Dexie 自增主键的双向对应
 * （ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §2）。
 */
export async function replaceConversationMessages(
  conversationId: string,
  messages: ChatMessageRecord[],
  title: string,
): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.where('conversationId').equals(conversationId).delete();
    if (messages.length === 0) return;
    await db.messages.bulkAdd(messages);
    const now = Date.now();
    const existing = await db.conversations.get(conversationId);
    await db.conversations.put({
      id: conversationId,
      title,
      url: existing?.url,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  });
}
