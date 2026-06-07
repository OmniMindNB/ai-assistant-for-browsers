import Dexie, { type Table } from 'dexie';

// 本地持久化（ref: technical-plan.md §2.4）
// 对话历史 / Skill 定义存 IndexedDB；API Key 等配置走 chrome.storage（见 settings.ts）。

export interface ChatMessageRecord {
  id?: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
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
