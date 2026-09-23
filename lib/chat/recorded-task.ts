// 「保存为指令」的纯逻辑：从会话里取出草稿、判断按钮该不该出现、生成要落盘的配置
// （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §4）。
// 放在 lib/ 而不是组件里，理由同 messages.ts：面板的可测逻辑集中在这里。

import { isPageLocationTool, MAX_TRAJECTORY_STEPS, type TrajectoryStep } from '@/lib/agent/task-trajectory';
import { newShortcutId, type ShortcutConfig } from '@/lib/shortcuts';
import { conversationTitle, type ChatMessage } from './messages';
import { MAX_PLAYBOOK_CONTEXT_CHARS, parsePlaybook, type TaskPlaybook } from './task-playbook';

export interface RecordedTaskDraft {
  name: string;
  goal: string;
  steps: TrajectoryStep[];
  /** 会话里录到的步骤超过上限，只保留了最后 MAX_TRAJECTORY_STEPS 步。 */
  truncated: boolean;
  /** 区间内有回复报告了 partial/failure——提示，不阻止保存。 */
  incompleteOutcome: boolean;
  /** 区间内助手回复的摘录，供模型整理通用做法：从最近的往前取，合计不超过 MAX_PLAYBOOK_CONTEXT_CHARS。 */
  replyContext: string;
}

function rangeUpTo(messages: readonly ChatMessage[], messageId: string): ChatMessage[] | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0 || messages[index].role !== 'assistant') return null;
  return messages.slice(0, index + 1);
}

/**
 * 会话里某条回复录到的、可以存进指令的步骤。IndexedDB 里旧版本录下的消息还带着网址和
 * 位置类步骤，这里一并去掉：保存的指令不绑定具体页面（见 task-trajectory.ts）。
 */
function savableSteps(message: ChatMessage): TrajectoryStep[] {
  if (message.role !== 'assistant') return [];
  return (message.trajectory ?? []).filter((step) => !isPageLocationTool(step.tool));
}

export function canSaveAsTask(messages: readonly ChatMessage[], messageId: string): boolean {
  const range = rangeUpTo(messages, messageId);
  return Boolean(range?.some((message) => savableSteps(message).length > 0));
}

function cloneStep(step: TrajectoryStep): TrajectoryStep {
  const { url: _legacyUrl, ...rest } = step as TrajectoryStep & { url?: unknown };
  return { ...rest, ...(rest.values ? { values: rest.values.map((value) => ({ ...value })) } : {}) };
}

/**
 * 越靠后的回复越接近"最后是怎么做成的"，所以预算先给最近的；超出时截取那条回复的结尾。
 * 拼回时恢复时间顺序，模型读起来才是一条连贯的经过。
 */
function collectReplyContext(range: readonly ChatMessage[]): string {
  const picked: string[] = [];
  let remaining = MAX_PLAYBOOK_CONTEXT_CHARS;
  for (const message of [...range].reverse()) {
    if (remaining <= 0) break;
    if (message.role !== 'assistant') continue;
    const text = message.content.trim();
    if (!text) continue;
    const piece = text.length > remaining ? text.slice(text.length - remaining) : text;
    picked.unshift(piece);
    remaining -= piece.length + 1;
  }
  return picked.join('\n');
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
  const all = range.flatMap(savableSteps);
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
    replyContext: collectReplyContext(range),
  };
}

export function toRecordedShortcut(input: {
  name: string;
  goal: string;
  steps: TrajectoryStep[];
  playbook?: TaskPlaybook;
}): ShortcutConfig {
  // 用户在抽屉里可能把做法删空或改出空行：走同一个规范化，什么都不剩就按没有做法保存。
  const playbook = input.playbook ? parsePlaybook(input.playbook) : null;
  return {
    id: newShortcutId(),
    origin: 'recorded',
    scope: 'page',
    customized: true,
    name: input.name.trim(),
    prompt: input.goal.trim(),
    trajectory: input.steps.map(cloneStep),
    ...(playbook ? { playbook } : {}),
  };
}
