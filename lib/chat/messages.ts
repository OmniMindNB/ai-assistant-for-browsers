import type { ChatMessageRecord } from '@/lib/db';
import type { MessageAttachment } from './attachments';
import type { TaskOutcome } from '@/lib/agent/task-outcome';
import type { ActivityStep } from '@/lib/agent/activity-steps';
import type { ShortcutRerun } from './shortcut-rerun';
import type { TabReferenceMeta } from './tab-reference';
import type { TrajectoryStep } from '@/lib/agent/task-trajectory';
import type { RunDiagnostics } from '@/lib/agent/run-diagnostics';

// 侧边栏消息的形状与派生规则（ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §3）。
// 本功能的全部可测逻辑集中在这里：vitest 只覆盖 lib/**，entrypoints/ 没有测试基建。

export interface ChatMessage {
  /** 客户端生成的稳定标识：React key + 编辑定位。不落库。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** 仅用户消息有意义：input = 普通输入（可编辑），action = 快捷操作（不可编辑） */
  kind?: 'input' | 'action';
  /** 划词提问时被引用的选区原文（裁剪后）；存在时渲染成独立的引用卡片而不是拼进 content。 */
  quotedText?: string;
  /**
   * 已就绪附件的历史安全投影（文本/图片/PDF 元数据）。图片会按
   * lib/agent/turn-context.ts 的规则在后续轮次里回放（仅限最近一条带图片的用户消息）；
   * PDF 提取文本仅用于当轮，不持久化、不回放。
   */
  attachments?: MessageAttachment[];
  /** 本轮用户显式引用的标签页（只有 title/url 元数据，不含正文）。重开会话不恢复授权。 */
  tabReferences?: TabReferenceMeta[];
  /** 本轮任务成败信号；仅当模型在一个动过页面的回合里调用了 report_task_outcome 才会有值。 */
  taskOutcome?: TaskOutcome;
  /** 本轮是否被用户点了"停止"中断；仅 assistant 消息可能为 true，用于跟正常完成区分开渲染。 */
  stopped?: boolean;
  /**
   * 本轮实际跑过的工具步骤（成功/失败/被中断都保留），随消息一起持久化供事后回看。
   * 运行期间的实时步骤条（ActivityStepList）是另一份易失状态，这里是它在轮次结束时的存档快照。
   */
  activitySteps?: ActivityStep[];
  /** 本轮是否触发过上下文窗口重切（早期历史被摘要/移出上下文）；仅 assistant 消息可能为 true。 */
  contextTruncated?: boolean;
  /** 快捷操作消息的重放配方，供「重新生成」按当时的定义重跑一遍（见 shortcut-rerun.ts）。 */
  rerun?: ShortcutRerun;
  /**
   * 本轮成功执行过的写操作参考轨迹（已脱敏）；仅 assistant 消息、且这一轮真的动过页面时才有值。
   * 供「保存为指令」取用（ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §3.5）。
   */
  trajectory?: TrajectoryStep[];
  /**
   * 这一轮的运行诊断（模型、协议、耗时、调用次数）；仅 assistant 消息、且由 run-registry 正常收尾时才有值。
   * 供会话导出排查问题（ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §3.2）。
   */
  runDiagnostics?: RunDiagnostics;
  /**
   * 推理模型本轮流式返回的推理内容，按 LLM 调用分段（一次调用一段），已按
   * lib/agent/reasoning.ts 的 MAX_REASONING_CHARS 滑动窗口限量；仅 assistant 消息、且真的收到过推理时才有值。
   * 只供面板回看：不回传给模型、不进会话导出（ref: docs/superpowers/specs/2026-09-24-reasoning-display-design.md）。
   */
  reasoning?: string[];
  /** 滑动窗口丢掉的最早那部分推理的字数；没有丢弃时不写。 */
  reasoningOmittedChars?: number;
}

const TITLE_MAX_CHARS = 40;
const DEFAULT_TITLE = '新对话';

