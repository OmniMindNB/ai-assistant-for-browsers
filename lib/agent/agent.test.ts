// lib/agent/agent.test.ts
const sendMessageSpy = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessageSpy(...args) };
});

// 测试环境的 browser 全局桩只有 storage.local（见 lib/test-setup.ts），没有 storage.session——
// 真实实现 getFormFieldsForTab 会读它。直接 mock 掉这一层，让「fieldId 定位到子帧」的用例
// 能确定性地控制查表结果，而不必真去搭一个 storage.session 桩。
const getFormFieldsForTabSpy = vi.fn();
vi.mock('./tab-form-fields', async () => {
  const actual = await vi.importActual<typeof import('./tab-form-fields')>('./tab-form-fields');
  return { ...actual, getFormFieldsForTab: (...args: unknown[]) => getFormFieldsForTabSpy(...args) };
});

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
  AfterToolCallContext,
  AgentMessage,
  BeforeToolCallContext,
  PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
import type { ProviderConfig } from '@/lib/settings';
import {
  buildSubmitIntentProbePayload,
  createBrowserAgentOptions,
  createModel,
  selectStreamFn,
  CONTEXT_RECUT_TARGET,
  MAX_CONTEXT_MESSAGES,
} from './agent';
import { DEFAULT_WRITE_TOOL_CALL_BUDGET } from './system-prompt';
import {
  CONTEXT_RECUT_TARGET_CHARS,
  IMAGE_CHAR_EQUIVALENT,
  MAX_CONTEXT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  contextCostChars,
} from './context-budget';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';
import { createTabSession, type TabSessionController } from './tab-session';
import { describeToolActivity } from './activity-description';
import type { BrowserAgentTool } from './tools';

const baseProvider: ProviderConfig = {
  id: 'p-1',
  name: 'Test',
  baseURL: 'https://example.com/v1',
  apiKey: 'key',
  model: 'test-model',
};

function beforeContext(name: string, args: unknown): BeforeToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
  } as unknown as BeforeToolCallContext;
}

function afterContext(
  name: string,
  args: unknown,
  isError: boolean,
  details: Record<string, unknown> = {},
): AfterToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
    result: { content: [{ type: 'text', text: isError ? 'failed' : 'ok' }], details },
    isError,
  } as unknown as AfterToolCallContext;
}

function textOnlyMessage(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolCallStillPendingMessage(name: string) {
  return { content: [{ type: 'toolCall', id: `${name}-id`, name, arguments: {} }] };
}

function runtimeOptions(
  overrides: { onConfirm?: () => Promise<boolean>; onContextTruncated?: () => void; messages?: AgentMessage[] } = {},
) {
  return createBrowserAgentOptions({
    provider: baseProvider,
    tabId: 1,
    tools: [],
    readToolCallBudget: 1,
    writeToolCallBudget: 2,
    steer: vi.fn(),
    ...overrides,
  });
}

describe('createBrowserAgentOptions tool policy hooks', () => {
  it('expands to the write budget when an auto-allowed write starts', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    const hooks = runtimeOptions();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#menu' }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#menu' }, false));
    // 写档在「已用 1 次」之上追加 2 次，总上限 3：写入开始后仍拿得到完整的写入额度。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('3'),
    });
  });

  it('expands to the write budget only after confirmation succeeds', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = runtimeOptions({ onConfirm: async () => true });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit' }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#submit' }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('3'),
    });
  });

  it('keeps the read budget when confirmation is denied', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = runtimeOptions({ onConfirm: async () => false });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit' }))).toMatchObject({
      block: true,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('1'),
    });
  });

  it('removes tools for one final turn and then stops', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 1,
      writeToolCallBudget: 2,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);
    expect(next?.context?.tools).toEqual([]);
    expect(next?.context?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('工具调用预算已经用完'),
    });
    expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(false);
    expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(true);
    expect(steer).not.toHaveBeenCalled();
  });

  it('blocks a third identical failed execution before permission or execution', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { selector: '.x', limit: 2 }, true));
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { limit: 2, selector: '.x' }, true));
    expect(
      await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: '.x', limit: 2 })),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining('连续失败两次'),
    });
  });

  it('counts two detected-submit denials toward bounded block termination', async () => {
    sendMessageSpy
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } })
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => false,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-a' }))).toMatchObject({
      block: true,
    });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [] } } as unknown as PrepareNextTurnContext),
    ).toBeUndefined();
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-b' }))).toMatchObject({
      block: true,
    });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [{}] } } as unknown as PrepareNextTurnContext),
    ).toMatchObject({ context: { tools: [] } });
  });

  it('counts dossier guard blocks toward bounded block termination', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    // read_page 巡检后还能补查一次，所以两次被拦都用 get_page_meta（巡检里已有全部元信息）。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}))).toMatchObject({ block: true });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [] } } as unknown as PrepareNextTurnContext),
    ).toBeUndefined();
    expect(await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}))).toMatchObject({ block: true });
    expect(
      await hooks.prepareNextTurnWithContext?.({ context: { messages: [], tools: [{}] } } as unknown as PrepareNextTurnContext),
    ).toMatchObject({ context: { tools: [] } });
  });

  // 会让这个用例失败的 production 改动：巡检后的补查限额不区分任务类型——专注阅读这类
  // 改页面的任务开始写之后，还要定位下一批元素，却被"该工具已经补查过一次"卡死
  // （ref: 2026-09-15 专注阅读把 query_dom 连拦四次、零写入收尾的事故）。
  it('lifts the post-dossier follow-up limit once a write has been attempted', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { selector: 'aside' }, false));
    // 对照组：还没写过，同一工具的第二次补查照旧被拦。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: 'nav' }))).toMatchObject({
      block: true,
    });
    expect(
      await hooks.beforeToolCall?.(beforeContext('browser_set_style', { selector: 'aside', styles: { display: 'none' } })),
    ).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_set_style', { selector: 'aside', styles: { display: 'none' } }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: 'nav' }))).toBeUndefined();
  });

  // 会让这个用例失败的 production 改动：拦截理由和巡检完成的 steer 只说"停止调用工具、给出
  // 最终回答"，改页面的任务读到它就不再尝试写工具，直接编一段完成总结。
  it('tells the model it may still act with write tools after the dossier', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    expect((steer.mock.calls.at(-1)?.[0] as { content: string }).content).toContain('写工具');
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { selector: 'aside' }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: 'nav' }))).toMatchObject({
      block: true,
      reason: expect.stringContaining('写工具'),
    });
  });
});

// 2026-09-30 事故：划词问答第 6 步 browser_open_tab 打开 install.sh，只因它在 WRITE_TOOL_NAMES 里，
// 就在读档 20 次之上又批下 40 次写档，本该 20 次收尾的问答一路跑到 41 次调用、83 条消息。
// 写档是给"改页面"留的余量；换页面、开关/切换标签页只决定在哪儿，不是在页面上动手，
// 读档内照常可用、照常记账，但不解锁写档。
describe('页面位置类工具不解锁写预算', () => {
  const LOCATION_CALLS: [string, Record<string, unknown>][] = [
    ['browser_navigate', { url: 'https://example.com/a' }],
    ['browser_go_back', {}],
    ['browser_open_tab', { url: 'https://example.com/b' }],
    ['browser_switch_tab', { tabId: 1 }],
    ['browser_close_tab', { tabId: 1 }],
  ];

  it.each(LOCATION_CALLS)('%s 之后仍按读档上限收口', async (name, args) => {
    const hooks = runtimeOptions(); // 读档 1、写档 2
    expect(await hooks.beforeToolCall?.(beforeContext(name, args))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext(name, args, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('1'),
    });
  });

  it.each(LOCATION_CALLS)('读档用尽时 %s 不能借"边界写入"的豁免闯过去', async (name, args) => {
    const hooks = runtimeOptions();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));

    expect(await hooks.beforeToolCall?.(beforeContext(name, args))).toMatchObject({ block: true });
  });

  it('换页之后真正动手的写操作照常解锁写档，额度从那一刻起算', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 2,
      writeToolCallBudget: 2,
      steer: vi.fn(),
    });
    await hooks.beforeToolCall?.(beforeContext('browser_navigate', { url: 'https://example.com/form' }));
    await hooks.afterToolCall?.(afterContext('browser_navigate', { url: 'https://example.com/form' }, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#go' }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#go' }, false));
    // 写档在「已用 1 次」之上追加 2 次，总上限 3。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('3'),
    });
  });
});

