import { describe, expect, it } from 'vitest';
import type { ActivityStep } from '@/lib/agent/activity-steps';
import { findRunningStep } from './run-status';

const step = (id: string, status: ActivityStep['status'], signature?: string): ActivityStep => ({
  id,
  description: id,
  status,
  ...(signature === undefined ? {} : { signature }),
});

describe('findRunningStep', () => {
  it('没有在跑的步骤时返回 undefined', () => {
    expect(findRunningStep([step('a', 'done', 's1')])).toBeUndefined();
    expect(findRunningStep([])).toBeUndefined();
  });

  it('序号只数工具调用，与步骤列表的编号一致', () => {
    const steps = [step('a', 'done', 's1'), step('notice', 'notice'), step('b', 'done', 's2'), step('c', 'running', 's3')];
    expect(findRunningStep(steps)).toEqual({ step: steps[3], ordinal: 3 });
  });

  it('取最后一个在跑的步骤', () => {
    const steps = [step('a', 'running', 's1'), step('b', 'running', 's2')];
    expect(findRunningStep(steps)?.step.id).toBe('b');
    expect(findRunningStep(steps)?.ordinal).toBe(2);
  });

  it('在跑的行不是工具调用时不给序号', () => {
    const steps = [step('a', 'done', 's1'), step('b', 'running')];
    expect(findRunningStep(steps)).toEqual({ step: steps[1] });
  });
});
