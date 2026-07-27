# 中英双语 UI 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Aluminum 侧边栏 + 设置页的界面文案在「跟随浏览器 / 中文 / English」三态间可切换，Chrome Web Store 商店列表提供中英文版本，README 提供英文版。

**Architecture:** 新增 `lib/i18n/` 模块（镜像 `lib/theme.ts` 的 auto/手动覆盖模式）：`locales/zh.ts`/`locales/en.ts` 是两个 key 同构（编译期用 `Record<keyof typeof zh, string>` 强制）的扁平字符串字典；`index.tsx` 提供 `resolveLocale`/`applyLocale`/`loadLocale`/`saveLocale`（存 `chrome.storage.local`）、一个 React Context（`LocaleProvider` + `useTranslation()`，供组件树内任意深度的组件直接取 `t()`，不做 prop 透传），以及一个模块级、非 hook 的 `t()`（读取 `applyLocale` 同步维护的模块级 `currentLocale` 变量），后者给 `entrypoints/sidepanel/store.ts`（Zustand store，不能用 hook）使用。

**Tech Stack:** React 18 + TypeScript（现有栈），无新增依赖。

## Global Constraints

- 语言态为 `'auto' | 'zh' | 'en'`，默认 `'auto'`；偏好持久化在 `browser.storage.local`，key 为 `aluminum:locale`（不同步云端，与主题偏好一致）。
- 不引入 `react-i18next` 等第三方 i18n 依赖。
- `lib/i18n/locales/en.ts` 必须与 `zh.ts` key 同构，用 `Record<keyof typeof zh, string>` 类型标注在编译期强制，不写运行时兜底分支。
- **不翻译**：`lib/agent/agent.ts`、`entrypoints/sidepanel/store.ts` 里的 `SYSTEM_PROMPT` 常量及发给模型的 `prompt` 变量（用户不可见的 Agent 指令），含其中「默认用中文回答，除非用户使用其他语言」的指令，维持现状不动。
- Chrome Web Store 名称/描述走 `default_locale` + `public/_locales/{zh_CN,en}/messages.json` 机制，由用户 Chrome 自身的 UI 语言决定，与应用内的语言切换器是两套独立机制，互不影响。
- 每个迁移任务在改动对应文件的同时，把该文件用到的新 key **同时**加入 `zh.ts` 和 `en.ts`（保持两个文件任何时刻都同构，`pnpm compile` 能在每个任务结束时独立通过）。
- 关联设计文档：`docs/superpowers/specs/2026-07-27-english-language-support-design.md`（含写计划阶段发现 `store.ts` 范围后补充的附录）。

---

### Task 1: `lib/i18n` 核心模块（字典 + resolveLocale/applyLocale + Context）

**Files:**
- Create: `lib/i18n/locales/zh.ts`
- Create: `lib/i18n/locales/en.ts`
- Create: `lib/i18n/index.tsx`（含 JSX，不能用 `.ts` 扩展名）
- Test: `lib/i18n/i18n.test.ts`

**Interfaces:**
- Produces（后续所有任务都依赖）：
  - `type LocaleMode = 'auto' | 'zh' | 'en'`
  - `type ResolvedLocale = 'zh' | 'en'`
  - `type TranslationKey = keyof typeof zh`
  - `type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string`
  - `localeFromLanguageTag(tag: string): ResolvedLocale`（纯函数）
  - `resolveLocale(mode: LocaleMode): ResolvedLocale`
  - `interpolate(template: string, vars?: Record<string, string | number>): string`（纯函数）
  - `loadLocale(): Promise<LocaleMode>` / `saveLocale(mode: LocaleMode): Promise<void>`
  - `applyLocale(mode: LocaleMode): ResolvedLocale`（设置 `<html lang>` + 模块级 `currentLocale`）
  - `t(key: TranslationKey, vars?): string`（模块级，非 hook，供 store.ts 用）
  - `LocaleProvider({ children }): JSX.Element`
  - `useTranslation(): { locale, resolved, setLocale, t }`

- [ ] **Step 1: 写测试（此时 `./index` 还不存在，预期失败）**

创建 `lib/i18n/i18n.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { interpolate, localeFromLanguageTag, resolveLocale } from './index';

describe('localeFromLanguageTag', () => {
  it('maps zh-prefixed tags to zh', () => {
    expect(localeFromLanguageTag('zh')).toBe('zh');
    expect(localeFromLanguageTag('zh-CN')).toBe('zh');
    expect(localeFromLanguageTag('zh-TW')).toBe('zh');
  });

  it('is case-insensitive', () => {
    expect(localeFromLanguageTag('ZH-Hans')).toBe('zh');
  });

  it('falls back to en for any non-zh tag', () => {
    expect(localeFromLanguageTag('en')).toBe('en');
    expect(localeFromLanguageTag('en-US')).toBe('en');
    expect(localeFromLanguageTag('fr')).toBe('en');
    expect(localeFromLanguageTag('ja')).toBe('en');
  });
});

describe('resolveLocale', () => {
  it('returns zh/en as-is without touching the browser language', () => {
    expect(resolveLocale('zh')).toBe('zh');
    expect(resolveLocale('en')).toBe('en');
  });
});

describe('interpolate', () => {
  it('returns the template unchanged when no vars are given', () => {
    expect(interpolate('例如 {value}')).toBe('例如 {value}');
  });

  it('substitutes known {name} placeholders', () => {
    expect(interpolate('例如 {value}', { value: 'DeepSeek' })).toBe('例如 DeepSeek');
    expect(interpolate('{minutes}分{seconds}秒', { minutes: 1, seconds: 30 })).toBe('1分30秒');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolate('hello {name}', { other: 'x' })).toBe('hello {name}');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/i18n/i18n.test.ts`
Expected: FAIL — `Cannot find module './index'` 或等价的模块解析错误。

- [ ] **Step 3: 创建种子字典 `lib/i18n/locales/zh.ts`**

```ts
export const zh = {
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.edit': '编辑',
  'common.hide': '隐藏',
  'common.show': '显示',
  'common.settings': '设置',
  'common.newChat': '新对话',
  'common.collapseSidebar': '收起侧边栏',
  'common.expandSidebar': '展开侧边栏',
  'common.send': '发送',
  'common.followSystem': '跟随浏览器',
  'appearance.heading': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.themeAriaLabel': '主题：{label}，点击切换',
  'appearance.themeTitle': '主题：{label}',
} as const;
```

- [ ] **Step 4: 创建种子字典 `lib/i18n/locales/en.ts`**

```ts
import { zh } from './zh';

export const en: Record<keyof typeof zh, string> = {
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.hide': 'Hide',
  'common.show': 'Show',
  'common.settings': 'Settings',
  'common.newChat': 'New Chat',
  'common.collapseSidebar': 'Collapse sidebar',
  'common.expandSidebar': 'Expand sidebar',
  'common.send': 'Send',
  'common.followSystem': 'System',
  'appearance.heading': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.themeAriaLabel': 'Theme: {label}, click to toggle',
  'appearance.themeTitle': 'Theme: {label}',
};
```

- [ ] **Step 5: 创建 `lib/i18n/index.tsx`**

```tsx
// 语言（i18n）管理：默认跟随浏览器，可手动覆盖为中文/English。
// 与 lib/theme.ts 的 auto/手动覆盖模式一致；偏好存于 chrome.storage.local，不同步到云端。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { zh } from './locales/zh';
import { en } from './locales/en';

export type LocaleMode = 'auto' | 'zh' | 'en';
export type ResolvedLocale = 'zh' | 'en';
export type TranslationKey = keyof typeof zh;

const LOCALE_KEY = 'aluminum:locale';
const DICTS: Record<ResolvedLocale, Record<TranslationKey, string>> = { zh, en };

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

let currentLocale: ResolvedLocale = 'zh';

/** 把解析后的语言应用到 <html lang>，并更新供非 React 代码（如 store.ts）使用的模块级当前语言。 */
export function applyLocale(mode: LocaleMode): ResolvedLocale {
  const resolved = resolveLocale(mode);
  currentLocale = resolved;
  document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
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
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm vitest run lib/i18n/i18n.test.ts`
Expected: PASS（10 个 `it`）。

- [ ] **Step 7: 类型检查**

Run: `pnpm compile`
Expected: 无新增错误。

- [ ] **Step 8: Commit**

```bash
git add lib/i18n/
git commit -m "feat: add lib/i18n core module (locale resolve/persist + t())"
```

---

### Task 2: 把 `LocaleProvider` 接入两个入口的 `main.tsx`

**Files:**
- Modify: `entrypoints/sidepanel/main.tsx`
- Modify: `entrypoints/options/main.tsx`

**Interfaces:**
- Consumes：Task 1 的 `applyLocale('auto')`、`LocaleProvider`（从 `@/lib/i18n`）。

- [ ] **Step 1: 修改 `entrypoints/sidepanel/main.tsx`**

Old:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/tailwind.css';
import { applyTheme } from '@/lib/theme';

// 先按系统偏好应用主题，避免加载前的闪烁；useTheme 会用存储的偏好修正。
applyTheme('auto');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```
New:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/tailwind.css';
import { applyTheme } from '@/lib/theme';
import { applyLocale, LocaleProvider } from '@/lib/i18n';

// 先按系统偏好应用主题/语言，避免加载前的闪烁；useTheme/LocaleProvider 会用存储的偏好修正。
applyTheme('auto');
applyLocale('auto');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 2: 对 `entrypoints/options/main.tsx` 做同样的修改**

（内容与上面完全一致，只是文件路径不同。）

- [ ] **Step 3: 类型检查 + 手动验证**

Run: `pnpm compile`
Expected: 无错误（`App` 组件目前还没用到 `useTranslation`，但 Provider 包裹本身不影响编译）。

Run: `pnpm dev`，在 `chrome://extensions` 加载 `.output/chrome-mv3`，打开侧边栏，`F12` 打开 DevTools 确认 `document.documentElement.lang` 是 `zh-CN` 或 `en`（取决于系统语言），无渲染报错。

- [ ] **Step 4: Commit**

```bash
git add entrypoints/sidepanel/main.tsx entrypoints/options/main.tsx
git commit -m "feat: wire LocaleProvider into sidepanel and options entrypoints"
```

---

### Task 3: `AppearanceSettings.tsx` 迁移 + 新增 `LanguageSettings.tsx`

**Files:**
- Modify: `components/AppearanceSettings.tsx`
- Create: `components/LanguageSettings.tsx`

**Interfaces:**
- Consumes：Task 1 的 `useTranslation()`、`LocaleMode`。
- Produces：`LanguageSettings({ mode: LocaleMode, onSet: (mode: LocaleMode) => void })` — 供 Task 4/7 挂载。

- [ ] **Step 1: 新增字典 key（`language.*`）**

