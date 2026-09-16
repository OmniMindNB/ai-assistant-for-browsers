import type { ToolCategory } from './activity-category';

export interface ActivityStep {
  id: string;
  description: string;
  /**
   * 'notice' 不是一次工具调用，而是流程本身的提示（例如"已达步骤上限，正在给出结论"）。
   * 单独一档是因为拿 'done' 冒充会在文案旁边画一个 ✓，读起来像"这件事成功了"。
   *
   * 'narration' 是模型自己在中间轮说的过场白（"让我先读取页面…"），由 run-registry 从
   * assistant 气泡里摘下来放进这里：它既不是工具调用也不是流程提示，而是模型的原话，
   * 所以既不编号也不画 ✓/⚠，只做一条中性的旁白。
   */
  status: 'running' | 'done' | 'failed' | 'notice' | 'narration';
  /** 当前操作目标标签页的标题；只在目标不是面板自己绑定的 tab 时才有值（同 confirm-summary.ts 的约定）。 */
  tabLabel?: string;
  /**
   * 工具类别，决定时间线上画哪个图标（见 activity-category.ts）。
   * 只有真正的工具调用有；旁白、流程提示、接管痕迹都没有，摘要也据此把它们排除在步数之外。
   */
  category?: ToolCategory;
  /**
   * 右侧那行灰字，例如"6 条结果"。只有结果天然可计数的少数工具才有
   * （见 run-registry.ts 的 describeToolResultNote），其余留空——宁可不写，不编数字。
   */
  resultNote?: string;
  /**
   * 调用签名（tool-policy.ts 的 toolSignature），用于识别"同一件事的再一次尝试"。
   * 非工具调用的步骤没有这个字段，因此永远不会被合并。
   */
  signature?: string;
  /** 第几次尝试；只有合并过重试的行才有值（>= 2）。 */
  attempt?: number;
}

export function upsertActivityStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === step.id);
  if (index !== -1) {
    const next = steps.slice();
    // attempt 由合并逻辑维护，不由调用方传——原地替换（tool_execution_update）时必须保住它，
    // 否则一次参数更新就会把"第 2 次尝试"抹回普通行。
    next[index] = { ...step, attempt: step.attempt ?? steps[index].attempt };
    return next;
  }

  // 同一个调用失败后模型往往原样再试一次，每次都是新的 toolCallId。不合并的话列表里会
  // 堆出两三行几乎一样的红字，用户看到的是"它卡住了"而不是"它在重试第 N 次"。
  // 只认紧挨着的上一行：中间隔了别的操作就说明这是一次新的尝试，不是同一件事的重试。
  const last = steps.at(-1);
  if (step.signature !== undefined && last?.signature === step.signature && last.status === 'failed') {
    return [...steps.slice(0, -1), { ...step, attempt: (last.attempt ?? 1) + 1 }];
  }

  return [...steps, step];
}

export function finishActivityStep(
  steps: ActivityStep[],
  id: string,
  status: 'done' | 'failed',
  description: string,
  resultNote?: string,
): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1) return steps;
  const next = steps.slice();
  // resultNote 只在有值时才写：显式写 undefined 会把这个键留在对象上，
  // 存进 IndexedDB 后成为一堆没用的 undefined 字段。
  next[index] = { ...next[index], status, description, ...(resultNote ? { resultNote } : {}) };
  return next;
}
