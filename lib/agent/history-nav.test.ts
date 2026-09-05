import { describe, expect, it, vi } from 'vitest';
import { performGoBack, type GoBackDeps } from './history-nav';

function deps(overrides: Partial<GoBackDeps> = {}): GoBackDeps {
  return {
    goBack: vi.fn().mockResolvedValue(undefined),
    getTab: vi.fn().mockResolvedValue({ url: 'https://a.test/list', title: '列表页' }),
    onceLoadComplete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('performGoBack', () => {
  it('reports the new URL once the page settles', async () => {
    let call = 0;
    const getTab = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { url: 'https://a.test/detail/1', title: '详情页' }
        : { url: 'https://a.test/list', title: '列表页' };
    });
    const result = await performGoBack(deps({ getTab }));
    expect(result).toEqual({ url: 'https://a.test/list', title: '列表页', moved: true });
  });

  it('reports moved:false without waiting for the settle when goBack rejects (no history to go back to)', async () => {
    const getTab = vi.fn().mockResolvedValue({ url: 'https://a.test/only-page', title: '唯一页面' });
    const goBack = vi.fn().mockRejectedValue(new Error('Cannot go back'));
    // 监听为了不漏掉 bfcache 瞬时后退而先于 goBack 挂上（见下一条测试），所以
    // onceLoadComplete 这个 mock 必然被调用过——真正要钉死的是"goBack 都没触发导航，
    // 就绝不能付那笔等待的代价"。用一个永不落定的 promise 表达：只要实现回头去
    // await 它，这条测试就会挂到超时而不是通过。
    const onceLoadComplete = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const result = await performGoBack(deps({ getTab, goBack, onceLoadComplete }));
    expect(result).toEqual({ url: 'https://a.test/only-page', title: '唯一页面', moved: false });
  });

  it('starts waiting for the load before triggering goBack, so an instant bfcache back is not missed', async () => {
    const order: string[] = [];
    const onceLoadComplete = vi.fn().mockImplementation(async () => {
      order.push('wait-started');
    });
    const goBack = vi.fn().mockImplementation(async () => {
      order.push('go-back-triggered');
    });
    await performGoBack(deps({ goBack, onceLoadComplete }));
    expect(order).toEqual(['wait-started', 'go-back-triggered']);
  });

  it('reports moved:false when goBack resolves but the URL never changes (e.g. it timed out)', async () => {
    const getTab = vi.fn().mockResolvedValue({ url: 'https://a.test/stuck', title: '卡住的页面' });
    const result = await performGoBack(deps({ getTab }));
    expect(result).toEqual({ url: 'https://a.test/stuck', title: '卡住的页面', moved: false });
  });

  it('sanitizes a page-controlled title', async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ url: 'https://a.test/1' })
      .mockResolvedValueOnce({ url: 'https://a.test/2', title: `x${'y'.repeat(200)}` });
    const result = await performGoBack(deps({ getTab }));
    expect(result.title!.length).toBeLessThan(130);
    expect(result.title!.endsWith('…')).toBe(true);
  });

  it('falls back to the before-state URL when the tab is gone after going back', async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ url: 'https://a.test/1', title: 'A' })
      .mockResolvedValueOnce(undefined);
    const result = await performGoBack(deps({ getTab }));
    expect(result).toEqual({ url: 'https://a.test/1', title: undefined, moved: false });
  });
});
