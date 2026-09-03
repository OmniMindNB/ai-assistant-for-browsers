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

  it('always allows ask_user — it does not mutate page or browser state', () => {
    expect(decideToolPermission('ask_user', { question: '你想让我提交这个表单吗？' })).toEqual({ level: 'always_allow' });
  });

  it('always allows wait — it does not mutate page or browser state', () => {
    expect(decideToolPermission('wait', { seconds: 2 })).toEqual({ level: 'always_allow' });
  });

  it('denies an unknown tool', () => {
    expect(decideToolPermission('browser_made_up', {}).level).toBe('deny');
  });

  it('denies eval_raw unconditionally', () => {
    expect(decideToolPermission('browser_eval_raw', {}).level).toBe('deny');
  });

  it('automatically allows low-risk write and interaction tools', () => {
    for (const tool of [
      'browser_set_style',
      'browser_modify_dom',
      'browser_click',
      'browser_fill_form',
      'browser_type',
      'browser_scroll',
      'browser_select',
      'browser_open_tab',
      'browser_navigate',
      'browser_set_storage',
      'browser_close_tab',
    ]) {
      expect(decideToolPermission(tool, { code: 'void 0', url: 'https://example.com' }).level).toBe('auto_allow');
    }
  });

  it('automatically allows navigation, tab closing, and website storage writes', () => {
    expect(decideToolPermission('browser_navigate', { url: 'https://example.com' }).level).toBe('auto_allow');
    expect(decideToolPermission('browser_close_tab', { tabId: 2 }).level).toBe('auto_allow');
    expect(decideToolPermission('browser_set_storage', { area: 'local', key: 'theme', value: 'dark' }).level).toBe('auto_allow');
  });

  it('denies navigate to a javascript: URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'javascript:alert(1)' }).level).toBe('deny');
  });

  it('denies navigate to a malformed URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'not a url' }).level).toBe('deny');
  });

  it('automatically allows navigate to an https URL', () => {
    expect(decideToolPermission('browser_navigate', { url: 'https://example.com' })).toEqual({
      level: 'auto_allow',
    });
  });

  it('denies browser_click when the selector targets a page-root container', () => {
    for (const selector of ['body', 'HTML', '#root', '#app', ':root', '*', 'div, body']) {
      expect(decideToolPermission('browser_click', { selector }).level).toBe('deny');
    }
  });

  it('allows browser_click by fieldId even if a stray selector arg looks like a root container', () => {
    // fieldId 路径走字段句柄表，不经过 CSS selector，selector 字段应被忽略。
    expect(decideToolPermission('browser_click', { fieldId: 'f1', selector: 'body' }).level).toBe('auto_allow');
  });

  it('automatically allows browser_click with an ordinary selector', () => {
    expect(decideToolPermission('browser_click', { selector: '.submit-button' }).level).toBe('auto_allow');
  });

  it('denies browser_modify_dom when the selector targets a page-root container', () => {
    for (const selector of ['body', 'html', '#root', '#app']) {
      expect(decideToolPermission('browser_modify_dom', { selector, action: 'remove' }).level).toBe('deny');
    }
  });

  it('automatically allows browser_modify_dom with an ordinary selector', () => {
    expect(decideToolPermission('browser_modify_dom', { selector: '.ad-banner', action: 'remove' }).level).toBe('auto_allow');
  });

  describe('多标签页编排工具的权限分级', () => {
    it('browser_switch_tab 与 browser_list_tabs 无需确认', () => {
      expect(decideToolPermission('browser_switch_tab', { tabId: 2 })).toEqual({ level: 'always_allow' });
      expect(decideToolPermission('browser_list_tabs', {})).toEqual({ level: 'always_allow' });
    });

    it('browser_open_tab 与 browser_close_tab 都自动放行', () => {
      expect(decideToolPermission('browser_open_tab', { url: 'https://example.com' }).level).toBe('auto_allow');
      expect(decideToolPermission('browser_close_tab', { tabId: 2 }).level).toBe('auto_allow');
    });

    it('denies browser_open_tab to a javascript: URL', () => {
      expect(decideToolPermission('browser_open_tab', { url: 'javascript:alert(1)' }).level).toBe('deny');
    });

    it('denies browser_open_tab to a file: URL', () => {
      expect(decideToolPermission('browser_open_tab', { url: 'file:///etc/passwd' }).level).toBe('deny');
    });

    it('denies browser_open_tab to a malformed URL', () => {
      expect(decideToolPermission('browser_open_tab', { url: 'not a url' }).level).toBe('deny');
    });

    it('automatically allows browser_open_tab to an https URL', () => {
      expect(decideToolPermission('browser_open_tab', { url: 'https://example.com' })).toEqual({
        level: 'auto_allow',
      });
    });
  });
});

