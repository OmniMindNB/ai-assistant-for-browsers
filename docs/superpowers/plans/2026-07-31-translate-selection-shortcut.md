# 新增内置快捷键「翻译划词」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第三个内置快捷键「翻译划词」（`scope: 'selection'`），沿用 `lib/shortcuts.ts` 现有的 `BUILTINS` 声明方式，无需改动执行管线或 UI 组件。

**Architecture:** 单任务改动——`lib/shortcuts.ts` 新增常量与 `BUILTINS` 条目、`lib/i18n/locales/{en,zh}.ts` 新增一对 name/prompt key、`lib/shortcuts.test.ts` 同步更新因默认项数量从 2 变为 3 而失效的断言并新增翻译项解析测试。三处必须一起改完才能编译通过和测试通过，因此不拆分成多个任务。

**Tech Stack:** TypeScript + Vitest，沿用现有 `lib/shortcuts.ts` / `lib/i18n` 的纯函数 + 静态字典模式。

## Global Constraints

- 新内置项 id：`builtin:translate-selection`（常量名 `BUILTIN_TRANSLATE_ID`），`scope: 'selection'`，追加在 `BUILTINS` 数组末尾（`Summarize → Explain → Translate` 顺序稳定）。
- 新增 i18n key：`shortcut.builtinTranslateName`、`shortcut.builtinTranslatePrompt`，中英文都要有，且必须成对新增（`TranslationKey = keyof typeof zh`，`en`/`zh` 缺一个都会编译失败）。
- 英文提示词：`Translate the selected text into English; if it is already in English, translate it into Chinese instead. Keep the tone and meaning faithful, and briefly note any idioms or culturally specific references.`
- 中文提示词：`将选中文本翻译成中文；如果原文本身已经是中文，则翻译成英文。请保持原意和语气，并简要标注习语或具有文化背景的表达。`
- 与另外两个内置提示词不同：**不追加** `Respond in English.`/`请使用中文回答。` 后缀（该后缀是给「输出语言本身不确定」的动作用的；翻译动作的输出语言已经在指令里显式指定，回退分支已经处理了「原文已是目标语言」的情况，再加后缀会自相矛盾）。
- 参考设计文档：`docs/superpowers/specs/2026-07-31-translate-selection-shortcut-design.md`。
- 不改变 `WorkbenchComposer` chip 展示逻辑、`buildShortcutExecution`/`store.shortcutSelectionPrompt` 执行管线、设置页 `ShortcutSettings` 组件——三者都是通用遍历 `ShortcutConfig[]`，新内置项自动生效，不需要改动。
- 不清理 `store.summarizeDisplay`/`store.summarizePrompt`/`store.explainDisplay`/`store.explainPrompt` 等未被引用的旧版 i18n key——与本次改动无关。

---

### Task 1: 新增 Translate 内置快捷键

**Files:**
- Modify: `lib/shortcuts.ts`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/zh.ts`
- Test: `lib/shortcuts.test.ts`

**Interfaces:**
- Produces: `export const BUILTIN_TRANSLATE_ID = 'builtin:translate-selection'`（供其他模块引用第三个内置项的 id，与已有的 `BUILTIN_SUMMARIZE_ID`/`BUILTIN_EXPLAIN_ID` 同级导出）。

- [ ] **Step 1: 更新会因默认项从 2 个变成 3 个而失效的既有测试**

打开 `lib/shortcuts.test.ts`，在顶部 import 列表里把

```ts
import {
  BUILTIN_EXPLAIN_ID,
  BUILTIN_SUMMARIZE_ID,
  SHORTCUTS_STORAGE_KEY,
```

改成

```ts
import {
  BUILTIN_EXPLAIN_ID,
  BUILTIN_SUMMARIZE_ID,
  BUILTIN_TRANSLATE_ID,
  SHORTCUTS_STORAGE_KEY,
```

把 `describe('shortcut defaults and localization', ...)` 里的第一个测试（原文件第 53-58 行）

```ts
  it('creates the two stable defaults in canonical order', () => {
    expect(defaultShortcutConfigs().map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_EXPLAIN_ID,
    ]);
  });
```

改成

```ts
  it('creates the three stable defaults in canonical order', () => {
    expect(defaultShortcutConfigs().map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_EXPLAIN_ID,
      BUILTIN_TRANSLATE_ID,
    ]);
  });
