import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOverlayForTab, getOverlayForTab, setOverlayForTab } from './tab-overlay-state';

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
});

describe('tab-overlay-state', () => {
  it('没写过时返回 undefined', async () => {
    await expect(getOverlayForTab(7)).resolves.toBeUndefined();
  });

  it('写入后能按同一个 tabId 读回', async () => {
    await setOverlayForTab(7, '正在点击「登录」');
    await expect(getOverlayForTab(7)).resolves.toEqual({ label: '正在点击「登录」' });
  });

  it('按标签页隔离', async () => {
    await setOverlayForTab(7, 'A');
    await expect(getOverlayForTab(8)).resolves.toBeUndefined();
  });

  it('清除后读不到', async () => {
    await setOverlayForTab(7, 'A');
    await clearOverlayForTab(7);
    await expect(getOverlayForTab(7)).resolves.toBeUndefined();
  });

  it('写入失败时静默降级，不抛给调用方', async () => {
    set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(setOverlayForTab(7, 'A')).resolves.toBeUndefined();
  });

  it('清除失败时同样静默降级', async () => {
    remove.mockRejectedValueOnce(new Error('boom'));
    await expect(clearOverlayForTab(7)).resolves.toBeUndefined();
  });
});
