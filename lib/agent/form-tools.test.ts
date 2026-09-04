import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetFormResult } from '@/lib/messaging';
import { defaultRedactionSettings } from '@/lib/redaction';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const loadRedactionSettings = vi.fn();
vi.mock('@/lib/redaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/redaction')>('@/lib/redaction');
  return { ...actual, loadRedactionSettings: (...args: unknown[]) => loadRedactionSettings(...args) };
});

// 默认关闭：既有测试用例对渲染文本做精确匹配，不应受脱敏默认开启影响。
// 新增的脱敏专项测试用 mockResolvedValueOnce 显式覆盖成开启状态。
beforeEach(() => {
  loadRedactionSettings.mockResolvedValue({ enabled: false, rules: [] });
});

const { createBrowserTools } = await import('./tools');

function getFormTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_get_form');
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
  textTruncated: false,
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

  it('renders fields as compact lines instead of pretty-printed JSON', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    const output = await getFormTool().execute('call-1', {});
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('f1 text「邮箱」value="a@b.c" required');
    expect(text).not.toContain('"fieldId": "f1"');
  });

  it('never sends the verification fingerprint to the model', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    const output = await getFormTool().execute('call-1', {});
    expect((output.content[0] as { text: string }).text).not.toContain('input|email|email|邮箱');
  });

  it('still hands the full structured data to the UI', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    const output = await getFormTool().execute('call-1', {});
    expect(output.details).toMatchObject({ fields: [{ fieldId: 'f1', fingerprint: 'input|email|email|邮箱' }] });
  });

  // 会让这个用例失败的 production 改动：恢复旧的 unreachable.iframes 旁注——那句话现在是假的
  // （iframe 已经可以正常读取/操作），会让模型主动放弃它其实够得着的表单。
  it('no longer claims iframes are unreachable, even when unreachable.iframes is set', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    const output = await getFormTool().execute('call-1', {});
    expect((output.content[0] as { text: string }).text).not.toContain('无法读取或操作');
  });

  it('surfaces dropped frames in the text so the model stops assuming it saw everything', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: { ...RESULT, droppedFrames: 2 } });
    const output = await getFormTool().execute('call-1', {});
    expect((output.content[0] as { text: string }).text).toContain('2');
  });

  it('throws with the backend error when the read fails', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: false, error: '目标标签页已关闭。' });
    await expect(getFormTool().execute('call-1', {})).rejects.toThrow('目标标签页已关闭。');
  });

  it('passes includeText through to the GET_FORM payload', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    await getFormTool().execute('call-1', { includeText: true });
    expect(sendMessage).toHaveBeenCalledWith('GET_FORM', { includeText: true }, 1);
  });

  it('passes includeScrollable through to the GET_FORM payload', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    await getFormTool().execute('call-1', { includeScrollable: true });
    expect(sendMessage).toHaveBeenCalledWith('GET_FORM', { includeScrollable: true }, 1);
  });

  it('surfaces discovered scrollable containers in the result text', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { ...RESULT, scrollableContainers: [{ fieldId: 's1', tag: 'div', scrollTop: 0, scrollHeight: 900, clientHeight: 300 }] },
    });
    const output = await getFormTool().execute('call-1', { includeScrollable: true });
    expect((output.content[0] as { text: string }).text).toContain('s1');
  });

  it('redacts sensitive values through the redaction pipeline when enabled', async () => {
    loadRedactionSettings.mockResolvedValueOnce(defaultRedactionSettings());
    const resultWithPhone: GetFormResult = {
      ...RESULT,
      fields: [{ ...RESULT.fields[0], value: '13812345678', label: '手机号', name: 'phone' }],
    };
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: resultWithPhone });

    const output = await getFormTool().execute('call-1', {});
    const text = (output.content[0] as { text: string }).text;

    expect(text).toContain('[手机号已脱敏]');
    expect(text).not.toContain('13812345678');
  });

  it('keeps original values when redaction is disabled', async () => {
    loadRedactionSettings.mockResolvedValueOnce({ enabled: false, rules: [] });
    const resultWithPhone: GetFormResult = {
      ...RESULT,
      fields: [{ ...RESULT.fields[0], value: '13812345678', label: '手机号', name: 'phone' }],
    };
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: resultWithPhone });

    const output = await getFormTool().execute('call-1', {});
    const text = (output.content[0] as { text: string }).text;

    expect(text).toContain('13812345678');
  });

  it('still hands the unredacted structured data to the UI via details', async () => {
    loadRedactionSettings.mockResolvedValueOnce(defaultRedactionSettings());
    const resultWithPhone: GetFormResult = {
      ...RESULT,
      fields: [{ ...RESULT.fields[0], value: '13812345678', label: '手机号', name: 'phone' }],
    };
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: resultWithPhone });

    const output = await getFormTool().execute('call-1', {});

    expect(output.details).toMatchObject({ fields: [{ fieldId: 'f1', value: '13812345678' }] });
  });
});

function fillFormTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_fill_form');
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

  it('surfaces a not_found submit outcome instead of staying silent', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: {
        outcomes: [{ fieldId: 'f1', status: 'ok' }],
        submitted: { fieldId: 'f9', status: 'not_found' },
      },
    });
    const output = await fillFormTool().execute('call-1', {
      fields: [{ fieldId: 'f1', value: 'x' }],
      submit: { fieldId: 'f9' },
    });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('提交按钮');
    expect(text).toContain('f9');
    expect(text).toContain('not_found');
  });
});

function scrollTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_scroll');
  if (!tool) throw new Error('browser_scroll 未注册');
  return tool;
}

describe('browser_scroll', () => {
  it('is registered as a tool', () => {
    expect(scrollTool().name).toBe('browser_scroll');
  });

  it('passes fieldId through to the SCROLL_PAGE payload', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { x: 0, y: 300, scrolledBy: 300, pixelsAbove: 300, pixelsBelow: 300, viewportHeight: 400, status: 'ok' },
    });
    await scrollTool().execute('call-1', { fieldId: 's1', y: 300 });
    expect(sendMessage).toHaveBeenCalledWith('SCROLL_PAGE', { fieldId: 's1', y: 300 }, 1);
  });

  it('tells the model to re-read the form when the handle table is stale', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { x: 0, y: 0, scrolledBy: 0, pixelsAbove: 0, pixelsBelow: 0, viewportHeight: 0, status: 'not_found', fieldsTableStale: true },
    });
    await expect(scrollTool().execute('call-1', { fieldId: 's1' })).rejects.toThrow('browser_get_form');
  });

  it('throws when the fieldId does not resolve (not_found, table present)', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { x: 0, y: 0, scrolledBy: 0, pixelsAbove: 0, pixelsBelow: 0, viewportHeight: 0, status: 'not_found' },
    });
    await expect(scrollTool().execute('call-1', { fieldId: 's1' })).rejects.toThrow();
  });
});

describe('多标签页：工具目标随 session.currentTabId 变化', () => {
  it('browser_read_page 使用调用时刻的 session.currentTabId，而不是创建工具集时的值', async () => {
    const session = createTabSession(1);
    const tool = createBrowserTools(session).find((candidate) => candidate.name === 'browser_read_page')!;

    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { title: 'A', url: 'https://a.example.com', lang: 'en', length: 1, text: 'a' },
    });
    await tool.execute('call-1', {});
    expect(sendMessage).toHaveBeenLastCalledWith('EXTRACT_PAGE', undefined, 1);

    session.openAndSwitch({ id: 2 });

    sendMessage.mockResolvedValueOnce({
      id: '2',
      ok: true,
      data: { title: 'B', url: 'https://b.example.com', lang: 'en', length: 1, text: 'b' },
    });
    await tool.execute('call-2', {});
    expect(sendMessage).toHaveBeenLastCalledWith('EXTRACT_PAGE', undefined, 2);
  });

  it('browser_click 与 browser_navigate 同样跟随 currentTabId', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const clickTool = createBrowserTools(session).find((c) => c.name === 'browser_click')!;
    const navigateTool = createBrowserTools(session).find((c) => c.name === 'browser_navigate')!;

    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: { status: 'ok' } });
    await clickTool.execute('call-1', { fieldId: 'f1' });
    expect(sendMessage).toHaveBeenLastCalledWith('CLICK_ELEMENT', { fieldId: 'f1' }, 2);

    sendMessage.mockResolvedValueOnce({ id: '2', ok: true, data: { url: 'https://c.example.com' } });
    await navigateTool.execute('call-2', { url: 'https://c.example.com' });
    expect(sendMessage).toHaveBeenLastCalledWith('NAVIGATE_TAB', { url: 'https://c.example.com' }, 2);
  });

  it('browser_navigate 成功后刷新 tracked 列表里该 tab 的标题/URL，不留旧值（最终审查 Important #7）', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2, title: 'Stale Title', url: 'https://stale.example.com' });
    const navigateTool = createBrowserTools(session).find((c) => c.name === 'browser_navigate')!;

    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { url: 'https://fresh.example.com', title: 'Fresh Title' },
    });
    await navigateTool.execute('call-1', { url: 'https://fresh.example.com' });

    expect(session.currentTabId).toBe(2); // 没有切换目标，还是同一个 tab
    expect(session.trackedTabs).toContainEqual({ id: 2, title: 'Fresh Title', url: 'https://fresh.example.com' });
  });
});