`lib/i18n/locales/zh.ts`，在 `'appearance.themeTitle': '主题：{label}',` 之后追加：

```ts
  'language.heading': '语言',
  'language.zh': '中文',
  'language.en': 'English',
```

`lib/i18n/locales/en.ts`，在对应位置追加：

```ts
  'language.heading': 'Language',
  'language.zh': '中文',
  'language.en': 'English',
```

- [ ] **Step 2: 迁移 `components/AppearanceSettings.tsx`**

完整替换文件内容为：

```tsx
// 外观（主题）设置：跟随浏览器 / 浅色 / 深色。
// 纯展示组件，主题状态由父组件通过 useTheme 提供（ref: lib/theme.ts）。
import type { ThemeMode } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';

export default function AppearanceSettings({
  mode,
  onSet,
}: {
  mode: ThemeMode;
  onSet: (mode: ThemeMode) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: ThemeMode; label: string }> = [
    { value: 'auto', label: t('common.followSystem') },
    { value: 'light', label: t('appearance.light') },
    { value: 'dark', label: t('appearance.dark') },
  ];
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {t('appearance.heading')}
      </h2>
      <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
        {options.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onSet(opt.value)}
              className={[
                'rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                active
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
              ].join(' ')}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: 新增 `components/LanguageSettings.tsx`**

```tsx
// 语言设置：跟随浏览器 / 中文 / English。结构与 AppearanceSettings.tsx 对称。
import { useTranslation, type LocaleMode } from '@/lib/i18n';

export default function LanguageSettings({
  mode,
  onSet,
}: {
  mode: LocaleMode;
  onSet: (mode: LocaleMode) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: LocaleMode; label: string }> = [
    { value: 'auto', label: t('common.followSystem') },
    { value: 'zh', label: t('language.zh') },
    { value: 'en', label: t('language.en') },
  ];
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {t('language.heading')}
      </h2>
      <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
        {options.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onSet(opt.value)}
              className={[
                'rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                active
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
              ].join(' ')}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm compile`
Expected: 无错误。（`LanguageSettings` 目前还没被任何页面引用，属正常的未使用导出，不是编译错误。）

- [ ] **Step 5: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts components/AppearanceSettings.tsx components/LanguageSettings.tsx
git commit -m "feat: translate AppearanceSettings and add LanguageSettings component"
```

---

### Task 4: `entrypoints/options/App.tsx` 迁移

**Files:**
- Modify: `entrypoints/options/App.tsx`

**Interfaces:**
- Consumes：Task 3 的 `LanguageSettings`；Task 1 的 `useTranslation()`。

- [ ] **Step 1: 新增字典 key**

`lib/i18n/locales/zh.ts` 追加：

```ts
  'settings.pageTitle': 'Aluminum 设置',
  'settings.descriptionPrefix': '配置 OpenAI 兼容的模型 Provider。API Key 仅保存在本机',
  'settings.optionsDescriptionSuffix': '，不会上传或同步（ref: technical-plan.md §6）。',
```

`lib/i18n/locales/en.ts` 追加：

```ts
  'settings.pageTitle': 'Aluminum Settings',
  'settings.descriptionPrefix':
    'Configure an OpenAI-compatible model provider. The API key is stored only on this device in',
  'settings.optionsDescriptionSuffix': ', and is never uploaded or synced (ref: technical-plan.md §6).',
```

- [ ] **Step 2: 迁移 `entrypoints/options/App.tsx`**

完整替换文件内容为：

```tsx
import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import LanguageSettings from '@/components/LanguageSettings';
import { useTheme } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';

export default function App() {
  const { mode, setMode } = useTheme();
  const { t, locale, setLocale } = useTranslation();
  return (
    <div className="min-h-screen bg-neutral-50 p-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold">{t('settings.pageTitle')}</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
          {t('settings.descriptionPrefix')}
          <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
          {t('settings.optionsDescriptionSuffix')}
        </p>
        <AppearanceSettings mode={mode} onSet={setMode} />
        <LanguageSettings mode={locale} onSet={setLocale} />
        <ProviderSettings />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 手动验证**

Run: `pnpm compile`
Expected: 无错误。

Run: `pnpm dev`，打开扩展的 options 页（`chrome://extensions` → Aluminum → 详情 → 扩展程序选项），确认页面标题、描述、外观/语言两个切换器都正常渲染，点击语言切换器在「跟随浏览器/中文/English」间点击，标题文案跟着变化。

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/options/App.tsx
git commit -m "feat: translate options page and wire in language switcher"
```

---

### Task 5: `entrypoints/sidepanel/MessageEditor.tsx` 迁移

**Files:**
- Modify: `entrypoints/sidepanel/MessageEditor.tsx`

- [ ] **Step 1: 新增字典 key**

`lib/i18n/locales/zh.ts` 追加：

```ts
  'chat.editMessageEditorAriaLabel': '编辑消息',
  'chat.editDiscardWarning': '提交后将丢弃后续 {count} 条消息',
```

`lib/i18n/locales/en.ts` 追加：

```ts
  'chat.editMessageEditorAriaLabel': 'Edit message',
  'chat.editDiscardWarning': 'Submitting will discard the following {count} message(s)',
```

- [ ] **Step 2: 迁移 `entrypoints/sidepanel/MessageEditor.tsx`**

Old（文件顶部 import）：
```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
```
New：
```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n';
```

Old（组件内部，state 声明之后）：
```tsx
  const [text, setText] = useState(initialContent);
  const ref = useRef<HTMLTextAreaElement>(null);
```
New：
```tsx
  const { t } = useTranslation();
  const [text, setText] = useState(initialContent);
  const ref = useRef<HTMLTextAreaElement>(null);
```

Old：
```tsx
        aria-label="编辑消息"
```
New：
```tsx
        aria-label={t('chat.editMessageEditorAriaLabel')}
```

Old：
```tsx
        <span className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
          {discardCount > 0 ? `提交后将丢弃后续 ${discardCount} 条消息` : ''}
        </span>
```
New：
```tsx
        <span className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
          {discardCount > 0 ? t('chat.editDiscardWarning', { count: discardCount }) : ''}
        </span>
```

Old：
```tsx
          >
            取消
          </button>
```
New：
```tsx
          >
            {t('common.cancel')}
          </button>
```

Old：
```tsx
          >
            发送
          </button>
```
New：
```tsx
          >
            {t('common.send')}
          </button>
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/sidepanel/MessageEditor.tsx
git commit -m "feat: translate MessageEditor"
```

---

### Task 6: `components/ProviderSettings.tsx` + `lib/settings.ts` 迁移

**Files:**
- Modify: `components/ProviderSettings.tsx`
- Modify: `lib/settings.ts:96-136`
- Modify: `lib/settings.test.ts`（在既有 `describe('draftPlaceholders', ...)` 内追加用例）

**Interfaces:**
- Produces：`draftPlaceholders(value: string, locale: ProviderPlaceholderLocale = 'zh'): DraftPlaceholders`
  —— 新增可选第二参数，默认值 `'zh'` 使既有调用点（含所有既存测试）行为不变。

- [ ] **Step 1: 修改 `lib/settings.ts:96-136`（`draftPlaceholders` 及其常量）**

Old：
```ts
/** 「添加/编辑 Provider」表单四个输入框的 placeholder 文案。 */
export interface DraftPlaceholders {
  name: string;
  baseURL: string;
  model: string;
  extras: string;
}

/** 自定义态：示例必须与具体厂商无关，否则会误导用户以为该字段有固定取值。 */
const CUSTOM_PLACEHOLDERS: DraftPlaceholders = {
  name: '例如 我的中转站',
  baseURL: 'https://your-host/v1',
  model: '例如 模型名',
  extras: '例如 备用模型名, 另一个模型名',
};

/** 占位符态（尚未选择任何预设）沿用既有的 DeepSeek 风格示例。 */
const DEFAULT_PLACEHOLDERS: DraftPlaceholders = {
  name: '例如 DeepSeek',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  extras: '例如 deepseek-v4-flash',
};

/**
 * 下拉值 → 各输入框 placeholder。
 * 「其他可用模型」不被任何预设填充，故其 placeholder 需随选中预设切换，展示该厂商的其他模型示例。
 */
export function draftPlaceholders(value: string): DraftPlaceholders {
  if (value === CUSTOM_PRESET_VALUE) return CUSTOM_PLACEHOLDERS;
  const preset = PROVIDER_PRESETS.find((p) => p.name === value);
  if (!preset) return DEFAULT_PLACEHOLDERS;
  const extras = (preset.models ?? []).filter((m) => m !== preset.model);
  return {
    name: `例如 ${preset.name}`,
    baseURL: preset.baseURL,
    model: preset.model,
    // 无其他模型可举例时不给提示：给错厂商的示例比不给示例更糟。
    extras: extras.length ? `例如 ${extras.join(', ')}` : '',
  };
}
```

New：
```ts
/** 「添加/编辑 Provider」表单四个输入框的 placeholder 文案。 */
export interface DraftPlaceholders {
  name: string;
  baseURL: string;
  model: string;
  extras: string;
}

/** draftPlaceholders 的语言参数；与 lib/i18n 的 ResolvedLocale 同构，但本文件不依赖 lib/i18n。 */
export type ProviderPlaceholderLocale = 'zh' | 'en';

/** 自定义态：示例必须与具体厂商无关，否则会误导用户以为该字段有固定取值。 */
const CUSTOM_PLACEHOLDERS_BY_LOCALE: Record<ProviderPlaceholderLocale, DraftPlaceholders> = {
  zh: {
    name: '例如 我的中转站',
    baseURL: 'https://your-host/v1',
    model: '例如 模型名',
    extras: '例如 备用模型名, 另一个模型名',
  },
  en: {
    name: 'e.g. My Relay Station',
    baseURL: 'https://your-host/v1',
    model: 'e.g. model name',
    extras: 'e.g. backup-model, another-model',
  },
};

/** 「例如 X」/「e.g. X」——预设分支的示例值本身语言中立（品牌/模型名），只有这层前缀按语言切换。 */
function examplePrefix(locale: ProviderPlaceholderLocale, value: string): string {
  return locale === 'en' ? `e.g. ${value}` : `例如 ${value}`;
}

/** 占位符态（尚未选择任何预设）沿用既有的 DeepSeek 风格示例；品牌/模型名本身不翻译。 */
function defaultPlaceholders(locale: ProviderPlaceholderLocale): DraftPlaceholders {
  return {
    name: examplePrefix(locale, 'DeepSeek'),
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    extras: examplePrefix(locale, 'deepseek-v4-flash'),
  };
}

/**
 * 下拉值 → 各输入框 placeholder。
 * 「其他可用模型」不被任何预设填充，故其 placeholder 需随选中预设切换，展示该厂商的其他模型示例。
 * locale 默认 'zh'，保持调用方不传时的既有行为不变。
 */
export function draftPlaceholders(
  value: string,
  locale: ProviderPlaceholderLocale = 'zh',
): DraftPlaceholders {
  if (value === CUSTOM_PRESET_VALUE) return CUSTOM_PLACEHOLDERS_BY_LOCALE[locale];
  const preset = PROVIDER_PRESETS.find((p) => p.name === value);
  if (!preset) return defaultPlaceholders(locale);
  const extras = (preset.models ?? []).filter((m) => m !== preset.model);
  return {
    name: examplePrefix(locale, preset.name),
    baseURL: preset.baseURL,
    model: preset.model,
    // 无其他模型可举例时不给提示：给错厂商的示例比不给示例更糟。
    extras: extras.length ? examplePrefix(locale, extras.join(', ')) : '',
  };
}
```

- [ ] **Step 2: 运行既有测试，确认零改动的情况下仍全部通过（回归防线）**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: PASS（`draftPlaceholders` 相关的 5 条既有用例不变，因为默认 `locale = 'zh'` 与旧行为字节相同）。

- [ ] **Step 3: 在 `lib/settings.test.ts` 追加英文用例**

在文件末尾 `describe('draftPlaceholders', ...)` 块的最后一个 `it` 之后（第 237-239 行）追加：

Old：
```ts
  it('falls back to the default placeholders for an unknown vendor name', () => {
    expect(draftPlaceholders('NoSuchVendor')).toEqual(draftPlaceholders(''));
  });
});
```
New：
```ts
  it('falls back to the default placeholders for an unknown vendor name', () => {
    expect(draftPlaceholders('NoSuchVendor')).toEqual(draftPlaceholders(''));
  });

  it('gives English examples for the custom selection when locale is en', () => {
    const p = draftPlaceholders(CUSTOM_PRESET_VALUE, 'en');
    expect(p.name).toBe('e.g. My Relay Station');
    expect(p.baseURL).toBe('https://your-host/v1');
    expect(p.model).toBe('e.g. model name');
    expect(p.extras).toBe('e.g. backup-model, another-model');
  });

  it('uses an "e.g." prefix for preset examples when locale is en', () => {
    const p = draftPlaceholders('OpenAI', 'en');
    expect(p.name).toBe('e.g. OpenAI');
    expect(p.baseURL).toBe('https://api.openai.com/v1');
    expect(p.model).toBe('gpt-5.6-sol');
    expect(p.extras).toBe('e.g. gpt-5.6-terra, gpt-5.6-luna');
  });

  it('keeps DeepSeek-flavoured examples with an "e.g." prefix for the empty state in en', () => {
    const p = draftPlaceholders('', 'en');
    expect(p.name).toBe('e.g. DeepSeek');
    expect(p.baseURL).toBe('https://api.deepseek.com');
    expect(p.model).toBe('deepseek-v4-pro');
    expect(p.extras).toBe('e.g. deepseek-v4-flash');
  });
});
```

- [ ] **Step 4: 运行测试，确认新增用例通过**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: PASS（全部用例，含新增 3 条）。

- [ ] **Step 5: 新增字典 key（`provider.*`）**

`lib/i18n/locales/zh.ts` 追加：

```ts
  'provider.configuredHeading': '已配置的 Provider',
  'provider.emptyList': '尚未配置任何 Provider，请在下方添加。',
  'provider.setActiveTitle': '设为当前 Provider',
  'provider.activeBadge': '当前',
  'provider.keyNotSet': '未填写',
  'provider.confirmDelete': '确认删除？',
  'provider.editHeading': '编辑 Provider',
  'provider.addHeading': '添加 Provider',
  'provider.removedElsewhere': '此 Provider 已在别处被删除，继续保存不会生效。',
  'provider.discardEdit': '放弃编辑',
  'provider.removedElsewhereFlash': '该 Provider 已在别处被删除，请放弃编辑',
  'provider.presetLabel': '快速预设',
  'provider.presetPlaceholderOption': '选择以填充 Base URL / 模型…',
  'provider.customOption': '自定义（手动填写）',
  'provider.fieldName': '名称',
  'provider.fieldApiType': '协议类型',
  'provider.apiOpenAI': 'OpenAI 兼容',
  'provider.apiAnthropic': 'Anthropic 兼容',
  'provider.fieldModel': '模型（默认）',
  'provider.fieldExtraModels': '其他可用模型（逗号分隔，可选）',
  'provider.saveChanges': '保存修改',
  'provider.addSubmit': '添加',
  'provider.flashFillRequired': '请填写名称、Base URL 和模型',
  'provider.flashSavedDuplicate': '已保存（存在同名 Provider）',
  'provider.flashSaved': '已保存',
