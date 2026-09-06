export interface AgentToolPolicyOptions {
  readToolCallBudget: number;
  writeToolCallBudget: number;
}

export interface ToolPreflightBlock {
  block: true;
  reason: string;
}

/**
 * 软提醒阈值（升序）：剩余调用次数跌到某一档时提醒一次。
 * 对标 alibaba/page-agent 的 <sys> 观察注入——预算耗尽前先让模型自己有机会收尾，
 * 而不是像修复前那样毫无预警地被硬阻断。
 */
const BUDGET_WARNING_THRESHOLDS = [2, 5] as const;

/**
 * 只等待、不产出任何页面信息的工具。它们此前和一次 browser_get_html 扣得一样多，
 * 于是"页面加载慢"这件与任务难度无关的事直接吃掉了读预算。
 * 注意这里只免记账，连续失败拦截照常适用。
 */
const FREE_WAIT_TOOL_NAMES = new Set(['wait', 'browser_wait_for']);

/**
 * 免费等待的次数上限。不设上限的话，模型可以用参数各不相同的 wait 无限空转——
 * 连续失败拦截只认失败，认不出"每次都成功地等了 1 秒"。
 */
export const MAX_FREE_WAIT_CALLS = 5;

/**
 * 前若干次失败不计入预算。猜错选择器恰恰是最需要留余量重试的时刻，
 * 而修复前失败照样扣预算，等于在最该给机会的地方收紧。
 * 同样有上限：越过配额后失败恢复正常计费，配合连续失败拦截兜住失控的循环。
 */
export const MAX_FREE_FAILED_CALLS = 3;

export interface AgentToolPolicy {
  readonly completedToolCalls: number;
  readonly currentBudget: number;
  readonly exhausted: boolean;
  /** 当前档位下还剩多少次工具调用。 */
  readonly remaining: number;
  /** 跌到提醒阈值时返回一次提示文案；同一阈值不重复提醒，未到阈值返回 undefined。 */
  budgetWarning(): string | undefined;
  preflight(toolName: string, args: unknown, isWriteTool: boolean): ToolPreflightBlock | undefined;
  approveWrite(): void;
  recordPreExecutionBlock(): void;
  recordExecution(toolName: string, args: unknown, isError: boolean): void;
  prepareFinalResponse(): boolean;
  shouldStopAfterTurn(): boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/**
 * "同一个调用"的判据。这里同时是两处的单一事实来源：本文件的连续失败拦截，
 * 以及 activity-steps.ts 的重试合并——两者对"算不算同一次尝试"必须给出一致的答案，
 * 否则会出现 UI 说第 2 次尝试、策略却当成两个不同调用（或反过来）。
 */
export function toolSignature(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(canonicalize(args))}`;
}

export function createAgentToolPolicy(options: AgentToolPolicyOptions): AgentToolPolicy {
  const writeToolCallBudget = Math.max(0, options.writeToolCallBudget);
  let completedToolCalls = 0;
  let writeApproved = false;
  /** 写入获批那一刻已经用掉的次数；写档从这里往上追加，不与读档共享同一个总上限。 */
  let writePhaseStart = 0;
  let freeWaitCalls = 0;
  let freeFailedCalls = 0;
  let boundaryWriteReserved = false;
  let consecutiveFailure: { signature: string; count: number } | undefined;
  let consecutivePreExecutionBlocks = 0;
  let phase: 'active' | 'final_response_prepared' | 'final_response_running' = 'active';
  const warnedThresholds = new Set<number>();

  return {
    get completedToolCalls() {
      return completedToolCalls;
    },
    get currentBudget() {
      return writeApproved ? writePhaseStart + writeToolCallBudget : options.readToolCallBudget;
    },
    get exhausted() {
      return completedToolCalls >= this.currentBudget;
    },
    get remaining() {
      return Math.max(0, this.currentBudget - completedToolCalls);
    },
    budgetWarning() {
      const remaining = this.remaining;
      // 预算已归零时不再软提醒：此时 prepareFinalResponse 的硬指令会接管，
      // 多发一条只会和它重复。软提醒的意义是「还有余量时提前收尾」。
      if (remaining <= 0) return undefined;
      // 升序找最紧的那一档：直接跌破 2 时只发「还剩 2 次」，不补发已经过时的「还剩 5 次」。
      const threshold = BUDGET_WARNING_THRESHOLDS.find((limit) => remaining <= limit && !warnedThresholds.has(limit));
      if (threshold === undefined) return undefined;
      // 连同所有更宽松的档位一起标记为已提醒，避免下一次调用又补发一条过时提醒；
      // 也让写入批准把预算抬高后，已发过的提醒不会被重新解锁。
      for (const limit of BUDGET_WARNING_THRESHOLDS) {
        if (limit >= threshold) warnedThresholds.add(limit);
      }
      return remaining <= BUDGET_WARNING_THRESHOLDS[0]
        ? `工具调用预算只剩 ${remaining} 次，必须立刻基于现有结果给出最终回答，并说明仍不确定的部分。`
        : `工具调用预算只剩 ${remaining} 次，请开始收尾：先完成最关键的一两步，然后基于现有证据作答。`;
    },
    preflight(toolName, args, isWriteTool) {
      const signature = toolSignature(toolName, args);
      if (consecutiveFailure?.signature === signature && consecutiveFailure.count >= 2) {
        return { block: true, reason: '相同工具调用连续失败两次，已停止重复尝试。' };
      }
      if (completedToolCalls >= this.currentBudget) {
        if (isWriteTool && !writeApproved && !boundaryWriteReserved) {
          boundaryWriteReserved = true;
          return undefined;
        }
        return { block: true, reason: `工具调用次数已达到预算上限 ${this.currentBudget}。` };
      }
      return undefined;
    },
    approveWrite() {
      // 只认第一次：每次写入都重新起算的话，写档就成了永不耗尽的滚动窗口。
      if (writeApproved) return;
      writeApproved = true;
      writePhaseStart = completedToolCalls;
    },
    recordPreExecutionBlock() {
      consecutivePreExecutionBlocks += 1;
    },
    recordExecution(toolName, args, isError) {
      // 两份免费配额，各自独立且都有上限：等待类工具不产出信息，失败调用最需要重试余量。
      // 等待优先于失败判定——一次失败的 wait 归等待配额，不该白白吃掉重试余量。
      if (FREE_WAIT_TOOL_NAMES.has(toolName) && freeWaitCalls < MAX_FREE_WAIT_CALLS) {
        freeWaitCalls += 1;
      } else if (isError && freeFailedCalls < MAX_FREE_FAILED_CALLS) {
        freeFailedCalls += 1;
      } else {
        completedToolCalls += 1;
      }

      if (!isError) {
        consecutiveFailure = undefined;
        consecutivePreExecutionBlocks = 0;
        return;
      }

      const signature = toolSignature(toolName, args);
      if (consecutiveFailure?.signature === signature) {
        consecutiveFailure.count += 1;
      } else {
        consecutiveFailure = { signature, count: 1 };
      }
    },
    prepareFinalResponse() {
      if (phase !== 'active' || (!this.exhausted && consecutivePreExecutionBlocks < 2)) return false;
      phase = 'final_response_prepared';
      return true;
    },
    shouldStopAfterTurn() {
      if (phase === 'final_response_prepared') {
        phase = 'final_response_running';
        return false;
      }
      return phase === 'final_response_running';
    },
  };
}
