export interface ActivityStep {
  id: string;
  description: string;
  /**
   * 'notice' 不是一次工具调用，而是流程本身的提示（例如"已达步骤上限，正在给出结论"）。
   * 单独一档是因为拿 'done' 冒充会在文案旁边画一个 ✓，读起来像"这件事成功了"。
   */
  status: 'running' | 'done' | 'failed' | 'notice';
  /** 当前操作目标标签页的标题；只在目标不是面板自己绑定的 tab 时才有值（同 confirm-summary.ts 的约定）。 */
  tabLabel?: string;
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
): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1) return steps;
  const next = steps.slice();
  next[index] = { ...next[index], status, description };
  return next;
}
