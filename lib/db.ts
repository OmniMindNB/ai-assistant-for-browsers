import Dexie, { type Table } from 'dexie';
import type { MessageAttachment } from './chat/attachments';
import type { TaskOutcome } from './agent/task-outcome';
import type { ActivityStep } from './agent/activity-steps';

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
  /**
   * 划词提问时被引用的选区原文（裁剪后），仅用于渲染成独立的引用卡片；
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为没有引用。
   */
  quotedText?: string;
  /**
   * 已就绪附件（文本/图片/PDF 元数据），仅用户消息有意义，随该轮一起落库供历史回看渲染；
   * PDF 提取文本和全部进行中状态不在此类型中，因而不能进入 IndexedDB。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为没有附件。
   */
  attachments?: MessageAttachment[];
  /**
   * 本轮任务成败信号，仅当模型调用过 report_task_outcome 才有值。
   * 不建索引，同 kind/quotedText/attachments 一样无需 Dexie 版本迁移；存量记录无此字段即视为没有信号。
   */
  taskOutcome?: TaskOutcome;
  /**
   * 本轮是否被用户主动停止；仅 assistant 消息可能为 true。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为未被停止。
   */
  stopped?: boolean;
  /**
   * 本轮实际跑过的工具步骤存档（成功/失败/被中断都保留），随该轮一起落库供历史回看渲染。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为没有步骤可回看。
   */
  activitySteps?: ActivityStep[];
  /**
   * 本轮是否触发过上下文窗口重切（早期历史被摘要/移出上下文），仅 assistant 消息可能为 true。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为未触发过。
   */
  contextTruncated?: boolean;
}

export interface ConversationRecord {
  id: string;
  title: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

class RuniDB extends Dexie {
  conversations!: Table<ConversationRecord, string>;
  messages!: Table<ChatMessageRecord, number>;

  constructor() {
    super('runi');
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: '++id, conversationId, createdAt',
    });
  }
}

export const db = new RuniDB();

/** 按更新时间倒序列出会话 */
export async function listConversations(): Promise<ConversationRecord[]> {
  return db.conversations.orderBy('updatedAt').reverse().toArray();
}

/**
 * 读取某会话的全部消息，按主键（自增 id）顺序返回，而不是按 createdAt 排序。
 *
 * `replaceConversationMessages` 用一次 `bulkAdd` 按 UI 顺序整体写入，所以插入顺序
 * （即索引 (conversationId, ++id) 的自然顺序）本身就是真相；不需要再靠 createdAt 重排。
 * 用 sortBy('createdAt') 在 createdAt 相等（同毫秒写入）时，正确性依赖
 * Array.prototype.sort 稳定排序 + 相等键内按主键返回两个隐式行为，均未被测试或注释覆盖，
 * 直接按主键索引取值可以消除这个隐式不变量。对存量数据同样成立，因为旧的 persist()
 * 也是按顺序插入的。
 */
export async function getConversationMessages(
  conversationId: string,
): Promise<ChatMessageRecord[]> {
  return db.messages.where('conversationId').equals(conversationId).toArray();
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
    // 空列表也要落到这里之后：docblock 承诺「无条件同步标题与 updatedAt」，
    // 空列表时只是没有消息可写，会话行仍然要更新（当前唯一调用方 persistConversation
    // 永远至少传一条消息，这里不可达，但让代码与文档保持一致，不给下一个读者挖坑）。
    if (messages.length > 0) {
      await db.messages.bulkAdd(messages);
    }
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
