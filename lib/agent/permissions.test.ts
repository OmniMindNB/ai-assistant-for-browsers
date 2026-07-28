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

  it('auto-allows revert_changes', () => {
    expect(decideToolPermission('browser_revert_changes', {})).toEqual({ level: 'auto_allow' });
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
