// 统一消息协议（ref: technical-plan.md §3.3）
// 用于 Side Panel ↔ Service Worker ↔ Content Script 之间的通信。

export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'GET_ACTIVE_TAB'
  | 'INJECT_SCRIPT'
  | 'UNDO_SCRIPT'
  | 'CHAT';

export interface Message<T = unknown> {
  /** 请求唯一 ID，便于流式分片匹配 */
  id: string;
  type: MessageType;
  payload?: T;
  /** 是否为流式响应 */
  stream?: boolean;
}

export interface MessageResponse<T = unknown> {
  id: string;
  ok: boolean;
  data?: T;
  error?: string;
}

/** EXTRACT_PAGE 返回的页面数据 */
export interface PageContent {
  title: string;
  url: string;
  lang: string;
  /** 纯文本正文（Phase 1 接入 Readability 优化） */
  text: string;
  /** 提取到的字符数 */
  length: number;
}

/** GET_SELECTION 返回的页面选区数据 */
export interface PageSelection {
  text: string;
}

/** INJECT_SCRIPT 请求载荷 */
export interface InjectScriptPayload {
  code: string;
}

/** INJECT_SCRIPT / UNDO_SCRIPT 返回结果 */
export interface InjectScriptResult {
  /** 脚本返回值的文本化表示（如有） */
  result?: string;
  /** 是否已保存可撤销快照 */
  snapshotSaved?: boolean;
}

/** 生成唯一消息 ID */
export function newMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 类型安全地发送一条运行时消息并等待响应 */
export async function sendMessage<TReq = unknown, TRes = unknown>(
  type: MessageType,
  payload?: TReq,
): Promise<MessageResponse<TRes>> {
  const message: Message<TReq> = { id: newMessageId(), type, payload };
  return browser.runtime.sendMessage(message) as Promise<MessageResponse<TRes>>;
}
