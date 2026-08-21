import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/lib/chat/attachments';
import {
  conversationTitle,
  discardedCount,
  findMessageIndex,
  isEditableMessage,
  toMessageRecords,
  type ChatMessage,
} from './messages';

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  kind?: 'input' | 'action',
  quotedText?: string,
): ChatMessage {
  return { id, role, content, createdAt: 1000, kind, quotedText };
}

describe('isEditableMessage', () => {
  it('普通输入的用户消息可编辑', () => {
    expect(isEditableMessage(msg('a', 'user', '你好', 'input'))).toBe(true);
  });

  it('快捷操作产生的用户消息不可编辑', () => {
    expect(isEditableMessage(msg('a', 'user', '📄 总结当前网页', 'action'))).toBe(false);
  });

  it('助手消息不可编辑', () => {
    expect(isEditableMessage(msg('a', 'assistant', '回答'))).toBe(false);
  });

  it('存量记录无 kind 时按可编辑处理', () => {
    expect(isEditableMessage(msg('a', 'user', '旧消息'))).toBe(true);
  });
});

describe('findMessageIndex', () => {
  const messages = [msg('a', 'user', '一'), msg('b', 'assistant', '二'), msg('c', 'user', '三')];

  it('命中时返回下标', () => {
    expect(findMessageIndex(messages, 'c')).toBe(2);
  });

  it('未命中时返回 -1', () => {
    expect(findMessageIndex(messages, 'zzz')).toBe(-1);
  });
});

describe('discardedCount', () => {
  const messages = [
    msg('a', 'user', '一'),
    msg('b', 'assistant', '二'),
    msg('c', 'user', '三'),
    msg('d', 'assistant', '四'),
  ];

  it('返回该消息之后的消息条数', () => {
    expect(discardedCount(messages, 'a')).toBe(3);
  });

  it('最后一条用户消息只丢弃它后面的那条回复', () => {
    expect(discardedCount(messages, 'c')).toBe(1);
  });

  it('未命中时返回 0', () => {
    expect(discardedCount(messages, 'zzz')).toBe(0);
  });
});

describe('toMessageRecords', () => {
  it('丢弃末尾 content 为空的 assistant 占位消息', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问'), msg('b', 'assistant', '')]);
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe('user');
  });

  it('不丢弃中间的空 assistant 消息', () => {
    const records = toMessageRecords('c-1', [
      msg('a', 'user', '问'),
      msg('b', 'assistant', ''),
      msg('c', 'user', '再问'),
    ]);
    expect(records).toHaveLength(3);
  });

  it('不丢弃有内容的末尾 assistant 消息', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问'), msg('b', 'assistant', '答')]);
    expect(records).toHaveLength(2);
  });

  it('保留 conversationId / createdAt / kind，且不带客户端 id', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问', 'action')]);
    expect(records[0]).toEqual({
      conversationId: 'c-1',
      role: 'user',
      content: '问',
      createdAt: 1000,
      kind: 'action',
    });
  });

  it('保留 quotedText', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问', 'input', '选中的原文')]);
    expect(records[0].quotedText).toBe('选中的原文');
  });

  it('空数组返回空数组', () => {
    expect(toMessageRecords('c-1', [])).toEqual([]);
  });

  it('保留 attachments', () => {
    const attachment: MessageAttachment = {
      id: 'a1', name: 'notes.txt', mimeType: 'text/plain', size: 5, kind: 'text', textContent: 'hello', truncated: false,
    };
    const records = toMessageRecords('c-1', [
      { id: 'a', role: 'user', content: '问', createdAt: 1000, attachments: [attachment] },
    ]);
    expect(records[0].attachments).toEqual([attachment]);
  });

  it('persists PDF metadata without transient extraction state', () => {
    const pdf: MessageAttachment = {
      id: 'pdf-1', name: 'report.pdf', mimeType: 'application/pdf', size: 100,
      kind: 'pdf', pageCount: 12, extractedChars: 42_000, truncated: false,
    };
    const records = toMessageRecords('c-1', [{
      id: 'm-1', role: 'user', content: 'Summarize', createdAt: 1, attachments: [pdf],
    }]);
    expect(records[0].attachments).toEqual([pdf]);
    expect(JSON.stringify(records[0])).not.toMatch(/transientText|file|taskId|status|private extracted text/);
  });

  it('没有附件时 attachments 为 undefined', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问')]);
    expect(records[0].attachments).toBeUndefined();
  });
});

describe('conversationTitle', () => {
  it('取首条用户消息内容', () => {
    expect(conversationTitle([msg('a', 'user', '你好'), msg('b', 'assistant', '答')])).toBe('你好');
  });

  it('跳过助手消息取首条用户消息', () => {
    expect(conversationTitle([msg('a', 'assistant', '答'), msg('b', 'user', '问')])).toBe('问');
  });

  it('超长标题截断到 40 字', () => {
    const long = '字'.repeat(100);
    expect(conversationTitle([msg('a', 'user', long)])).toBe('字'.repeat(40));
  });

  it('没有用户消息时返回默认标题', () => {
    expect(conversationTitle([msg('a', 'assistant', '答')])).toBe('新对话');
    expect(conversationTitle([])).toBe('新对话');
  });
});
