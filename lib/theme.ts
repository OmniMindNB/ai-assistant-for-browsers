// 主题（外观）管理：默认跟随浏览器，可手动覆盖为浅色/深色。
// 通过在 <html> 上切换 .dark 类实现（ref: assets/tailwind.css 的 @custom-variant dark）。
// 主题偏好存于 chrome.storage.local，不同步到云端。
import { useEffect, useState } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'aluminum:theme';

export async function loadTheme(): Promise<ThemeMode> {
  const res = await browser.storage.local.get(THEME_KEY);
  return (res[THEME_KEY] as ThemeMode) ?? 'auto';
}

export async function saveTheme(theme: ThemeMode): Promise<void> {
  await browser.storage.local.set({ [THEME_KEY]: theme });
}

/** auto 模式下解析系统偏好；light/dark 原样返回。 */
export function resolvedTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 把解析后的主题应用到 <html>。 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolvedTheme(mode);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  return resolved;
}

/**
 * 主题 React hook：加载偏好、应用、监听系统变化，并暴露 setMode。
 * 在每个入口（侧边栏 / options）各调用一次即可；子组件通过 props 接收 mode/setMode。
 */
export function useTheme(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => Promise<void>;
} {
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolvedTheme('auto'));

  useEffect(() => {
    loadTheme().then((m) => {
      setModeState(m);
      setResolved(applyTheme(m));
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setResolved(applyTheme(mode));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  async function setMode(next: ThemeMode) {
    setModeState(next);
    setResolved(applyTheme(next));
    await saveTheme(next);
  }

  return { mode, resolved, setMode };
}
