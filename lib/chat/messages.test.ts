import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/lib/chat/attachments';
import {
  canRegenerateMessage,
  conversationTitle,
  discardedCount,
  findMessageIndex,
  findPrecedingUserMessage,
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

describe('findPrecedingUserMessage', () => {
  it('返回紧邻在前的 user 消息', () => {
    const messages = [msg('u1', 'user', '一', 'input'), msg('a1', 'assistant', '二')];
    expect(findPrecedingUserMessage(messages, 'a1')?.id).toBe('u1');
  });

  it('跳过中间的空 assistant 占位，找到更早的 user 消息', () => {
    const messages = [
      msg('u1', 'user', '一', 'input'),
      msg('a1', 'assistant', ''),
      msg('a2', 'assistant', '二'),
    ];
    expect(findPrecedingUserMessage(messages, 'a2')?.id).toBe('u1');
  });

  it('assistant 消息不存在时返回 undefined', () => {
    expect(findPrecedingUserMessage([msg('u1', 'user', '一')], 'missing')).toBeUndefined();
  });

  it('前面没有 user 消息时返回 undefined', () => {
    expect(findPrecedingUserMessage([msg('a1', 'assistant', '孤立回答')], 'a1')).toBeUndefined();
  });
});

describe('canRegenerateMessage', () => {
  it('前一条是普通输入的 user 消息时可以重新生成', () => {
    const messages = [msg('u1', 'user', '一', 'input'), msg('a1', 'assistant', '二')];
    expect(canRegenerateMessage(messages, 'a1')).toBe(true);
  });

  // 快捷操作展示的是标签（如「📄 总结当前网页」），真正发给模型的 prompt 是另一段文字且
  // 未持久化——原样重发标签文本语义就是错的，所以这类回复不该展示"能重新生成"的假象。
  it('前一条是快捷操作产生的 user 消息时不可以重新生成', () => {
    const messages = [msg('u1', 'user', '📄 总结当前网页', 'action'), msg('a1', 'assistant', '摘要')];
    expect(canRegenerateMessage(messages, 'a1')).toBe(false);
  });

  it('没有前置 user 消息时不可以重新生成', () => {
    expect(canRegenerateMessage([msg('a1', 'assistant', '孤立回答')], 'a1')).toBe(false);
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

  it('保留 taskOutcome', () => {
    const records = toMessageRecords('c-1', [
      { id: 'a', role: 'assistant', content: '已完成', createdAt: 1000, taskOutcome: { outcome: 'success', reason: '已提交表单。' } },
    ]);
    expect(records[0].taskOutcome).toEqual({ outcome: 'success', reason: '已提交表单。' });
  });

  it('没有 taskOutcome 时字段为 undefined', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问')]);
    expect(records[0].taskOutcome).toBeUndefined();
  });

  it('保留 stopped 与 activitySteps', () => {
    const records = toMessageRecords('c-1', [
      {
        id: 'a',
        role: 'assistant',
        content: '写到一半',
        createdAt: 1000,
        stopped: true,
        activitySteps: [{ id: 't-1', description: '点击了提交按钮', status: 'failed' }],
      },
    ]);
    expect(records[0].stopped).toBe(true);
    expect(records[0].activitySteps).toEqual([
      { id: 't-1', description: '点击了提交按钮', status: 'failed' },
    ]);
  });

  it('没有 stopped / activitySteps 时字段为 undefined', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问')]);
    expect(records[0].stopped).toBeUndefined();
    expect(records[0].activitySteps).toBeUndefined();
  });

  it('保留 contextTruncated', () => {
    const records = toMessageRecords('c-1', [
      { id: 'a', role: 'assistant', content: '已完成', createdAt: 1000, contextTruncated: true },
    ]);
    expect(records[0].contextTruncated).toBe(true);
  });

  it('没有 contextTruncated 时字段为 undefined', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问')]);
    expect(records[0].contextTruncated).toBeUndefined();
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