// 同一事故的另一半：第 5 步巡检、第 6 步 browser_open_tab，"尝试过写"的标志就此置真，
// 巡检后的补查限额整个失效，之后 read_page 6 次、get_html 7 次全被放行。那道豁免是给
// "改页面的任务要继续定位元素"留的；换页面、开关标签页不是在改页面，不该触发它。
describe('页面位置类工具不算"尝试过写"', () => {
  const LOCATION_WRITES: [string, Record<string, unknown>][] = [
    ['browser_navigate', { url: 'https://example.com/a' }],
    ['browser_go_back', {}],
    ['browser_open_tab', { url: 'https://example.com/b' }],
    ['browser_close_tab', { tabId: 1 }],
  ];

  function hooksWith(steer = vi.fn()) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 20,
      writeToolCallBudget: 40,
      steer,
    });
  }

  it.each(LOCATION_WRITES)('巡检之后 %s 不解除补查限额', async (name, args) => {
    const hooks = hooksWith();
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    expect(await hooks.beforeToolCall?.(beforeContext(name, args))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext(name, args, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('巡检'),
    });
  });

  it.each(LOCATION_WRITES)('%s 之后拿到句柄却没动手就停下，照常补一轮', async (name, args) => {
    const steer = vi.fn();
    const hooks = hooksWith(steer);
    await hooks.beforeToolCall?.(beforeContext(name, args));
    await hooks.afterToolCall?.(afterContext(name, args, false));
    await hooks.afterToolCall?.(afterContext('browser_get_form', {}, false));

    await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('表单有这些字段'),
      context: { messages: [], tools: [{ name: 'browser_fill_form' }] },
    } as unknown as PrepareNextTurnContext);

    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('fieldId') }));
  });
});

// 2026-09-30 事故：用户问"两种安装方式的区别"，模型误调了巡检。巡检完成的 steer 和补查拦截理由
// 只给了两种意图——问页面实现 / 要改页面——问答任务哪边都不沾，模型只能往"页面实现"上套，
// 最后答成了 CSS @layer 和导航脚本。第三种意图（问的是别的，巡检只是选错了工具）必须有出口：
// 按原问题作答，且需要正文时读得到——巡检里的正文只截了 textMaxChars，一刀禁掉 read_page
// 会把内容问答卡在信息不足的状态。
describe('巡检之后仍然回到用户的原问题', () => {
  function hooksWith(steer = vi.fn()) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 20,
      writeToolCallBudget: 40,
      steer,
    });
  }

  it('巡检完成的 steer 给"问的不是页面实现"留了出口：按原问题作答、可以读正文', async () => {
    const steer = vi.fn();
    const hooks = hooksWith(steer);
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));

    const content = (steer.mock.calls.at(-1)?.[0] as { content: string }).content;
    expect(content).toContain('原始问题');
    expect(content).toContain('browser_read_page');
  });

  it('宽泛资料的拦截理由指向用户的原始问题，而不是"基于巡检结果回答"', async () => {
    const hooks = hooksWith();
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}))).toMatchObject({
      block: true,
      reason: expect.stringContaining('原始问题'),
    });
  });

  it('补查额度用尽的拦截理由同样指向用户的原始问题', async () => {
    const hooks = hooksWith();
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    await hooks.afterToolCall?.(afterContext('browser_query_dom', { selector: 'main' }, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: 'nav' }))).toMatchObject({
      block: true,
      reason: expect.stringContaining('原始问题'),
    });
  });

  it('巡检之后 read_page 可以补查一次，第二次拦下', async () => {
    const hooks = hooksWith();
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', { offset: 4000 }))).toBeUndefined();
    await hooks.afterToolCall?.(afterContext('browser_read_page', { offset: 4000 }, false));
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', { offset: 8000 }))).toMatchObject({
      block: true,
    });
  });

  // 事故里模型正是先 read_page、再误调巡检：巡检结果一到，前一份正文就被压成一句话摘要。
  // "每个工具补查一次"若连巡检之前的调用也算进去，这一次补查恰恰在最需要的场景里拿不到。
  it('巡检之前读过正文，不影响巡检之后那一次 read_page 补查', async () => {
    const hooks = hooksWith();
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));

    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', { offset: 4000 }))).toBeUndefined();
  });
});

describe('createBrowserAgentOptions task outcome forcing', () => {
  const reportTaskOutcomeTool = { name: 'report_task_outcome' } as unknown as BrowserAgentTool;

  function hooksWithTool(overrides: { onTaskOutcome?: (outcome: unknown) => void; steer?: (m: AgentMessage) => void } = {}) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: overrides.steer ?? vi.fn(),
      onTaskOutcome: overrides.onTaskOutcome,
    });
  }

  it('does not force a closing turn when no write tool ran this run', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not force a closing turn while the model still has pending tool calls', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('forces exactly one closing turn restricted to report_task_outcome after a write with no outcome reported', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    const first = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(first?.context?.tools).toEqual([reportTaskOutcomeTool]);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0][0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('report_task_outcome'),
    });

    // 模型在被强制的这一轮仍然没有调用，也只补一次，不会无限重试。
    const second = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('still nothing'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(second).toBeUndefined();
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('does not force a closing turn once report_task_outcome has already been called', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));

    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not force a closing turn when report_task_outcome is not among the available tools', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  // 预算耗尽的那一轮恰恰是最需要 failure 徽标的一轮：既有分支原来无条件返回 tools: []，
  // 模型在唯一一次收尾轮里根本没有 report_task_outcome 可调（ref: 最终审查 Important）。
  it('offers report_task_outcome during the final turn when the budget is exhausted and a report is still owed', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer,
    });
    // 写工具跑过一次，预算随即耗尽（读=写预算=1）。
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([reportTaskOutcomeTool]);
    const content = (next?.context?.messages.at(-1) as { content: string }).content;
    expect(content).toContain('工具调用预算已经用完');
    expect(content).toContain('report_task_outcome');
  });

  // 单次触发：预算分支已经把 outcomeForceAttempted 置位，之后 else if 分支不会再补一次。
  it('does not force a second closing turn after the budget branch already offered the tool', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    // 阶段机已经离开 active，prepareFinalResponse 不会再返回 true；此时若 outcomeForceAttempted
    // 没被置位，下面这次调用会走 else if 分支再补一轮 steer。
    const second = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('still nothing'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(second).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  // 只读运行不欠汇报：收尾指令里不能混进 report_task_outcome 那句；但因为一次写都没成功过，
  // 要带上"不要声称已经修改页面"的提示（写过的运行不带，见下一个用例的逐字断言）。
  it('keeps the report clause out of the budget-exhaustion branch when no report is owed', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 2,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 只读，没有写工具跑过
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_read_page'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([]);
    const content = (next?.context?.messages.at(-1) as { content: string }).content;
    expect(content).toBe(
      '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。'
        + '注意：本次运行没有成功执行任何页面修改操作。如果用户要求的是修改页面，必须如实说明尚未完成以及卡在哪里，不要声称已经隐藏、修改或调整了任何内容。',
    );
    expect(content).not.toContain('report_task_outcome');
  });

  it('keeps the budget-exhaustion branch byte-identical when the outcome was already reported', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([]);
    expect((next?.context?.messages.at(-1) as { content: string }).content).toBe(
      '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。',
    );
  });

  // 连续被阻断的收尾分支走的是同一段代码，同样要在欠汇报时把工具递回去。
  it('offers report_task_outcome on the consecutive-block final turn when a report is still owed', async () => {
    sendMessageSpy
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } })
      .mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => false,
    });
    // 先成功跑一次写工具，这样确实欠一次汇报。
    await hooks.afterToolCall?.(afterContext('browser_modify_dom', { selector: '#a' }, false));
    // 再连续两次被拒绝（pre-execution block），触发「连续被阻止」收尾。
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-a' }));
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-b' }));

    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([reportTaskOutcomeTool]);
    const content = (next?.context?.messages.at(-1) as { content: string }).content;
    expect(content).toContain('工具调用连续被阻止');
    expect(content).toContain('report_task_outcome');
  });

  // 会让这个用例失败的 production 改动：收尾轮只说"基于已有结果给出最终回答"，一次写都没
  // 成功过的运行照样套用提示词里"说明隐藏了什么、调整了什么"的格式，编出一段完成总结。
  it('forbids claiming page changes on the final turn when no write ever ran', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_inspect_page_implementation', {}, false));
    await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}));
    await hooks.beforeToolCall?.(beforeContext('browser_get_page_meta', {}));

    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_get_page_meta'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);

    expect(next?.context?.tools).toEqual([]);
    const content = (next?.context?.messages.at(-1) as { content: string }).content;
    expect(content).toContain('工具调用连续被阻止');
    expect(content).toContain('没有成功执行任何页面修改');
  });

  it('never blocks report_task_outcome on an exhausted budget', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 1,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 预算耗尽
    // 对照组：普通只读工具此时确实被硬阻断。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({ block: true });
    // report_task_outcome 完全豁免预算 preflight。
    expect(
      await hooks.beforeToolCall?.(beforeContext('report_task_outcome', { outcome: 'failure', reason: '预算用尽。' })),
    ).toBeUndefined();
  });

  it('does not consume a budget slot when report_task_outcome executes', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 2,
      writeToolCallBudget: 2,
      steer: vi.fn(),
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 1/2
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));
    // 如果上面那次算进了预算，这里就是 2/2 已耗尽，只读工具会被阻断。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: '.x' }))).toBeUndefined();
  });

  it('threads onTaskOutcome through to the default report_task_outcome tool', async () => {
    const onTaskOutcome = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onTaskOutcome,
    });
    const tool = (hooks.initialState!.tools as BrowserAgentTool[]).find((t) => t.name === 'report_task_outcome');
    expect(tool).toBeDefined();
    await tool!.execute('call-1', { outcome: 'partial', reason: '只完成了一半。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'partial', reason: '只完成了一半。' });
  });
});

