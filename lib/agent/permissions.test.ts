import { describe, expect, it, vi } from 'vitest';
import { beforeToolCallPermissionGate, decideToolPermission } from './permissions';
import { createConfirmGateState } from './confirm-gate';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';

function makeContext(toolName: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: { role: 'assistant', content: [] } as unknown as BeforeToolCallContext['assistantMessage'],
    toolCall: { id: 'call-1', type: 'toolCall', name: toolName, arguments: args } as unknown as BeforeToolCallContext['toolCall'],
    args,
    context: {} as BeforeToolCallContext['context'],
  };
}

describe('decideToolPermission', () => {
  it('always allows read-only tools', () => {
    expect(decideToolPermission('browser_read_page', {})).toEqual({ level: 'always_allow' });
  });

  it('denies an unknown tool', () => {
    expect(decideToolPermission('browser_made_up', {}).level).toBe('deny');
  });

  it('denies eval_raw unconditionally', () => {
    expect(decideToolPermission('browser_eval_raw', {}).level).toBe('deny');
  });

  it('requires confirmation for the write/interaction tools', () => {
    for (const tool of [
      'browser_set_style',
      'browser_modify_dom',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_select',
      'browser_set_storage',
    ]) {
      expect(decideToolPermission(tool, { code: 'void 0' }).level).toBe('confirm');
    }
  });

  it('denies navigate to a javascript: URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'javascript:alert(1)' }).level).toBe('deny');
  });

  it('denies navigate to a malformed URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'not a url' }).level).toBe('deny');
  });

  it('requires confirmation for navigate to an https URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'https://example.com' })).toEqual({
      level: 'confirm',
      reason: expect.stringContaining('修改页面'),
    });
  });
});

describe('beforeToolCallPermissionGate', () => {
  it('allows read-only tools without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_read_page', {}), {
      gateState: createConfirmGateState(),
      onConfirm,
    });
    expect(result).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('denies immediately without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_eval_raw', {}), {
      gateState: createConfirmGateState(),
      onConfirm,
    });
    expect(result?.block).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('awaits onConfirm for a confirm-tier tool and allows once approved', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const result = await beforeToolCallPermissionGate(makeContext('browser_click', { selector: 'button' }), {
      gateState: createConfirmGateState(),
      onConfirm,
    });
    expect(result).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledWith('call-1', 'browser_click', { selector: 'button' }, expect.any(String));
  });
});

describe('submit intent escalation', () => {
  it('keeps decideToolPermission pure — it never denies on sensitive fields', () => {
    expect(decideToolPermission('browser_fill_form', { fields: [{ fieldId: 'f1', value: 'x' }] }).level).toBe('confirm');
  });

  it('escalates a click that submits a form to confirm_always', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);
    state.decision = 'approved'; // 本轮早先已批准过一次写操作

    const result = await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-1', name: 'browser_click' }, args: { selector: 'button' } } as any,
      {
        gateState: state,
        onConfirm,
        resolveSubmitIntent: async () => ({ isSubmit: true, formAction: 'https://example.com/checkout', fieldCount: 12 }),
      },
    );

    expect(result).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1); // 尽管本轮已批准，仍然又问了一次
  });

  it('leaves a non-submitting click on the once-per-turn path', async () => {
    const state = createConfirmGateState();
    state.decision = 'approved';
    const onConfirm = vi.fn().mockResolvedValue(true);

    const result = await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-2', name: 'browser_click' }, args: { selector: 'a' } } as any,
      { gateState: state, onConfirm, resolveSubmitIntent: async () => ({ isSubmit: false }) },
    );

    expect(result).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('enriches only the copy handed to the confirmation UI, never the model args', async () => {
    const args = { fields: [{ fieldId: 'f1', value: 'a@b.c' }] };
    const onConfirm = vi.fn().mockResolvedValue(true);

    await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-1', name: 'browser_fill_form' }, args } as any,
      {
        gateState: createConfirmGateState(),
        onConfirm,
        resolveSubmitIntent: async () => ({ isSubmit: false, fieldLabels: [{ fieldId: 'f1', label: '邮箱' }] }),
      },
    );

    expect((onConfirm.mock.calls[0][2] as any).fields[0].label).toBe('邮箱');
    expect((args.fields[0] as any).label).toBeUndefined();
  });

  it('enriches a browser_click(fieldId) confirmation with the field label, without touching the model args', async () => {
    const args = { fieldId: 'f7' };
    const onConfirm = vi.fn().mockResolvedValue(true);

    await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-1', name: 'browser_click' }, args } as any,
      {
        gateState: createConfirmGateState(),
        onConfirm,
        resolveSubmitIntent: async () => ({ isSubmit: false, fieldLabels: [{ fieldId: 'f7', label: '登录' }] }),
      },
    );

    expect((onConfirm.mock.calls[0][2] as any).label).toBe('登录');
    expect((args as any).label).toBeUndefined();
  });
});
