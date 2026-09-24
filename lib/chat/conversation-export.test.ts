import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import { interpolate } from '@/lib/i18n/core';
import { zh } from '@/lib/i18n/locales/zh';
import type { Translate } from '@/lib/i18n';
import type { ChatMessageRecord, ConversationRecord } from '@/lib/db';
import { createBrowserTools } from '@/lib/agent/tools';
import { createTabSession } from '@/lib/agent/tab-session';
import { WRITE_TOOL_NAMES } from '@/lib/agent/permissions';
import {
  buildConversationExport,
  EXPORT_SCHEMA,
  KEPT_WRITE_ARG_KEYS,
  MASKED_WRITE_ARG_KEYS,
  sanitizeToolArgs,
  stripUrl,
} from './conversation-export';

const t = ((key: keyof typeof zh, vars?: Record<string, string | number>) => interpolate(zh[key], vars)) as Translate;
const redaction = defaultRedactionSettings();

const conversation: ConversationRecord = {
  id: 'c1',
  title: '帮我填 13812345678 的表单',
  url: 'https://shop.example.com/checkout?order=998877&token=abc#step2',
  createdAt: 1,
  updatedAt: 2,
};

function record(partial: Partial<ChatMessageRecord>): ChatMessageRecord {
  return { conversationId: 'c1', role: 'user', content: '', createdAt: 1, ...partial };
}

function build(records: ChatMessageRecord[], conv: ConversationRecord = conversation) {
  return buildConversationExport({ conversation: conv, records, redaction, extensionVersion: '1.4.0', locale: 'zh', exportedAt: 100, t });
}

describe('stripUrl', () => {
  it('drops query and hash', () => {
    expect(stripUrl('https://a.com/x/y?token=1#h')).toBe('https://a.com/x/y');
  });
  // Review Focus #1
  it('returns undefined for unparseable input instead of throwing', () => {
    expect(stripUrl('')).toBeUndefined();
    expect(stripUrl('not a url')).toBeUndefined();
  });
  it('keeps non-http schemes without their query', () => {
    expect(stripUrl('chrome://newtab/?x=1')).toBe('chrome://newtab/');
    expect(stripUrl('about:blank')).toBe('about:blank');
  });
});

describe('sanitizeToolArgs', () => {
  it('masks value/text of write tools and keeps locators', () => {
    const out = sanitizeToolArgs('browser_fill_form', { fields: [{ fieldId: 'f3', value: 'P@ssw0rd!!' }], submit: { fieldId: 'f9' } }, redaction, t);
    expect(out).toEqual({ fields: [{ fieldId: 'f3', value: '‹已省略 10 字›' }], submit: { fieldId: 'f9' } });
    expect(sanitizeToolArgs('browser_type', { selector: '#pwd', text: 'secret' }, redaction, t)).toEqual({ selector: '#pwd', text: '‹已省略 6 字›' });
  });

  it('does not mask read tools\' search text, but still redacts it', () => {
    expect(sanitizeToolArgs('browser_find_text', { text: '下一步' }, redaction, t)).toEqual({ text: '下一步' });
    expect(sanitizeToolArgs('browser_find_text', { text: '13812345678' }, redaction, t)).not.toEqual({ text: '13812345678' });
  });

  it('strips url query and clips long strings', () => {
    const out = sanitizeToolArgs('browser_navigate', { url: 'https://a.com/p?sid=1' }, redaction, t);
    expect(out).toEqual({ url: 'https://a.com/p' });
    const long = sanitizeToolArgs('browser_click', { selector: 'x'.repeat(500) }, redaction, t) as { selector: string };
    expect(long.selector.length).toBeLessThanOrEqual(121);
  });

  it('leaves non-string values alone', () => {
    expect(sanitizeToolArgs('browser_set_storage', { area: 'local', key: 'k', value: null }, redaction, t)).toEqual({ area: 'local', key: 'k', value: null });
  });
});

// 守护测试（spec §7）：写工具新增了字符串参数，就必须明确它该屏蔽还是保留。
describe('write tool argument keys guard', () => {
  function collectStringKeys(schema: any, key: string | undefined, out: Set<string>): void {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'string' && key) out.add(key);
    if (schema.properties) for (const [k, v] of Object.entries(schema.properties)) collectStringKeys(v, k, out);
    if (schema.items) collectStringKeys(schema.items, key, out);
    if (schema.patternProperties) for (const v of Object.values(schema.patternProperties)) collectStringKeys(v, key, out);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') collectStringKeys(schema.additionalProperties, key, out);
    for (const c of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) collectStringKeys(c, key, out);
  }

  it('classifies every string parameter of every write tool', () => {
    const unclassified: string[] = [];
    for (const tool of createBrowserTools(createTabSession(1))) {
      if (!WRITE_TOOL_NAMES.has(tool.name)) continue;
      const keys = new Set<string>();
      collectStringKeys(tool.parameters, undefined, keys);
      for (const key of keys) {
        if (!MASKED_WRITE_ARG_KEYS.has(key) && !KEPT_WRITE_ARG_KEYS.has(key)) unclassified.push(`${tool.name}.${key}`);
      }
    }
    expect(unclassified).toEqual([]);
  });
});

