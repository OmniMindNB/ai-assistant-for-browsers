import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadRunStateSnapshot,
  saveRunStateSnapshot,
  clearRunStateSnapshot,
  listOrphanRunTabIds,
} from './run-state-storage';
import type { RunSnapshot } from './run-port-protocol';

const store = new Map<string, unknown>();

beforeEach(() => {
  store.clear();
  (globalThis as any).browser = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        }),
        remove: vi.fn(async (key: string) => {
          store.delete(key);
        }),
        // 冷启动扫描要枚举所有 runi:agent-run:* 键，模拟 get(null) 返回全部
        getAll: undefined,
      },
    },
  };
  // browser.storage.session.get(null) 在真实 Chrome 里返回全部条目；polyfill 下同样支持传 null。
  (globalThis as any).browser.storage.session.get = vi.fn(async (key: unknown) => {
    if (key === null) return Object.fromEntries(store.entries());
    return { [key as string]: store.get(key as string) };
  });
});

function makeSnapshot(tabId: number): RunSnapshot {
  return {
    tabId,
    conversationId: 'conv-1',
    busy: true,
    messages: [],
    activitySteps: [],
    pendingConfirmation: null,
    pendingQuestion: null,
  };
}

describe('run-state-storage', () => {
  it('round-trips a snapshot for a tab', async () => {
    await saveRunStateSnapshot(7, makeSnapshot(7));
    const loaded = await loadRunStateSnapshot(7);
    expect(loaded).toEqual(makeSnapshot(7));
  });

  it('returns undefined for a tab with no saved snapshot', async () => {
    expect(await loadRunStateSnapshot(999)).toBeUndefined();
  });

  it('clears a snapshot', async () => {
    await saveRunStateSnapshot(7, makeSnapshot(7));
    await clearRunStateSnapshot(7);
    expect(await loadRunStateSnapshot(7)).toBeUndefined();
  });

  it('lists tabIds with a saved snapshot for orphan scanning', async () => {
    await saveRunStateSnapshot(7, makeSnapshot(7));
    await saveRunStateSnapshot(12, makeSnapshot(12));
    expect((await listOrphanRunTabIds()).sort((a, b) => a - b)).toEqual([7, 12]);
  });

  it('write failure degrades silently (quota exceeded etc.)', async () => {
    (globalThis as any).browser.storage.session.set = vi.fn(async () => {
      throw new Error('QUOTA_BYTES exceeded');
    });
    await expect(saveRunStateSnapshot(7, makeSnapshot(7))).resolves.toBeUndefined();
  });
});
