// React 无关的 i18n 基础函数：语言偏好读写、解析、字符串插值。
// 从 index.tsx 拆出来是为了让只需要这些（比如 entrypoints/content.ts——一个跑在
// 每个页面里的内容脚本）的消费方不必连带拉入 React 运行时和完整的翻译字典。
export type LocaleMode = 'auto' | 'zh' | 'en';
export type ResolvedLocale = 'zh' | 'en';

export const LOCALE_KEY = 'runi:locale';

export async function loadLocale(): Promise<LocaleMode> {
  const res = await browser.storage.local.get(LOCALE_KEY);
  return (res[LOCALE_KEY] as LocaleMode) ?? 'auto';
}

export async function saveLocale(mode: LocaleMode): Promise<void> {
  await browser.storage.local.set({ [LOCALE_KEY]: mode });
}

/** 纯函数：给定浏览器语言标签，判断落在 zh 还是 en（未识别语言一律落到 en）。 */
export function localeFromLanguageTag(tag: string): ResolvedLocale {
  return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function detectBrowserLanguage(): string {
  return browser.i18n?.getUILanguage?.() ?? navigator.language;
}

/** auto 模式下解析浏览器语言；zh/en 原样返回。 */
export function resolveLocale(mode: LocaleMode): ResolvedLocale {
  if (mode === 'zh' || mode === 'en') return mode;
  return localeFromLanguageTag(detectBrowserLanguage());
}

/** {name} 占位符替换；未提供 vars 时原样返回。 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
