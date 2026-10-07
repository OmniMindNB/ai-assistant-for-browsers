import type { ActivityStep } from '@/lib/agent/activity-steps';

/**
 * header 状态行要用的"此刻在跑的那一步"及其序号。
 *
 * 序号与步骤列表（ActivityStepList）的编号规则一致：只给真正的工具调用（有 signature 的行）
 * 编号，流程提示和接管痕迹不算一步。两边口径不同的话，header 说"第 4 步"、列表里那一行
 * 却标着 3.，用户会以为有一步没显示出来。
 *
 * 取最后一个 running 的行（不用 findLast：目标环境未必有）。没有工具在跑时返回 undefined。
 */
export function findRunningStep(steps: ActivityStep[]): { step: ActivityStep; ordinal?: number } | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.status !== 'running') continue;
    if (step.signature === undefined) return { step };
    let ordinal = 0;
    for (let j = 0; j <= i; j += 1) {
      if (steps[j].signature !== undefined) ordinal += 1;
    }
    return { step, ordinal };
  }
  return undefined;
}
