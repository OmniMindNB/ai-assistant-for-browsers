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

    const first = await resolveConfirmGate(state, 'call-1', 'browser_click', { selector: 'button' }, '需要确认', onConfirm, 1);
    expect(first).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const second = await resolveConfirmGate(state, 'call-2', 'browser_type', { selector: 'input' }, '需要确认', onConfirm, 1);
    expect(second).toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('remembers denial and blocks subsequent calls without asking again', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(false);

    const first = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, 1);
    expect(first).toEqual({ block: true, reason: '用户拒绝了该操作。' });

    const second = await resolveConfirmGate(state, 'call-2', 'browser_type', {}, '需要确认', onConfirm, 1);
    expect(second).toEqual({ block: true, reason: '用户已拒绝本轮页面修改，不再重复询问。' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('blocks with a fixed message when no onConfirm is supplied', async () => {
    const state = createConfirmGateState();
    const result = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', undefined, 1);
    expect(result).toEqual({ block: true, reason: '该操作需要用户确认，当前确认 UI 尚未接入。' });
  });

  it('treats an aborted signal as a denial', async () => {
    const state = createConfirmGateState();
    const controller = new AbortController();
    controller.abort();
    const onConfirm = vi.fn().mockImplementation(() => new Promise<boolean>(() => {}));
    const result = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, 1, controller.signal);
    expect(result).toEqual({ block: true, reason: '用户拒绝了该操作。' });
  });

  describe('目标 tab 切换后重新确认（最终审查 Important #2）', () => {
    it('(a) 批准了 tab A 上的写操作后，目标切到 tab B 会重新弹出确认，不复用缓存', async () => {
      const state = createConfirmGateState();
      const onConfirm = vi.fn().mockResolvedValue(true);

      const first = await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, 1);
      expect(first).toBeUndefined();
      expect(onConfirm).toHaveBeenCalledTimes(1);

      const second = await resolveConfirmGate(state, 'call-2', 'browser_fill_form', {}, '需要确认', onConfirm, 2);
      expect(second).toBeUndefined();
      expect(onConfirm).toHaveBeenCalledTimes(2); // 目标 tab 变了，必须重新问
      expect(onConfirm).toHaveBeenLastCalledWith('call-2', 'browser_fill_form', {}, '需要确认');
    });

    it('(b) 两次调用目标是同一个 tab 时，仍然只问一次（同 tab 内"每轮只问一次"不受影响）', async () => {
      const state = createConfirmGateState();
      const onConfirm = vi.fn().mockResolvedValue(true);

      await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, 1);
      const second = await resolveConfirmGate(state, 'call-2', 'browser_type', {}, '需要确认', onConfirm, 1);

      expect(second).toBeUndefined();
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('切到新 tab 后被拒绝，不会影响回切旧 tab 已批准的状态被污染成拒绝', async () => {
      const state = createConfirmGateState();
      const onConfirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await resolveConfirmGate(state, 'call-1', 'browser_click', {}, '需要确认', onConfirm, 1);
      expect(state.decision).toBe('approved');

      const denied = await resolveConfirmGate(state, 'call-2', 'browser_click', {}, '需要确认', onConfirm, 2);
      expect(denied?.block).toBe(true);
      expect(state.decision).toBe('denied');
      expect(state.decidedForTabId).toBe(2);
    });
  });
});

describe('confirm_always', () => {
  it('asks again even after the turn was already approved', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);

    await resolveConfirmGate(state, 'call-1', 'browser_fill_form', {}, '理由', onConfirm, 1);
    expect(state.decision).toBe('approved');

    await resolveConfirmGate(state, 'call-2', 'browser_click', {}, '提交理由', onConfirm, 1, undefined, true);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('does not write the always-decision back into the turn cache', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(false);

    await resolveConfirmGate(state, 'call-1', 'browser_fill_form', {}, '理由', vi.fn().mockResolvedValue(true), 1);
    const denied = await resolveConfirmGate(state, 'call-2', 'browser_click', {}, '提交', onConfirm, 1, undefined, true);

    expect(denied?.block).toBe(true);
    // 拒绝提交不能污染已经批准的填写决定
    expect(state.decision).toBe('approved');
  });

  it('records approved always-calls so the tool policy can count them as writes', async () => {
    const state = createConfirmGateState();
    await resolveConfirmGate(state, 'call-9', 'browser_click', {}, '提交', vi.fn().mockResolvedValue(true), 1, undefined, true);
    expect(state.alwaysApprovedCallIds.has('call-9')).toBe(true);
  });

  it('(c) confirm_always 路径不受目标 tab 切换影响——本就每次都问，不读也不写 decidedForTabId', async () => {
    const state = createConfirmGateState();
    const onConfirm = vi.fn().mockResolvedValue(true);

    await resolveConfirmGate(state, 'call-1', 'browser_fill_form', {}, '提交', onConfirm, 1, undefined, true);
    expect(state.decidedForTabId).toBeNull();
    expect(state.decision).toBe('unset');

    await resolveConfirmGate(state, 'call-2', 'browser_fill_form', {}, '提交', onConfirm, 2, undefined, true);
    expect(onConfirm).toHaveBeenCalledTimes(2); // 每次都问，与 tab 是否变化无关
    expect(state.decidedForTabId).toBeNull();
  });
});
