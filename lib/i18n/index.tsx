// 语言（i18n）管理：默认跟随浏览器，可手动覆盖为中文/English。
// 与 lib/theme.ts 的 auto/手动覆盖模式一致；偏好存于 chrome.storage.local，不同步到云端。
// React 无关的基础函数（loadLocale/saveLocale/resolveLocale/localeFromLanguageTag/interpolate）
// 已拆到 ./core.ts，这里原样 re-export，保持所有既有 import 路径不变。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { zh } from './locales/zh';
import { en } from './locales/en';
import {
  interpolate,
  loadLocale,
  localeFromLanguageTag,
  resolveLocale,
  saveLocale,
  LOCALE_KEY,
  type LocaleMode,
  type ResolvedLocale,
} from './core';

export {
  interpolate,
  loadLocale,
  localeFromLanguageTag,
  resolveLocale,
  saveLocale,
  LOCALE_KEY,
};
export type { LocaleMode, ResolvedLocale };

export type TranslationKey = keyof typeof zh;
const DICTS: Record<ResolvedLocale, Record<TranslationKey, string>> = { zh, en };

let currentLocale: ResolvedLocale = resolveLocale('auto');

/** 把解析后的语言应用到 <html lang>，并更新供非 React 代码（如 store.ts）使用的模块级当前语言。 */
export function applyLocale(mode: LocaleMode): ResolvedLocale {
  const resolved = resolveLocale(mode);
  currentLocale = resolved;
  // service worker 没有 document；background 侧调用这个函数只是为了让 t()/getCurrentLocale()
  // 读到正确的语言（describeToolActivity 等格式化函数现在跑在 background 里，见
  // docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md 的 Global Constraints）。
  if (typeof document !== 'undefined') {
    document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
  }
  return resolved;
}

/**
 * 非 hook 的查词函数：读取模块级 currentLocale，可在 React 组件外使用（如 Zustand store）。
 * 组件内优先用 useTranslation() 返回的同一个函数引用——区别只在于 useTranslation() 额外
 * 提供 resolved/locale，使组件能在语言变化时正确重渲染；t() 本身的正确性不依赖 Context。
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return interpolate(DICTS[currentLocale][key], vars);
}

export type Translate = typeof t;

/**
 * 当前解析后的语言。与 t() 读同一个模块级变量，因此在 React 组件外（如 Zustand store）
 * 的可用性和新鲜度与 t() 完全一致——都依赖 LocaleProvider 挂载时调用过 applyLocale。
 */
export function getCurrentLocale(): ResolvedLocale {
  return currentLocale;
}

interface LocaleContextValue {
  locale: LocaleMode;
  resolved: ResolvedLocale;
  setLocale: (mode: LocaleMode) => Promise<void>;
  t: Translate;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleMode>('auto');
  const [resolved, setResolved] = useState<ResolvedLocale>(() => resolveLocale('auto'));

  useEffect(() => {
    loadLocale().then((mode) => {
      setLocaleState(mode);
      setResolved(applyLocale(mode));
    });
  }, []);

  async function setLocale(next: LocaleMode) {
    setLocaleState(next);
    setResolved(applyLocale(next));
    await saveLocale(next);
  }

  return (
    <LocaleContext.Provider value={{ locale, resolved, setLocale, t }}>{children}</LocaleContext.Provider>
  );
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useTranslation must be used within LocaleProvider');
  return ctx;
}
