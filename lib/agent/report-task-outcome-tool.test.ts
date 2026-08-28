import { describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from './tools';
import { createTabSession } from './tab-session';
import { REPORT_TASK_OUTCOME_TOOL_NAME, type TaskOutcome } from './task-outcome';

function getTool(onTaskOutcome?: (outcome: TaskOutcome) => void) {
  const tool = createBrowserTools(createTabSession(1), { onTaskOutcome }).find(
    (candidate) => candidate.name === REPORT_TASK_OUTCOME_TOOL_NAME,
  );
  if (!tool) throw new Error('report_task_outcome 未注册');
  return tool;
}

describe('report_task_outcome', () => {
  it('is registered as a tool', () => {
    expect(getTool().name).toBe('report_task_outcome');
  });

  it('forwards the outcome and reason to onTaskOutcome', async () => {
    const onTaskOutcome = vi.fn();
    const output = await getTool(onTaskOutcome).execute('call-1', {
      outcome: 'success',
      reason: '已经填好并提交表单。',
    });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'success', reason: '已经填好并提交表单。' });
    expect((output.content[0] as { text: string }).text).toContain('success');
  });

  it('reports partial and failure outcomes the same way', async () => {
    const onTaskOutcome = vi.fn();
    await getTool(onTaskOutcome).execute('call-1', { outcome: 'partial', reason: '只填了 3 个字段中的 2 个。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'partial', reason: '只填了 3 个字段中的 2 个。' });
    await getTool(onTaskOutcome).execute('call-2', { outcome: 'failure', reason: '没有找到提交按钮。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'failure', reason: '没有找到提交按钮。' });
  });

  it('does not throw when onTaskOutcome is not wired up', async () => {
    await expect(getTool(undefined).execute('call-1', { outcome: 'success', reason: 'ok' })).resolves.toBeDefined();
  });
});
