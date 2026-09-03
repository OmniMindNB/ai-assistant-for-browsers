import { describe, expect, it, vi } from 'vitest';
import { createTakeoverGateState, resolveTakeoverGate } from './takeover-gate';

const TAB = 7;

function ask(answer: boolean) {
  return vi.fn().mockResolvedValue(answer);
}

describe('resolveTakeoverGate', () => {
  it('没有接管记录时直接放行，不打扰用户', async () => {
    const onTakeover = ask(true);
    const result = await resolveTakeoverGate(
      createTakeoverGateState(), 'c1', 'browser_click', {}, TAB, undefined, onTakeover,
    );
    expect(result).toBeUndefined();
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it('有未处理的接管时询问用户；选择继续则放行', async () => {
    const state = createTakeoverGateState();
    const onTakeover = ask(true);

    const result = await resolveTakeoverGate(state, 'c1', 'browser_click', { selector: '#a' }, TAB, 1000, onTakeover);

    expect(result).toBeUndefined();
    expect(onTakeover).toHaveBeenCalledWith('c1', 'browser_click', { selector: '#a' }, TAB);
  });

  it('选择结束时拦下这次写操作，并给模型可执行的收尾指示', async () => {
    const state = createTakeoverGateState();
    const result = await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, ask(false));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('停止调用任何写操作工具');
  });

  // 一次接管只该打断一次：同一轮里后续的写操作不能反复弹同一个问题。
  it('同一次接管只问一次，之后的写操作直接放行', async () => {
    const state = createTakeoverGateState();
    const onTakeover = ask(true);

    await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, onTakeover);
    const second = await resolveTakeoverGate(state, 'c2', 'browser_type', {}, TAB, 1000, onTakeover);

    expect(second).toBeUndefined();
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it('用户又接管了一次（更新的时间戳）会重新询问', async () => {
    const state = createTakeoverGateState();
    const onTakeover = ask(true);

    await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, onTakeover);
    await resolveTakeoverGate(state, 'c2', 'browser_type', {}, TAB, 2000, onTakeover);

    expect(onTakeover).toHaveBeenCalledTimes(2);
  });

  // 用户选了"到此为止"之后，模型可能还会再试着写。那时不该把同一个问题再弹一遍，
  // 而是继续拦下——记账对两种选择都生效。
  it('选择结束后不再重复询问，但继续拦截', async () => {
    const state = createTakeoverGateState();
    const onTakeover = ask(false);

    await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, onTakeover);
    const second = await resolveTakeoverGate(state, 'c2', 'browser_type', {}, TAB, 1000, onTakeover);

    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(second).toBeUndefined();
  });

  it('按 tab 分别记账：一个 tab 上问过不影响另一个 tab', async () => {
    const state = createTakeoverGateState();
    const onTakeover = ask(true);

    await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, onTakeover);
    await resolveTakeoverGate(state, 'c2', 'browser_click', {}, TAB + 1, 1000, onTakeover);

    expect(onTakeover).toHaveBeenCalledTimes(2);
  });

  // 接管提示是"避免和用户抢"的体贴，不是安全边界（安全边界在 permissions.ts）。
  // 没接 UI 时拦死会让调用方彻底无法写入。
  it('没有接入 UI 时放行而不是拦死', async () => {
    const state = createTakeoverGateState();
    const result = await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, undefined);
    expect(result).toBeUndefined();
  });

  it('已 abort 的信号按"不继续"处理', async () => {
    const state = createTakeoverGateState();
    const controller = new AbortController();
    controller.abort();
    const onTakeover = ask(true);

    const result = await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, onTakeover, controller.signal);

    expect(result?.block).toBe(true);
  });

  it('询问过程抛错时按"不继续"处理，不把拒绝漏给调用方', async () => {
    const state = createTakeoverGateState();
    const onTakeover = vi.fn().mockRejectedValue(new Error('port closed'));

    const result = await resolveTakeoverGate(state, 'c1', 'browser_click', {}, TAB, 1000, onTakeover);

    expect(result?.block).toBe(true);
  });
});
