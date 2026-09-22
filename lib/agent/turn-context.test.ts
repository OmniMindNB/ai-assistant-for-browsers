import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat/messages';
import { toAgentMessages } from './turn-context';

function userMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'u1', role: 'user', content: '你好', createdAt: 1000, ...over };
}

function assistantMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '好的', createdAt: 2000, ...over };
}

describe('toAgentMessages', () => {
  // 迁移回归保护：纯文本历史的翻译结果必须与迁移前逐字段一致。
  it('纯文本历史原样翻译', () => {
    const result = toAgentMessages([userMsg(), assistantMsg()]);

    expect(result[0]).toEqual({ role: 'user', content: '你好', timestamp: 1000 });
    expect(result[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
      api: 'openai-completions',
      provider: 'history',
      model: 'history',
      stopReason: 'stop',
      timestamp: 2000,
    });
  });

  it('空文本的 assistant 消息翻译成空 content 数组', () => {
    expect(toAgentMessages([assistantMsg({ content: '' })])[0]).toMatchObject({ content: [] });
  });
});
