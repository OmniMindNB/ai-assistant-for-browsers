import { describe, it, expect } from 'vitest';
import { summarizeActivity, SUMMARY_MAX_CATEGORIES } from './activity-summary';
import type { ActivityStep } from './activity-steps';

function step(overrides: Partial<ActivityStep> & { id: string }): ActivityStep {
  return { description: 'x', status: 'done', ...overrides };
}

describe('summarizeActivity', () => {
  it('counts only real tool steps, ignoring narration and notices', () => {
    const summary = summarizeActivity([
      step({ id: '1', category: 'read' }),
      step({ id: 'n1', status: 'narration' }),
      step({ id: '2', category: 'interact' }),
      step({ id: 'notice', status: 'notice' }),
    ]);

    // 旁白和流程提示不是"做过的事"，把它们算进步数会让计数看起来比实际操作多。
    expect(summary.toolStepCount).toBe(2);
  });

  it('lists categories by first appearance without repeating them', () => {
    const summary = summarizeActivity([
      step({ id: '1', category: 'read' }),
      step({ id: '2', category: 'read' }),
      step({ id: '3', category: 'interact' }),
      step({ id: '4', category: 'read' }),
    ]);

    expect(summary.categories).toEqual(['read', 'interact']);
  });

  it('caps the category list so the summary line stays one line', () => {
    const summary = summarizeActivity([
      step({ id: '1', category: 'read' }),
      step({ id: '2', category: 'navigate' }),
      step({ id: '3', category: 'interact' }),
      step({ id: '4', category: 'write' }),
      step({ id: '5', category: 'screenshot' }),
    ]);

    expect(summary.categories).toHaveLength(SUMMARY_MAX_CATEGORIES);
    expect(summary.categories).toEqual(['read', 'navigate', 'interact']);
    // 步数仍然数全，被截掉的只是类别标签。
    expect(summary.toolStepCount).toBe(5);
  });

  // 折叠规则要用它：有失败的一轮结束后仍保持展开，因为那正是最需要被看到的。
  it('flags a run that contains a failed step', () => {
    expect(summarizeActivity([step({ id: '1', category: 'read' })]).hasFailure).toBe(false);
    expect(
      summarizeActivity([
        step({ id: '1', category: 'read' }),
        step({ id: '2', category: 'interact', status: 'failed' }),
      ]).hasFailure,
    ).toBe(true);
  });

  it('handles an empty list', () => {
    expect(summarizeActivity([])).toEqual({ categories: [], toolStepCount: 0, hasFailure: false });
  });
});