// 实测（2026-09-14，glm-5.3 答题页）：get_form → get_html → query_dom → get_form → get_html 连读 15 次，
// 一次写都没做就以纯文本结束了本轮。既有的收尾补调只在"写过之后"才生效，这种早停没有任何兜底。
// 口径刻意收窄：只有拿过字段句柄（get_form / find_text——它们存在的意义就是喂给后续写操作）
// 却从未尝试写入时才补一轮，纯问答（总结本页、问实现）不受影响，不多等一次模型往返。
describe('createBrowserAgentOptions 拿到句柄却未动手就停下时补一轮', () => {
  function hooks(steer: (m: AgentMessage) => void, readToolCallBudget = 20) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget,
      writeToolCallBudget: 40,
      steer,
    });
  }

  function endTurn(h: ReturnType<typeof hooks>, message: unknown = textOnlyMessage('分析完了')) {
    return h.prepareNextTurnWithContext?.({
      message,
      context: { messages: [], tools: [{ name: 'browser_fill_form' }] },
    } as unknown as PrepareNextTurnContext);
  }

  it('get_form 之后又读了几次、没写就以纯文本收尾：steer 一次让它继续，工具表不动', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    await h.afterToolCall?.(afterContext('browser_get_html', { selector: 'form' }, false));
    await h.afterToolCall?.(afterContext('browser_query_dom', { selector: 'form' }, false));

    expect(await endTurn(h)).toBeUndefined();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0][0]).toMatchObject({ role: 'user', content: expect.stringContaining('fieldId') });
  });

  it('browser_find_text 同样算拿到了句柄', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_find_text', { text: '提交' }, false));
    await endTurn(h);
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('每次运行最多补一次，模型补过之后仍不动手也不再追', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    await endTurn(h);
    await endTurn(h, textOnlyMessage('这只是问答'));
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('get_form 本身失败时不补：模型的文字是在解释失败，不是早停', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, true));
    await endTurn(h);
    expect(steer).not.toHaveBeenCalled();
  });

  it('尝试过写入但失败时不补', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    expect(await h.beforeToolCall?.(beforeContext('browser_fill_form', { fields: [] }))).toBeUndefined();
    await h.afterToolCall?.(afterContext('browser_fill_form', { fields: [] }, true));
    await endTurn(h);
    expect(steer).not.toHaveBeenCalled();
  });

  it('写入在执行前就被闸门拦下时也不补（被拦的调用不经过 afterToolCall）', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    // 对根容器 remove 是 permissions.ts 的硬拒绝，走 beforeToolCall 的阻断分支。
    // （不用 javascript: 导航做例子：位置类工具本来就不算"尝试过写"，见「页面位置类工具不算"尝试过写"」那组。）
    expect(
      await h.beforeToolCall?.(beforeContext('browser_modify_dom', { selector: 'body', action: 'remove' })),
    ).toMatchObject({ block: true });
    await endTurn(h);
    expect(steer).not.toHaveBeenCalled();
  });

  it('向用户提过问（ask_user）之后不补：停下可能正是用户的回答', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    await h.afterToolCall?.(afterContext('ask_user', { question: '要提交吗？' }, false));
    await endTurn(h);
    expect(steer).not.toHaveBeenCalled();
  });

  it('本轮消息里还有待执行的工具调用时不补', async () => {
    const steer = vi.fn();
    const h = hooks(steer);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    await endTurn(h, toolCallStillPendingMessage('browser_get_html'));
    expect(steer).not.toHaveBeenCalled();
  });

  it('预算耗尽的收尾轮优先，不叠加补一轮', async () => {
    const steer = vi.fn();
    const h = hooks(steer, 1);
    await h.afterToolCall?.(afterContext('browser_get_form', {}, false));
    expect(await endTurn(h)).toMatchObject({ context: { tools: [] } });
    await endTurn(h);
    expect(steer).not.toHaveBeenCalled();
  });
});

describe('执行期遮罩', () => {
  const overlayOptions = (onOverlay: () => void, approve: boolean) =>
    createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      steer: () => {},
      onConfirm: async () => approve,
      onOverlay,
    });

  it('自动导航会通知一次遮罩打开', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_navigate', { url: 'https://example.com/next' }), undefined);

    expect(onOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, label: expect.any(String) }),
      1,
    );
  });

  it('非提交自动点击不弹确认并打开遮罩', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    const onConfirm = vi.fn();
    const onOverlay = vi.fn();
    const options = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      steer: () => {},
      onConfirm,
      onOverlay,
    });

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#menu', index: 0 }), undefined);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true }), 1);
  });

  it('只读工具不触发遮罩', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_read_page', {}), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });

  it('用户拒绝确认时不打开遮罩', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: true } });
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, false);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#submit', index: 0 }), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });

  // 跨帧写操作：fieldId 定位到子帧（句柄 frameId !== 0）时，顶层遮罩不该显示模拟光标——
  // content script 只在顶层跑，收不到子帧派发的 runi:cursor-move（ref: 设计文档 §6）。
  it('fieldId 定位到子帧时遮罩关闭光标', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    getFormFieldsForTabSpy.mockResolvedValueOnce({
      url: 'https://example.com',
      fields: {
        f1: {
          path: [{ kind: 'selector', selector: 'button', index: 0 }],
          expect: { tag: 'button' },
          sensitive: false,
          kind: 'submit',
          frameId: 3,
        },
      },
    });
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_click', { fieldId: 'f1' }), undefined);

    expect(getFormFieldsForTabSpy).toHaveBeenCalledWith(1);
    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true, cursor: false }), 1);
  });

  it('fieldId 定位到主帧（frameId: 0）时遮罩保留光标', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    getFormFieldsForTabSpy.mockResolvedValueOnce({
      url: 'https://example.com',
      fields: {
        f1: {
          path: [{ kind: 'selector', selector: 'button', index: 0 }],
          expect: { tag: 'button' },
          sensitive: false,
          kind: 'submit',
          frameId: 0,
        },
      },
    });
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_click', { fieldId: 'f1' }), undefined);

    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true, cursor: true }), 1);
  });

  it('browser_fill_form 的 submit.fieldId 定位到子帧时遮罩关闭光标', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    getFormFieldsForTabSpy.mockResolvedValueOnce({
      url: 'https://example.com',
      fields: {
        f9: {
          path: [{ kind: 'selector', selector: 'button', index: 0 }],
          expect: { tag: 'button' },
          sensitive: false,
          kind: 'submit',
          frameId: 5,
        },
      },
    });
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(
      beforeContext('browser_fill_form', { fields: [], submit: { fieldId: 'f9' } }),
      undefined,
    );

    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true, cursor: false }), 1);
  });

  it('查表失败（如 storage.session 不可用）时默认保留光标，不影响写操作放行', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    getFormFieldsForTabSpy.mockRejectedValueOnce(new Error('boom'));
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    const result = await options.beforeToolCall!(beforeContext('browser_click', { fieldId: 'f1' }), undefined);

    expect(result).toBeUndefined();
    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true, cursor: true }), 1);
  });

  it('裸选择器写操作（无 fieldId）不查表，遮罩保留光标', async () => {
    getFormFieldsForTabSpy.mockClear();
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { isSubmit: false } });
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#menu', index: 0 }), undefined);

    expect(getFormFieldsForTabSpy).not.toHaveBeenCalled();
    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: true, cursor: true }), 1);
  });
});

// ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.2 —
// browser_navigate/browser_open_tab 自己的结果文案已经告诉模型跳到哪了；这里只补
// browser_click / browser_fill_form / browser_type 隐式触发的导航，此前对模型完全不可见。
describe('写工具结果里的页面位置', () => {
  function hooksWithSteer(steer: (m: AgentMessage) => void = vi.fn()) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer,
    });
  }

  /** afterToolCall 追加的那一行；没有追加时返回 undefined。 */
  function locationLine(result: unknown): string | undefined {
    const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
    return content?.find((part) => part.text?.startsWith('[页面位置]'))?.text;
  }

  async function withBaseline(url = 'https://example.com/a') {
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);
    await hooks.afterToolCall?.(afterContext('browser_navigate', { url }, false, { url }));
    return { hooks, steer };
  }

  it('browser_navigate 从自身结果里静默记录基线，不额外查询 URL', async () => {
    sendMessageSpy.mockClear();
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);

    const result = await hooks.afterToolCall?.(
      afterContext('browser_navigate', { url: 'https://example.com/a' }, false, { url: 'https://example.com/a' }),
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(locationLine(result)).toBeUndefined();
  });

  it('首次写之前在 beforeToolCall 里记下基线，第一次点击就能区分跳没跳', async () => {
    sendMessageSpy.mockImplementation(async (type: string) =>
      type === 'GET_TAB_URL' ? { ok: true, data: { url: 'https://example.com/list' } } : { ok: true, data: { isSubmit: false } },
    );
    try {
      const hooks = hooksWithSteer();
      expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#card' }))).toBeUndefined();
      sendMessageSpy.mockImplementation(async (type: string) =>
        type === 'GET_TAB_URL' ? { ok: true, data: { url: 'https://example.com/detail' } } : { ok: true, data: {} },
      );
      const result = await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#card' }, false));
      expect(locationLine(result)).toContain('从 "https://example.com/list" 跳转到 "https://example.com/detail"');
    } finally {
      sendMessageSpy.mockReset();
    }
  });

  it('基线未知时只报当前地址，不声称跳了或没跳', async () => {
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/first' } });
    const steer = vi.fn();
    const hooks = hooksWithSteer(steer);

    const result = await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    expect(locationLine(result)).toBe('[页面位置] 当前地址："https://example.com/first"。');
    expect(steer).not.toHaveBeenCalled();
  });

  it('点击导致 URL 变化时，写进工具结果并等待页面稳定后才把控制权交还给模型', async () => {
    vi.useFakeTimers();
    try {
      const { hooks, steer } = await withBaseline();
      sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/b' } });

      let settled = false;
      const pending = hooks.afterToolCall
        ?.(afterContext('browser_click', { selector: '#a' }, false))
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      expect(settled).toBe(true);
      // 原有结果保留在前，位置行追加在后。
      expect((result as { content: { text: string }[] }).content[0].text).toBe('ok');
      expect(locationLine(result)).toContain('从 "https://example.com/a" 跳转到 "https://example.com/b"');
      expect(steer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('点击后 URL 未变化：明确说没跳，免得模型再调 browser_get_active_tab，且不等待', async () => {
    const { hooks } = await withBaseline();
    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/a' } });

    const result = await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    expect(locationLine(result)).toContain('地址未变化，仍为 "https://example.com/a"');
    expect(locationLine(result)).toContain('browser_get_active_tab');
  });

  it('browser_fill_form 与 browser_type 只在地址真的变了时才追加', async () => {
    const { hooks } = await withBaseline();

    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/a' } });
    const unchanged = await hooks.afterToolCall?.(afterContext('browser_fill_form', { fields: [] }, false));
    expect(locationLine(unchanged)).toBeUndefined();

    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/submitted' } });
    const filled = await hooks.afterToolCall?.(afterContext('browser_fill_form', { fields: [] }, false));
    expect(locationLine(filled)).toContain('https://example.com/submitted');

    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/typed' } });
    const typed = await hooks.afterToolCall?.(afterContext('browser_type', { fieldId: 'f1', text: 'x' }, false));
    expect(locationLine(typed)).toContain('从 "https://example.com/submitted" 跳转到 "https://example.com/typed"');
  });

  // browser_press_key 的 Enter 可以像 browser_click 一样触发隐式表单提交，因此必须
  // 同样纳入 NAVIGATION_WATCH_TOOLS（ref: 最终评审 finding 1），并且没跳也要说。
  it('browser_press_key（回车提交）与点击同样处理', async () => {
    const { hooks } = await withBaseline();

    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/pressed' } });
    const pressed = await hooks.afterToolCall?.(afterContext('browser_press_key', { fieldId: 'f1', key: 'Enter' }, false));
    expect(locationLine(pressed)).toContain('https://example.com/pressed');

    sendMessageSpy.mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com/pressed' } });
    const again = await hooks.afterToolCall?.(afterContext('browser_press_key', { fieldId: 'f1', key: 'Enter' }, false));
    expect(locationLine(again)).toContain('地址未变化');
  });

  it('工具执行失败时不查询 URL、也不追加位置', async () => {
    sendMessageSpy.mockClear();
    const hooks = hooksWithSteer();

    const result = await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, true));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(locationLine(result)).toBeUndefined();
  });
});

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantToolCallMessage(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  } as unknown as AgentMessage;
}

function toolResultMessage(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function resultText(message: AgentMessage): string {
  return ((message as unknown as { content: { type: string; text: string }[] }).content[0]).text;
}

// ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.1 —
// 对方每步从 history 重建 prompt，只挂当前这一份浏览器状态；旧的 DOM/HTML dump 完全不进
// 上下文。我们没有强制自评字段，改用已有的 describeToolActivity 一句话摘要作为压缩来源。
describe('上下文压缩：只读工具的历史结果压成一句话摘要', () => {
  it('把更早的只读工具结果压成一句话摘要，只保留最新一份完整内容', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_read_page', {}),
      toolResultMessage('call-1', 'browser_read_page', 'PAGE TEXT A'.repeat(50)),
      assistantToolCallMessage('call-2', 'browser_click', { selector: '#a' }),
      toolResultMessage('call-2', 'browser_click', '已点击 "#a"。'),
      assistantToolCallMessage('call-3', 'browser_read_page', {}),
      toolResultMessage('call-3', 'browser_read_page', 'PAGE TEXT B (current)'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(describeToolActivity('browser_read_page', {}, 'done'));
    expect(resultText(compacted[3])).toBe('已点击 "#a"。');
    expect(resultText(compacted[5])).toBe('PAGE TEXT B (current)');
  });

  it('用工具调用当时的参数生成摘要文案', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_query_dom', { selector: '.old-target' }),
      toolResultMessage('call-1', 'browser_query_dom', 'huge dom dump'),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest page text'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(
      describeToolActivity('browser_query_dom', { selector: '.old-target' }, 'done'),
    );
  });

  it('压缩失败的旧读取结果时保留失败状态', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_get_html', { selector: '#x' }),
      toolResultMessage('call-1', 'browser_get_html', 'error: not found', true),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(describeToolActivity('browser_get_html', { selector: '#x' }, 'failed'));
  });

  it('browser_get_form 的旧结果有专门的摘要文案，不落入通用兜底', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_get_form', {}),
      toolResultMessage('call-1', 'browser_get_form', 'huge form structure dump'),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).not.toBe(describeToolActivity('browser_unknown_tool', {}, 'done'));
    expect(resultText(compacted[1])).toBe(describeToolActivity('browser_get_form', {}, 'done'));
  });

  it('非只读工具的历史结果原样保留，不参与摘要压缩', async () => {
    const hooks = runtimeOptions();
    const longWriteText = 'X'.repeat(500);
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_fill_form', { fields: [] }),
      toolResultMessage('call-1', 'browser_fill_form', longWriteText),
      assistantToolCallMessage('call-2', 'browser_read_page', {}),
      toolResultMessage('call-2', 'browser_read_page', 'latest'),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1])).toBe(longWriteText);
  });

  it('最新一份读取结果超长时仍按 MAX_TOOL_RESULT_CHARS 截断（安全网保留）', async () => {
    const hooks = runtimeOptions();
    // 长度从常量推，不写死：写死的话每次上调 MAX_TOOL_RESULT_CHARS 都会让这个安全网用例
    // 悄悄失效（夹具反而比上限还短），而它恰恰是上限变动时最该继续生效的一个。
    const hugeText = 'A'.repeat(MAX_TOOL_RESULT_CHARS + 10000);
    const messages: AgentMessage[] = [
      assistantToolCallMessage('call-1', 'browser_read_page', {}),
      toolResultMessage('call-1', 'browser_read_page', hugeText),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(resultText(compacted[1]).length).toBeLessThan(hugeText.length);
    expect(resultText(compacted[1])).toContain('已截断');
  });
});

describe('selectStreamFn', () => {
  it('returns browserOpenAIStream when api is undefined (default)', () => {
    expect(selectStreamFn(baseProvider)).toBe(browserOpenAIStream);
  });

  it('returns browserOpenAIStream when api is openai-completions', () => {
    expect(selectStreamFn({ ...baseProvider, api: 'openai-completions' })).toBe(browserOpenAIStream);
  });

  it('returns browserAnthropicStream when api is anthropic-messages', () => {
    expect(selectStreamFn({ ...baseProvider, api: 'anthropic-messages' })).toBe(browserAnthropicStream);
  });
});