```

紧跟在 `'resolves an unedited built-in through the current locale'` 测试（原文件第 60-64 行）之后新增一个测试：

```ts
  it('resolves the translate built-in through the current locale', () => {
    const translateShortcut = defaultShortcutConfigs()[2];
    expect(resolveShortcut(translateShortcut, translator(zh)).name).toBe('翻译划词');
    expect(resolveShortcut(translateShortcut, translator(en)).name).toBe('Translate selection');
  });
```

在 `describe('shortcut list operations', ...)` 里，把 `restoreDefaultShortcuts` 测试（原文件第 256-271 行）里的断言

```ts
    const restored = restoreDefaultShortcuts([custom, defaultShortcutConfigs()[1]]);
    expect(restored.map((item) => item.id)).toEqual([
      'custom-1',
      BUILTIN_EXPLAIN_ID,
      BUILTIN_SUMMARIZE_ID,
    ]);
```

改成

```ts
    const restored = restoreDefaultShortcuts([custom, defaultShortcutConfigs()[1]]);
    expect(restored.map((item) => item.id)).toEqual([
      'custom-1',
      BUILTIN_EXPLAIN_ID,
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_TRANSLATE_ID,
    ]);
```

把 `moveShortcut` 测试（原文件第 273-283 行）

```ts
  it('moves one item without changing any record', () => {
    const items = [
      ...defaultShortcutConfigs(),
      { id: 'custom-1', origin: 'custom', scope: 'none', customized: true, name: 'C', prompt: 'P' },
    ] satisfies ShortcutConfig[];
    expect(moveShortcut(items, 'custom-1', 'up').map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      'custom-1',
      BUILTIN_EXPLAIN_ID,
    ]);
  });
```

改成

```ts
  it('moves one item without changing any record', () => {
    const items = [
      ...defaultShortcutConfigs(),
      { id: 'custom-1', origin: 'custom', scope: 'none', customized: true, name: 'C', prompt: 'P' },
    ] satisfies ShortcutConfig[];
    expect(moveShortcut(items, 'custom-1', 'up').map((item) => item.id)).toEqual([
      BUILTIN_SUMMARIZE_ID,
      BUILTIN_EXPLAIN_ID,
      'custom-1',
      BUILTIN_TRANSLATE_ID,
    ]);
  });
```

- [ ] **Step 2: 运行测试，确认按预期失败**

Run: `pnpm vitest run lib/shortcuts.test.ts`
Expected: FAIL —`BUILTIN_TRANSLATE_ID` 未导出（import 报错/`undefined`），`defaultShortcutConfigs()` 仍只返回 2 项，新增的 translate 解析测试和已更新的断言都会失败。

- [ ] **Step 3: 在 `lib/shortcuts.ts` 里新增常量和 `BUILTINS` 条目**

把

```ts
export const BUILTIN_SUMMARIZE_ID = 'builtin:summarize-page';
export const BUILTIN_EXPLAIN_ID = 'builtin:explain-selection';

const BUILTINS = [
  {
    id: BUILTIN_SUMMARIZE_ID,
    scope: 'page',
    nameKey: 'shortcut.builtinSummarizeName',
    promptKey: 'shortcut.builtinSummarizePrompt',
  },
  {
    id: BUILTIN_EXPLAIN_ID,
    scope: 'selection',
    nameKey: 'shortcut.builtinExplainName',
    promptKey: 'shortcut.builtinExplainPrompt',
  },
] as const;
```

改成

```ts
export const BUILTIN_SUMMARIZE_ID = 'builtin:summarize-page';
export const BUILTIN_EXPLAIN_ID = 'builtin:explain-selection';
export const BUILTIN_TRANSLATE_ID = 'builtin:translate-selection';

