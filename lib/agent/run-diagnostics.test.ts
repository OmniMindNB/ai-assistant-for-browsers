import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import { baseUrlHost, buildRunDiagnostics, extractToolErrorText, isUnmetWait, MAX_STEP_DETAIL_CHARS, MAX_STEP_ERROR_CHARS, MAX_STEP_RESULT_CHARS, summarizeToolResult, summarizeToolResultDetail } from './run-diagnostics';

const redaction = defaultRedactionSettings();

describe('extractToolErrorText', () => {
  it('joins the text parts of a pi-agent-core error result', () => {
    const result = { content: [{ type: 'text', text: '找不到元素' }, { type: 'image', data: 'x' }, { type: 'text', text: '#submit' }], details: {} };
    expect(extractToolErrorText(result, redaction)).toBe('找不到元素\n#submit');
  });

  it('returns undefined when there is no text', () => {
    expect(extractToolErrorText(undefined, redaction)).toBeUndefined();
    expect(extractToolErrorText({ content: [] }, redaction)).toBeUndefined();
    expect(extractToolErrorText({ content: [{ type: 'text', text: '   ' }] }, redaction)).toBeUndefined();
  });

  // Review Focus #5：先脱敏再截断——手机号跨过截断点时也不能漏出前半截。
  it('redacts before clipping so a phone number straddling the cut never leaks', () => {
    const phone = '13812345678';
    const text = `${'a'.repeat(MAX_STEP_ERROR_CHARS - 5)}${phone}${'b'.repeat(50)}`;
    const out = extractToolErrorText({ content: [{ type: 'text', text }] }, redaction)!;
    expect(out).not.toContain('13812');
    expect(out.length).toBeLessThanOrEqual(MAX_STEP_ERROR_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('baseUrlHost', () => {
  it('keeps only host (with port)', () => {
    expect(baseUrlHost('https://api.deepseek.com/v1/chat')).toBe('api.deepseek.com');
    expect(baseUrlHost('http://localhost:11434/v1')).toBe('localhost:11434');
  });
  it('returns empty string for garbage', () => {
    expect(baseUrlHost('not a url')).toBe('');
  });
});

describe('buildRunDiagnostics', () => {
  it('never carries the api key or the full baseURL', () => {
    const d = buildRunDiagnostics({
      provider: { id: 'p', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1?token=abc', apiKey: 'sk-secret', model: 'deepseek-v4-pro' } as never,
      withoutBrowserTools: false,
      readToolCallBudget: 20,
      writeToolCallBudget: 40,
      startedAt: 1000,
      endedAt: 39200,
      llmTurns: 5,
      toolCalls: 9,
    });
    expect(d).toEqual({
      providerName: 'DeepSeek',
      api: 'openai-completions',
      baseUrlHost: 'api.deepseek.com',
      modelId: 'deepseek-v4-pro',
      vision: false,
      withoutBrowserTools: false,
      readToolCallBudget: 20,
      writeToolCallBudget: 40,
      startedAt: 1000,
      durationMs: 38200,
      llmTurns: 5,
      toolCalls: 9,
    });
    expect(JSON.stringify(d)).not.toContain('sk-secret');
    expect(JSON.stringify(d)).not.toContain('token=abc');
  });

  it('clamps a negative duration to 0', () => {
    const d = buildRunDiagnostics({
      provider: { id: 'p', name: 'x', baseURL: '', apiKey: '', model: 'm' } as never,
      withoutBrowserTools: true, readToolCallBudget: 1, writeToolCallBudget: 1,
      startedAt: 10, endedAt: 5, llmTurns: 0, toolCalls: 0,
    });
    expect(d.durationMs).toBe(0);
  });
});

// 2026-10-07 开端口会话导出只有调用参数没有结果：等待是成功还是超时、find_text 命中了几个，
// 事后一概无从知道，排查只能靠猜。成功步骤也留一行结果摘要。
describe('summarizeToolResult', () => {
  const text = (value: string, details: unknown = {}) => ({ content: [{ type: 'text', text: value }], details });

  it('写工具取结果第一行', () => {
    expect(summarizeToolResult('browser_click', text('已点击 f56（"Ubuntu"）。\n页面新出现 3 个可交互元素：…'), redaction))
      .toBe('已点击 f56（"Ubuntu"）。');
  });

  it('browser_wait_for 取结果第一行（成功或超时都要看得见）', () => {
    expect(summarizeToolResult('browser_wait_for', text('等待超时：8000ms 内未满足条件（页面出现文本 "6000"），实际等待 8003ms。\n页面可能仍在加载…'), redaction))
      .toBe('等待超时：8000ms 内未满足条件（页面出现文本 "6000"），实际等待 8003ms。');
  });

  it('browser_find_text 报命中数、可见数和前几个命中的文字', () => {
    const details = {
      matches: [
        { fieldId: 't1', tag: 'script', text: 'window.cfg', visible: false, clickable: false },
        { fieldId: 't2', tag: 'span', text: '6000', visible: true, clickable: false },
        { fieldId: 't3', tag: 'div', text: '开放6000端口', visible: true, clickable: false },
      ],
      truncated: false,
    };
    expect(summarizeToolResult('browser_find_text', text('{...}', details), redaction))
      .toBe('命中 3 个（可见 2 个）：t2「6000」、t3「开放6000端口」');
    expect(summarizeToolResult('browser_find_text', text('{...}', { matches: [], truncated: false }), redaction)).toBe('命中 0 个');
  });

  it('browser_get_form 报元素数', () => {
    const details = { fields: [{ visible: true }, { visible: false }, { visible: true }] };
    expect(summarizeToolResult('browser_get_form', text('...', details), redaction)).toBe('3 个可交互元素（可见 2 个）');
  });

  it('其它读工具不给摘要：结果是大段转储，第一行没有信息量', () => {
    expect(summarizeToolResult('browser_read_page', text('页面正文（untrusted page content）\n…'), redaction)).toBeUndefined();
  });

  it('页面文案先脱敏再截断', () => {
    const long = `已点击 f1（"13812345678 ${'很长'.repeat(200)}"）。`;
    const summary = summarizeToolResult('browser_click', text(long), redaction)!;
    expect(summary).not.toContain('13812345678');
    expect(summary.length).toBeLessThanOrEqual(MAX_STEP_RESULT_CHARS + 1);
  });
});

describe('isUnmetWait', () => {
  it('只有 browser_wait_for 且 met 为 false 才算', () => {
    expect(isUnmetWait('browser_wait_for', { content: [], details: { met: false, elapsedMs: 8000 } })).toBe(true);
    expect(isUnmetWait('browser_wait_for', { content: [], details: { met: true, elapsedMs: 600 } })).toBe(false);
    expect(isUnmetWait('browser_click', { content: [], details: { met: false } })).toBe(false);
    expect(isUnmetWait('browser_wait_for', undefined)).toBe(false);
  });
});

// 第一行之后才是要看的东西：新出现元素的清单、[页面位置]、[跳转后页面]——第二份开端口导出里
// 模型每次点击后仍自己调 get_form，没有这几行就判断不了清单到底附上没有、列了什么。
describe('summarizeToolResultDetail', () => {
  const result = (...texts: string[]) => ({ content: texts.map((text) => ({ type: 'text', text })), details: {} });

  it('写工具：第一行之后的全部内容，含 afterToolCall 追加的说明', () => {
    expect(summarizeToolResultDetail('browser_click', result('已点击 f60。\n页面新出现 2 个可交互元素：f61「概要」。', '[页面位置] 从 "a" 跳转到 "b"。', '[跳转后页面] 已重新读取页面，65 个可交互元素：…'), redaction))
      .toBe('页面新出现 2 个可交互元素：f61「概要」。\n[页面位置] 从 "a" 跳转到 "b"。\n[跳转后页面] 已重新读取页面，65 个可交互元素：…');
  });

  it('只有一行时没有附加内容', () => {
    expect(summarizeToolResultDetail('browser_click', result('已点击 f60。'), redaction)).toBeUndefined();
  });

  it('读工具不记：结果是大段转储', () => {
    expect(summarizeToolResultDetail('browser_get_form', result('标题\n大段 JSON'), redaction)).toBeUndefined();
  });

  it('先脱敏再截断', () => {
    const detail = summarizeToolResultDetail('browser_click', result(`已点击。\n13812345678 ${'元素'.repeat(2000)}`), redaction)!;
    expect(detail).not.toContain('13812345678');
    expect(detail.length).toBeLessThanOrEqual(MAX_STEP_DETAIL_CHARS + 1);
  });
});
