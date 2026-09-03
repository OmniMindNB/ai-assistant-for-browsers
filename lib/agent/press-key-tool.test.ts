import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';
import { buildSubmitIntentProbePayload } from './agent';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');
const { AUTO_APPROVE_TOOL_NAMES, WRITE_TOOL_NAMES, decideToolPermission } = await import('./permissions');

function getPressKeyTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_press_key');
  if (!tool) throw new Error('browser_press_key 未注册');
  return tool;
}

beforeEach(() => {
  sendMessage.mockReset();
});

describe('browser_press_key 工具', () => {
  it('已注册', () => {
    expect(getPressKeyTool().name).toBe('browser_press_key');
  });

  it('把 fieldId 与按键发给当前操作 tab', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { status: 'ok', key: 'Enter', target: 'input#q', defaultPrevented: false, submitted: true },
    });
    await getPressKeyTool().execute('call-1', { key: 'Enter', fieldId: 'f1' });

    expect(sendMessage).toHaveBeenCalledWith(
      'PRESS_KEY',
      expect.objectContaining({ key: 'Enter', fieldId: 'f1' }),
      1,
    );
  });

  it('非法按键在发消息之前就抛出', async () => {
    await expect(getPressKeyTool().execute('call-1', { key: 'F5' })).rejects.toThrow('F5');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('句柄表失效时提示重新读取表单', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { status: 'not_found', key: 'Enter', defaultPrevented: false, submitted: false, fieldsTableStale: true } });
    await expect(getPressKeyTool().execute('call-1', { key: 'Enter', fieldId: 'f1' })).rejects.toThrow('browser_get_form');
  });

  it('没有焦点时的失败文案要求给出 fieldId', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { status: 'no_focus', key: 'Enter', defaultPrevented: false, submitted: false } });
    await expect(getPressKeyTool().execute('call-1', { key: 'Enter' })).rejects.toThrow('fieldId');
  });

  it('结果文案报告是否被拦截以及是否触发提交', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { status: 'ok', key: 'Enter', target: 'input#q', defaultPrevented: true, submitted: false },
    });
    const output = await getPressKeyTool().execute('call-1', { key: 'Enter', fieldId: 'f1' });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('Enter');
    expect(text).toContain('preventDefault');
  });
});

describe('browser_press_key 的权限分级', () => {
  it('是写工具，走自动放行', () => {
    expect(AUTO_APPROVE_TOOL_NAMES.has('browser_press_key')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('browser_press_key')).toBe(true);
    expect(decideToolPermission('browser_press_key', { key: 'Enter' })).toEqual({ level: 'auto_allow' });
  });
});

// Enter 能提交表单，因此 press_key 必须进 SUBMIT_CAPABLE_TOOLS——否则它就是
// 绕过"结构化检测到的提交每次都要确认"这条硬边界的后门。
describe('browser_press_key 的提交探测', () => {
  it('探测载荷带上 fieldId 与按键', () => {
    const payload = buildSubmitIntentProbePayload('browser_press_key', { key: 'Enter', fieldId: 'f1' });
    // 字段名必须是 fieldId，不是 submitFieldId：ProbeKeyTargetPayload（lib/messaging.ts）
    // 声明的就是 fieldId，probeEnterSubmitIntent（entrypoints/background.ts）两处调用
    // （PROBE_KEY_TARGET 消息分支、pressKey() 内部复用）读的也都是 payload.fieldId。
    // 发送端一旦发成 submitFieldId，确认闸门探测永远拿不到 handle，
    // 会把「应确认的提交」错判成 isSubmit:false，是曾经真实发生过的安全回归。
    expect(payload).toMatchObject({ fieldId: 'f1', fieldIds: ['f1'] });
    expect(payload).not.toHaveProperty('submitFieldId');
  });

  it('不给目标时探测走 activeElement', () => {
    const payload = buildSubmitIntentProbePayload('browser_press_key', { key: 'Enter' });
    expect(payload).toMatchObject({ useActiveElement: true });
  });
});
