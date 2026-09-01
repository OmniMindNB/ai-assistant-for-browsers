import { describe, expect, it } from 'vitest';
import { finishActivityStep, upsertActivityStep, type ActivityStep } from './activity-steps';

describe('upsertActivityStep', () => {
  it('appends a new step when the id is not already present', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = upsertActivityStep(steps, { id: 'b', description: 'B', status: 'running' });
    expect(next).toEqual([
      { id: 'a', description: 'A', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ]);
    expect(steps).toEqual([{ id: 'a', description: 'A', status: 'running' }]);
  });

  it('replaces the step in place when the id already exists, preserving position', () => {
    const steps: ActivityStep[] = [
      { id: 'a', description: 'A', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ];
    const next = upsertActivityStep(steps, { id: 'a', description: 'A updated', status: 'running' });
    expect(next).toEqual([
      { id: 'a', description: 'A updated', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ]);
    expect(next).toHaveLength(2);
  });
});

describe('finishActivityStep', () => {
  it('flips a running step to done, replacing its description', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'Clicking X', status: 'running' }];
    const next = finishActivityStep(steps, 'a', 'done', 'Clicked X');
    expect(next).toEqual([{ id: 'a', description: 'Clicked X', status: 'done' }]);
  });

  it('flips a running step to failed', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'Clicking X', status: 'running' }];
    const next = finishActivityStep(steps, 'a', 'failed', 'Failed to click X');
    expect(next).toEqual([{ id: 'a', description: 'Failed to click X', status: 'failed' }]);
  });

  it('is a no-op (same array reference) when the id is not found', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = finishActivityStep(steps, 'missing', 'done', 'irrelevant');
    expect(next).toBe(steps);
  });

  it('does not mutate steps for entries other than the target id', () => {
    const steps: ActivityStep[] = [
      { id: 'a', description: 'A', status: 'done' },
      { id: 'b', description: 'B', status: 'running' },
    ];
    const next = finishActivityStep(steps, 'b', 'done', 'B done');
    expect(next[0]).toBe(steps[0]);
    expect(next[1]).toEqual({ id: 'b', description: 'B done', status: 'done' });
  });
});