/**
 * 只有普通输入的用户消息可编辑。
 * 快捷操作消息展示的是标签（如「📄 总结当前网页」），真正的 prompt 是另一段文字且未持久化，
 * 编辑它会把标签本身当 prompt 发出去，所以直接禁掉。
 * 存量记录没有 kind，按 input 处理。
 */
export function isEditableMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.kind !== 'action';
}

/** 返回 id 对应消息的下标；未找到返回 -1 */
export function findMessageIndex(messages: ChatMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id);
}

/** 从指定 assistant 消息往前找最近一条 user 消息；未找到（消息不存在/前面没有 user 消息）返回 undefined */
export function findPrecedingUserMessage(messages: ChatMessage[], assistantId: string): ChatMessage | undefined {
  const assistantIndex = findMessageIndex(messages, assistantId);
  if (assistantIndex < 0) return undefined;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i];
  }
  return undefined;
}

/**
 * 这条 assistant 回复能不能重新生成——两条路各自成立即可：
 * - 普通输入消息：原样重发 content（复用 editMessage 的截断重发逻辑）。
 * - 快捷操作消息：按 rerun 配方重跑一遍（标签≠真实 prompt，不能原样重发，见 shortcut-rerun.ts）。
 *
 * 存量历史里的快捷操作消息没有 rerun 配方，重跑不出来，只能不展示按钮——展示一个点了
 * 没反应的按钮比不展示更糟。
 */
export function canRegenerateMessage(messages: ChatMessage[], assistantId: string): boolean {
  const userMessage = findPrecedingUserMessage(messages, assistantId);
  if (!userMessage) return false;
  return isEditableMessage(userMessage) || userMessage.rerun !== undefined;
}

/** 编辑该条消息后将被一并丢弃的后续消息条数；id 未命中时返回 0 */
export function discardedCount(messages: ChatMessage[], id: string): number {
  const index = findMessageIndex(messages, id);
  if (index < 0) return 0;
  return messages.length - index - 1;
}

/**
 * UI 消息 → DB 记录。
 * 丢弃末尾 content 为空的 assistant 占位：一轮出错或被中止时 UI 会留下这个占位，
 * 落库后重开会话会渲染成一个空气泡。中间的空 assistant 保留，因为它承载了轮次结构。
 */
export function toMessageRecords(
  conversationId: string,
  messages: ChatMessage[],
): ChatMessageRecord[] {
  const last = messages[messages.length - 1];
  const end = last && last.role === 'assistant' && !last.content ? messages.length - 1 : messages.length;
  return messages.slice(0, end).map((message) => ({
    conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    kind: message.kind,
    quotedText: message.quotedText,
    attachments: message.attachments,
    tabReferences: message.tabReferences,
    taskOutcome: message.taskOutcome,
    stopped: message.stopped,
    activitySteps: message.activitySteps,
    contextTruncated: message.contextTruncated,
    rerun: message.rerun,
    trajectory: message.trajectory,
    runDiagnostics: message.runDiagnostics,
    reasoning: message.reasoning,
    reasoningOmittedChars: message.reasoningOmittedChars,
  }));
}

/** 会话标题取首条用户消息的前 40 字；没有用户消息时给默认标题 */
export function conversationTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = first?.content.trim();
  return text ? text.slice(0, TITLE_MAX_CHARS) : DEFAULT_TITLE;
}

/**
 * background 运行中的快照会去掉历史消息上的推理（见 lib/agent/reasoning.ts 的 stripHistoryReasoning），
 * 面板按消息 id 把自己手里的那份补回来，避免运行期间历史推理折叠块闪没。
 */
export function restoreStrippedReasoning(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const known = new Map<string, ChatMessage>();
  for (const message of previous) {
    if (message.reasoning !== undefined) known.set(message.id, message);
  }
  if (known.size === 0) return incoming;
  return incoming.map((message) => {
    if (message.reasoning !== undefined) return message;
    const source = known.get(message.id);
    if (!source) return message;
    return {
      ...message,
      reasoning: source.reasoning,
      ...(source.reasoningOmittedChars !== undefined ? { reasoningOmittedChars: source.reasoningOmittedChars } : {}),
    };
  });
}
