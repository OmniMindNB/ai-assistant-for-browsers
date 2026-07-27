# 设计：插件界面中英双语支持

- 状态：已批准 Approved
- 日期：2026-07-27
- 关联：`lib/theme.ts`（复用的 auto/手动覆盖模式）、`entrypoints/sidepanel/App.tsx`、
  `entrypoints/options/App.tsx`、`components/ProviderSettings.tsx`、`components/AppearanceSettings.tsx`、
  `wxt.config.ts`、`README.md`

## 背景

当前插件的所有用户可见文案（侧边栏聊天视图、设置页、Provider 表单、ARIA label、状态提示）
均以中文字面量硬编码在 JSX 里，`entrypoints/sidepanel/index.html` 与 `entrypoints/options/index.html`
的 `<html lang>` 也固定为 `zh-CN`；`wxt.config.ts` 里的扩展名称/描述同样只有中文，
Chrome Web Store 商店列表对英文用户不友好。项目目前没有任何 i18n 基础设施。

本设计让插件同时面向中/英文用户：界面文案可双语切换，商店列表文案对应本地化，
README 提供英文版本。Agent 系统提示词、代码注释、commit message 不在范围内——
按 `CLAUDE.md` 约定继续保持中文，且 Agent 回复语言已经自然跟随用户输入语言，无需改动。

## 目标

- 侧边栏 + 设置页（options）的全部界面文案可在「跟随浏览器 / 中文 / English」三态间切换，
  默认跟随浏览器语言，用户可在设置页手动覆盖，偏好持久化到本地。
- Chrome Web Store 商店列表（扩展名称、描述）提供中英文版本，跟随用户 Chrome 的界面语言自动选择。
- `README.md` 补充英文版 `README.en.md`，两份文件互相链接。
- `<html lang>` 随所选语言动态更新。

## 非目标

- 不改动 Agent 系统提示词（`lib/agent/agent.ts`）——回复语言已由 LLM 根据用户输入自然决定。
- 不翻译代码注释、commit message、`docs/` 下的其余中文文档（除 README 外）。
- 不引入 `react-i18next` 等第三方 i18n 库——文案量和复杂度（无复数、无嵌套插值）不值得引入依赖，
  手写轻量 `t()` 与项目现有风格（`lib/theme.ts` 的 auto/手动覆盖模式）保持一致。
- 不做「记忆每个会话独立语言」之类的高级功能，语言是全局单一偏好。

## 设计

### 架构：`lib/i18n/`

镜像 `lib/theme.ts` 已经验证过的 auto/手动覆盖模式：

```
lib/i18n/
  locales/
    zh.ts   // 源语言，扁平化命名空间 key，如 sidebar.newChat / confirm.approve
    en.ts   // 英文翻译，用 `satisfies Record<keyof typeof zh, string>` 强制与 zh.ts 的 key 一一对应
  index.ts  // LocaleMode 类型、resolveLocale、load/saveLocale、LocaleProvider、useTranslation
```

```ts
export type LocaleMode = 'auto' | 'zh' | 'en';
export type ResolvedLocale = 'zh' | 'en';

const LOCALE_KEY = 'aluminum:locale';

export async function loadLocale(): Promise<LocaleMode>;
export async function saveLocale(mode: LocaleMode): Promise<void>;

/** auto 模式下用 chrome.i18n.getUILanguage()（降级 navigator.language）判断；zh/en 原样返回 */
export function resolveLocale(mode: LocaleMode): ResolvedLocale;

/** 把解析后的语言应用到 <html lang> */
export function applyLocale(mode: LocaleMode): ResolvedLocale;
```

`resolveLocale`：语言字符串以 `zh` 开头（`zh`、`zh-CN`、`zh-TW` 等）→ `'zh'`，否则一律 `'en'`
（不做英文以外语种的细分，未识别语言落到英文兜底，覆盖面最广）。

`t()` 的调用面几乎覆盖侧边栏和设置页的每一个组件（不同于 `theme.ts` 只被 3-4 个组件用到），
逐层 prop 透传会让 `App.tsx`（1000+ 行、约 15 个子组件函数）里几乎每个函数签名都多一个参数。
因此用 React Context 承载：

```tsx
// LocaleProvider：加载偏好、应用、监听 setMode，向下提供 { t, locale, resolved, setLocale }
export function LocaleProvider({ children }: { children: ReactNode }): JSX.Element;
export function useTranslation(): {
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  locale: LocaleMode;
  resolved: ResolvedLocale;
  setLocale: (mode: LocaleMode) => Promise<void>;
};
```

`t(key, vars)`：从当前 `resolved` 语言的字典取值，`{varName}` token 做字符串替换。
因为 `en.ts` 用 `satisfies` 强制和 `zh.ts` 同构，key 缺失在编译期就会报错，
`t()` 内部不需要「key 不存在时怎么办」的运行时兜底分支。

`entrypoints/sidepanel/main.tsx` 与 `entrypoints/options/main.tsx` 的 `<App />` 外包一层
`<LocaleProvider>`（与现有 `applyTheme('auto')` 预应用同理，`LocaleProvider` 内部在首次渲染前
先用 `resolveLocale('auto')` 应用一次 `<html lang>`，避免闪烁，随后用存储的偏好修正）。

### 文案迁移

把 `App.tsx`、`MessageEditor.tsx`、`ProviderSettings.tsx`、`AppearanceSettings.tsx`、
`options/App.tsx` 里现存的全部中文字面量（普查约 130 处命中，含少量注释需排除）替换为
`t('namespace.key')` 调用。命名空间按文件/功能区划分：`sidebar.*`、`topbar.*`、`chat.*`、
`confirm.*`、`settings.*`、`appearance.*`、`language.*`、`provider.*`、`common.*`（通用的
「取消/保存/删除」等复用词条落在 `common`，避免重复定义）。

