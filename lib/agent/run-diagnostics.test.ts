import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import { baseUrlHost, buildRunDiagnostics, extractToolErrorText, MAX_STEP_ERROR_CHARS } from './run-diagnostics';

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
