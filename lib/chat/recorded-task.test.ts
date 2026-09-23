import { describe, expect, it } from 'vitest';
import { MAX_TRAJECTORY_STEPS, type TrajectoryStep } from '@/lib/agent/task-trajectory';
import { validateShortcutConfigs } from '@/lib/shortcuts';
import type { ChatMessage } from './messages';
import { buildRecordedTaskDraft, canSaveAsTask, toRecordedShortcut } from './recorded-task';
import { MAX_PLAYBOOK_CONTEXT_CHARS } from './task-playbook';

const step = (n: number): TrajectoryStep => ({ tool: 'browser_click', target: `「按钮${n}」` });

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
  // 快捷/回放消息的 content 只是显示标签（"▶ 差旅报销单 · 金额改成 300"），真正发出去的
  // 目标在 rerun 配方里；拿标签当 goal，再保存一次回放过的会话就把真实目标弄丢了。
  it('uses the rerun recipe instead of the display label for shortcut and replay messages', () => {
    const replayed: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '▶ 差旅报销单 · 金额改成 300',
        createdAt: 1,
        rerun: {
          shortcut: { id: 'shortcut-rec-1', origin: 'recorded', scope: 'page', customized: true, name: '差旅报销单', prompt: '帮我填一张差旅报销单', trajectory: [step(1)] },
          supplement: '金额改成 300',
        },
      },
      { id: 'a1', role: 'assistant', content: '已提交', createdAt: 2, trajectory: [step(1)] },
      {
        id: 'u2',
        role: 'user',
        content: '📄 总结当前网页',
        createdAt: 3,
        rerun: { shortcut: { id: 'summarize-page', origin: 'builtin', scope: 'page', customized: false, name: '总结当前网页', prompt: '请总结当前网页' } },
      },
      { id: 'a2', role: 'assistant', content: '总结如下', createdAt: 4 },
    ];
    const draft = buildRecordedTaskDraft(replayed, 'a2')!;
    expect(draft.goal).toBe('帮我填一张差旅报销单\n金额改成 300\n请总结当前网页');
    expect(draft.goal).not.toContain('▶');
  });

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

  it('drops urls and page-location steps that older versions recorded in chat history', () => {
    const legacy = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      {
        id: 'a1', role: 'assistant', content: 'x', createdAt: 2,
        trajectory: [
          { tool: 'browser_navigate', url: 'https://a.test/v/1', detail: 'https://a.test/v/1' },
          { tool: 'browser_click', url: 'https://a.test/v/1', target: '「倍速」' },
        ],
      },
    ] as unknown as ChatMessage[];
    expect(buildRecordedTaskDraft(legacy, 'a1')!.steps).toEqual([{ tool: 'browser_click', target: '「倍速」' }]);

    const onlyNavigation = [
      legacy[0],
      { ...legacy[1], trajectory: [{ tool: 'browser_navigate', url: '', detail: 'https://a.test' }] },
    ] as unknown as ChatMessage[];
    expect(canSaveAsTask(onlyNavigation, 'a1')).toBe(false);
  });

  it('returns copies, so editing the draft cannot mutate chat history', () => {
    const withValue: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'x', createdAt: 2, trajectory: [{ tool: 'browser_fill_form', values: [{ target: '「a」', value: '1' }] }] },
    ];
    const draft = buildRecordedTaskDraft(withValue, 'a1')!;
    draft.steps[0].values![0].value = '2';
    expect(withValue[1].trajectory![0].values![0].value).toBe('1');
  });

  it('collects the assistant replies, newest first within the budget, back in chronological order', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'first reply', createdAt: 2, trajectory: [step(1)] },
      { id: 'u2', role: 'user', content: 'more', createdAt: 3 },
      { id: 'a2', role: 'assistant', content: 'x'.repeat(MAX_PLAYBOOK_CONTEXT_CHARS), createdAt: 4 },
    ] as ChatMessage[];
    const draft = buildRecordedTaskDraft(messages, 'a2')!;
    expect(draft.replyContext).toHaveLength(MAX_PLAYBOOK_CONTEXT_CHARS);
    expect(draft.replyContext).not.toContain('first reply');

    const short = buildRecordedTaskDraft(messages.slice(0, 2), 'a1')!;
    expect(short.replyContext).toBe('first reply');
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

describe('toRecordedShortcut with a playbook', () => {
  it('stores a cleaned playbook, and drops one left without steps', () => {
    const base = { name: 'n', goal: 'g', steps: [step(1)] };
    expect(toRecordedShortcut({ ...base, playbook: { applicability: ' 视频页 ', steps: ['a', ''] } }).playbook).toEqual({
      applicability: '视频页',
      steps: ['a'],
    });
    expect(toRecordedShortcut({ ...base, playbook: { applicability: '视频页', steps: [' '] } }).playbook).toBeUndefined();
    expect(toRecordedShortcut(base).playbook).toBeUndefined();
    expect(validateShortcutConfigs([toRecordedShortcut({ ...base, playbook: { applicability: 'x', steps: ['a'] } })]).errors).toEqual([]);
  });
});