```

`lib/i18n/locales/en.ts` 追加：

```ts
  'provider.configuredHeading': 'Configured providers',
  'provider.emptyList': 'No providers configured yet. Add one below.',
  'provider.setActiveTitle': 'Set as active provider',
  'provider.activeBadge': 'Active',
  'provider.keyNotSet': 'Not set',
  'provider.confirmDelete': 'Confirm delete?',
  'provider.editHeading': 'Edit provider',
  'provider.addHeading': 'Add provider',
  'provider.removedElsewhere': 'This provider was deleted elsewhere; saving will have no effect.',
  'provider.discardEdit': 'Discard edit',
  'provider.removedElsewhereFlash': 'This provider was deleted elsewhere — discard your edit',
  'provider.presetLabel': 'Quick preset',
  'provider.presetPlaceholderOption': 'Select to fill in Base URL / model…',
  'provider.customOption': 'Custom (fill in manually)',
  'provider.fieldName': 'Name',
  'provider.fieldApiType': 'Protocol',
  'provider.apiOpenAI': 'OpenAI-compatible',
  'provider.apiAnthropic': 'Anthropic-compatible',
  'provider.fieldModel': 'Model (default)',
  'provider.fieldExtraModels': 'Other available models (comma-separated, optional)',
  'provider.saveChanges': 'Save changes',
  'provider.addSubmit': 'Add',
  'provider.flashFillRequired': 'Please fill in name, Base URL, and model',
  'provider.flashSavedDuplicate': 'Saved (a provider with this name already exists)',
  'provider.flashSaved': 'Saved',