const BUILTINS = [
  {
    id: BUILTIN_SUMMARIZE_ID,
    scope: 'page',
    nameKey: 'shortcut.builtinSummarizeName',
    promptKey: 'shortcut.builtinSummarizePrompt',
  },
  {
    id: BUILTIN_EXPLAIN_ID,
    scope: 'selection',
    nameKey: 'shortcut.builtinExplainName',
    promptKey: 'shortcut.builtinExplainPrompt',
  },
  {
    id: BUILTIN_TRANSLATE_ID,
    scope: 'selection',
    nameKey: 'shortcut.builtinTranslateName',
    promptKey: 'shortcut.builtinTranslatePrompt',
  },
] as const;
```

- [ ] **Step 4: 在 `lib/i18n/locales/en.ts` 里新增一对 key**

把

```ts
  'shortcut.builtinExplainName': 'Explain selection',
  'shortcut.builtinExplainPrompt':
    'Explain the selected text, adding background, definitions, or a plain-language explanation when useful. Respond in English.',
  'shortcut.heading': 'Shortcuts',
```

改成

```ts
  'shortcut.builtinExplainName': 'Explain selection',
  'shortcut.builtinExplainPrompt':
    'Explain the selected text, adding background, definitions, or a plain-language explanation when useful. Respond in English.',
  'shortcut.builtinTranslateName': 'Translate selection',
  'shortcut.builtinTranslatePrompt':
    'Translate the selected text into English; if it is already in English, translate it into Chinese instead. Keep the tone and meaning faithful, and briefly note any idioms or culturally specific references.',
  'shortcut.heading': 'Shortcuts',
```

- [ ] **Step 5: 在 `lib/i18n/locales/zh.ts` 里新增一对 key**

把

```ts
  'shortcut.builtinExplainName': '解释划词',
  'shortcut.builtinExplainPrompt':
    '请解释选中的内容，必要时给出背景、定义或通俗说明。请使用中文回答。',
  'shortcut.heading': '快捷方式',
```

改成

```ts
  'shortcut.builtinExplainName': '解释划词',
  'shortcut.builtinExplainPrompt':
    '请解释选中的内容，必要时给出背景、定义或通俗说明。请使用中文回答。',
  'shortcut.builtinTranslateName': '翻译划词',
  'shortcut.builtinTranslatePrompt':
    '将选中文本翻译成中文；如果原文本身已经是中文，则翻译成英文。请保持原意和语气，并简要标注习语或具有文化背景的表达。',
  'shortcut.heading': '快捷方式',
```

- [ ] **Step 6: 运行定向测试，确认通过**

Run: `pnpm vitest run lib/shortcuts.test.ts`
Expected: PASS（全部用例，包括更新过的和新增的）

- [ ] **Step 7: 运行完整测试、类型检查、生产构建**

Run: `pnpm test`
Expected: PASS

Run: `pnpm compile`
Expected: 无类型错误（确认 `en`/`zh` 的 key 集合仍然完全对齐）

Run: `pnpm build`
Expected: 构建成功，无报错

- [ ] **Step 8: 手动验证（`pnpm dev` 加载解包扩展）**

在任意网页选中一段文本，打开侧边栏，确认工具栏出现三个 chip：`Summarize page`、`Explain selection`、`Translate selection`（或对应中文名，取决于界面语言），点击 `Translate selection` 触发一次翻译请求且能正常返回结果。在设置页的快捷键列表里确认新内置项可见、可编辑覆盖、可参与排序。

- [ ] **Step 9: 提交**

```bash
git add lib/shortcuts.ts lib/shortcuts.test.ts lib/i18n/locales/en.ts lib/i18n/locales/zh.ts
git commit -m "feat: add translate-selection builtin shortcut"
```