describe('buildConversationExport', () => {
  it('redacts the title and strips the page url', () => {
    const doc = build([]);
    expect(doc.schema).toBe(EXPORT_SCHEMA);
    expect(doc.conversation.title).not.toContain('13812345678');
    expect(doc.conversation.url).toBe('https://shop.example.com/checkout');
    expect(doc.extensionVersion).toBe('1.4.0');
  });

  // Review Focus #1
  it('omits an unparseable conversation url instead of throwing', () => {
    const doc = build([], { ...conversation, url: 'garbage' });
    expect(doc.conversation).not.toHaveProperty('url');
  });

  it('redacts user content and quoted text; drops system records', () => {
    const doc = build([
      record({ role: 'system', content: 'sys' }),
      record({ content: '我的邮箱 a@b.com', quotedText: '电话 13812345678' }),
    ]);
    expect(doc.messages).toHaveLength(1);
    expect(doc.messages[0].content).not.toContain('a@b.com');
    expect(doc.messages[0].quotedText).not.toContain('13812345678');
  });

  it('exports attachment metadata only', () => {
    const doc = build([
      record({
        attachments: [
          { id: 'i', kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 2048, dataUrl: 'data:image/png;base64,AAAA' },
          { id: 't', kind: 'text', name: 'a.txt', mimeType: 'text/plain', size: 5, textContent: 'SECRET', truncated: false },
          { id: 'p', kind: 'pdf', name: 'b.pdf', mimeType: 'application/pdf', size: 9, pageCount: 3, extractedChars: 100, truncated: false },
        ],
      }),
    ]);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('base64');
    expect(json).not.toContain('SECRET');
    expect(doc.messages[0].attachments).toEqual([
      { kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 2048 },
      { kind: 'text', name: 'a.txt', mimeType: 'text/plain', size: 5 },
      { kind: 'pdf', name: 'b.pdf', mimeType: 'application/pdf', size: 9, pageCount: 3 },
    ]);
  });

  it('splits step signatures into tool name + sanitized args', () => {
    const doc = build([
      record({ role: 'assistant', content: '好', activitySteps: [
        { id: 's1', description: '填写 1 个字段', status: 'failed', attempt: 2, signature: 'browser_fill_form:{"fields":[{"fieldId":"f3","value":"110101199001011234"}]}', errorText: '读回不一致' },
      ] }),
    ]);
    const step = doc.messages[0].steps![0];
    expect(step).toMatchObject({ status: 'failed', attempt: 2, toolName: 'browser_fill_form', errorText: '读回不一致' });
    expect(step.args).toContain('f3');
    expect(step.args).not.toContain('110101199001011234');
  });

  // Review Focus #3
  it('never exports a raw signature that is not valid JSON', () => {
    const doc = build([
      record({ role: 'assistant', content: '', activitySteps: [
        { id: 's1', description: 'x', status: 'done', signature: 'browser_type:{"selector":"#p","text":"hunter2' },
      ] }),
    ]);
    const step = doc.messages[0].steps![0];
    expect(step.toolName).toBe('browser_type');
    expect(step).not.toHaveProperty('args');
    expect(JSON.stringify(doc)).not.toContain('hunter2');
  });

  it('keeps only id/name/scope of a shortcut rerun', () => {
    const doc = build([
      record({ kind: 'action', content: '润色', rerun: {
        shortcut: { id: 'polish', origin: 'builtin', scope: 'selection', customized: false, name: '润色选中文字', prompt: 'p' },
        selection: '选中的原文', supplement: '补充',
      } as never }),
    ]);
    expect(doc.messages[0].shortcut).toEqual({ id: 'polish', name: '润色选中文字', scope: 'selection' });
    expect(JSON.stringify(doc)).not.toContain('选中的原文');
  });

  it('passes through runDiagnostics, taskOutcome and flags', () => {
    const runDiagnostics = {
      providerName: 'DeepSeek', api: 'openai-completions', baseUrlHost: 'api.deepseek.com', modelId: 'm',
      vision: false, withoutBrowserTools: false, readToolCallBudget: 20, writeToolCallBudget: 40,
      startedAt: 1, durationMs: 38200, llmTurns: 5, toolCalls: 9,
    };
    const doc = build([
      record({ role: 'assistant', content: 'x', stopped: true, contextTruncated: true, runDiagnostics, taskOutcome: { outcome: 'partial', reason: '卡在第二步' } }),
    ]);
    expect(doc.messages[0]).toMatchObject({ stopped: true, contextTruncated: true, runDiagnostics, taskOutcome: { outcome: 'partial', reason: '卡在第二步' } });
  });

  it('strips tab reference urls and redacts titles', () => {
    const doc = build([
      record({ tabReferences: [{ id: 3, title: '订单 13812345678', url: 'https://a.com/o?id=1' }] }),
    ]);
    expect(doc.messages[0].tabReferences).toEqual([{ title: expect.not.stringContaining('13812345678'), url: 'https://a.com/o' }]);
  });
});
