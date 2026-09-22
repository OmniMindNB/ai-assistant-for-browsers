import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat/messages';
import type { ImageAttachment } from '@/lib/chat/attachments';
import { defaultRedactionSettings } from '@/lib/redaction';
import type { FormFieldTable } from './tab-form-fields';
import { MAX_REPLAYED_IMAGE_BYTES, toAgentMessages, MAX_HANDOFF_STEPS, MAX_HANDOFF_HANDLES, buildTurnHandoff } from './turn-context';

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

const redaction = defaultRedactionSettings();

function fieldTable(over: Partial<FormFieldTable> = {}): FormFieldTable {
  return {
    url: 'https://example.com/form',
    fields: {
      f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' },
      f2: { path: [], expect: { tag: 'button', text: '提交' }, sensitive: false, kind: 'button' },
    },
    ...over,
  };
}

function assistantWithSteps(descriptions: string[]): ChatMessage {
  return assistantMsg({
    activitySteps: descriptions.map((description, index) => ({
      id: `s${index}`,
      description,
      status: 'done' as const,
    })),
  });
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

describe('buildTurnHandoff', () => {
  it('足迹与句柄都没有时返回 undefined（绝不发空消息）', () => {
    expect(buildTurnHandoff({ redaction })).toBeUndefined();
  });

  it('同时给出足迹段与句柄段', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantWithSteps(['读取了页面内容', '点击了「下一步」']),
      table: fieldTable(),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).toContain('[系统观察]');
    expect(result).toContain('点击了「下一步」');
    expect(result).toContain('f1：邮箱');
    expect(result).toContain('f2：提交');
  });

  // 句柄的新鲜度判断复用 FormFieldTable.url 那道现成的锁，不另造一套。
  it('句柄表的 url 与当前目标不符时不输出句柄段，足迹段照常', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantWithSteps(['读取了页面内容']),
      table: fieldTable(),
      targetUrl: 'https://example.com/another',
      redaction,
    });

    expect(result).toContain('读取了页面内容');
    expect(result).not.toContain('f1');
  });

  it('targetUrl 查不到时不输出句柄段', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantWithSteps(['读取了页面内容']),
      table: fieldTable(),
      redaction,
    });

    expect(result).not.toContain('f1');
  });

  // ⚠️ 这条用例是 spec §2.3 那条约束的执行者，不得删改：句柄表存的是未脱敏的原始 label，
  // 而 browser_get_form 交给模型的渲染结果是过了 redactText 的。少这一道，交接块就是
  // 一条绕过脱敏的新路。
  it('句柄 label 里的敏感串被脱敏', () => {
    const result = buildTurnHandoff({
      table: fieldTable({
        fields: {
          f1: { path: [], expect: { tag: 'input', label: '联系电话 13812345678' }, sensitive: false, kind: 'text' },
        },
      }),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).not.toContain('13812345678');
  });

  it('sensitive 句柄不出现在输出里', () => {
    const result = buildTurnHandoff({
      table: fieldTable({
        fields: {
          f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' },
          f2: { path: [], expect: { tag: 'input', label: '支付密码' }, sensitive: true, kind: 'text' },
        },
      }),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).toContain('f1：邮箱');
    expect(result).not.toContain('支付密码');
  });

  it('步数超上限时截断并报出剩余数量', () => {
    const descriptions = Array.from({ length: MAX_HANDOFF_STEPS + 3 }, (_, index) => `第 ${index} 步`);
    const result = buildTurnHandoff({ lastAssistant: assistantWithSteps(descriptions), redaction });

    expect(result).toContain(`第 ${MAX_HANDOFF_STEPS - 1} 步`);
    expect(result).not.toContain(`第 ${MAX_HANDOFF_STEPS} 步`);
    expect(result).toContain('另有 3 步未列出');
  });

  it('句柄数超上限时截断并报出剩余数量', () => {
    const fields: FormFieldTable['fields'] = {};
    for (let index = 0; index < MAX_HANDOFF_HANDLES + 5; index += 1) {
      fields[`f${index}`] = { path: [], expect: { tag: 'input', label: `字段 ${index}` }, sensitive: false, kind: 'text' };
    }

    const result = buildTurnHandoff({
      table: fieldTable({ fields }),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).toContain('另有 5 个未列出');
  });

  it('只有 running / notice 状态的步骤时不输出足迹段', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantMsg({ activitySteps: [{ id: 's0', description: '正在读取', status: 'running' }] }),
      redaction,
    });

    expect(result).toBeUndefined();
  });
});
