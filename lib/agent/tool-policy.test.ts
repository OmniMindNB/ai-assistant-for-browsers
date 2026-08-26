import { describe, expect, it } from 'vitest';
import { createAgentToolPolicy } from './tool-policy';

describe('AgentToolPolicy budgets', () => {
  it('blocks reads after the read budget', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.preflight('browser_get_html', {}, false)).toMatchObject({ block: true, reason: expect.stringContaining('2') });
  });

  it('allows a first write tool at the read boundary and expands the budget when writing starts', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.preflight('browser_click', { selector: '#save' }, true)).toBeUndefined();
    policy.approveWrite();
    expect(policy.preflight('browser_click', { selector: '#save' }, true)).toBeUndefined();
    expect(policy.currentBudget).toBe(4);
  });

  it('does not expand unless approveWrite is called', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.currentBudget).toBe(2);
    expect(policy.preflight('browser_get_html', {}, false)?.block).toBe(true);
  });

  it('allows only one pending write tool at the read boundary', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.preflight('browser_click', { selector: '#save' }, true)).toBeUndefined();
    expect(policy.currentBudget).toBe(2);
    expect(policy.preflight('browser_type', { selector: '#name', text: 'Ada' }, true)).toMatchObject({ block: true });
    expect(policy.currentBudget).toBe(2);
  });
});

describe('AgentToolPolicy repeated failures', () => {
  it('blocks the third consecutive failure with the same canonical signature', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    policy.recordExecution('browser_query_dom', { limit: 2, selector: '.x' }, true);
    policy.recordExecution('browser_query_dom', { selector: '.x', limit: 2 }, true);
    expect(policy.preflight('browser_query_dom', { limit: 2, selector: '.x' }, false)).toMatchObject({
      block: true,
      reason: expect.stringContaining('连续失败两次'),
    });
  });

  it('resets the failure streak after a success or signature change', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    policy.recordExecution('browser_query_dom', { selector: '.x' }, true);
    policy.recordExecution('browser_query_dom', { selector: '.y' }, true);
    expect(policy.preflight('browser_query_dom', { selector: '.x' }, false)).toBeUndefined();
    policy.recordExecution('browser_query_dom', { selector: '.x' }, false);
    expect(policy.preflight('browser_query_dom', { selector: '.x' }, false)).toBeUndefined();
  });
});

describe('AgentToolPolicy final response', () => {
  it('prepares exactly one final response turn and stops after it', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 1, writeToolCallBudget: 2 });
    policy.recordExecution('browser_read_page', {}, false);
    expect(policy.prepareFinalResponse()).toBe(true);
    expect(policy.prepareFinalResponse()).toBe(false);
    expect(policy.shouldStopAfterTurn()).toBe(false);
    expect(policy.shouldStopAfterTurn()).toBe(true);
  });

  it('allows one blocked attempt to change strategy and prepares a final response after the next block', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    policy.recordPreExecutionBlock();
    expect(policy.prepareFinalResponse()).toBe(false);
    policy.recordPreExecutionBlock();
    expect(policy.prepareFinalResponse()).toBe(true);
  });

  it('resets the blocked-attempt streak only after a successful execution', () => {
    const resetPolicy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    resetPolicy.recordPreExecutionBlock();
    resetPolicy.recordExecution('browser_query_dom', { selector: '.ok' }, false);
    resetPolicy.recordPreExecutionBlock();
    expect(resetPolicy.prepareFinalResponse()).toBe(false);

    const failedPolicy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    failedPolicy.recordPreExecutionBlock();
    failedPolicy.recordExecution('browser_query_dom', { selector: '.missing' }, true);
    failedPolicy.recordPreExecutionBlock();
    expect(failedPolicy.prepareFinalResponse()).toBe(true);
  });
});

// 修复前预算是「硬阻断」：模型毫无预警地被挡下，只能在最后一轮被动收尾。
// 这里补一层软提醒，让它自己有机会收尾（对标 alibaba/page-agent 的 <sys> 观察注入）。
describe('AgentToolPolicy budget warnings', () => {
  function drain(policy: ReturnType<typeof createAgentToolPolicy>, times: number): void {
    for (let i = 0; i < times; i += 1) policy.recordExecution('browser_read_page', {}, false);
  }

  it('reports how many tool calls are left', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    expect(policy.remaining).toBe(12);
    drain(policy, 3);
    expect(policy.remaining).toBe(9);
  });

  it('stays quiet while the budget is comfortable', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    drain(policy, 6);
    expect(policy.budgetWarning()).toBeUndefined();
  });

  it('warns once when five calls are left', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    drain(policy, 7);
    expect(policy.budgetWarning()).toContain('5');
    expect(policy.budgetWarning()).toBeUndefined();
  });

  it('escalates when only two calls are left', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    drain(policy, 7);
    policy.budgetWarning();
    drain(policy, 3);
    expect(policy.budgetWarning()).toContain('2');
    expect(policy.budgetWarning()).toBeUndefined();
  });

  // 预算从读档跳到写档会让 remaining 变大，不能因此把已发过的提醒重新解锁。
  it('does not repeat the five-call warning after the write budget widens it', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    drain(policy, 7);
    expect(policy.budgetWarning()).toContain('5');
    policy.approveWrite();
    // 预算 12 → 24，remaining 回到 17：不该因为「又跌回 5」而重复提醒。
    drain(policy, 12);
    expect(policy.remaining).toBe(5);
    expect(policy.budgetWarning()).toBeUndefined();
    // 但更紧的那一档仍然要能触发。
    drain(policy, 3);
    expect(policy.budgetWarning()).toContain('2');
  });

  // 直接掉到 2 以内时只该发最紧的那一条，不该先补发一条已经过时的「还剩 5 次」。
  it('skips the looser warning when the budget drops straight past both thresholds', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    drain(policy, 11);
    expect(policy.budgetWarning()).toContain('1');
    expect(policy.budgetWarning()).toBeUndefined();
  });
});

// 预算归零后由 prepareFinalResponse 的硬指令接管，软提醒再发一条只会与它重复。
describe('AgentToolPolicy budget warning at exhaustion', () => {
  it('stays quiet once the budget is fully spent', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 1, writeToolCallBudget: 1 });
    policy.recordExecution('browser_read_page', {}, false);
    expect(policy.remaining).toBe(0);
    expect(policy.budgetWarning()).toBeUndefined();
  });
});