describe('createModel', () => {
  it('sets api to openai-completions by default', () => {
    expect(createModel(baseProvider).api).toBe('openai-completions');
  });

  it('sets api to anthropic-messages when configured', () => {
    expect(createModel({ ...baseProvider, api: 'anthropic-messages' }).api).toBe('anthropic-messages');
  });

  it('keeps id/provider/baseUrl derived from the ProviderConfig', () => {
    const model = createModel(baseProvider);
    expect(model.id).toBe('test-model');
    expect(model.provider).toBe('p-1');
    expect(model.baseUrl).toBe('https://example.com/v1');
  });

  it('declares both text and image input support', () => {
    expect(createModel(baseProvider).input).toEqual(['text', 'image']);
  });
});

describe('buildSubmitIntentProbePayload', () => {
  it('builds a fieldId probe payload for browser_click with a fieldId', () => {
    expect(buildSubmitIntentProbePayload('browser_click', { fieldId: 'f7' })).toEqual({
      submitFieldId: 'f7',
      fieldIds: ['f7'],
    });
  });

  it('falls back to selector/index for browser_click without a fieldId', () => {
    expect(buildSubmitIntentProbePayload('browser_click', { selector: '#save', index: 2 })).toEqual({
      selector: '#save',
      index: 2,
    });
  });

  it('keeps the existing fill_form payload shape', () => {
    expect(
      buildSubmitIntentProbePayload('browser_fill_form', {
        fields: [{ fieldId: 'f1' }, { fieldId: 'f2' }],
        submit: { fieldId: 'f9' },
      }),
    ).toEqual({ submitFieldId: 'f9', fieldIds: ['f1', 'f2'] });
  });
});

// 修复前预算是纯硬阻断：模型毫无预警地被挡下。这里在跌到阈值时先软提醒一次，
// 给它自己收尾的机会（ref: lib/agent/tool-policy.ts 的 budgetWarning）。
describe('createBrowserAgentOptions budget warnings', () => {
  function withBudget(steer: (message: AgentMessage) => void, readToolCallBudget: number) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget,
      writeToolCallBudget: readToolCallBudget,
      steer,
    });
  }

  // 预算 8：第 2 次调用后还剩 6（不提醒），第 3 次后剩 5，命中阈值。
  it('steers a warning once the remaining budget hits the threshold', async () => {
    const steer = vi.fn<(message: AgentMessage) => void>();
    const hooks = withBudget(steer, 8);
    for (let i = 0; i < 2; i += 1) await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(steer).not.toHaveBeenCalled();

    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0][0]).toMatchObject({ role: 'user', content: expect.stringContaining('5 次') });
  });

  it('does not repeat the same warning on the next tool call', async () => {
    const steer = vi.fn<(message: AgentMessage) => void>();
    const hooks = withBudget(steer, 8);
    for (let i = 0; i < 4; i += 1) await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    expect(steer).toHaveBeenCalledTimes(1);
  });
});

describe('多标签页：session 可选，且遮罩跟随当前操作目标', () => {
  it('未传 session 时退化为单 tab，行为与改动前一致', async () => {
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
    });
    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#a' }))).toBeUndefined();
  });

  it('切换当前操作 tab 后，遮罩先关旧目标再开新目标', async () => {
    const session = createTabSession(1);
    const onOverlay = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,       tabExists: async () => true,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
      onOverlay,
    });

    // 先批准一次写操作，遮罩在 tab 1 上打开
    await hooks.beforeToolCall?.(beforeContext('browser_navigate', { url: 'https://example.com/a' }));
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }), 1);

    // browser_open_tab 执行后 session.currentTabId 变成 2（工具自己会调用 session.openAndSwitch；
    // 这里手动模拟工具执行完成后的状态，因为 tools 数组是空的 [] ）
    session.openAndSwitch({ id: 2, title: 'Example' });
    await hooks.afterToolCall?.(afterContext('browser_open_tab', { url: 'https://example.com' }, false));

    expect(onOverlay).toHaveBeenCalledWith(expect.objectContaining({ active: false }), 1);
    expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }), 2);
  });

  it('PROBE_CLICK_TARGET 探测使用 session.currentTabId，不是面板绑定的 tabId', async () => {
    sendMessageSpy.mockClear();
    const session = createTabSession(1);
    session.openAndSwitch({ id: 2 });
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,       tabExists: async () => true,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
    });

    await hooks.beforeToolCall?.(beforeContext('browser_click', { fieldId: 'f1' }), undefined);

    expect(sendMessageSpy).toHaveBeenCalledWith(
      'PROBE_CLICK_TARGET',
      expect.objectContaining({ submitFieldId: 'f1' }),
      2,
    );
  });

  it('表单提交意图探测失败时按普通已知操作自动执行', async () => {
    sendMessageSpy.mockRejectedValueOnce(new Error('message channel unavailable'));
    const onConfirm = vi.fn().mockResolvedValue(true);
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm,
    });

    expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#continue' }))).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('检测到的表单提交每次确认，不受目标 tab 或既有批准影响', async () => {
    // 按消息类型应答：批准后的点击还会查一次 GET_TAB_URL 记基线，按顺序排的 once 值会被它吃掉。
    sendMessageSpy.mockImplementation(async (type: string) =>
      type === 'GET_TAB_URL' ? { ok: true, data: { url: 'https://example.com/' } } : { ok: true, data: { isSubmit: true } },
    );
    onTestFinished(() => {
      sendMessageSpy.mockReset();
    });
    const session = createTabSession(1);
    const onConfirm = vi.fn().mockResolvedValue(true);
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,       tabExists: async () => true,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm,
    });

    // 在 tab 1 上批准一次检测到的提交。
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-a' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // browser_open_tab 把当前操作目标切到 tab 2（模拟工具执行后的效果）。
    session.openAndSwitch({ id: 2, title: 'Example' });

    // 同一轮里对 tab 2 的提交仍然必须确认。
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-b' }));
    expect(onConfirm).toHaveBeenCalledTimes(2);

    // 切回 tab 1 后再次提交也必须确认；confirm_always 从不复用决定。
    session.switchTo(1);
    await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#submit-c' }));
    expect(onConfirm).toHaveBeenCalledTimes(3);
  });

  it('onSessionChange 在 open/switch/close 成功后立即触发，不等回合结束才存（最终审查 Important #4）', async () => {
    const session = createTabSession(1);
    const onSessionChange = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      session,       tabExists: async () => true,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onConfirm: async () => true,
      onSessionChange,
    });

    // browser_open_tab 成功执行后（工具自己会调用 session.openAndSwitch；这里手动模拟）。
    session.openAndSwitch({ id: 2, title: 'Example' });
    await hooks.afterToolCall?.(afterContext('browser_open_tab', { url: 'https://example.com' }, false));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenLastCalledWith(session);

    // 关掉一个非当前 tracked tab：currentTabId 不变，但 trackedTabs 变了，也要通知。
    session.openAndSwitch({ id: 3, title: 'Other' });
    session.switchTo(2); // 2 是当前目标，3 不是
    await hooks.afterToolCall?.(afterContext('browser_open_tab', { url: 'https://other.example.com' }, false));
    onSessionChange.mockClear();
    session.close(3);
    await hooks.afterToolCall?.(afterContext('browser_close_tab', { tabId: 3 }, false));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenLastCalledWith(session);

    // 失败的调用不触发。
    onSessionChange.mockClear();
    await hooks.afterToolCall?.(afterContext('browser_switch_tab', { tabId: 2 }, true));
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});

