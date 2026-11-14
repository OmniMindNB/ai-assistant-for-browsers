import type { BeforeToolCallResult } from '@earendil-works/pi-agent-core';

export type ConfirmKind = 'submit' | 'commit';

/**
 * 一次确认的完整答复。布尔形态是“只回答这一次”；对象形态带上了用户在确认卡上勾选的
 * “本次任务内不再询问”——同 kind 的后续确认在整个 run 内直接沿用 approved
 * （ref: docs/superpowers/specs/2026-11-14-confirm-silence-for-run-design.md）。
 */
export type ConfirmResult = boolean | { approved: boolean; silenceForRun?: boolean };

export type ConfirmFn = (
  toolCallId: string,
  toolName: string,
  args: unknown,
  reason: string,
  /** 确认卡片的类型：结构提交（submit）还是行为规则命中的疑似提交（commit）。缺省按 submit。 */
  kind?: ConfirmKind,
) => Promise<ConfirmResult>;

export interface ConfirmGateState {
  decision: 'unset' | 'approved' | 'denied';
  /**
   * 上一次记录 decision 时的目标 tab id。目标 tab 变了，缓存的批准/拒绝就不再适用——
   * 用户批准的是"操作那个 tab"，不是"这一轮任意 tab"，必须针对新目标重新问一次
   * （ref: 最终审查 Important #2：确认门跨 tab 未重问）。
   */
  decidedForTabId: number | null;
  /** confirm_always 档位下被批准的 toolCallId，供 agent.ts 判断是否要开放写预算。 */
  alwaysApprovedCallIds: Set<string>;
  /**
   * 用户勾选“本次任务内不再询问”后按 kind 记下的静默决定（值 = 沿用的批准与否）。
   * 作用域是 run：state 随每轮 agent 重建，新任务自然从头问起；不持久化——worker 被逐的
   * run 本就不可恢复（孤儿扫描），记忆没有载体。takeover 不走 resolveConfirmGate，永远不会
   * 进这张表。与上面的 per-turn 缓存刻意不同：缓存是隐式的、随目标 tab 切换作废；这是
   * 显式知情授权，用户勾的就是“本次任务”，跨 tab 不作废。
   */
  silencedKinds: Map<ConfirmKind, boolean>;
}

export function createConfirmGateState(): ConfirmGateState {
  return {
    decision: 'unset',
    decidedForTabId: null,
    alwaysApprovedCallIds: new Set(),
    silencedKinds: new Map(),
  };
}

/**
 * signal 触发 abort 时把 promise 当作 false（拒绝）处理；
 * promise 本身 reject（例如 onConfirm 抛错）时也当作 false 处理，而不是让调用方收到一个未处理的拒绝。
 */
export async function raceWithAbort(promise: Promise<ConfirmResult>, signal?: AbortSignal): Promise<ConfirmResult> {
  if (!signal) return promise.catch(() => false);
  if (signal.aborted) return false;
  return new Promise<ConfirmResult>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(false);
      },
    );
  });
}

/**
 * 每轮只向用户确认一次：第一次 confirm 级工具调用会等待 onConfirm 的结果并记忆下来，
 * 同一个 state 实例（= 同一轮）内后续 confirm 级调用直接复用这个决定，不再重复询问——
 * 但仅限目标 tab 不变的情况下：目标 tab 变化时，缓存的决定视为过期，重新询问一次
 * （ref: 最终审查 Important #2）。
 */
export async function resolveConfirmGate(
  state: ConfirmGateState,
  toolCallId: string,
  toolName: string,
  args: unknown,
  reason: string,
  onConfirm: ConfirmFn | undefined,
  targetTabId: number,
  signal?: AbortSignal,
  always = false,
  kind: ConfirmKind = 'submit',
): Promise<BeforeToolCallResult | undefined> {
  if (always) {
    // 提交这类不可逆操作每次都问：既不读本轮缓存，也不写回本轮缓存——
    // 用户拒绝一次提交，不应该连带撤销他已经批准的填写（ref: Spec-0005）。
    // 唯一的例外是 silencedKinds：那是用户在确认卡上明确勾选的“本次任务内不再询问”，
    // 属于知情授权，与本轮缓存是两回事。
    const silenced = state.silencedKinds.get(kind);
    if (silenced !== undefined) {
      if (silenced) {
        state.alwaysApprovedCallIds.add(toolCallId);
        return undefined;
      }
      return {
        block: true,
        reason:
          kind === 'commit'
            ? '用户已选择本次任务内不再询问，按其选择拒绝了这次点击。'
            : '用户已选择本次任务内不再询问，按其选择拒绝了该提交操作。',
      };
    }
    if (!onConfirm) return { block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' };
    const decision = await raceWithAbort(onConfirm(toolCallId, toolName, args, reason, kind), signal);
    const approved = typeof decision === 'boolean' ? decision : decision.approved;
    if (typeof decision !== 'boolean' && decision.silenceForRun) {
      state.silencedKinds.set(kind, approved);
    }
    if (!approved) {
      return {
        block: true,
        reason: kind === 'commit' ? '用户拒绝了这次点击。' : '用户拒绝了该提交操作。',
      };
    }
    state.alwaysApprovedCallIds.add(toolCallId);
    return undefined;
  }

  // 目标 tab 和上次记录决定时不一样：不管上次是批准还是拒绝，都不能沿用到新目标上，
  // 重置为 unset 走下面正常的询问流程。
  if (state.decidedForTabId !== null && state.decidedForTabId !== targetTabId) {
    state.decision = 'unset';
  }

  if (state.decision === 'approved') return undefined;
  if (state.decision === 'denied') {
    return { block: true, reason: '用户已拒绝本轮页面修改，不再重复询问。' };
  }
  if (!onConfirm) {
    return { block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' };
  }
  // 对象形态在这里只取 approved：silence 是 confirm_always（提交/疑似提交）独有的授权，
  // 本档位（普通 confirm）自有 per-turn 缓存，不叠加静默。
  const decision = await raceWithAbort(onConfirm(toolCallId, toolName, args, reason), signal);
  const approved = typeof decision === 'boolean' ? decision : decision.approved;
  state.decision = approved ? 'approved' : 'denied';
  state.decidedForTabId = targetTabId;
  if (!approved) return { block: true, reason: '用户拒绝了该操作。' };
  return undefined;
}
