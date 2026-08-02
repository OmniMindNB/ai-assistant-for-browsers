import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextThemeMode, useTheme, type ThemeMode } from './theme';

afterEach(() => vi.restoreAllMocks());

describe('nextThemeMode', () => {
  it('skips a candidate that would resolve to the same visible theme when system prefers light', () => {
    // 系统偏好为浅色时，auto 的解析结果已经是 light；从 auto 切到 light 不该是原地不动的第一下点击。
    const resolveAsLight = (m: ThemeMode) => (m === 'auto' ? 'light' : m);
    expect(nextThemeMode('auto', 'light', resolveAsLight)).toBe('dark');
    expect(nextThemeMode('light', 'light', resolveAsLight)).toBe('dark');
    expect(nextThemeMode('dark', 'dark', resolveAsLight)).toBe('auto');
  });

  it('skips a candidate that would resolve to the same visible theme when system prefers dark', () => {
    // 系统偏好为深色时，dark -> auto 才是原地不动的一步（而不是 auto -> light）。
    const resolveAsDark = (m: ThemeMode) => (m === 'auto' ? 'dark' : m);
    expect(nextThemeMode('auto', 'dark', resolveAsDark)).toBe('light');
    expect(nextThemeMode('light', 'light', resolveAsDark)).toBe('dark');
    expect(nextThemeMode('dark', 'dark', resolveAsDark)).toBe('light');
  });
});

describe('useTheme', () => {
  it('keeps a mode change made before the initial load resolves, instead of it being overwritten afterwards', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });

    let resolveLoad: (value: Record<string, unknown>) => void = () => {};
    const pendingLoad = new Promise<Record<string, unknown>>((resolve) => {
      resolveLoad = resolve;
    });
    vi.spyOn((globalThis as any).browser.storage.local, 'get').mockReturnValue(pendingLoad);

    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('auto');

    // 用户在初次读取持久化偏好完成之前就手动切换了一次
    await act(async () => {
      await result.current.setMode('light');
    });
    expect(result.current.mode).toBe('light');

    // 现在初次加载才 resolve，返回的是切换前保存的旧值（dark）
    await act(async () => {
      resolveLoad({ 'runi:theme': 'dark' });
      await pendingLoad;
    });

    await waitFor(() => expect(result.current.mode).toBe('light'));
    expect(result.current.resolved).toBe('light');
  });

  it('still applies the persisted preference when the load resolves before any manual change', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.spyOn((globalThis as any).browser.storage.local, 'get').mockResolvedValue({ 'runi:theme': 'dark' });

    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current.mode).toBe('dark'));
    expect(result.current.resolved).toBe('dark');
  });
});
