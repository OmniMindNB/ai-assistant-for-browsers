import type { BeforeToolCallResult } from '@earendil-works/pi-agent-core';

export type ConfirmFn = (toolCallId: string, toolName: string, args: unknown, reason: string) => Promise<boolean>;

export interface ConfirmGateState {
  decision: 'unset' | 'approved' | 'denied';
}

export function createConfirmGateState(): ConfirmGateState {
  return { decision: 'unset' };
}

/** signal 触发 abort 时把 promise 当作 false（拒绝）处理。 */
export async function raceWithAbort(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return promise;
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
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
): Promise<BeforeToolCallResult | undefined> {
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