describe('beforeToolCallPermissionGate', () => {
  it('allows read-only tools without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_read_page', {}), {
      gateState: createConfirmGateState(),
      onConfirm,
      targetTabId: 1,
    });
    expect(result).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('denies immediately without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_eval_raw', {}), {
      gateState: createConfirmGateState(),
      onConfirm,
      targetTabId: 1,
    });
    expect(result?.block).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not call onConfirm for an auto-allowed write tool', async () => {
    const onConfirm = vi.fn();
    const result = await beforeToolCallPermissionGate(makeContext('browser_click', { selector: 'button' }), {
      gateState: createConfirmGateState(),
      onConfirm,
      targetTabId: 1,
      resolveSubmitIntent: async () => ({ isSubmit: false }),
    });
    expect(result).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not call onConfirm for navigation, tab closing, or storage writes', async () => {
    const onConfirm = vi.fn();
    for (const [toolName, args] of [
      ['browser_navigate', { url: 'https://example.com' }],
      ['browser_close_tab', { tabId: 2 }],
      ['browser_set_storage', { area: 'local', key: 'a', value: 'b' }],
    ] as const) {
      expect(await beforeToolCallPermissionGate(makeContext(toolName, args), {
        gateState: createConfirmGateState(),
        onConfirm,
        targetTabId: 1,
      })).toBeUndefined();
    }
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('submit intent escalation', () => {
  it('keeps decideToolPermission pure — it never denies on sensitive fields', () => {
    expect(decideToolPermission('browser_fill_form', { fields: [{ fieldId: 'f1', value: 'x' }] }).level).toBe('auto_allow');
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
        targetTabId: 1,
        resolveSubmitIntent: async () => ({ isSubmit: true, formAction: 'https://example.com/checkout', fieldCount: 12 }),
      },
    );

    expect(result).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1); // 尽管本轮已批准，仍然又问了一次
  });

  it('automatically allows a non-submitting click', async () => {
    const state = createConfirmGateState();
    state.decision = 'approved';
    const onConfirm = vi.fn().mockResolvedValue(true);

    const result = await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-2', name: 'browser_click' }, args: { selector: 'a' } } as any,
      { gateState: state, onConfirm, targetTabId: 1, resolveSubmitIntent: async () => ({ isSubmit: false }) },
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
        targetTabId: 1,
        resolveSubmitIntent: async () => ({ isSubmit: true, fieldLabels: [{ fieldId: 'f1', label: '邮箱' }] }),
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
        targetTabId: 1,
        resolveSubmitIntent: async () => ({ isSubmit: true, fieldLabels: [{ fieldId: 'f7', label: '登录' }] }),
      },
    );

    expect((onConfirm.mock.calls[0][2] as any).label).toBe('登录');
    expect((args as any).label).toBeUndefined();
  });

  // browser_press_key 的 Enter 能像 browser_click 一样触发隐式表单提交，SUBMIT_CAPABLE_TOOLS
  // 里必须包含它——否则就是绕过「结构化检测到的提交每次都要确认」这条硬边界的后门
  // （ref: 最终评审 finding 2）。这两个用例专门锁死这条membership，防止未来被误删而无测试报警。
  it('escalates a press_key that submits a form to confirm_always', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);
    state.decision = 'approved'; // 本轮早先已批准过一次写操作

    const result = await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-1', name: 'browser_press_key' }, args: { key: 'Enter', fieldId: 'f1' } } as any,
      {
        gateState: state,
        onConfirm,
        targetTabId: 1,
        resolveSubmitIntent: async () => ({ isSubmit: true, formAction: 'https://example.com/checkout', fieldCount: 12 }),
      },
    );

    expect(result).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1); // 尽管本轮已批准，仍然又问了一次
  });

  it('enriches a browser_press_key(fieldId) confirmation with the field label and formAction, without touching the model args', async () => {
    const args = { fieldId: 'f7', key: 'Enter' };
    const onConfirm = vi.fn().mockResolvedValue(true);

    await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-1', name: 'browser_press_key' }, args } as any,
      {
        gateState: createConfirmGateState(),
        onConfirm,
        targetTabId: 1,
        resolveSubmitIntent: async () => ({
          isSubmit: true,
          formAction: 'https://example.com/checkout',
          fieldLabels: [{ fieldId: 'f7', label: '登录' }],
        }),
      },
    );

    expect((onConfirm.mock.calls[0][2] as any).label).toBe('登录');
    expect((onConfirm.mock.calls[0][2] as any).formAction).toBe('https://example.com/checkout');
    expect((args as any).label).toBeUndefined();
    expect((args as any).formAction).toBeUndefined();
  });

  it('automatically allows a non-submitting press_key', async () => {
    const state = createConfirmGateState();
    state.decision = 'approved';
    const onConfirm = vi.fn().mockResolvedValue(true);

    const result = await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-2', name: 'browser_press_key' }, args: { key: 'Tab', fieldId: 'f1' } } as any,
      { gateState: state, onConfirm, targetTabId: 1, resolveSubmitIntent: async () => ({ isSubmit: false }) },
    );

    expect(result).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
