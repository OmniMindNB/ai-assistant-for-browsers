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
  exportFileName,
  renderConversationExportMarkdown,
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
  // 终审 #5：非 http(s) 的 pathname 可能就是全部载荷（data:）或本机用户名（file:），只留 scheme + host。
  it('drops the pathname of non-http schemes', () => {
    expect(stripUrl('chrome://newtab/?x=1')).toBe('chrome://newtab');
    expect(stripUrl('about:blank')).toBe('about:');
    expect(stripUrl('file:///C:/Users/alice/secret.html')).toBe('file:');
    expect(stripUrl('data:text/html,<b>token=abc</b>')).toBe('data:');
  });
});

describe('export privacy fixes from final review', () => {
  // 终审 #5：http(s) 路径里也可能有邮箱等，同样要过脱敏。
  it('redacts personal data inside url paths', () => {
    const doc = build([], { ...conversation, url: 'https://a.com/user/foo@bar.com/orders' });
    expect(doc.conversation.url).not.toContain('foo@bar.com');
    expect(sanitizeToolArgs('browser_navigate', { url: 'https://a.com/u/foo@bar.com' }, redaction, t)).not.toEqual({ url: 'https://a.com/u/foo@bar.com' });
  });

  // 终审 #1：轨迹里的表单填写值不能绕过 §4.2 的屏蔽。
  it('masks form values recorded in the trajectory', () => {
    const doc = build([
      record({ role: 'assistant', content: '好', trajectory: [
        { tool: 'browser_fill_form', values: [{ target: '「收货地址」', value: '北京市海淀区' }, { target: '「同意条款」', checked: true }] },
      ] }),
    ]);
    expect(JSON.stringify(doc)).not.toContain('北京市海淀区');
    expect(doc.messages[0].trajectory![0].values).toEqual([
      { target: '「收货地址」', value: '‹已省略 6 字›' },
      { target: '「同意条款」', checked: true },
    ]);
  });

  // 终审 #2：browser_type 的步骤描述里带着输入的原文。
  it('does not leak typed text through the step description', () => {
    const doc = build([
      record({ role: 'assistant', content: '好', activitySteps: [
        { id: 's1', description: '已向 "#pwd" 输入 "hunter22"', status: 'done', signature: 'browser_type:{"selector":"#pwd","text":"hunter22"}' },
      ] }),
    ]);
    expect(JSON.stringify(doc)).not.toContain('hunter22');
    expect(renderConversationExportMarkdown(doc, t)).not.toContain('hunter22');
  });

  it('keeps a result-derived description when it does not depend on masked values', () => {
    const doc = build([
      record({ role: 'assistant', content: '好', activitySteps: [
        { id: 's1', description: '已填写 2/3 个字段', status: 'done', signature: 'browser_fill_form:{"fields":[{"fieldId":"f1","value":"x"}]}' },
      ] }),
    ]);
    expect(doc.messages[0].steps![0].description).toBe('已填写 2/3 个字段');
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

  // 推理只给面板回看用，导出不带（ref: 2026-09-24-reasoning-display-design.md §3.3）。
  it('never exports assistant reasoning', () => {
    const doc = build([
      record({ content: '问' }),
      record({ role: 'assistant', content: '答', reasoning: ['推理里的秘密步骤'], reasoningOmittedChars: 3 }),
    ]);
    expect(JSON.stringify(doc)).not.toContain('推理里的秘密步骤');
    expect(renderConversationExportMarkdown(doc, t)).not.toContain('推理里的秘密步骤');
  });
});

describe('renderConversationExportMarkdown', () => {
  const runDiagnostics = {
    providerName: 'DeepSeek', api: 'openai-completions', baseUrlHost: 'api.deepseek.com', modelId: 'deepseek-v4-pro',
    vision: false, withoutBrowserTools: false, readToolCallBudget: 20, writeToolCallBudget: 40,
    startedAt: 1, durationMs: 38200, llmTurns: 5, toolCalls: 9,
  };

  function render(records: ChatMessageRecord[]) {
    return renderConversationExportMarkdown(build(records), t);
  }

  it('renders header, rounds, run info, steps table and a parseable JSON appendix', () => {
    const md = render([
      record({ content: '帮我填表' }),
      record({ role: 'assistant', content: '已完成', runDiagnostics, taskOutcome: { outcome: 'partial', reason: '卡在第二步' }, activitySteps: [
        { id: 's1', description: '读取页面表单', status: 'done', signature: 'browser_get_form:{}' },
        { id: 's2', description: '填写 | 3 个字段', status: 'failed', attempt: 2, signature: 'browser_fill_form:{"fields":[{"fieldId":"f3","value":"abc"}]}', errorText: '第一行\n第二行' },
      ] }),
      record({ content: '再来一次' }),
    ]);
    expect(md).toContain('# Runi 会话导出：');
    expect(md).toContain('- 扩展版本：1.4.0 · 界面语言：zh');
    expect(md).toContain('## 第 1 轮');
    expect(md).toContain('## 第 2 轮');
    expect(md).toContain('DeepSeek · deepseek-v4-pro（openai-completions @ api.deepseek.com）');
    expect(md).toContain('耗时 38.2s');
    expect(md).toContain('**任务结果**：partial —— 卡在第二步');
    expect(md).toContain('| # | 状态 | 步骤 | 调用 | 失败原因 |');
    expect(md).toContain('填写 \\| 3 个字段');
    expect(md).toContain('第一行<br>第二行');
    expect(md).toContain('✗ ×2');
    expect(md).not.toContain('"value":"abc"');

    const fence = md.match(/\n(`{3,})json\n/)![1];
    const json = md.slice(md.lastIndexOf(`${fence}json\n`) + fence.length + 5, md.lastIndexOf(`\n${fence}`));
    expect(JSON.parse(json).schema).toBe(EXPORT_SCHEMA);
  });

  it('omits the run info line for legacy messages without diagnostics', () => {
    const md = render([record({ content: '问' }), record({ role: 'assistant', content: '答' })]);
    expect(md).not.toContain('**运行信息**');
  });

  it('puts a leading assistant message into round 1', () => {
    const md = render([record({ role: 'assistant', content: '欢迎' }), record({ content: '问' })]);
    expect(md.indexOf('## 第 1 轮')).toBeLessThan(md.indexOf('欢迎'));
    expect(md).toContain('## 第 2 轮');
  });

  // Review Focus #2
  it('closes an unbalanced code fence so later sections are not swallowed', () => {
    const md = render([record({ role: 'assistant', content: '看这段：\n```js\nconst a = 1;' }), record({ content: '下一轮' })]);
    const beforeRound2 = md.slice(0, md.indexOf('## 第 2 轮'));
    const fenceLines = beforeRound2.split('\n').filter((line) => /^\s*(`{3,}|~{3,})/.test(line));
    expect(fenceLines.length % 2).toBe(0);
  });

  // 终审 #3：按 CommonMark 开/闭规则追踪围栏，而不是数行数。
  it('closes an open fence with the same character and length', () => {
    const md = render([record({ role: 'assistant', content: '````md\n```js\nx\n```' }), record({ content: '下一轮' })]);
    expect(md).toContain('```js\nx\n```\n````\n');
  });

  it('does not append a fence to a well-formed reply mixing ``` and ~~~', () => {
    const md = render([record({ role: 'assistant', content: '```md\n~~~\n```' }), record({ content: '下一轮' })]);
    expect(md).toContain('```md\n~~~\n```\n\n## 第 2 轮');
  });

  it('uses a JSON fence longer than any backtick run inside the JSON', () => {
    const md = render([record({ content: '````四个反引号````' })]);
    expect(md).toMatch(/\n`{5,}json\n/);
  });
});

describe('exportFileName', () => {
  const at = new Date(2026, 8, 24, 14, 3).getTime();
  it('formats title and local timestamp', () => {
    expect(exportFileName('帮我填表', at)).toBe('runi-帮我填表-20260924-1403.md');
  });
  // Review Focus #4
  it('replaces illegal characters and falls back when nothing usable is left', () => {
    expect(exportFileName('a/b:c*?', at)).toBe('runi-a_b_c__-20260924-1403.md');
    expect(exportFileName('   ', at)).toBe('runi-conversation-20260924-1403.md');
    expect(exportFileName('...', at)).toBe('runi-conversation-20260924-1403.md');
  });
  it('clips long titles to 40 chars', () => {
    const name = exportFileName('字'.repeat(100), at);
    expect(name).toBe(`runi-${'字'.repeat(40)}-20260924-1403.md`);
  });
});
