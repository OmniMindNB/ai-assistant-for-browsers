// 主题（外观）管理：默认跟随浏览器，可手动覆盖为浅色/深色。
// 通过在 <html> 上切换 .dark 类实现（ref: assets/tailwind.css 的 @custom-variant dark）。
// 主题偏好存于 chrome.storage.local，不同步到云端。
import { useEffect, useRef, useState } from 'react';

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
 * "切换主题"按钮下一个模式：按 auto -> light -> dark -> auto 循环。
 * 循环中总有恰好一步的解析结果和当前解析主题相同（例如系统偏好浅色时，auto -> light
 * 视觉上没有变化）——那一步会被跳过，保证按钮每次点击都产生可见变化。
 */
export function nextThemeMode(
  mode: ThemeMode,
  resolved: ResolvedTheme,
  resolve: (m: ThemeMode) => ResolvedTheme = resolvedTheme,
): ThemeMode {
  const order: ThemeMode[] = ['auto', 'light', 'dark'];
  const idx = order.indexOf(mode);
  let next = order[(idx + 1) % order.length];
  if (resolve(next) === resolved) {
    next = order[(order.indexOf(next) + 1) % order.length];
  }
  return next;
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
  // loadTheme() 是异步的：如果用户在它 resolve 之前就手动切换了一次主题（比如刚打开侧边栏
  // 就点了"切换主题"），迟到的加载结果不应该覆盖用户刚做出的选择——否则效果就是"点了跟没点一样，
  // 得点第二下才生效"。用这个 ref 记录"用户是否已经手动设置过"，加载完成时据此判断要不要应用。
  const userOverrideRef = useRef(false);

  useEffect(() => {
    loadTheme().then((m) => {
      if (userOverrideRef.current) return;
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
    userOverrideRef.current = true;
    setModeState(next);
    setResolved(applyTheme(next));
    await saveTheme(next);
  }

  return { mode, resolved, setMode };
}