// 实测复现（2026-09-01 侧边栏 perf 采样）：一次 19 轮的运行在最后一轮收到
// DeepSeek 400 —— "Messages with role 'tool' must be a response to a preceding
// message with 'tool_calls'"，整轮运行没有产出任何回答。原因是 slice(-MAX_CONTEXT_MESSAGES)
// 是按条数盲切的，切点可能落在「带 tool_calls 的 assistant 消息」和它的 toolResult 之间，
// 于是窗口以一条无主的 toolResult 开头，OpenAI 兼容协议一律判 400。
describe('上下文压缩：窗口边界不得切出无主的 toolResult', () => {
  // 严格 A/R 交替时 slice(-24) 永远落在 assistant 上；真正打破奇偶、让切点落到
  // toolResult 上的是中途插入的单条 user 消息——正是 afterToolCall 里 [系统观察]
  // 导航通知和预算软提醒这两处 steer 干的事。下面按真实形态构造。
  // 长度取 MAX_CONTEXT_MESSAGES + 2，保证一定触发重切；前半段 12 对之后插入一条 steer
  // user 消息打破奇偶，使重切点 length - CONTEXT_RECUT_TARGET 正好落在一条 toolResult 上。
  // 下面的前置断言会在常量改动导致夹具失效时直接报错，而不是让测试悄悄空转。
  const FIRST_BLOCK_PAIRS = 12;

  function conversationWithSteer(): AgentMessage[] {
    const total = MAX_CONTEXT_MESSAGES + 2;
    const secondBlockPairs = (total - 2 - FIRST_BLOCK_PAIRS * 2) / 2;
    const messages: AgentMessage[] = [userMessage('开始')];
    for (let index = 0; index < FIRST_BLOCK_PAIRS; index += 1) {
      messages.push(assistantToolCallMessage(`call-a${index}`, 'browser_type', { text: `a${index}` }));
      messages.push(toolResultMessage(`call-a${index}`, 'browser_type', `已输入 a${index}。`));
    }
    messages.push(userMessage('[系统观察] 页面地址已变化。'));
    for (let index = 0; index < secondBlockPairs; index += 1) {
      messages.push(assistantToolCallMessage(`call-b${index}`, 'browser_type', { text: `b${index}` }));
      messages.push(toolResultMessage(`call-b${index}`, 'browser_type', `已输入 b${index}。`));
    }
    return messages;
  }

  it('切点落在 assistant(tool_calls) 与它的 toolResult 之间时，不把这条 toolResult 单独留在窗口开头', async () => {
    const hooks = runtimeOptions();
    const messages = conversationWithSteer();
    // 前置条件：重切点确实落在一条 toolResult 上，盲切会把它对应的 assistant 丢在窗口外。
    const recutIndex = messages.length - CONTEXT_RECUT_TARGET;
    expect(messages.length).toBeGreaterThan(MAX_CONTEXT_MESSAGES);
    expect((messages[recutIndex] as unknown as { role: string }).role).toBe('toolResult');

    const compacted = await hooks.transformContext!(messages);
    const first = compacted[0] as unknown as { role: string };

    expect(first.role).not.toBe('toolResult');
  });

  it('每一条 toolResult 在窗口内都能找到它对应的 tool_calls', async () => {
    const hooks = runtimeOptions();
    const messages = conversationWithSteer();

    const compacted = await hooks.transformContext!(messages);
    const announced = new Set<string>();
    for (const message of compacted as unknown as {
      role: string;
      toolCallId?: string;
      content?: { type: string; id?: string }[];
    }[]) {
      if (message.role === 'assistant') {
        for (const part of message.content ?? []) {
          if (part.type === 'toolCall' && part.id) announced.add(part.id);
        }
      }
      if (message.role === 'toolResult') {
        expect(announced.has(message.toolCallId!)).toBe(true);
      }
    }
  });

  // 交接块（turn-context.ts 的 buildTurnHandoff）在序列里的形状与上面的 steer 一样是单条
  // user 消息，但位置不同：它固定落在历史末尾、本轮工具调用之前。这里补的是那个下标。
  it('历史末尾的单条 user 消息（轮次交接块）不会让窗口以无主 toolResult 开头', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage('开始')];
    for (let index = 0; index < MAX_CONTEXT_MESSAGES; index += 1) {
      messages.push(assistantToolCallMessage(`call-c${index}`, 'browser_type', { text: `c${index}` }));
      messages.push(toolResultMessage(`call-c${index}`, 'browser_type', `已输入 c${index}。`));
    }
    messages.push(userMessage('[系统观察] 本会话上一轮的执行足迹（可能已过时）：\n- 读取了表单结构'));

    const compacted = await hooks.transformContext!(messages);

    expect(messages.length).toBeGreaterThan(MAX_CONTEXT_MESSAGES);
    expect((compacted[0] as unknown as { role: string }).role).not.toBe('toolResult');
    // 交接块本身必须留在窗口里——它是给本轮用的，被切掉等于白算。
    const last = compacted[compacted.length - 1] as unknown as { content: { type: string; text?: string }[] };
    const contentText = last.content?.map((c: any) => c.text ?? '').join('') ?? '';
    expect(contentText).toContain('[系统观察]');
  });
});

// 实测（2026-09-01 perf 采样，DeepSeek 前缀缓存）：消息数一撞到窗口上限，命中 token 数
// 就从逐轮增长变成死死钉在 4224——那正好是静态系统提示词的大小，意味着整段对话每轮都在
// 重新处理。原因是 slice(-N) 每轮都把窗口往前挪两条，请求前缀逐轮都不一样，缓存必然全失效。
// 修法是给窗口加迟滞：只在超过高水位时重切一次到低水位，两次重切之间起点固定不动，
// 请求前缀只增不改，缓存才有得命中。
describe('上下文窗口：迟滞重切，保证前缀在两次重切之间只增不改', () => {
  function pairs(count: number, prefix: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      messages.push(assistantToolCallMessage(`${prefix}-${index}`, 'browser_type', { text: `${index}` }));
      messages.push(toolResultMessage(`${prefix}-${index}`, 'browser_type', `已输入 ${index}。`));
    }
    return messages;
  }

  function firstText(message: AgentMessage): string {
    return JSON.stringify((message as unknown as { content: unknown }).content);
  }

  it('未超过高水位时一条都不切', async () => {
    const hooks = runtimeOptions();
    const messages = pairs(MAX_CONTEXT_MESSAGES / 2, 'call');

    const compacted = await hooks.transformContext!(messages);

    expect(compacted).toHaveLength(messages.length);
  });

  it('超过高水位后重切到低水位，而不是只切掉溢出的那两条', async () => {
    const hooks = runtimeOptions();
    const messages = pairs(MAX_CONTEXT_MESSAGES, 'call'); // 2×MAX 条，远超高水位

    const compacted = await hooks.transformContext!(messages);

    expect(compacted.length).toBeLessThanOrEqual(CONTEXT_RECUT_TARGET);
  });

  it('重切之后连续多轮追加消息，窗口起点保持不动（前缀只增不改）', async () => {
    const hooks = runtimeOptions();
    const messages = pairs(MAX_CONTEXT_MESSAGES, 'call');

    const firstWindow = await hooks.transformContext!(messages);
    const anchor = firstText(firstWindow[0]);

    // 再追加若干轮，只要没再次撞到高水位，窗口开头必须还是同一条消息。
    for (let round = 0; round < 3; round += 1) {
      messages.push(...pairs(1, `later-${round}`));
      const next = await hooks.transformContext!(messages);
      expect(firstText(next[0])).toBe(anchor);
      // 而且是纯追加：旧窗口的每一条都还在，位置不变。
      expect(next.length).toBeGreaterThan(firstWindow.length);
    }
  });

  it('高水位与写入预算匹配，不会让长任务后半程一直待在滑动窗口里', () => {
    // 写入预算 40 次工具调用 ≈ 80 条消息；窗口高水位至少要能覆盖预算的一半，
    // 否则任务刚过半就进入逐轮重切、缓存全失效的状态。
    expect(MAX_CONTEXT_MESSAGES).toBeGreaterThanOrEqual(DEFAULT_WRITE_TOOL_CALL_BUDGET);
    expect(CONTEXT_RECUT_TARGET).toBeLessThan(MAX_CONTEXT_MESSAGES);
  });

  it('未超过高水位时不通知外层发生过重切', async () => {
    const onContextTruncated = vi.fn();
    const hooks = runtimeOptions({ onContextTruncated });
    const messages = pairs(MAX_CONTEXT_MESSAGES / 2, 'call');

    await hooks.transformContext!(messages);

    expect(onContextTruncated).not.toHaveBeenCalled();
  });

  it('超过高水位重切后通知外层，并且此后每一轮都继续通知', async () => {
    const onContextTruncated = vi.fn();
    const hooks = runtimeOptions({ onContextTruncated });
    const messages = pairs(MAX_CONTEXT_MESSAGES, 'call');

    await hooks.transformContext!(messages);
    expect(onContextTruncated).toHaveBeenCalledTimes(1);

    messages.push(...pairs(1, 'later'));
    await hooks.transformContext!(messages);
    expect(onContextTruncated).toHaveBeenCalledTimes(2);
  });
});

