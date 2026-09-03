import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTakeoverForTab, getTakeoverForTab, setTakeoverForTab, takeoverStorageKey } from './tab-takeover';

const store = new Map<string, unknown>();
const get = vi.fn(async (key: string) => {
  const value = store.get(key);
  return value === undefined ? {} : { [key]: value };
});
const set = vi.fn(async (items: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(items)) store.set(key, value);
});
const remove = vi.fn(async (key: string) => {
  store.delete(key);
});

(globalThis as any).browser = { storage: { session: { get, set, remove } } };

beforeEach(() => {
  store.clear();
  get.mockClear();
  set.mockClear();
  remove.mockClear();
  get.mockImplementation(async (key: string) => {
    const value = store.get(key);
    return value === undefined ? {} : { [key]: value };
  });
  set.mockImplementation(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) store.set(key, value);
  });
});

describe('tab-takeover', () => {
  it('没接管过时返回 undefined', async () => {
    await expect(getTakeoverForTab(7)).resolves.toBeUndefined();
  });

  it('写入后能按同一个 tabId 读回时间戳', async () => {
    await setTakeoverForTab(7, 1234);
    await expect(getTakeoverForTab(7)).resolves.toBe(1234);
  });

  it('按 tabId 隔离', async () => {
    await setTakeoverForTab(7, 1234);
    await expect(getTakeoverForTab(8)).resolves.toBeUndefined();
  });

  it('后写的时间戳覆盖先写的', async () => {
    await setTakeoverForTab(7, 1000);
    await setTakeoverForTab(7, 2000);
    await expect(getTakeoverForTab(7)).resolves.toBe(2000);
  });

  it('清除后读不到', async () => {
    await setTakeoverForTab(7, 1234);
    await clearTakeoverForTab(7);
    await expect(getTakeoverForTab(7)).resolves.toBeUndefined();
  });

  it('key 带 tabId，避免不同标签页互相覆盖', () => {
    expect(takeoverStorageKey(7)).not.toBe(takeoverStorageKey(8));
  });

  // 这是提醒性质的功能，存储异常不该让整轮任务停摆。
  it('读失败时降级成"没接管过"而不是抛错', async () => {
    get.mockRejectedValueOnce(new Error('quota'));
    await expect(getTakeoverForTab(7)).resolves.toBeUndefined();
  });

  it('写失败时静默忽略', async () => {
    set.mockRejectedValueOnce(new Error('quota'));
    await expect(setTakeoverForTab(7, 1)).resolves.toBeUndefined();
  });

  it('存的不是数字时按没接管过处理', async () => {
    store.set(takeoverStorageKey(7), 'yes');
    await expect(getTakeoverForTab(7)).resolves.toBeUndefined();
  });
});
