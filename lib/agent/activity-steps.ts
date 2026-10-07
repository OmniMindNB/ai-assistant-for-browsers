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
  /**
   * 失败时工具返回的报错原文（已 redactText、已截断，见 run-diagnostics.ts 的 extractToolErrorText）。
   * 只在 tool_execution_end 且 isError 时写入；面板暂不渲染，供会话导出排查问题
   * （ref: 2026-09-24-conversation-export-design.md §3.1）。
   */
  errorText?: string;
  /**
   * 成功步骤的一行结果摘要（已 redactText、已截断，见 run-diagnostics.ts 的 summarizeToolResult）。
   * 与 errorText 互补：一个说失败在哪，一个说成功拿到了什么；同样只供会话导出排查。
   */
  resultText?: string;
  /**
   * 写工具结果第一行之后的全部内容（新出现元素的清单、afterToolCall 追加的 [页面位置] /
   * [跳转后页面]），已脱敏、已截断，见 summarizeToolResultDetail。只供会话导出。
   */
  resultDetail?: string;
  /**
   * 工具调用的起止时间（epoch ms），只供会话导出拆耗时：起止之间是工具本身加前后钩子
   * （含权限确认、跳转后的等待），上一步结束到这一步开始之间约等于模型那一轮的耗时。
   * 合并过重试的行记的是最后一次尝试。
   */
  startedAt?: number;
  endedAt?: number;
  /**
   * 失败步骤附带的可操作提示。目前只有一种：browser_run_script 因"允许用户脚本"开关未开而失败，
   * 面板在这一行下方给出开启入口（ref: 2026-10-02-run-script-design.md §3.5）。
   */
  hint?: 'enable_user_scripts';
}

export function upsertActivityStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === step.id);
  if (index !== -1) {
    const next = steps.slice();
    // attempt 由合并逻辑维护，不由调用方传——原地替换（tool_execution_update）时必须保住它，
    // 否则一次参数更新就会把"第 2 次尝试"抹回普通行。
    next[index] = {
      ...step,
      attempt: step.attempt ?? steps[index].attempt,
      // 同理：参数更新不该把开始时间抹掉，否则这一步的耗时就没了。
      startedAt: step.startedAt ?? steps[index].startedAt,
    };
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

/** finishActivityStep 的可选附加信息；只有传了的字段才落到步骤上。 */
export interface FinishActivityStepExtra {
  errorText?: string;
  hint?: ActivityStep['hint'];
  resultText?: string;
  resultDetail?: string;
  endedAt?: number;
}

export function finishActivityStep(
  steps: ActivityStep[],
  id: string,
  status: 'done' | 'failed',
  description: string,
  extra: FinishActivityStepExtra = {},
): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1) return steps;
  const next = steps.slice();
  const defined = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined));
  next[index] = { ...next[index], status, description, ...defined };
  return next;
}