```

- [ ] **Step 6: 迁移 `components/ProviderSettings.tsx`**

Old（顶部 import）：
```tsx
import { useEffect, useRef, useState } from 'react';
import {
  loadSettings,
  saveSettings,
  newProviderId,
  applyPresetToDraft,
  draftPlaceholders,
  hasDuplicateProviderName,
  resolvePresetSelection,
  trimProviderDraft,
  CUSTOM_PRESET_VALUE,
  PROVIDER_PRESETS,
  STORAGE_KEY,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';
```
New：
```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import {
  loadSettings,
  saveSettings,
  newProviderId,
  applyPresetToDraft,
  draftPlaceholders,
  hasDuplicateProviderName,
  resolvePresetSelection,
  trimProviderDraft,
  CUSTOM_PRESET_VALUE,
  PROVIDER_PRESETS,
  STORAGE_KEY,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';
```

Old（组件顶部）：
```tsx
export default function ProviderSettings({ onChange }: { onChange?: () => void }) {
  const [settings, setSettings] = useState<Settings>({ providers: [] });
```
New：
```tsx
export default function ProviderSettings({ onChange }: { onChange?: () => void }) {
  const { t, resolved } = useTranslation();
  const [settings, setSettings] = useState<Settings>({ providers: [] });
```

Old：
```tsx
  function flash(msg: string) {
```
（不变，`flash` 本身不含中文，调用方传入已翻译好的字符串，见下方几处。）

Old：
```tsx
    if (editingRemoved) {
      flash('该 Provider 已在别处被删除，请放弃编辑');
      return;
    }
    const trimmed = trimProviderDraft(draft);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
```
New：
```tsx
    if (editingRemoved) {
      flash(t('provider.removedElsewhereFlash'));
      return;
    }
    const trimmed = trimProviderDraft(draft);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash(t('provider.flashFillRequired'));
      return;
    }
```

Old：
```tsx
      flash(isDuplicateName ? '已保存（存在同名 Provider）' : '已保存');
```
New：
```tsx
      flash(isDuplicateName ? t('provider.flashSavedDuplicate') : t('provider.flashSaved'));
```

Old：
```tsx
  const placeholders = draftPlaceholders(selectedPreset);
```
New：
```tsx
  const placeholders = draftPlaceholders(selectedPreset, resolved);
```

Old：
```tsx
        <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          已配置的 Provider
        </h2>
        {settings.providers.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-4 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
            尚未配置任何 Provider，请在下方添加。
          </p>
```
New：
```tsx
        <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {t('provider.configuredHeading')}
        </h2>
        {settings.providers.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-4 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
            {t('provider.emptyList')}
          </p>
```

Old：
```tsx
                    onChange={() => setActive(p.id)}
                    title="设为当前 Provider"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {p.name}
                      {active && (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/40 dark:text-green-300">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                      {p.model} · {p.baseURL} · Key {p.apiKey ? '••••' + p.apiKey.slice(-4) : '未填写'}
                    </div>
                  </div>
                  <button
                    onClick={() => loadDraft(p)}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() =>
                      confirmingDeleteId === p.id ? confirmDelete(p.id) : requestDelete(p.id)
                    }
                    className={
                      confirmingDeleteId === p.id
                        ? 'rounded border border-red-600 bg-red-600 px-2 py-1 text-xs text-white transition-colors hover:bg-red-700'
                        : 'rounded border border-red-200 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40'
                    }
                  >
                    {confirmingDeleteId === p.id ? '确认删除？' : '删除'}
                  </button>
```
New：
```tsx
                    onChange={() => setActive(p.id)}
                    title={t('provider.setActiveTitle')}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {p.name}
                      {active && (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/40 dark:text-green-300">
                          {t('provider.activeBadge')}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                      {p.model} · {p.baseURL} · Key {p.apiKey ? '••••' + p.apiKey.slice(-4) : t('provider.keyNotSet')}
                    </div>
                  </div>
                  <button
                    onClick={() => loadDraft(p)}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() =>
                      confirmingDeleteId === p.id ? confirmDelete(p.id) : requestDelete(p.id)
                    }
                    className={
                      confirmingDeleteId === p.id
                        ? 'rounded border border-red-600 bg-red-600 px-2 py-1 text-xs text-white transition-colors hover:bg-red-700'
                        : 'rounded border border-red-200 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40'
                    }
                  >
                    {confirmingDeleteId === p.id ? t('provider.confirmDelete') : t('common.delete')}
                  </button>
```

Old：
```tsx
        <h2 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {isEditing ? '编辑 Provider' : '添加 Provider'}
        </h2>

        {editingRemoved && (
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            此 Provider 已在别处被删除，继续保存不会生效。
            <button type="button" onClick={resetDraft} className="ml-2 underline">
              放弃编辑
            </button>
          </p>
        )}

        <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
          快速预设
          <select
            className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={selectedPreset}
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">选择以填充 Base URL / 模型…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            {/* 用 disabled option 而非 <hr>：<hr> in <select> 仅较新 Chromium 支持，项目同时构建 Firefox */}
            <option disabled>──────────</option>
            <option value={CUSTOM_PRESET_VALUE}>自定义（手动填写）</option>
          </select>
        </label>
```
New：
```tsx
        <h2 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {isEditing ? t('provider.editHeading') : t('provider.addHeading')}
        </h2>

        {editingRemoved && (
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {t('provider.removedElsewhere')}
            <button type="button" onClick={resetDraft} className="ml-2 underline">
              {t('provider.discardEdit')}
            </button>
          </p>
        )}

        <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
          {t('provider.presetLabel')}
          <select
            className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={selectedPreset}
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">{t('provider.presetPlaceholderOption')}</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            {/* 用 disabled option 而非 <hr>：<hr> in <select> 仅较新 Chromium 支持，项目同时构建 Firefox */}
            <option disabled>──────────</option>
            <option value={CUSTOM_PRESET_VALUE}>{t('provider.customOption')}</option>
          </select>
        </label>
```

Old：
```tsx
          <Field
            label="名称"
            value={draft.name}
            placeholder={placeholders.name}
            required
            onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
          />
          <Field
            label="Base URL"
            value={draft.baseURL}
            placeholder={placeholders.baseURL}
            required
            onChange={(v) => setDraft((d) => ({ ...d, baseURL: v }))}
          />
          <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
            协议类型
            <select
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              value={draft.api ?? 'openai-completions'}
              onChange={(e) =>
                setDraft((d) => ({ ...d, api: e.target.value as ProviderConfig['api'] }))
              }
            >
              <option value="openai-completions">OpenAI 兼容</option>
              <option value="anthropic-messages">Anthropic 兼容</option>
            </select>
          </label>
          <Field
            label="模型（默认）"
            value={draft.model}
            placeholder={placeholders.model}
            required
            onChange={(v) => setDraft((d) => ({ ...d, model: v }))}
          />
          <Field
            label="其他可用模型（逗号分隔，可选）"
            value={extrasText}
            placeholder={placeholders.extras}
            onChange={setExtrasText}
          />
          <Field
            label="API Key"
            type="password"
            toggleable
            value={draft.apiKey}
            placeholder="sk-..."
            onChange={(v) => setDraft((d) => ({ ...d, apiKey: v }))}
          />

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
            >
              {isEditing ? '保存修改' : '添加'}
            </button>
            {isEditing && (
              <button
                type="button"
                onClick={resetDraft}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                取消
              </button>
            )}
            {toast && <span className="text-xs text-green-600 dark:text-green-400">{toast}</span>}
          </div>
```
New：
```tsx
          <Field
            label={t('provider.fieldName')}
            value={draft.name}
            placeholder={placeholders.name}
            required
            onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
          />
          <Field
            label="Base URL"
            value={draft.baseURL}
            placeholder={placeholders.baseURL}
            required
            onChange={(v) => setDraft((d) => ({ ...d, baseURL: v }))}
          />
          <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
            {t('provider.fieldApiType')}
            <select
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              value={draft.api ?? 'openai-completions'}
              onChange={(e) =>
                setDraft((d) => ({ ...d, api: e.target.value as ProviderConfig['api'] }))
              }
            >
              <option value="openai-completions">{t('provider.apiOpenAI')}</option>
              <option value="anthropic-messages">{t('provider.apiAnthropic')}</option>
            </select>
          </label>
          <Field
            label={t('provider.fieldModel')}
            value={draft.model}
            placeholder={placeholders.model}
            required
            onChange={(v) => setDraft((d) => ({ ...d, model: v }))}
          />
          <Field
            label={t('provider.fieldExtraModels')}
            value={extrasText}
            placeholder={placeholders.extras}
            onChange={setExtrasText}
          />
          <Field
            label="API Key"
            type="password"
            toggleable
            value={draft.apiKey}
            placeholder="sk-..."
            onChange={(v) => setDraft((d) => ({ ...d, apiKey: v }))}
          />

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
            >
              {isEditing ? t('provider.saveChanges') : t('provider.addSubmit')}
            </button>
            {isEditing && (
              <button
                type="button"
                onClick={resetDraft}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                {t('common.cancel')}
              </button>
            )}
            {toast && <span className="text-xs text-green-600 dark:text-green-400">{toast}</span>}
          </div>
```

Old（`Field` 子组件，"隐藏/显示" 切换按钮）：
```tsx
function Field({
  label,
  value,
  placeholder,
  type = 'text',
  required,
  toggleable,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  toggleable?: boolean;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
```
New：
```tsx
function Field({
  label,
  value,
  placeholder,
  type = 'text',
  required,
  toggleable,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  toggleable?: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
```

Old：
```tsx
          >
            {revealed ? '隐藏' : '显示'}
          </button>
```
New：
```tsx
          >
            {revealed ? t('common.hide') : t('common.show')}
          </button>
```

- [ ] **Step 7: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 8: 手动验证**

Run: `pnpm dev`，打开设置页，把语言切到 English：确认「Configured providers」「Add provider」表单的所有字段标签、按钮、下拉选项、flash 提示、placeholder 示例文案（如 "e.g. My Relay Station"）均已切换；把语言切回中文，确认与迁移前视觉、文案完全一致（回归）。

- [ ] **Step 9: Commit**

```bash
git add lib/settings.ts lib/settings.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts components/ProviderSettings.tsx
git commit -m "feat: translate ProviderSettings and add locale-aware placeholder examples"
```

---

### Task 7: `entrypoints/sidepanel/App.tsx` 迁移（一）—— App() / Sidebar / TopBar / SettingsView

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx:1-568`

**Interfaces:**
- Consumes：Task 3 的 `LanguageSettings`；Task 1 的 `useTranslation`、`LocaleMode`。
- Produces（供 Task 8 复用）：`App.tsx` 顶部新增的 `import { useTranslation, type LocaleMode } from '@/lib/i18n';`（Task 8 会在同一行追加 `type Translate`）。

- [ ] **Step 1: 新增字典 key**

`lib/i18n/locales/zh.ts` 追加：

```ts
  'chat.jumpToBottom': '回到底部',
  'sidebar.ariaLabel': '会话与设置',
  'sidebar.historyLabel': '历史会话',
  'sidebar.noHistory': '暂无历史会话',
  'sidebar.noProvider': '未配置 Provider',
  'sidebar.untitledConversation': '未命名会话',
  'sidebar.deleteConversationAriaLabel': '删除会话 {title}',
  'banner.noProviderPrefix': '未检测到模型 Provider，请前往',
  'banner.noProviderSuffix': '填写 API Key。',
  'settings.backAriaLabel': '返回对话',
  'settings.descriptionSuffix': '，不会上传或同步。',
```

`lib/i18n/locales/en.ts` 追加：

```ts
  'chat.jumpToBottom': 'Back to bottom',
  'sidebar.ariaLabel': 'Conversations & settings',
  'sidebar.historyLabel': 'History',
  'sidebar.noHistory': 'No conversations yet',
  'sidebar.noProvider': 'No provider configured',
  'sidebar.untitledConversation': 'Untitled conversation',
  'sidebar.deleteConversationAriaLabel': 'Delete conversation {title}',
  'banner.noProviderPrefix': 'No model provider detected. Go to',
  'banner.noProviderSuffix': 'to enter an API key.',
  'settings.backAriaLabel': 'Back to chat',
  'settings.descriptionSuffix': ', never uploaded or synced.',
```

- [ ] **Step 2: import 部分**

Old：
```tsx
import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { providerModels, type ProviderConfig } from '@/lib/settings';
```
New：
```tsx
import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import LanguageSettings from '@/components/LanguageSettings';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { useTranslation, type LocaleMode } from '@/lib/i18n';
import { providerModels, type ProviderConfig } from '@/lib/settings';
```

- [ ] **Step 3: `App()` 顶部 hook 接入**

Old：
```tsx
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
```
New：
```tsx
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { t, locale: localeMode, setLocale } = useTranslation();
```

- [ ] **Step 4: "回到底部"**

Old：
```tsx
                <IconChevronDown className="h-3.5 w-3.5" />
                回到底部
              </button>
```
New：
```tsx
                <IconChevronDown className="h-3.5 w-3.5" />
                {t('chat.jumpToBottom')}
              </button>
```

- [ ] **Step 5: `SettingsView` 调用点新增 `localeMode`/`onSetLocale`**

Old：
```tsx
      {view === 'settings' ? (
        <SettingsView
          themeMode={themeMode}
          onSetTheme={setThemeMode}
          onBack={() => setView('chat')}
          onChange={refreshProvider}
        />
      ) : (
```
New：
```tsx
      {view === 'settings' ? (
        <SettingsView
          themeMode={themeMode}
          onSetTheme={setThemeMode}
          localeMode={localeMode}
          onSetLocale={setLocale}
          onBack={() => setView('chat')}
          onChange={refreshProvider}
        />
      ) : (
```

- [ ] **Step 6: `Sidebar` 组件**

Old：
```tsx
  onOpenSettings: () => void;
}) {
  return (
    <aside
      aria-label="会话与设置"
```
New：
```tsx
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t('sidebar.ariaLabel')}
```

Old：
```tsx
          <button
            onClick={onClose}
            aria-label="收起侧边栏"
```
New：
```tsx
          <button
            onClick={onClose}
            aria-label={t('common.collapseSidebar')}
```

Old：
```tsx
            <IconPlus className="h-4 w-4" /> 新对话
          </button>
        </div>

        <nav aria-label="历史会话" className="flex-1 overflow-y-auto px-2 py-2">
          <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            历史会话
          </div>
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-400 dark:text-neutral-600">暂无历史会话</p>
```
New：
```tsx
            <IconPlus className="h-4 w-4" /> {t('common.newChat')}
          </button>
        </div>

        <nav aria-label={t('sidebar.historyLabel')} className="flex-1 overflow-y-auto px-2 py-2">
          <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t('sidebar.historyLabel')}
          </div>
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-400 dark:text-neutral-600">{t('sidebar.noHistory')}</p>
```

Old：
```tsx
            <span className="truncate">{provider ? provider.name : '未配置 Provider'}</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle mode={themeMode} onSet={onSetTheme} />
            <button
              onClick={onOpenSettings}
              className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            >
              <IconGear className="h-4 w-4" /> 设置
            </button>
```
New：
```tsx
            <span className="truncate">{provider ? provider.name : t('sidebar.noProvider')}</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle mode={themeMode} onSet={onSetTheme} />
            <button
              onClick={onOpenSettings}
              className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            >
              <IconGear className="h-4 w-4" /> {t('common.settings')}
            </button>
```

- [ ] **Step 7: `ThemeToggle` 组件**

Old：
```tsx
function ThemeToggle({ mode, onSet }: { mode: ThemeMode; onSet: (m: ThemeMode) => void }) {
  const next: ThemeMode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
  const label = mode === 'auto' ? '跟随浏览器' : mode === 'light' ? '浅色' : '深色';
  return (
    <button
      onClick={() => onSet(next)}
      aria-label={`主题：${label}，点击切换`}
      title={`主题：${label}`}
```
New：
```tsx
function ThemeToggle({ mode, onSet }: { mode: ThemeMode; onSet: (m: ThemeMode) => void }) {
  const { t } = useTranslation();
  const next: ThemeMode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
  const label =
    mode === 'auto' ? t('common.followSystem') : mode === 'light' ? t('appearance.light') : t('appearance.dark');
  return (
    <button
      onClick={() => onSet(next)}
      aria-label={t('appearance.themeAriaLabel', { label })}
      title={t('appearance.themeTitle', { label })}
```

- [ ] **Step 8: `ConversationItem` 组件**

Old：
```tsx
  onRemove: (id: string) => void;
}) {
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800">
        <button onClick={() => onPick(c.id)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm text-neutral-800 dark:text-neutral-200">
            {c.title || '未命名会话'}
          </div>
          <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
            {new Date(c.updatedAt).toLocaleString()}
          </div>
        </button>
        <button
          onClick={() => onRemove(c.id)}
          aria-label={`删除会话 ${c.title || ''}`}
```
New：
```tsx
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800">
        <button onClick={() => onPick(c.id)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm text-neutral-800 dark:text-neutral-200">
            {c.title || t('sidebar.untitledConversation')}
          </div>
          <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
            {new Date(c.updatedAt).toLocaleString()}
          </div>
        </button>
        <button
          onClick={() => onRemove(c.id)}
          aria-label={t('sidebar.deleteConversationAriaLabel', { title: c.title || '' })}
```

- [ ] **Step 9: `TopBar` 组件**

Old：
```tsx
  onNewChat: () => void;
}) {
  return (
    <header className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <button
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
```
New：
```tsx
  onNewChat: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <button
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? t('common.collapseSidebar') : t('common.expandSidebar')}
```

Old：
```tsx
        <button
          onClick={onNewChat}
          aria-label="新对话"
          title="新对话"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconPlus className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

function ProviderBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
      <span>未检测到模型 Provider，请前往</span>
      <button
        onClick={onOpenSettings}
        className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
      >
        设置
      </button>
      <span>填写 API Key。</span>
    </div>
  );
}
```
New：
```tsx
        <button
          onClick={onNewChat}
          aria-label={t('common.newChat')}
          title={t('common.newChat')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconPlus className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

function ProviderBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
      <span>{t('banner.noProviderPrefix')}</span>
      <button
        onClick={onOpenSettings}
        className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
      >
        {t('common.settings')}
      </button>
      <span>{t('banner.noProviderSuffix')}</span>
    </div>
  );
}
```

- [ ] **Step 10: `SettingsView` 组件**

Old：
```tsx
function SettingsView({
  themeMode,
  onSetTheme,
  onBack,
  onChange,
}: {
  themeMode: ThemeMode;
  onSetTheme: (m: ThemeMode) => void;
  onBack: () => void;
  onChange: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
        <button
          onClick={onBack}
          aria-label="返回对话"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">设置</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-4 text-neutral-900 dark:text-neutral-100">
          <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
            配置 OpenAI 兼容的模型 Provider。API Key 仅保存在本机
            <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
            ，不会上传或同步。
          </p>
          <AppearanceSettings mode={themeMode} onSet={onSetTheme} />
          <ProviderSettings onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
```
New：
```tsx
function SettingsView({
  themeMode,
  onSetTheme,
  localeMode,
  onSetLocale,
  onBack,
  onChange,
}: {
  themeMode: ThemeMode;
  onSetTheme: (m: ThemeMode) => void;
  localeMode: LocaleMode;
  onSetLocale: (m: LocaleMode) => void;
  onBack: () => void;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
        <button
          onClick={onBack}
          aria-label={t('settings.backAriaLabel')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('common.settings')}</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-4 text-neutral-900 dark:text-neutral-100">
          <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
            {t('settings.descriptionPrefix')}
            <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
            {t('settings.descriptionSuffix')}
          </p>
          <AppearanceSettings mode={themeMode} onSet={onSetTheme} />
          <LanguageSettings mode={localeMode} onSet={onSetLocale} />
          <ProviderSettings onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 11: 类型检查**

Run: `pnpm compile`
Expected: 无错误（`statusLabel`/`statusColor`、`EmptyState` 及之后的组件仍是中文字面量，属于 Task 8 范围，此时不受影响）。

- [ ] **Step 12: 手动验证**

Run: `pnpm dev`，打开侧边栏设置视图，确认能看到「语言」切换器；切到 English，确认侧边栏（新对话/历史会话/设置按钮）、顶栏、设置页头部全部变成英文；聊天视图本体（EmptyState 等，Task 8 之前）仍显示中文——这是预期的中间状态。

- [ ] **Step 13: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/sidepanel/App.tsx
git commit -m "feat: translate App.tsx sidebar, top bar, and settings view"
```

---

### Task 8: `entrypoints/sidepanel/App.tsx` 迁移（二）—— EmptyState / Message / 确认卡片 / Composer

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx:572-1056`

**Interfaces:**
- Consumes：Task 7 已建立的 `useTranslation` import；新增 `type Translate`。

- [ ] **Step 1: 新增字典 key**

`lib/i18n/locales/zh.ts` 追加：

```ts
  'chat.emptyTitle': '和 Aluminum 对话',
  'chat.emptySubtitle': '我可以总结当前网页、解释划词内容，或回答任何问题。',
  'chat.summarizeCardTitle': '总结当前网页',
  'chat.summarizeCardSubtitle': '快速提炼要点',
  'chat.explainCardTitle': '解释划词内容',
  'chat.explainCardSubtitle': '选中页面文本即可',
  'chat.editMessageAriaLabel': '编辑这条消息',
  'chat.generatingAriaLabel': '正在生成',
  'chat.toolCallsLabel': 'Agent 工具调用',
  'chat.toolCallsRunningSuffix': '（{count} 运行中）',
  'status.running': '运行中',
  'status.confirming': '待确认',
  'status.blocked': '已拦截',
  'status.error': '失败',
  'status.done': '完成',
  'confirm.title': '🔒 修改页面前，先请你确认',
  'confirm.approve': '批准本轮操作',
  'confirm.deny': '拒绝',
  'confirm.approveHint': '批准后，本轮内后续的写操作会自动执行，无需逐条确认；这轮做的所有改动之后都能一键撤销。',
  'confirm.elapsedMinutesSeconds': '{minutes}分{seconds}秒',
  'confirm.elapsedSecondsOnly': '{seconds}秒',
  'confirm.userScriptsWaitingTitle': '⏳ 等待开启「允许用户脚本」开关……',
  'confirm.userScriptsWaitingBody':
    '注入脚本需要先在本扩展详情页开启「允许用户脚本」开关；已等待 {elapsed}，重试{attempts} 次。开启后会自动继续，无需重新提问。',
  'confirm.openExtensionSettings': '🔧 前往开启',
  'confirm.cancelWait': '取消等待',
  'confirm.undoBarStatus': '● 本轮已修改页面',
  'confirm.undoBarButton': '撤销本轮更改',
  'chat.summarizeChipLabel': '总结本页',
  'chat.explainChipLabel': '解释划词',
  'chat.composerAriaLabel': '消息输入框',
  'chat.composerPlaceholder': '输入消息，Enter 发送，Shift+Enter 换行',
  'chat.stopGenerating': '停止生成',
  'chat.sendMessage': '发送消息',
  'chat.selectProviderModelAriaLabel': '选择 Provider 与模型',
  'chat.noModelSelected': '未选择',
```

`lib/i18n/locales/en.ts` 追加：

```ts
  'chat.emptyTitle': 'Chat with Aluminum',
  'chat.emptySubtitle': 'I can summarize this page, explain selected text, or answer any question.',
  'chat.summarizeCardTitle': 'Summarize this page',
  'chat.summarizeCardSubtitle': 'Quickly extract key points',
  'chat.explainCardTitle': 'Explain selected text',
  'chat.explainCardSubtitle': 'Just select text on the page',
  'chat.editMessageAriaLabel': 'Edit this message',
  'chat.generatingAriaLabel': 'Generating',
  'chat.toolCallsLabel': 'Agent tool calls',
  'chat.toolCallsRunningSuffix': ' ({count} running)',
  'status.running': 'Running',
  'status.confirming': 'Awaiting confirmation',
  'status.blocked': 'Blocked',
  'status.error': 'Failed',
  'status.done': 'Done',
  'confirm.title': '🔒 Please confirm before modifying the page',
  'confirm.approve': 'Approve this turn',
  'confirm.deny': 'Deny',
  'confirm.approveHint':
    'Once approved, further write actions this turn run automatically without asking again; every change made this turn can be undone with one click.',
  'confirm.elapsedMinutesSeconds': '{minutes}m {seconds}s',
  'confirm.elapsedSecondsOnly': '{seconds}s',
  'confirm.userScriptsWaitingTitle': '⏳ Waiting for "Allow User Scripts" to be enabled…',
  'confirm.userScriptsWaitingBody':
    'Injecting a script requires enabling "Allow User Scripts" on this extension\'s details page; waited {elapsed}, retried {attempts} time(s). It will continue automatically once enabled — no need to ask again.',
  'confirm.openExtensionSettings': '🔧 Open settings',
  'confirm.cancelWait': 'Cancel waiting',
  'confirm.undoBarStatus': '● Page modified this turn',
  'confirm.undoBarButton': 'Undo this turn',
  'chat.summarizeChipLabel': 'Summarize page',
  'chat.explainChipLabel': 'Explain selection',
  'chat.composerAriaLabel': 'Message input',
  'chat.composerPlaceholder': 'Type a message. Enter to send, Shift+Enter for a new line',
  'chat.stopGenerating': 'Stop generating',
  'chat.sendMessage': 'Send message',
  'chat.selectProviderModelAriaLabel': 'Select provider and model',
  'chat.noModelSelected': 'Not selected',
```

- [ ] **Step 2: import 扩展**

Old：
```tsx
import { useTranslation, type LocaleMode } from '@/lib/i18n';
```
New：
```tsx
import { useTranslation, type LocaleMode, type Translate } from '@/lib/i18n';
```

- [ ] **Step 3: `EmptyState` 组件**

Old：
```tsx
  onExplain: () => void;
}) {
  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-white dark:bg-neutral-800">
        <IconSparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">和 Aluminum 对话</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        我可以总结当前网页、解释划词内容，或回答任何问题。
      </p>
```
New：
```tsx
  onExplain: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-white dark:bg-neutral-800">
        <IconSparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('chat.emptyTitle')}</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {t('chat.emptySubtitle')}
      </p>
```

Old：
```tsx
          <span className="min-w-0">
            <span className="block font-medium text-neutral-900 dark:text-neutral-100">总结当前网页</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">快速提炼要点</span>
          </span>
        </button>
```
New：
```tsx
          <span className="min-w-0">
            <span className="block font-medium text-neutral-900 dark:text-neutral-100">{t('chat.summarizeCardTitle')}</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('chat.summarizeCardSubtitle')}</span>
          </span>
        </button>
```

Old：
```tsx
          <span className="min-w-0">
            <span className="block font-medium text-neutral-900 dark:text-neutral-100">解释划词内容</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">选中页面文本即可</span>
          </span>
        </button>
```
New：
```tsx
          <span className="min-w-0">
            <span className="block font-medium text-neutral-900 dark:text-neutral-100">{t('chat.explainCardTitle')}</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('chat.explainCardSubtitle')}</span>
          </span>
        </button>
```

- [ ] **Step 4: `Message` 组件**

Old：
```tsx
  onSubmitEdit: (content: string) => void;
}) {
  const { role, content } = message;

  if (role === 'user') {
```
New：
```tsx
  onSubmitEdit: (content: string) => void;
}) {
  const { t } = useTranslation();
  const { role, content } = message;

  if (role === 'user') {
```

Old：
```tsx
            onClick={onBeginEdit}
            aria-label="编辑这条消息"
            title="编辑这条消息"
```
New：
```tsx
            onClick={onBeginEdit}
            aria-label={t('chat.editMessageAriaLabel')}
            title={t('chat.editMessageAriaLabel')}
```

- [ ] **Step 5: `TypingDots` 组件**

Old：
```tsx
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="正在生成">
```
New：
```tsx
function TypingDots() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label={t('chat.generatingAriaLabel')}>
```

- [ ] **Step 6: `ToolActivityList` 组件**

Old：
```tsx
function ToolActivityList({ activities }: { activities: ToolActivity[] }) {
  const running = activities.filter((a) => a.status === 'running' || a.status === 'confirming').length;
  return (
    <details className="group rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300">
        <IconChevronRight className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
        <span className="font-medium text-neutral-700 dark:text-neutral-200">Agent 工具调用</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          · {activities.length}
          {running ? `（${running} 运行中）` : ''}
        </span>
      </summary>
      <ul className="space-y-1 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
        {activities.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-xs">
            <span className={statusColor(a.status)}>{statusLabel(a.status)}</span>
```
New：
```tsx
function ToolActivityList({ activities }: { activities: ToolActivity[] }) {
  const { t } = useTranslation();
  const running = activities.filter((a) => a.status === 'running' || a.status === 'confirming').length;
  return (
    <details className="group rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300">
        <IconChevronRight className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
        <span className="font-medium text-neutral-700 dark:text-neutral-200">{t('chat.toolCallsLabel')}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          · {activities.length}
          {running ? t('chat.toolCallsRunningSuffix', { count: running }) : ''}
        </span>
      </summary>
      <ul className="space-y-1 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
        {activities.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-xs">
            <span className={statusColor(a.status)}>{statusLabel(a.status, t)}</span>
```

- [ ] **Step 7: `ConfirmationCard` 组件**

Old：
```tsx
  onDeny: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-2 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        🔒 修改页面前，先请你确认
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">{confirmation.summary}</p>
      {confirmation.codePreview && (
        <pre className="mb-2 max-h-40 overflow-auto rounded-lg bg-neutral-900/90 p-2 text-[11px] text-neutral-100">
          {confirmation.codePreview}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          批准本轮操作
        </button>
        <button
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          拒绝
        </button>
      </div>
      <p className="mt-2 text-[11px] text-amber-800/70 dark:text-amber-300/60">
        批准后，本轮内后续的写操作会自动执行，无需逐条确认；这轮做的所有改动之后都能一键撤销。
      </p>
    </div>
  );
}
```
New：
```tsx
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-2 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        {t('confirm.title')}
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">{confirmation.summary}</p>
      {confirmation.codePreview && (
        <pre className="mb-2 max-h-40 overflow-auto rounded-lg bg-neutral-900/90 p-2 text-[11px] text-neutral-100">
          {confirmation.codePreview}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('confirm.approve')}
        </button>
        <button
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('confirm.deny')}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-amber-800/70 dark:text-amber-300/60">
        {t('confirm.approveHint')}
      </p>
    </div>
  );
}
```

- [ ] **Step 8: `UserScriptsBlockedNotice` 组件**

Old：
```tsx
  onCancelWait: () => void;
}) {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-1 font-medium text-amber-900 dark:text-amber-200">
        ⏳ 等待开启「允许用户脚本」开关……
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">
        注入脚本需要先在本扩展详情页开启「允许用户脚本」开关；已等待 {elapsedLabel}，重试
        {attempts} 次。开启后会自动继续，无需重新提问。
      </p>
      <div className="flex gap-2">
        <button
          onClick={onOpenSettings}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          🔧 前往开启
        </button>
        <button
          onClick={onCancelWait}
          className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          取消等待
        </button>
      </div>
    </div>
  );
}
```
New：
```tsx
  onCancelWait: () => void;
}) {
  const { t } = useTranslation();
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel =
    minutes > 0
      ? t('confirm.elapsedMinutesSeconds', { minutes, seconds })
      : t('confirm.elapsedSecondsOnly', { seconds });
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mb-1 font-medium text-amber-900 dark:text-amber-200">
        {t('confirm.userScriptsWaitingTitle')}
      </div>
      <p className="mb-2 text-amber-900/90 dark:text-amber-200/90">
        {t('confirm.userScriptsWaitingBody', { elapsed: elapsedLabel, attempts })}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onOpenSettings}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('confirm.openExtensionSettings')}
        </button>
        <button
          onClick={onCancelWait}
          className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          {t('confirm.cancelWait')}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: `UndoBar` 组件**

Old：
```tsx
function UndoBar({ onRevert }: { onRevert: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-emerald-600 dark:text-emerald-400">● 本轮已修改页面</span>
      <button
        onClick={onRevert}
        className="font-medium text-red-600 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-red-400"
      >
        撤销本轮更改
      </button>
    </div>
  );
}
```
New：
```tsx
function UndoBar({ onRevert }: { onRevert: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <span className="text-emerald-600 dark:text-emerald-400">{t('confirm.undoBarStatus')}</span>
      <button
        onClick={onRevert}
        className="font-medium text-red-600 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-red-400"
      >
        {t('confirm.undoBarButton')}
      </button>
    </div>
  );
}
```

- [ ] **Step 10: `statusLabel` 函数（改为接收 `t` 参数，非组件）**

Old：
```tsx
function statusLabel(status: ToolActivity['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'confirming':
      return '待确认';
    case 'blocked':
      return '已拦截';
    case 'error':
      return '失败';
    default:
      return '完成';
  }
}
```
New：
```tsx
function statusLabel(status: ToolActivity['status'], t: Translate): string {
  switch (status) {
    case 'running':
      return t('status.running');
    case 'confirming':
      return t('status.confirming');
    case 'blocked':
      return t('status.blocked');
    case 'error':
      return t('status.error');
    default:
      return t('status.done');
  }
}
```

- [ ] **Step 11: `Composer` 组件**

Old：
```tsx
  onSelectProviderModel: (providerId: string, model: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canSend = input.trim().length > 0 && !busy;
```
New：
```tsx
  onSelectProviderModel: (providerId: string, model: string) => void;
}) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canSend = input.trim().length > 0 && !busy;
```

Old：
```tsx
          <Chip onClick={onSummarize} disabled={busy} icon={<IconFileText className="h-3.5 w-3.5" />} label="总结本页" />
          <Chip onClick={onExplain} disabled={busy} icon={<IconMessage className="h-3.5 w-3.5" />} label="解释划词" />
        </div>
        <div className="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm transition-colors focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-900">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            aria-label="消息输入框"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          {busy ? (
            <button
              onClick={onStop}
              aria-label="停止生成"
              title="停止生成"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              aria-label="发送消息"
              title="发送消息"
```
New：
```tsx
          <Chip onClick={onSummarize} disabled={busy} icon={<IconFileText className="h-3.5 w-3.5" />} label={t('chat.summarizeChipLabel')} />
          <Chip onClick={onExplain} disabled={busy} icon={<IconMessage className="h-3.5 w-3.5" />} label={t('chat.explainChipLabel')} />
        </div>
        <div className="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm transition-colors focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-900">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            aria-label={t('chat.composerAriaLabel')}
            placeholder={t('chat.composerPlaceholder')}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          {busy ? (
            <button
              onClick={onStop}
              aria-label={t('chat.stopGenerating')}
              title={t('chat.stopGenerating')}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              aria-label={t('chat.sendMessage')}
              title={t('chat.sendMessage')}
```

- [ ] **Step 12: `ModelPicker` 组件**

Old：
```tsx
  const selected = providers.find((p) => p.id === selectedProviderId);
  const currentModel = selectedModel || selected?.model || '';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="选择 Provider 与模型"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex max-w-[60vw] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        {selected && <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{selected.name}</span>}
        <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">{currentModel || '未选择'}</span>
```
New：
```tsx
  const { t } = useTranslation();
  const selected = providers.find((p) => p.id === selectedProviderId);
  const currentModel = selectedModel || selected?.model || '';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('chat.selectProviderModelAriaLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex max-w-[60vw] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        {selected && <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{selected.name}</span>}
        <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">{currentModel || t('chat.noModelSelected')}</span>
```

- [ ] **Step 13: 类型检查**

Run: `pnpm compile`
Expected: 无错误。此时 `entrypoints/sidepanel/App.tsx` 里应已不再含任何裸中文字面量（`grep -P "[\x{4e00}-\x{9fff}]" entrypoints/sidepanel/App.tsx` 应无匹配，仅剩英文注释——若项目决定保留中文注释，注释行属预期保留项，不算文案）。

- [ ] **Step 14: 手动验证**

Run: `pnpm dev`，把语言切到 English：从空状态卡片、消息气泡、工具调用列表、确认卡片、用户脚本等待提示、撤销栏，到输入框/发送/停止按钮，逐一确认英文文案正确、无遗漏中文；切回中文确认与迁移前视觉一致。

- [ ] **Step 15: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/sidepanel/App.tsx
git commit -m "feat: translate App.tsx empty state, messages, and confirmation UI"
```

---

### Task 9: `entrypoints/sidepanel/store.ts` 错误提示 + 注入气泡迁移

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`

**Interfaces:**
- Consumes：Task 1 的模块级 `t()`（非 hook）。
- 不改动：`SYSTEM_PROMPT` 常量（第 37-46 行）、`summarizePage`/`explainSelection` 里发给模型的 `prompt` 变量。

- [ ] **Step 1: 新增字典 key**

`lib/i18n/locales/zh.ts` 追加：

```ts
  'store.noActiveTab': '未找到当前标签页，请确保有一个网页处于打开状态。',
  'store.summarizeDisplay': '📄 总结当前网页',
  'store.getSelectionFailed': '获取选区失败',
  'store.noSelection': '未检测到选中的文本，请先在页面中划选内容。',
  'store.explainDisplay': '💬 解释：{preview}',
  'store.noRevertTabInfo': '没有可撤销的标签页信息。',
  'store.revertFailed': '撤销失败',
  'store.noChangesToRevert': '本轮没有可撤销的改动。',
  'store.noProviderConfigured': '未配置 Provider，请在「设置」中添加 API Key。',
  'store.missingApiKey': '当前 Provider 未填写 API Key，请在「设置」中补全。',
  'store.messageNotFound': '这条消息已不在当前对话中。',
  'store.staleBackgroundWarning':
    '当前扩展后台服务仍是旧版本，浏览器 Agent 工具尚未加载，因此我不会基于猜测回答。\n\n缺失消息类型：{missingTypes}\n\n请在浏览器扩展管理页点击 Aluminum 的「重新加载」，然后刷新当前网页并重新打开侧边栏。',
  'store.modelCallFailed': '模型调用失败：{reason}\n\n请检查设置中的 Base URL、API Key 和模型名称是否正确。',
  'store.unknownError': '未知错误',
  'store.tokenLimitReached': '模型在生成过程中达到了 token 上限（可能是思考阶段耗尽了预算），未能给出正式回复。请重试或简化问题。',
  'store.generationAborted': '本次生成已被中止。',
  'store.onlyToolCalls': '模型只发起了工具调用就结束了本轮，没有给出文字回答。请再问一次，或换一个更具体的问题。',
  'store.noTextResult': '本次 Agent 运行没有生成文本结果。详情见侧边栏控制台日志（右键「检查」）。',
```

`lib/i18n/locales/en.ts` 追加：

```ts
  'store.noActiveTab': 'No active tab found. Make sure a webpage is open.',
  'store.summarizeDisplay': '📄 Summarize this page',
  'store.getSelectionFailed': 'Failed to get selection',
  'store.noSelection': 'No selected text detected. Please select some text on the page first.',
  'store.explainDisplay': '💬 Explain: {preview}',
  'store.noRevertTabInfo': 'No tab information available to undo.',
  'store.revertFailed': 'Undo failed',
  'store.noChangesToRevert': 'No changes to undo this turn.',
  'store.noProviderConfigured': 'No provider configured. Add an API key in Settings.',
  'store.missingApiKey': 'The current provider has no API key set. Add one in Settings.',
  'store.messageNotFound': 'This message is no longer in the current conversation.',
  'store.staleBackgroundWarning':
    'The extension\'s background service is still an old version and the browser agent tools haven\'t loaded, so I won\'t guess an answer.\n\nMissing message types: {missingTypes}\n\nClick "Reload" for Aluminum on the extensions management page, then refresh this page and reopen the side panel.',
  'store.modelCallFailed': 'Model call failed: {reason}\n\nPlease check the Base URL, API key, and model name in Settings.',
  'store.unknownError': 'Unknown error',
  'store.tokenLimitReached':
    'The model hit its token limit while generating (possibly exhausted during reasoning) and did not produce a final reply. Please retry or simplify your question.',
  'store.generationAborted': 'This generation was aborted.',
  'store.onlyToolCalls':
    'The model only made tool calls and ended the turn without a text reply. Please ask again, or try a more specific question.',
  'store.noTextResult': 'This agent run produced no text result. See the side panel console log for details (right-click → Inspect).',
```

- [ ] **Step 2: import**

Old：
```ts
import { createBrowserAgent } from '@/lib/agent/agent';
import { summarizeToolCallForConfirmation } from '@/lib/agent/confirm-summary';
import { getConversationIdForTab, setConversationIdForTab } from '@/lib/agent/tab-conversation';
```
New：
```ts
import { createBrowserAgent } from '@/lib/agent/agent';
import { summarizeToolCallForConfirmation } from '@/lib/agent/confirm-summary';
import { getConversationIdForTab, setConversationIdForTab } from '@/lib/agent/tab-conversation';
import { t } from '@/lib/i18n';
```

- [ ] **Step 3: `resolveActiveTabId`**

Old：
```ts
  if (!res.ok || typeof res.data?.id !== 'number') {
    throw new Error(res.error ?? '未找到当前标签页，请确保有一个网页处于打开状态。');
  }
```
New：
```ts
  if (!res.ok || typeof res.data?.id !== 'number') {
    throw new Error(res.error ?? t('store.noActiveTab'));
  }
```

- [ ] **Step 4: `summarizePage`（只翻译 `display`，`prompt` 不变）**

Old：
```ts
  summarizePage: async () => {
    if (get().busy) return;
    const display = makeMessage('user', '📄 总结当前网页', 'action');
    const prompt = '请读取当前网页内容并总结，给出 3-5 个要点和一段简短摘要。';
    await runAgent(set, get, display, prompt);
  },
```
New：
```ts
  summarizePage: async () => {
    if (get().busy) return;
    const display = makeMessage('user', t('store.summarizeDisplay'), 'action');
    const prompt = '请读取当前网页内容并总结，给出 3-5 个要点和一段简短摘要。';
    await runAgent(set, get, display, prompt);
  },
```

- [ ] **Step 5: `explainSelection`（只翻译 `display` 和两处 error，`prompt` 不变）**

Old：
```ts
      if (!res.ok || !res.data) throw new Error(res.error ?? '获取选区失败');
      selection = res.data;
    } catch (e) {
      set({ busy: false, error: errMsg(e) });
      return;
    }
    if (!selection.text) {
      set({ busy: false, error: '未检测到选中的文本，请先在页面中划选内容。' });
      return;
    }
    set({ busy: false });
    const preview =
      selection.text.length > 80 ? `${selection.text.slice(0, 80)}…` : selection.text;
    const display = makeMessage('user', `💬 解释：${preview}`, 'action');
```
New：
```ts
      if (!res.ok || !res.data) throw new Error(res.error ?? t('store.getSelectionFailed'));
      selection = res.data;
    } catch (e) {
      set({ busy: false, error: errMsg(e) });
      return;
    }
    if (!selection.text) {
      set({ busy: false, error: t('store.noSelection') });
      return;
    }
    set({ busy: false });
    const preview =
      selection.text.length > 80 ? `${selection.text.slice(0, 80)}…` : selection.text;
    const display = makeMessage('user', t('store.explainDisplay', { preview }), 'action');
```

- [ ] **Step 6: `revertTurnChanges`**

Old：
```ts
  revertTurnChanges: async () => {
    if (currentTurnTabId === null) {
      set({ error: '没有可撤销的标签页信息。' });
      return;
    }
    try {
      const res = (await sendMessage('REVERT_CHANGES', undefined, currentTurnTabId)) as MessageResponse<RevertChangesResult>;
      if (!res.ok) throw new Error(res.error ?? '撤销失败');
      if (!res.data?.reverted) {
        set({ turnHasChanges: false, error: '本轮没有可撤销的改动。' });
        return;
      }
```
New：
```ts
  revertTurnChanges: async () => {
    if (currentTurnTabId === null) {
      set({ error: t('store.noRevertTabInfo') });
      return;
    }
    try {
      const res = (await sendMessage('REVERT_CHANGES', undefined, currentTurnTabId)) as MessageResponse<RevertChangesResult>;
      if (!res.ok) throw new Error(res.error ?? t('store.revertFailed'));
      if (!res.data?.reverted) {
        set({ turnHasChanges: false, error: t('store.noChangesToRevert') });
        return;
      }
```

- [ ] **Step 7: `runAgent` 里的 Provider 校验**

Old：
```ts
  if (!provider) {
    set({ error: '未配置 Provider，请在「设置」中添加 API Key。' });
    return false;
  }
  if (!provider.apiKey) {
    set({ error: '当前 Provider 未填写 API Key，请在「设置」中补全。' });
    return false;
  }
```
New：
```ts
  if (!provider) {
    set({ error: t('store.noProviderConfigured') });
    return false;
  }
  if (!provider.apiKey) {
    set({ error: t('store.missingApiKey') });
    return false;
  }
```

- [ ] **Step 8: 截断历史未命中分支**

Old：
```ts
    if (index < 0) {
      set({ error: '这条消息已不在当前对话中。' });
      return false;
    }
```
New：
```ts
    if (index < 0) {
      set({ error: t('store.messageNotFound') });
      return false;
    }
```

- [ ] **Step 9: 后台协议过旧警告**

Old：
```ts
      acc =
        '当前扩展后台服务仍是旧版本，浏览器 Agent 工具尚未加载，因此我不会基于猜测回答。' +
        `\n\n缺失消息类型：${missingTypes.join(', ')}` +
        '\n\n请在浏览器扩展管理页点击 Aluminum 的「重新加载」，然后刷新当前网页并重新打开侧边栏。';
```
New：
```ts
      acc = t('store.staleBackgroundWarning', { missingTypes: missingTypes.join(', ') });
```

- [ ] **Step 10: `describeEmptyAgentRun`**

Old：
```ts
function describeEmptyAgentRun(last: LastAssistantInfo | undefined): string {
  if (last?.stopReason === 'error') {
    return `模型调用失败：${last.errorMessage || '未知错误'}\n\n请检查设置中的 Base URL、API Key 和模型名称是否正确。`;
  }
  if (last?.stopReason === 'length') {
    return '模型在生成过程中达到了 token 上限（可能是思考阶段耗尽了预算），未能给出正式回复。请重试或简化问题。';
  }
  if (last?.stopReason === 'aborted') return '本次生成已被中止。';
  const onlyToolCalls =
    Array.isArray(last?.content) &&
    last.content.length > 0 &&
    last.content.every((part) => (part as { type?: unknown })?.type === 'toolCall');
  if (onlyToolCalls) {
    return '模型只发起了工具调用就结束了本轮，没有给出文字回答。请再问一次，或换一个更具体的问题。';
  }
  return '本次 Agent 运行没有生成文本结果。详情见侧边栏控制台日志（右键「检查」）。';
}
```
New：
```ts
function describeEmptyAgentRun(last: LastAssistantInfo | undefined): string {
  if (last?.stopReason === 'error') {
    return t('store.modelCallFailed', { reason: last.errorMessage || t('store.unknownError') });
  }
  if (last?.stopReason === 'length') {
    return t('store.tokenLimitReached');
  }
  if (last?.stopReason === 'aborted') return t('store.generationAborted');
  const onlyToolCalls =
    Array.isArray(last?.content) &&
    last.content.length > 0 &&
    last.content.every((part) => (part as { type?: unknown })?.type === 'toolCall');
  if (onlyToolCalls) {
    return t('store.onlyToolCalls');
  }
  return t('store.noTextResult');
}
```

- [ ] **Step 11: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 12: 手动验证**

Run: `pnpm dev`，语言切到 English 后触发几种错误路径验证英文文案：不选 Provider 直接发消息（noProviderConfigured）、无选区时点「解释划词」（noSelection）、点「撤销本轮更改」在没有改动时（noChangesToRevert）。切回中文确认文案与迁移前一致。

- [ ] **Step 13: Commit**

```bash
git add lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/sidepanel/store.ts
git commit -m "feat: translate store.ts error messages and injected chat bubbles"
```

---

### Task 10: Chrome Web Store 商店列表 i18n

**Files:**
- Create: `public/_locales/zh_CN/messages.json`
- Create: `public/_locales/en/messages.json`
- Modify: `wxt.config.ts:20-41`

- [ ] **Step 1: 创建 `public/_locales/zh_CN/messages.json`**

```json
{
  "extName": {
    "message": "Aluminum",
    "description": "Extension name"
  },
  "extDescription": {
    "message": "AI 助手侧边栏：总结、理解、改造与自动化当前网页",
    "description": "Extension description shown in the Chrome Web Store"
  }
}
```

- [ ] **Step 2: 创建 `public/_locales/en/messages.json`**

```json
{
  "extName": {
    "message": "Aluminum",
    "description": "Extension name"
  },
  "extDescription": {
    "message": "AI sidebar assistant: summarize, understand, transform, and automate the current page",
    "description": "Extension description shown in the Chrome Web Store"
  }
}
```

- [ ] **Step 3: 修改 `wxt.config.ts`**

Old：
```ts
  manifest: {
    name: 'Aluminum',
    description: 'AI 助手侧边栏：总结、理解、改造与自动化当前网页',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'userScripts'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '138',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Aluminum',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
```
New：
```ts
  manifest: {
    default_locale: 'zh_CN',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'userScripts'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '138',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: '__MSG_extName__',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
```

- [ ] **Step 4: 构建并检查产物**

Run: `pnpm build`
Expected: 构建成功，无错误。

检查 `.output/chrome-mv3/manifest.json` 含：
```json
"default_locale": "zh_CN",
"name": "__MSG_extName__",
"description": "__MSG_extDescription__",
```
（`__MSG_*` 占位符由 Chrome 在加载扩展时按用户浏览器 UI 语言解析显示，构建产物里本就应该是字面量占位符，不是构建时解析。）

检查 `.output/chrome-mv3/_locales/zh_CN/messages.json` 与 `.output/chrome-mv3/_locales/en/messages.json` 存在且内容与 `public/_locales/` 下一致（WXT 原样复制 `public/` 到输出根目录）。

- [ ] **Step 5: 手动验证**

在 `chrome://extensions` 加载 `.output/chrome-mv3`（开发者模式 → 加载解压缩的扩展），确认扩展卡片上显示的名称是「Aluminum」、描述是中文版本（对应当前 Chrome UI 语言为中文的情况）。

- [ ] **Step 6: Commit**

```bash
git add public/_locales/ wxt.config.ts
git commit -m "feat: localize Chrome Web Store listing name/description"
```

---

### Task 11: README 英文版

**Files:**
- Create: `README.en.md`
- Modify: `README.md`（顶部加语言切换链接）

- [ ] **Step 1: 修改 `README.md`**

Old：
```markdown
# Aluminum

> 值得信赖的浏览器页面 Agent —— 修改页面前逐项征求你的确认、随时一键撤销，回答基于页面证据而非泛泛而谈；接入你自己选的、自己持有 Key 的模型，对话历史只留在本地、不上传云端。
```
New：
```markdown
# Aluminum

**中文** | [English](README.en.md)

> 值得信赖的浏览器页面 Agent —— 修改页面前逐项征求你的确认、随时一键撤销，回答基于页面证据而非泛泛而谈；接入你自己选的、自己持有 Key 的模型，对话历史只留在本地、不上传云端。
```

- [ ] **Step 2: 创建 `README.en.md`**

```markdown
# Aluminum

[中文](README.md) | **English**

> A trustworthy browser page agent — asks for your confirmation before every page change, with one-click undo at any time; answers are grounded in page evidence, not generic guesses. Bring your own model with your own API key; conversation history stays local and is never uploaded.

## Core features

- 🔒 **Confirm before acting**: style/DOM edits, click/type/scroll/navigate, script injection, and other write actions all ask for your confirmation turn by turn before running — a Deny-First permission model + static scanning of injected scripts (AST-based dangerous API detection) + SSRF protection
- ↩️ **One-click undo**: a snapshot is captured automatically before each turn's first write, so you can always undo everything that turn changed
- 🔍 **Evidence-driven analysis**: automatically reads page text / DOM / scripts / stylesheets / computed styles / screenshots, and when answering "how is this implemented," cites specific code evidence instead of giving a generic description
- 🔑 **Bring your own model**: connect any OpenAI-compatible provider / API key / model — not locked to a single vendor
- 🗂️ **Local-first**: conversation history is stored only in local IndexedDB, never synced to any cloud
- 📄 **Page summarization / comprehension aids**: extract key points, explain terms, and answer questions grounded in page context, all in one click
- ⚡ **Skill system**: turn common actions into reusable, centrally managed Skills

## Tech stack

| Aspect | Choice |
|------|------|
| Extension framework | [WXT](https://wxt.dev/) (Manifest V3) |
| UI | React 18 + TypeScript + Tailwind CSS |
| Agent | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) (tool-call loop, OpenAI-compatible Chat Completions) |
| State | Zustand |
| Storage | Dexie (IndexedDB) + `chrome.storage` |
| Testing | Vitest |
| Package manager | pnpm |

## Quick start

```bash
# Install dependencies
pnpm install

# Start dev (auto-loads the extension with hot reload)
pnpm dev

# Production build, output in .output/chrome-mv3
pnpm build

# Type check
pnpm compile

# Run tests
pnpm test
```

> If Google Chrome isn't installed locally, point the browser binary to Microsoft Edge or another Chromium-based browser in [web-ext.config.ts](web-ext.config.ts).

Load the unpacked extension: in your browser go to `Extensions` → enable `Developer mode` → `Load unpacked` → select `.output/chrome-mv3`.

## Project structure

```
entrypoints/        # Extension entry points
  background.ts     # Service worker: message router, the only context with tabs/scripting permissions
  content.ts        # Content script: page extraction (Readability) / text selection
  sidepanel/        # Side panel React app (chat UI, confirmation card, undo bar)
  options/          # Settings / provider & API key management
lib/                # Shared libraries
  messaging.ts      # Unified messaging protocol across the three contexts
  agent/            # Agent loop and tool calls
    agent.ts        # Agent wiring (model / tools / lifecycle hooks)
    tools.ts        # browser_* tool definitions (read-only / write / undo)
    permissions.ts  # Deny-First permission tiers (always_allow / confirm / deny)
    confirm-gate.ts # First write in a turn prompts for confirmation; result is reused for the rest of the turn
    turn-snapshot.ts# Snapshot before writes, used by browser_revert_changes to undo
    stream.ts       # SSE streaming response parsing
  db.ts             # IndexedDB (Dexie)
  settings.ts       # Provider configuration storage
  security.ts       # Static safety scan for injected scripts (acorn AST)
docs/               # Documentation (docs-driven development)
```

## Documentation

This project follows **docs-driven development**: docs come before code, and docs are the single source of truth.

- [Documentation overview](docs/README.md)
- [Product requirements](docs/plan.md)
- [Technical plan](docs/technical-plan.md)
- [Progress board](docs/PROGRESS.md)
- [Architecture Decision Records (ADR)](docs/adr/)

## Development status

🚧 In development — Phase 0/1/2 and Agent Phase B (write/interactive tools + permission confirmation UI) are complete,
Agent Phase A (tool-call loop) is in acceptance testing, and Agent Phase C (CDP / multi-tab / scraping export) hasn't started.
See the [progress board](docs/PROGRESS.md) for details.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.en.md
git commit -m "docs: add English README and cross-link with the Chinese version"
```

---

### Task 12: 最终验证

**Files:** 无新增/修改文件，仅运行验证命令并对照 spec 验收标准人工检查。

- [ ] **Step 1: 全量类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部通过，含 `lib/i18n/i18n.test.ts`（新增）与 `lib/settings.test.ts`（新增 3 条英文用例）。

- [ ] **Step 3: 生产构建**

Run: `pnpm build`
Expected: 构建成功；`.output/chrome-mv3/manifest.json` 含 `default_locale`/`__MSG_*` 占位符；`.output/chrome-mv3/_locales/{zh_CN,en}/messages.json` 存在。

- [ ] **Step 4: 对照设计文档验收标准逐项人工检查**

在 `chrome://extensions` 加载 `.output/chrome-mv3`，打开侧边栏与 options 页，逐项核对
`docs/superpowers/specs/2026-07-27-english-language-support-design.md` 的「验收标准」：

- [ ] 设置页（侧边栏内 + options 页）出现「语言 / Language」三态切换，行为与外观切换一致。
- [ ] 默认（`auto`）状态下，界面语言与浏览器 UI 语言一致；中文之外的浏览器语言落到英文。
- [ ] 手动切换到「中文」或「English」后，侧边栏与设置页的全部文案（含 ARIA label、确认卡片、
      Provider 表单、状态提示，含 store.ts 的错误提示与注入气泡）同步切换，`<html lang>` 随之更新。
- [ ] 关闭并重新打开侧边栏/options，语言偏好保持上次手动选择。
- [ ] Chrome 扩展管理页显示的名称/描述随浏览器 UI 语言变化。
- [ ] `README.en.md` 存在，与 `README.md` 顶部互相有语言切换链接。

- [ ] **Step 5: 更新进度看板（如项目约定需要）**

若 `docs/PROGRESS.md` 有对应条目需要勾选/更新，按项目现有格式补充一行说明本功能已完成（不确定格式时可跳过，不属于本功能的强制交付物）。

- [ ] **Step 6: 最终 Commit（如 Step 5 有改动）**

```bash
git add docs/PROGRESS.md
git commit -m "docs: mark bilingual UI support as complete in progress board"
```
