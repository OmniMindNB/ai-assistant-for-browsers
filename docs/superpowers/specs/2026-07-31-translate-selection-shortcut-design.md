# 设计：新增内置快捷键「翻译划词」

- 状态：已批准 Approved
- 日期：2026-07-31
- 关联：`lib/shortcuts.ts`、`lib/shortcuts.test.ts`、`lib/i18n/locales/{zh,en}.ts`

## 背景

目前只有两个内置快捷键：`Summarize page`（page scope）和 `Explain selection`
（selection scope）。两者都通过 `lib/shortcuts.ts` 里的 `BUILTINS` 静态数组 +
i18n name/prompt key 声明，执行路径（`resolveShortcut` → `buildShortcutExecution`
→ `store.shortcutSelectionPrompt` 包裹）完全通用，不针对具体某个内置项做特殊
处理。侧边栏工具栏（`WorkbenchComposer`）取 `shortcuts.filter(isUsableShortcutCommand)
.slice(0, 4)` 展示最多 4 个 chip，目前 2 个内置项之外还留 2 个位置给自定义快捷键。

## 目标

- 新增第三个内置快捷键「翻译划词」，`scope: 'selection'`，与 Explain 同属
  selection scope，作为「解释划词」的自然搭档。
- 沿用现有 `BUILTINS` + i18n key 的声明方式，不引入新的架构或特殊路径。

## 非目标

- 不改变 chip 展示逻辑、slot 数量（仍是 4 个）、overflow 规则。
- 不改变 `buildShortcutExecution`/`store.shortcutSelectionPrompt` 等通用执行管线。
- 不清理 `store.summarizeDisplay`/`store.summarizePrompt`/`store.explainDisplay`/
  `store.explainPrompt` 等旧版遗留 i18n key（现已被通用管线取代、未被引用，但
  清理与本次改动无关，不在本次范围内）。

## 设计

### 1. `lib/shortcuts.ts`

新增常量与 `BUILTINS` 条目：

```ts
export const BUILTIN_TRANSLATE_ID = 'builtin:translate-selection';

const BUILTINS = [
  { id: BUILTIN_SUMMARIZE_ID, scope: 'page', nameKey: 'shortcut.builtinSummarizeName', promptKey: 'shortcut.builtinSummarizePrompt' },
  { id: BUILTIN_EXPLAIN_ID, scope: 'selection', nameKey: 'shortcut.builtinExplainName', promptKey: 'shortcut.builtinExplainPrompt' },
  { id: BUILTIN_TRANSLATE_ID, scope: 'selection', nameKey: 'shortcut.builtinTranslateName', promptKey: 'shortcut.builtinTranslatePrompt' },
] as const;
```

顺序追加在末尾，保持 `Summarize → Explain → Translate` 的稳定顺序（`defaultShortcutConfigs()`
按数组顺序生成）。

### 2. i18n（`lib/i18n/locales/en.ts` / `zh.ts`）

新增两个 key（紧邻现有 `shortcut.builtinExplain*` 之后）：

- `shortcut.builtinTranslateName`
  - en: `Translate selection`
  - zh: `翻译划词`
- `shortcut.builtinTranslatePrompt`
  - en: `Translate the selected text into English; if it is already in English, translate it into Chinese instead. Keep the tone and meaning faithful, and briefly note any idioms or culturally specific references.`
  - zh: `将选中文本翻译成中文；如果原文本身已经是中文，则翻译成英文。请保持原意和语气，并简要标注习语或具有文化背景的表达。`

与另外两个内置提示词的一处刻意不同：**不追加** `Respond in English.`/`请使用中文
回答。` 后缀。该后缀存在的原因是原始动作（总结/解释）本身不指定输出语言，模型
默认会跟随被总结/解释内容的语言，需要显式强制跟随界面语言；而翻译动作的输出
语言已经在指令里明确指定（界面语言，若原文已是界面语言则回退到应用支持的另一
语言），再加这句反而会与「回退翻译成中文」分支自相矛盾。

### 3. 侧边栏 / 设置页

不需要改动。`WorkbenchComposer` 的 quick chip、Options/嵌入式 `ShortcutSettings`
列表、`buildShortcutExecution` 的 selection 分支均已经是通用遍历 `ShortcutConfig[]`，
新内置项会自动出现在两处 UI 和执行路径里。

## 测试

`lib/shortcuts.test.ts` 中依赖 `defaultShortcutConfigs()` 具体长度/顺序的用例需要
同步更新（纯粹是断言层面的机械调整，无行为变化）：

- `'creates the two stable defaults in canonical order'`：改为断言三项
  `[SUMMARIZE, EXPLAIN, TRANSLATE]`，测试描述改为 "three"。
- `restoreDefaultShortcuts` 用例（第 265 行附近）：输入里只显式包含 Explain，
  断言输出末尾追加的缺失内置项需要同时包含 `BUILTIN_SUMMARIZE_ID` 和新的
  `BUILTIN_TRANSLATE_ID`。
- `moveShortcut` 用例（第 273 行附近）：`[...defaultShortcutConfigs(), custom]`
  现在是 4 项，`custom-1` 的初始位置和上移后的期望顺序需要按新长度重新计算。

新增最小覆盖：`resolveShortcut(defaultShortcutConfigs()[2], translator(...))` 在
en/zh 下分别解析出 `Translate selection`/`翻译划词`。

收尾：`pnpm compile`、`pnpm test`、`pnpm build`。

## 验收标准

- [ ] `lib/shortcuts.ts` 新增 `BUILTIN_TRANSLATE_ID` 与对应 `BUILTINS` 条目。
- [ ] `en.ts`/`zh.ts` 成对新增 `shortcut.builtinTranslateName`/`Prompt`。
- [ ] `lib/shortcuts.test.ts` 中因默认项数量变化而失败的断言已同步更新，且新增
      对 Translate 内置项的解析测试。
- [ ] 三个内置快捷键在侧边栏工具栏和设置页快捷键列表中均正常显示、可执行、可
      拖动排序（复用现有 CRUD 能力，无需新增测试即视为满足，因逻辑是通用的）。
- [ ] `pnpm compile`、`pnpm test`、`pnpm build` 通过。

## 开放问题

- 无。
