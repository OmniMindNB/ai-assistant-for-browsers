import { describe, expect, it, vi } from 'vitest';
import { createConfirmGateState, raceWithAbort, resolveConfirmGate } from './confirm-gate';

describe('raceWithAbort', () => {
  it('returns the promise result when there is no signal', async () => {
    await expect(raceWithAbort(Promise.resolve(true))).resolves.toBe(true);
  });

  it('resolves to false immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const never = new Promise<boolean>(() => {});
    await expect(raceWithAbort(never, controller.signal)).resolves.toBe(false);
  });

  it('resolves to false when the signal aborts before the promise settles', async () => {
    const controller = new AbortController();
    let settleLater: (value: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      settleLater = resolve;
    });
    const result = raceWithAbort(pending, controller.signal);
    controller.abort();
    await expect(result).resolves.toBe(false);
    settleLater(true); // 迟到的 resolve 不应再影响已经返回的结果
  });

  it('resolves to false (not rejects) when the wrapped promise rejects and there is no signal', async () => {
    const rejected = Promise.reject(new Error('onConfirm blew up'));
    await expect(raceWithAbort(rejected)).resolves.toBe(false);
  });

  it('resolves to false (not rejects) when the wrapped promise rejects and a signal is present', async () => {
    const controller = new AbortController();
    const rejected = Promise.reject(new Error('onConfirm blew up'));
    await expect(raceWithAbort(rejected, controller.signal)).resolves.toBe(false);
  });
});

describe('resolveConfirmGate', () => {
  it('asks onConfirm once and remembers approval for later calls in the same turn', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);

    const first = await resolveConfirmGate(state, 'call-1', 'browser_click', { selector: 'button' }, '需要确认', onConfirm);
    expect(first).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const second = await resolveConfirmGate(state, 'call-2', 'browser_type', { selector: 'input' }, '需要确认', onConfirm);
    expect(second).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('remembers denial and blocks subsequent calls without asking again', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(false);

    const first = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm);
    expect(first).toEqual({ block: true, reason: '用户拒绝了该操作。' });

    const second = await resolveConfirmGate(state, 'call-2', 'browser_type', {}, '需要确认', onConfirm);
    expect(second).toEqual({ block: true, reason: '用户已拒绝本轮页面修改，不再重复询问。' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('blocks with a fixed message when no onConfirm is supplied', async () => {
    const state = createConfirmGateState();
    const result = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', undefined);
    expect(result).toEqual({ block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' });
  });

  it('treats an aborted signal as a denial', async () => {
    const state = createConfirmGateState();
    const controller = new AbortController();
    controller.abort();
    const onConfirm = vi.fn().mockImplementation(() => new Promise<boolean>(() => {}));
    const result = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, controller.signal);
    expect(result).toEqual({ block: true, reason: '用户拒绝了该操作。' });
  });
});

describe('confirm_always', () => {
  it('asks again even after the turn was already approved', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);

    await resolveConfirmGate(state, 'call-1', 'browser_fill_form', {}, '理由', onConfirm);
    expect(state.decision).toBe('approved');

    await resolveConfirmGate(state, 'call-2', 'browser_click', {}, '提交理由', onConfirm, undefined, true);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('does not write the always-decision back into the turn cache', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(false);

    await resolveConfirmGate(state, 'call-1', 'browser_fill_form', {}, '理由', vi.fn().mockResolvedValue(true));
    const denied = await resolveConfirmGate(state, 'call-2', 'browser_click', {}, '提交', onConfirm, undefined, true);

    expect(denied?.block).toBe(true);
    // 拒绝提交不能污染已经批准的填写决定
    expect(state.decision).toBe('approved');
  });

  it('records approved always-calls so the tool policy can count them as writes', async () => {
    const state = createConfirmGateState();
    await resolveConfirmGate(state, 'call-9', 'browser_click', {}, '提交', vi.fn().mockResolvedValue(true), undefined, true);
    expect(state.alwaysApprovedCallIds.has('call-9')).toBe(true);
  });
});