describe('多标签页编排工具：browser_open_tab / browser_switch_tab / browser_close_tab', () => {
  function toolFor(session: ReturnType<typeof createTabSession>, name: string) {
    const tool = createBrowserTools(session).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} 未注册`);
    return tool;
  }

  it('browser_open_tab 把 OPEN_NEW_TAB 发给 session.panelTabId（不是 currentTabId），成功后调用 session.openAndSwitch', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 }); // currentTabId 变成 2，panelTabId 仍是 1
    const tool = toolFor(session, 'browser_open_tab');

    sendMessage.mockClear();
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { id: 3, url: 'https://example.com', title: 'Example' },
    });
    await tool.execute('call-1', { url: 'https://example.com' });

    expect(sendMessage).toHaveBeenCalledWith('OPEN_NEW_TAB', { url: 'https://example.com' }, 1);
    expect(session.currentTabId).toBe(3);
    expect(session.trackedTabs).toContainEqual({ id: 3, url: 'https://example.com', title: 'Example' });
  });

  it('browser_close_tab: 关闭面板自己的 tab 时本地校验直接短路，never 调用 sendMessage', async () => {
    const session = createTabSession(1);
    const tool = toolFor(session, 'browser_close_tab');
    sendMessage.mockClear();

    await expect(tool.execute('call-1', { tabId: 1 })).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('browser_close_tab: 关闭一个未追踪的 tab 时本地校验直接短路，never 调用 sendMessage', async () => {
    const session = createTabSession(1);
    const tool = toolFor(session, 'browser_close_tab');
    sendMessage.mockClear();

    await expect(tool.execute('call-1', { tabId: 999 })).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('browser_close_tab: 关闭一个已追踪的 tab 会调用 CLOSE_TAB，成功后目标从 trackedTabs 移除', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const tool = toolFor(session, 'browser_close_tab');

    sendMessage.mockClear();
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: { closed: true, tabId: 2 } });
    await tool.execute('call-1', { tabId: 2 });

    expect(sendMessage).toHaveBeenCalledWith('CLOSE_TAB', undefined, 2);
    expect(session.isTracked(2)).toBe(false);
    expect(session.currentTabId).toBe(1); // 关掉的正好是 current，自动回退面板 tab
  });

  it('browser_switch_tab: 切到未追踪的 tab 直接抛错，不发送任何消息', async () => {
    const session = createTabSession(1);
    const tool = toolFor(session, 'browser_switch_tab');
    sendMessage.mockClear();

    await expect(tool.execute('call-1', { tabId: 999 })).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('browser_switch_tab: 切到已追踪的 tab 成功，且从不发送任何消息（纯内存操作）', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const tool = toolFor(session, 'browser_switch_tab');
    sendMessage.mockClear();

    await tool.execute('call-1', { tabId: 1 });

    expect(session.currentTabId).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('browser_list_tabs：只读返回 tracked 列表快照', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2, title: 'B' });
    const tool = toolFor(session, 'browser_list_tabs');
    sendMessage.mockClear();

    const output = await tool.execute('call-1', {});

    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('2');
    expect(text).toContain('B');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
