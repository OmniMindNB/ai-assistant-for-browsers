import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat/messages';
import type { ImageAttachment } from '@/lib/chat/attachments';
import { MAX_REPLAYED_IMAGE_BYTES, toAgentMessages } from './turn-context';

function imageAttachment(over: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: 'i1',
    name: 'a.png',
    mimeType: 'image/png',
    size: 1024,
    kind: 'image',
    dataUrl: 'data:image/png;base64,AAAA',
    ...over,
  };
}

function partsOf(message: unknown): Array<{ type: string; text?: string }> {
  const content = (message as { content: unknown }).content;
  if (!Array.isArray(content)) throw new Error('期望 content 是数组，实际是字符串');
  return content as Array<{ type: string; text?: string }>;
}

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

describe('toAgentMessages：图片跨轮回放', () => {
  it('只有最新那条带图消息保留图片，更早的降级成占位', () => {
    const result = toAgentMessages([
      userMsg({ id: 'u1', content: '看这张', createdAt: 1, attachments: [imageAttachment({ name: 'old.png' })] }),
      assistantMsg({ id: 'a1', createdAt: 2 }),
      userMsg({ id: 'u2', content: '再看这张', createdAt: 3, attachments: [imageAttachment({ name: 'new.png' })] }),
    ]);

    expect(result[0].content).toBe('看这张\n[图片 old.png 已移出上下文，如需要请用户重新发送]');
    expect(partsOf(result[2])).toEqual([
      { type: 'text', text: '再看这张' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  // 按消息划界而不是按张数：用户记得的是"我刚贴的那条消息"。
  it('同一条消息里的多张图整体保留', () => {
    const result = toAgentMessages([
      userMsg({ attachments: [imageAttachment({ id: 'i1' }), imageAttachment({ id: 'i2' })] }),
    ]);

    expect(partsOf(result[0]).filter((part) => part.type === 'image')).toHaveLength(2);
  });

  it('累计字节超过上限后，后续的图降级成占位', () => {
    const result = toAgentMessages([
      userMsg({
        content: '两张',
        attachments: [
          imageAttachment({ id: 'i1', name: 'big.png', size: MAX_REPLAYED_IMAGE_BYTES - 1 }),
          imageAttachment({ id: 'i2', name: 'second.png', size: 2 }),
        ],
      }),
    ]);

    const parts = partsOf(result[0]);
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(1);
    expect(parts[0].text).toBe('两张\n[图片 second.png 已移出上下文，如需要请用户重新发送]');
  });

  // 与 recutStartForCharBudget "末尾那条无条件保留" 同构：一条只剩占位符的图片消息，
  // 比一条超预算的请求更没用。
  it('第一张自身就超预算时仍然保留', () => {
    const result = toAgentMessages([
      userMsg({ attachments: [imageAttachment({ name: 'huge.png', size: MAX_REPLAYED_IMAGE_BYTES * 3 })] }),
    ]);

    expect(partsOf(result[0]).filter((part) => part.type === 'image')).toHaveLength(1);
  });

  it('非图片附件不影响翻译结果', () => {
    const result = toAgentMessages([
      userMsg({
        attachments: [
          { id: 't1', name: 'a.txt', mimeType: 'text/plain', size: 10, kind: 'text', textContent: 'x', truncated: false },
        ],
      }),
    ]);

    expect(result[0].content).toBe('你好');
  });
});
