import type { BeforeToolCallResult } from '@earendil-works/pi-agent-core';

export type ConfirmFn = (toolCallId: string, toolName: string, args: unknown, reason: string) => Promise<boolean>;

export interface ConfirmGateState {
  decision: 'unset' | 'approved' | 'denied';
  /** confirm_always 档位下被批准的 toolCallId，供 agent.ts 判断是否要开放写预算。 */
  alwaysApprovedCallIds: Set<string>;
}

export function createConfirmGateState(): ConfirmGateState {
  return { decision: 'unset', alwaysApprovedCallIds: new Set() };
}

/**
 * signal 触发 abort 时把 promise 当作 false（拒绝）处理；
 * promise 本身 reject（例如 onConfirm 抛错）时也当作 false 处理，而不是让调用方收到一个未处理的拒绝。
 */
export async function raceWithAbort(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return promise.catch(() => false);
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
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
 * 同一个 state 实例（= 同一轮）内后续 confirm 级调用直接复用这个决定，不再重复询问。
 */
export async function resolveConfirmGate(
  state: ConfirmGateState,
  toolCallId: string,
  toolName: string,
  args: unknown,
  reason: string,
  onConfirm: ConfirmFn | undefined,
  signal?: AbortSignal,
  always = false,
): Promise<BeforeToolCallResult | undefined> {
  if (always) {
    // 提交这类不可逆操作每次都问：既不读本轮缓存，也不写回本轮缓存——
    // 用户拒绝一次提交，不应该连带撤销他已经批准的填写（ref: Spec-0005）。
    if (!onConfirm) return { block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' };
    const approvedAlways = await raceWithAbort(onConfirm(toolCallId, toolName, args, reason), signal);
    if (!approvedAlways) return { block: true, reason: '用户拒绝了该提交操作。' };
    state.alwaysApprovedCallIds.add(toolCallId);
    return undefined;
  }

  if (state.decision === 'approved') return undefined;
  if (state.decision === 'denied') {
    return { block: true, reason: '用户已拒绝本轮页面修改，不再重复询问。' };
  }
  if (!onConfirm) {
    return { block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' };
  }
  const approved = await raceWithAbort(onConfirm(toolCallId, toolName, args, reason), signal);
  state.decision = approved ? 'approved' : 'denied';
  if (!approved) return { block: true, reason: '用户拒绝了该操作。' };
  return undefined;
}
