import { describe, expect, it, vi } from 'vitest';
import type { GetFormResult } from '@/lib/messaging';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');

function getFormTool() {
  const tool = createBrowserTools(1).find((candidate) => candidate.name === 'browser_get_form');
  if (!tool) throw new Error('browser_get_form 未注册');
  return tool;
}

const RESULT: GetFormResult = {
  forms: [{ formId: 'form0', action: 'https://example.com/checkout', method: 'post', submitFieldIds: ['f3'] }],
  fields: [
    {
      fieldId: 'f1', kind: 'text', name: 'email', label: '邮箱', required: true, disabled: false,
      readOnly: false, visible: true, value: 'a@b.c', valueState: 'filled', sensitive: false,
      writable: true, clickable: false, fingerprint: 'input|email|email|邮箱', formId: 'form0',
    },
  ],
  orphanFieldIds: [],
  unreachable: { iframes: 2, closedShadowRoots: 0 },
  truncated: false,
};

describe('browser_get_form', () => {
  it('is registered as a tool', () => {
    expect(getFormTool().name).toBe('browser_get_form');
  });

  it('marks the result as untrusted page content', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    const output = await getFormTool().execute('call-1', {});
    expect((output.content[0] as { text: string }).text).toContain('untrusted page content');
  });

  it('surfaces unreachable iframes in the text so the model stops probing', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    const output = await getFormTool().execute('call-1', {});
    expect((output.content[0] as { text: string }).text).toContain('iframe');
  });

  it('throws with the backend error when the read fails', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: false, error: '目标标签页已关闭。' });
    await expect(getFormTool().execute('call-1', {})).rejects.toThrow('目标标签页已关闭。');
  });
});

function fillFormTool() {
  const tool = createBrowserTools(1).find((candidate) => candidate.name === 'browser_fill_form');
  if (!tool) throw new Error('browser_fill_form 未注册');
  return tool;
}

describe('browser_fill_form', () => {
  it('is registered as a tool', () => {
    expect(fillFormTool().name).toBe('browser_fill_form');
  });

  it('does not report partial failure as overall success', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: {
        outcomes: [
          { fieldId: 'f1', status: 'ok' },
          { fieldId: 'f2', status: 'invalid_value', detail: '写入后回读不符。', actualValue: '' },
          { fieldId: 'f3', status: 'blocked_sensitive', detail: '密码字段不代填。' },
        ],
      },
    });
    const output = await fillFormTool().execute('call-1', { fields: [] });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('1 个成功');
    expect(text).toContain('2 个失败');
    expect(text).toContain('f2');
    expect(text).toContain('f3');
  });

  it('tells the model to re-read the form when the handle table is stale', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: { outcomes: [], fieldsTableStale: true } });
    await expect(fillFormTool().execute('call-1', { fields: [] })).rejects.toThrow('browser_get_form');
  });

  it('rejects more than 50 fields in one call', async () => {
    const fields = Array.from({ length: 51 }, (_, index) => ({ fieldId: `f${index}`, value: 'x' }));
    await expect(fillFormTool().execute('call-1', { fields })).rejects.toThrow('50');
  });
});
