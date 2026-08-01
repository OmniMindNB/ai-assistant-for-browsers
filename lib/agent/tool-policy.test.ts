import { describe, expect, it } from 'vitest';
import { createAgentToolPolicy } from './tool-policy';

describe('AgentToolPolicy budgets', () => {
  it('blocks reads after the read budget', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.preflight('browser_get_html', {}, false)).toMatchObject({ block: true, reason: expect.stringContaining('2') });
  });

  it('allows a first confirm tool at the read boundary and expands only after approval', () => {
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

  it('allows only one unapproved confirm tool at the read boundary', () => {
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
});
