// 「保存为指令」的纯逻辑：从会话里取出草稿、判断按钮该不该出现、生成要落盘的配置
// （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §4）。
// 放在 lib/ 而不是组件里，理由同 messages.ts：面板的可测逻辑集中在这里。

import { MAX_TRAJECTORY_STEPS, type TrajectoryStep } from '@/lib/agent/task-trajectory';
import { newShortcutId, type ShortcutConfig } from '@/lib/shortcuts';
import { conversationTitle, type ChatMessage } from './messages';

export interface RecordedTaskDraft {
  name: string;
  goal: string;
  steps: TrajectoryStep[];
  /** 会话里录到的步骤超过上限，只保留了最后 MAX_TRAJECTORY_STEPS 步。 */
  truncated: boolean;
  /** 区间内有回复报告了 partial/failure——提示，不阻止保存。 */
  incompleteOutcome: boolean;
}

function rangeUpTo(messages: readonly ChatMessage[], messageId: string): ChatMessage[] | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0 || messages[index].role !== 'assistant') return null;
  return messages.slice(0, index + 1);
}

export function canSaveAsTask(messages: readonly ChatMessage[], messageId: string): boolean {
  const range = rangeUpTo(messages, messageId);
  return Boolean(range?.some((message) => message.role === 'assistant' && (message.trajectory?.length ?? 0) > 0));
}

function cloneStep(step: TrajectoryStep): TrajectoryStep {
  return { ...step, ...(step.values ? { values: step.values.map((value) => ({ ...value })) } : {}) };
}

/**
 * 一条用户消息"真正要做的事"。快捷操作/录制指令消息的 content 只是显示标签
 * （"▶ 差旅报销单 · 金额改成 300"、"📄 总结当前网页"），真实 prompt 在 rerun 配方里；
 * 补充说明另起一行接在后面，和多轮对话里"后一句补充前一句"的拼法一致。
 */
function userGoalText(message: ChatMessage): string {
  if (!message.rerun) return message.content.trim();
  const prompt = message.rerun.shortcut.prompt.trim();
  const supplement = message.rerun.supplement?.trim();
  return [prompt, supplement].filter(Boolean).join('\n');
}

/**
 * 取数范围是"会话开头到被点的那条回复"：一次成功的对话常常跨多轮——第一轮填了一半，
 * 用户补了信息，第二轮才提交。
 */
export function buildRecordedTaskDraft(messages: readonly ChatMessage[], messageId: string): RecordedTaskDraft | null {
  if (!canSaveAsTask(messages, messageId)) return null;
  const range = rangeUpTo(messages, messageId)!;
  const all = range.flatMap((message) => (message.role === 'assistant' ? message.trajectory ?? [] : []));
  return {
    name: conversationTitle(range),
    goal: range
      .filter((message) => message.role === 'user')
      .map(userGoalText)
      .filter(Boolean)
      .join('\n'),
    // 超出上限保留最后 N 步：越靠后越接近最终走通的那条路。
    steps: all.slice(-MAX_TRAJECTORY_STEPS).map(cloneStep),
    truncated: all.length > MAX_TRAJECTORY_STEPS,
    incompleteOutcome: range.some((message) => message.taskOutcome !== undefined && message.taskOutcome.outcome !== 'success'),
  };
}

export function toRecordedShortcut(input: { name: string; goal: string; steps: TrajectoryStep[] }): ShortcutConfig {
  return {
    id: newShortcutId(),
    origin: 'recorded',
    scope: 'page',
    customized: true,
    name: input.name.trim(),
    prompt: input.goal.trim(),
    trajectory: input.steps.map(cloneStep),
  };
}