describe('tab-access 闸门', () => {
  function optionsWithSession(session: TabSessionController, extra: Record<string, unknown> = {}) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 10,
      writeToolCallBudget: 10,
      steer: vi.fn(),
      session,       tabExists: async () => true,
      ...extra,
    });
  }

  it('拒绝落在只读引用标签页上的写操作，且不触发接管提示、不亮遮罩', async () => {
    const onTakeover = vi.fn();
    const onOverlay = vi.fn();
    const session = createTabSession(1);
    session.reference([{ id: 7, url: 'https://docs.example.com' }]);
    session.switchTo(7);

    const hooks = optionsWithSession(session, { onTakeover, onOverlay });
    const result = await hooks.beforeToolCall?.(beforeContext('browser_click', { fieldId: 'f1' }));

    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain('只读');
    expect(onTakeover).not.toHaveBeenCalled();
    expect(onOverlay).not.toHaveBeenCalled();
  });

  // 回归：闸门过去无条件按 session.currentTabId 查表，而 browser_close_tab 是参数寻址的——
  // 当前目标停在面板 tab（永远 'full'）时，模型只要把只读引用页的 id 写进参数就能把闸门
  // 骗到面板 tab 上并放行（ref: 2026-09-05 跨标签页上下文最终评审 Critical）。
  it('拒绝关闭只读引用标签页，即使当前操作目标是另一个可写标签页', async () => {
    const session = createTabSession(1);
    session.reference([{ id: 7, title: 'Docs', url: 'https://docs.example.com' }]);
    expect(session.currentTabId).toBe(1);

    const hooks = optionsWithSession(session);
    const result = await hooks.beforeToolCall?.(beforeContext('browser_close_tab', { tabId: 7 }));

    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain('只读');
  });

  it('照常允许关闭 agent 自己打开的标签页', async () => {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 9, url: 'https://example.com' });
    session.reference([{ id: 7, title: 'Docs', url: 'https://docs.example.com' }]);
    session.switchTo(1);

    const hooks = optionsWithSession(session);
    expect(await hooks.beforeToolCall?.(beforeContext('browser_close_tab', { tabId: 9 }))).toBeUndefined();
  });

  it('读工具落在只读引用标签页上照常放行', async () => {
    const session = createTabSession(1);
    session.reference([{ id: 7 }]);
    session.switchTo(7);
    const hooks = optionsWithSession(session);
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toBeUndefined();
  });
});

// 窗口此前只按「消息条数」裁剪（MAX_CONTEXT_MESSAGES），countMessageChars 只是 perf 遥测、
// 不参与任何决策。这在每条消息都很小的前提下成立，而这个前提有两个现成的破法：
//   1. 用户附件——单条 user 消息可以带 5 份各 30000 字符的文本、或一份 60000 字符的 PDF 正文，
//      而 user 消息永远不进 compactAgentMessages 的摘要逻辑；
//   2. 只读工具的读取上限一旦上调（本次重构的下一步），最新一份结果就能独占几万字符。
// 两者都不会让条数越线，于是窗口一条都不切，请求直接撞供应商的 400 context length exceeded：
// 失败发生在服务端，用户等完一整轮却拿不到任何回答，跟 2026-09-01 那次无主 toolResult 的
// 400 是同一类事故。字符预算就是这道兜底。
describe('上下文窗口：字符预算兜底', () => {
  function pairs(count: number, prefix: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      messages.push(assistantToolCallMessage(`${prefix}-${index}`, 'browser_type', { text: `${index}` }));
      messages.push(toolResultMessage(`${prefix}-${index}`, 'browser_type', `已输入 ${index}。`));
    }
    return messages;
  }

  /** 模拟带附件的 user 消息：正文很长，且永远不会被摘要压缩。 */
  function bulkyUserMessage(chars: number, tag: string): AgentMessage {
    return userMessage(`${tag}${'字'.repeat(chars)}`);
  }

  function screenshotResultMessage(toolCallId: string, base64Chars: number): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId,
      toolName: 'browser_screenshot',
      content: [{ type: 'image', data: 'x'.repeat(base64Chars), mimeType: 'image/jpeg' }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  function costOf(messages: AgentMessage[]): number {
    return contextCostChars(messages);
  }

  function firstText(message: AgentMessage): string {
    return JSON.stringify((message as unknown as { content: unknown }).content);
  }

  it('条数远未超标但字符数超过高水位时也要重切', async () => {
    const hooks = runtimeOptions();
    // 6 条大附件消息，条数远低于 MAX_CONTEXT_MESSAGES(48)，字符数却远超高水位。
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push(bulkyUserMessage(Math.floor(MAX_CONTEXT_CHARS / 3), `#${index} `));
      messages.push(...pairs(1, `call-${index}`));
    }
    expect(messages.length).toBeLessThan(MAX_CONTEXT_MESSAGES);
    expect(costOf(messages)).toBeGreaterThan(MAX_CONTEXT_CHARS);

    const compacted = await hooks.transformContext!(messages);

    expect(compacted.length).toBeLessThan(messages.length);
  });

  it('重切一次到低水位以下，而不是只切掉溢出的那一条', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push(bulkyUserMessage(Math.floor(MAX_CONTEXT_CHARS / 3), `#${index} `));
      messages.push(...pairs(1, `call-${index}`));
    }

    const compacted = await hooks.transformContext!(messages);

    expect(costOf(compacted)).toBeLessThanOrEqual(CONTEXT_RECUT_TARGET_CHARS);
  });

  // 与按条数重切同一个坑：切点落在 toolResult 上就会让窗口以无主的 tool 消息开头，
  // OpenAI 兼容协议一律判 400。字符重切必须复用同一套边界对齐。
  it('字符重切的切点同样对齐 tool_call 边界', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage('开始')];
    for (let index = 0; index < 8; index += 1) {
      messages.push(assistantToolCallMessage(`c-${index}`, 'browser_get_html', { selector: 'body' }));
      // 只读结果：只有最新一份保留全文，其余会被压成一句话摘要，所以这里靠 user 消息堆字符。
      messages.push(toolResultMessage(`c-${index}`, 'browser_get_html', 'x'.repeat(2000)));
      messages.push(bulkyUserMessage(Math.floor(MAX_CONTEXT_CHARS / 4), `#${index} `));
    }

    const compacted = await hooks.transformContext!(messages);
    // 前置条件：这批消息确实触发了字符重切，否则下面的边界检查等于空转。
    expect(compacted.length).toBeLessThan(messages.length);

    const announced = new Set<string>();
    for (const message of compacted as unknown as {
      role: string;
      toolCallId?: string;
      content?: { type: string; id?: string }[];
    }[]) {
      if (message.role === 'assistant') {
        for (const part of message.content ?? []) {
          if (part.type === 'toolCall' && part.id) announced.add(part.id);
        }
      }
      if (message.role === 'toolResult') expect(announced.has(message.toolCallId!)).toBe(true);
    }
  });

  // 迟滞的理由与按条数重切完全一样：起点一旦逐轮漂移，供应商前缀缓存每轮全失效
  // （2026-09-01 实测命中数死钉在系统提示词大小）。
  it('字符重切之后追加小消息，窗口起点保持不动', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push(bulkyUserMessage(Math.floor(MAX_CONTEXT_CHARS / 3), `#${index} `));
      messages.push(...pairs(1, `call-${index}`));
    }

    const firstWindow = await hooks.transformContext!(messages);
    // 前置条件：第一次就必须已经因为字符预算重切过，否则起点不动是白测的。
    expect(firstWindow.length).toBeLessThan(messages.length);
    const anchor = firstText(firstWindow[0]);

    for (let round = 0; round < 3; round += 1) {
      messages.push(...pairs(1, `later-${round}`));
      const next = await hooks.transformContext!(messages);
      expect(firstText(next[0])).toBe(anchor);
    }
  });

  // 会让这个用例失败的 production 改动：无条件切到低水位以下。用户刚粘进来的长附件
  // 本身就可能比整个预算还大，切空窗口等于把用户这一轮的提问本身丢掉，模型会对着空
  // 上下文瞎答——比超预算更糟。
  it('最后一条消息自己就超过预算时，窗口至少保留它', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      ...pairs(3, 'old'),
      bulkyUserMessage(MAX_CONTEXT_CHARS * 2, '超大附件 '),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(firstText(compacted[compacted.length - 1])).toContain('超大附件');
  });

  it('字符触发的重切同样通知外层', async () => {
    const onContextTruncated = vi.fn();
    const hooks = runtimeOptions({ onContextTruncated });
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push(bulkyUserMessage(Math.floor(MAX_CONTEXT_CHARS / 3), `#${index} `));
      messages.push(...pairs(1, `call-${index}`));
    }

    await hooks.transformContext!(messages);

    expect(onContextTruncated).toHaveBeenCalled();
  });

  // 会让这个用例失败的 production 改动：按 base64 长度计图片。一张 1280px 截图的 base64
  // 约 200 万字符（SCREENSHOT_MAX_BYTES 1.5MB），按长度计就等于每次截图都把窗口清空，
  // 而它换算成 token 只有一千多。图片必须按 token 当量计。
  // 会让这个用例失败的 production 改动：只数 content 里的文本部分。模型可以往写工具的
  // 参数里塞几万字符（browser_modify_dom 的 html、browser_fill_form 的多字段值），
  // 这些字符一样要进请求体，不计就等于预算对最容易失控的那一类内容视而不见。
  it('工具调用参数计入预算', () => {
    const call = assistantToolCallMessage('c1', 'browser_modify_dom', { html: 'x'.repeat(50000) });

    expect(contextCostChars([call])).toBeGreaterThan(50000);
  });

  it('截图按固定当量计入，不按 base64 长度', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [
      ...pairs(3, 'call'),
      assistantToolCallMessage('shot', 'browser_screenshot', {}),
      screenshotResultMessage('shot', 2_000_000),
    ];

    const compacted = await hooks.transformContext!(messages);

    expect(compacted).toHaveLength(messages.length);
  });
});