### 语言切换入口

新增 `components/LanguageSettings.tsx`，UI 与 `AppearanceSettings.tsx` 的三态分段按钮完全一致
（跟随浏览器 / 中文 / English），复用同一套 Tailwind class。在设置视图里紧邻外观设置放置——
侧边栏 `SettingsView`（`App.tsx`）与 `options/App.tsx` 都需要接入。

### Chrome Web Store 商店列表 i18n

与应用内切换器是两套独立机制——商店列表语言由用户 Chrome 自身的界面语言决定，不受应用内设置影响：

- 新增 `public/_locales/zh_CN/messages.json`、`public/_locales/en/messages.json`，
  各含 `extName`/`extDescription` 两个 key。
- `wxt.config.ts`：`manifest.name` → `'__MSG_extName__'`，`manifest.description` →
  `'__MSG_extDescription__'`，`action.default_title` → `'__MSG_extName__'`，
  顶层新增 `default_locale: 'zh_CN'`。

### README

新增 `README.en.md`，内容结构与 `README.md` 对齐（英文翻译）。两份文件顶部各加一行语言切换：

- `README.md` 顶部：`**中文** | [English](README.en.md)`
- `README.en.md` 顶部：`**English** | [中文](README.md)`

## 边界与异常

- `chrome.i18n.getUILanguage()` 在 content script/background 等非 UI 上下文不一定可用，
  但 `resolveLocale` 只在侧边栏/options 的 React 渲染路径里调用，不存在跨 context 调用的情况。
- 用户手动选中 `zh`/`en` 后修改系统语言：不影响已保存的手动偏好，只有 `auto` 模式才会
  重新解析。与 `theme.ts` 不同的是，`auto` 语言不做运行时监听——`matchMedia` 对深色模式
  有原生变更事件，但浏览器 UI 语言没有对应的 change 事件可监听，`auto` 下的语言只在
  `LocaleProvider` 挂载时解析一次，用户改了系统语言需要重新打开侧边栏/options 才会生效。
- `en.ts` 与 `zh.ts` 的 key 不同构：`pnpm compile` 阶段的 TS 类型检查失败，不会进入运行时。

## 安全与隐私

不涉及新增权限、网络请求或页面内容访问。语言偏好与主题偏好同样只存 `chrome.storage.local`，
不同步云端。

## 测试

新增 `lib/i18n/i18n.test.ts`（沿用 `lib/settings.test.ts` 的 `describe` 风格）：

- `resolveLocale`：`'auto'` + 各类 `zh*`/`en*`/未知语言字符串输入 → 预期输出；`'zh'`/`'en'` 原样返回。
- `loadLocale`/`saveLocale`：`browser.storage.local` 读写往返。
- `en.ts`/`zh.ts` key 同构性由 TS 编译期保证，不需要额外运行时测试。

不新增组件测试（`vitest.config.ts` 的 `include` 只覆盖 `lib/**`，与 Spec
`2026-07-26-provider-custom-preset-option-design.md` 中的既有结论一致）。

手动 QA：侧边栏与设置页分别切换三态语言，确认全部文案跟随切换、`<html lang>` 更新、
关闭重开后偏好保留；分别在中文/英文 Chrome 环境下确认 `auto` 默认值正确；
打包后查看 `chrome://extensions` 里扩展名称/描述随浏览器语言变化。

## 验收标准

- [ ] 设置页（侧边栏内 + options 页）出现「语言 / Language」三态切换，行为与外观切换一致。
- [ ] 默认（`auto`）状态下，界面语言与浏览器 UI 语言一致；中文之外的浏览器语言落到英文。
- [ ] 手动切换到「中文」或「English」后，侧边栏与设置页的全部文案（含 ARIA label、
      确认卡片、Provider 表单、状态提示）同步切换，`<html lang>` 随之更新。
- [ ] 关闭并重新打开侧边栏/options，语言偏好保持上次手动选择。
- [ ] `wxt.config.ts` 使用 `__MSG_extName__`/`__MSG_extDescription__` + `default_locale`，
      `public/_locales/{zh_CN,en}/messages.json` 均存在且 key 一致。
- [ ] `README.en.md` 存在，与 `README.md` 顶部互相有语言切换链接。
- [ ] `pnpm compile` 与 `pnpm test` 通过。

## 附录：范围补充（写计划阶段发现）

写实现计划时发现 `entrypoints/sidepanel/store.ts`（原设计未列出）里混有两类文本：

- **用户可见**：`error: '...'` 状态提示（约 12 处，如「未配置 Provider，请在『设置』中添加 API Key。」）、
  以及总结/解释操作注入的聊天气泡（`📄 总结当前网页`、`💬 解释：{preview}`）。这些属于本设计
  「状态提示」验收标准的一部分，纳入翻译范围，用 `t()` 替换。
- **Agent 输入**：`SYSTEM_PROMPT` 常量、`summarizePage`/`explainSelection` 里发给模型的 `prompt`
  变量（用户看不到，只有 `display` 气泡可见）。这些不属于「界面」，维持非目标里「不改 Agent
  系统提示词」的既定边界，不翻译、不改动，包括其中「默认用中文回答，除非用户使用其他语言」的
  指令。

`store.ts` 是 Zustand store（非 React 组件），不能用 `useTranslation()` hook。`lib/i18n` 因此在
Context 之外再导出一个模块级、非 hook 的 `t()`（读取一个由 `applyLocale()` 同步维护的模块级
`currentLocale` 变量），`useTranslation()` 返回的 `t` 与之是同一个函数引用；React 侧的 Context
只负责在语言变化时触发重渲染，不是 `t()` 正确性的必要条件。
