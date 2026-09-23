import { describe, expect, it } from 'vitest';
import { MAX_TRAJECTORY_STEPS, type TrajectoryStep } from '@/lib/agent/task-trajectory';
import { validateShortcutConfigs } from '@/lib/shortcuts';
import type { ChatMessage } from './messages';
import { buildRecordedTaskDraft, canSaveAsTask, toRecordedShortcut } from './recorded-task';

const step = (n: number): TrajectoryStep => ({ tool: 'browser_click', url: 'https://example.com/a', target: `「按钮${n}」` });

const conversation: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '帮我填一张差旅报销单', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: '填了一半，金额是多少？', createdAt: 2, trajectory: [step(1)] },
  { id: 'u2', role: 'user', content: '金额写 280', createdAt: 3 },
  { id: 'a2', role: 'assistant', content: '已提交', createdAt: 4, trajectory: [step(2)] },
  { id: 'u3', role: 'user', content: '谢谢', createdAt: 5 },
  { id: 'a3', role: 'assistant', content: '不客气', createdAt: 6 },
];

describe('canSaveAsTask', () => {
  it('offers saving on any assistant reply that has a recorded step at or before it', () => {
    expect(canSaveAsTask(conversation, 'a1')).toBe(true);
    expect(canSaveAsTask(conversation, 'a3')).toBe(true);
  });

  it('does not offer saving for pure Q&A, user messages or unknown ids', () => {
    const qa: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', createdAt: 2 },
    ];
    expect(canSaveAsTask(qa, 'a1')).toBe(false);
    expect(canSaveAsTask(conversation, 'u1')).toBe(false);
    expect(canSaveAsTask(conversation, 'missing')).toBe(false);
  });
});

describe('buildRecordedTaskDraft', () => {
  it('joins every step and every user message up to the chosen reply', () => {
    const draft = buildRecordedTaskDraft(conversation, 'a2')!;
    expect(draft.name).toBe('帮我填一张差旅报销单');
    expect(draft.goal).toBe('帮我填一张差旅报销单\n金额写 280');
    expect(draft.steps).toEqual([step(1), step(2)]);
    expect(draft.truncated).toBe(false);
    expect(draft.incompleteOutcome).toBe(false);
  });

  it('keeps the last steps when the session recorded more than the cap', () => {
    const many: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'x', createdAt: 2, trajectory: Array.from({ length: 40 }, (_, i) => step(i)) },
      { id: 'a2', role: 'assistant', content: 'y', createdAt: 3, trajectory: Array.from({ length: 40 }, (_, i) => step(100 + i)) },
    ];
    const draft = buildRecordedTaskDraft(many, 'a2')!;
    expect(draft.steps).toHaveLength(MAX_TRAJECTORY_STEPS);
    expect(draft.steps.at(-1)).toEqual(step(139));
    expect(draft.truncated).toBe(true);
  });

  it('warns when a reply in range reported the task as not completed', () => {
    const partial = conversation.map((message) =>
      message.id === 'a2' ? { ...message, taskOutcome: { outcome: 'partial' as const, reason: 'x' } } : message,
    );
    expect(buildRecordedTaskDraft(partial, 'a2')!.incompleteOutcome).toBe(true);
  });

  it('returns copies, so editing the draft cannot mutate chat history', () => {
    const withValue: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'x', createdAt: 2, trajectory: [{ tool: 'browser_fill_form', url: '', values: [{ target: '「a」', value: '1' }] }] },
    ];
    const draft = buildRecordedTaskDraft(withValue, 'a1')!;
    draft.steps[0].values![0].value = '2';
    expect(withValue[1].trajectory![0].values![0].value).toBe('1');
  });

  it('returns null when nothing can be saved', () => {
    expect(buildRecordedTaskDraft(conversation, 'u1')).toBeNull();
  });
});

describe('toRecordedShortcut', () => {
  it('produces a config that passes storage validation', () => {
    const config = toRecordedShortcut({ name: ' 报销单 ', goal: ' 填报销单 ', steps: [step(1)] });
    expect(config).toMatchObject({ origin: 'recorded', scope: 'page', customized: true, name: '报销单', prompt: '填报销单' });
    expect(validateShortcutConfigs([config]).errors).toEqual([]);
  });
});