// 2026-09-30 事故（deepseek-v4.1-flash，划词问"这两种安装方式的区别是什么？"）：单轮跑了 41 次
// 工具调用、约 83 条消息，撞到 MAX_CONTEXT_MESSAGES 后窗口重切，把下标 0 的那条用户提问整条切掉。
// 后半程模型看不到问题本身，只能对着巡检结果猜意图，最终答成了"页面是怎么实现的"，还自报 success。
// 重切只保护了"最后一条"，而单轮任务里定义任务的是本轮第一条——agent.prompt() 追加的那条。
// 它必须常驻窗口头部：头部固定，前缀缓存反而更稳。
describe('上下文窗口：本轮任务消息常驻', () => {
  const TASK = '引用：curl … npm …\n\n这两种安装方式的区别是什么？';

  function pairs(count: number, prefix: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      messages.push(assistantToolCallMessage(`${prefix}-${index}`, 'browser_type', { text: `${index}` }));
      messages.push(toolResultMessage(`${prefix}-${index}`, 'browser_type', `已输入 ${index}。`));
    }
    return messages;
  }

  function textOf(message: AgentMessage): string {
    return JSON.stringify((message as unknown as { content: unknown }).content);
  }

  function countTask(messages: AgentMessage[]): number {
    return messages.filter((message) => textOf(message).includes('这两种安装方式的区别是什么')).length;
  }

  it('条数重切后，本轮提问仍在窗口头部', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage(TASK), ...pairs(41, 'call')];

    const compacted = await hooks.transformContext!(messages);

    // 前置条件：确实发生过条数重切，否则下面的断言是空转。
    expect(compacted.length).toBeLessThan(messages.length);
    expect(textOf(compacted[0])).toContain('这两种安装方式的区别是什么');
    expect(countTask(compacted)).toBe(1);
    // 任务消息之后紧跟的窗口仍然不能以无主 toolResult 开头。
    expect((compacted[1] as unknown as { role: string }).role).not.toBe('toolResult');
  });

  it('有历史会话时，常驻的是本轮提问而不是历史里的旧消息', async () => {
    const prior: AgentMessage[] = [
      userMessage('上一轮的旧问题'),
      { role: 'assistant', content: [{ type: 'text', text: '上一轮的回答' }] } as unknown as AgentMessage,
      userMessage('[系统观察] 本会话上一轮的执行足迹（可能已过时）'),
    ];
    const hooks = runtimeOptions({ messages: prior });
    const messages: AgentMessage[] = [...prior, userMessage(TASK), ...pairs(41, 'call')];

    const compacted = await hooks.transformContext!(messages);

    expect(textOf(compacted[0])).toContain('这两种安装方式的区别是什么');
    expect(compacted.some((message) => textOf(message).includes('上一轮的旧问题'))).toBe(false);
  });

  it('字符预算重切后，本轮提问仍在窗口里，且总量仍守住低水位', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage(TASK)];
    for (let index = 0; index < 6; index += 1) {
      messages.push(...pairs(1, `call-${index}`));
      // 中途 steer 进来的大块 user 消息：不进摘要压缩，只有字符预算拦得住。
      messages.push(userMessage(`#${index} ${'字'.repeat(Math.floor(MAX_CONTEXT_CHARS / 3))}`));
    }

    const compacted = await hooks.transformContext!(messages);

    expect(compacted.length).toBeLessThan(messages.length);
    expect(textOf(compacted[0])).toContain('这两种安装方式的区别是什么');
    expect(contextCostChars(compacted)).toBeLessThanOrEqual(CONTEXT_RECUT_TARGET_CHARS);
  });

  it('重切之后继续追加，窗口头部保持不变（前缀只增不改）', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage(TASK), ...pairs(41, 'call')];

    const first = await hooks.transformContext!(messages);
    const head = first.slice(0, 2).map(textOf);

    for (let round = 0; round < 3; round += 1) {
      messages.push(...pairs(1, `later-${round}`));
      const next = await hooks.transformContext!(messages);
      expect(next.slice(0, 2).map(textOf)).toEqual(head);
    }
  });

  it('未重切时不重复插入任务消息', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage(TASK), ...pairs(3, 'call')];

    const compacted = await hooks.transformContext!(messages);

    expect(compacted).toHaveLength(messages.length);
    expect(countTask(compacted)).toBe(1);
  });
});

describe('上下文字符预算常量之间的不变量', () => {
  // 高水位要装得下「一条满额只读结果 + 一张截图」还有富余，否则模型每读满一次就触发重切，
  // 前缀缓存逐轮失效，正好回到迟滞想修掉的那个问题。
  it('高水位容得下一条满额工具结果加一张截图', () => {
    expect(MAX_CONTEXT_CHARS).toBeGreaterThan(MAX_TOOL_RESULT_CHARS + IMAGE_CHAR_EQUIVALENT);
  });

  it('低水位低于高水位', () => {
    expect(CONTEXT_RECUT_TARGET_CHARS).toBeLessThan(MAX_CONTEXT_CHARS);
  });

  // 低水位必须仍然装得下一条满额只读结果：否则一次重切就会把刚读到的页面正文本身切掉，
  // 模型下一轮只能重读，陷入读—切—重读的循环。
  it('低水位仍然容得下一条满额工具结果', () => {
    expect(CONTEXT_RECUT_TARGET_CHARS).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
  });

  // 新锚点是内容而不是窗口（spec §5），但仍要校验最坏情况落在声明窗口内，
  // 且给系统提示词和输出留出余量。这条不变量锁的是"我们自己的两个常量不打架"
  // ——`model.contextWindow` 是 createModel 里我们自己写死的 1,000,000，不是供应商的
  // 真实窗口，所以这个断言不能证明、也不负责证明不会撞供应商 400（那是无法在单测里
  // 验证的外部事实，见 spec §10 第一条）。
  it('最坏情况的上下文预算仍在声明窗口内，并留有系统提示词与输出的余量', () => {
    const model = createModel({
      id: 'p-test',
      name: 'test',
      baseURL: 'https://example.test/v1',
      apiKey: 'k',
      model: 'test-model',
    });
    // 系统提示词 + 工具表的估算值，沿用 spec §5 的口径（未实测）
    const SYSTEM_PROMPT_ALLOWANCE = 25_000;
    // 中文最保守口径：1 字符 ≈ 1 token
    const worstCaseTokens = MAX_CONTEXT_CHARS + SYSTEM_PROMPT_ALLOWANCE + model.maxTokens;
    expect(worstCaseTokens).toBeLessThan(model.contextWindow);
    // 不是"刚好塞下"：留至少一倍余量，给 tokenizer 差异和估算误差
    expect(worstCaseTokens * 2).toBeLessThan(model.contextWindow);
  });
});

describe('createBrowserAgentOptions closed operating target', () => {
  function hooksWithTarget(tabExists: (tabId: number) => Promise<boolean>) {
    const session = createTabSession(1);
    session.openAndSwitch({ id: 7, url: 'https://pi.dev/install.sh' });
    const onSessionChange = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      session,
      steer: vi.fn(),
      tabExists,
      onSessionChange,
    });
    return { hooks, session, onSessionChange };
  }

  it('blocks the call and falls back to the panel tab once the target tab is gone', async () => {
    const { hooks, session, onSessionChange } = hooksWithTarget(async (id) => id !== 7);
    const result = await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}));
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining('已被关闭') });
    expect(session.currentTabId).toBe(1);
    expect(session.isTracked(7)).toBe(false);
    expect(onSessionChange).toHaveBeenCalledWith(session);
    // 回退之后下一次调用落在面板 tab 上，照常放行。
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toBeUndefined();
  });

  it('lets target-independent tools through without probing the target', async () => {
    const tabExists = vi.fn().mockResolvedValue(false);
    const { hooks, session } = hooksWithTarget(tabExists);
    expect(await hooks.beforeToolCall?.(beforeContext('browser_list_tabs', {}))).toBeUndefined();
    expect(tabExists).not.toHaveBeenCalled();
    expect(session.currentTabId).toBe(7);
  });

  it('does nothing while the target tab is still open', async () => {
    const { hooks, session } = hooksWithTarget(async () => true);
    expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toBeUndefined();
    expect(session.currentTabId).toBe(7);
  });
});
