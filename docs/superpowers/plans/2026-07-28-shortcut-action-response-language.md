# 快捷动作回复语言 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `Summarize page` 与 `Explain selection` 的隐藏提示词和回复语言跟随当前界面语言，同时保持普通对话继续跟随用户输入语言。

**Architecture:** 在现有中英文翻译表中加入快捷动作隐藏提示词，并新增一个位于 `lib/chat/` 的纯函数模块负责组装总结与选区解释提示词。Zustand store 只在两个快捷动作中调用这些函数；普通 `send()` 与 `editMessage()` 路径保持原样。

**Tech Stack:** TypeScript 5.9、React 19、Zustand、WXT 0.20、Vitest 4、Chrome Manifest V3。

## Global Constraints

- 仅 `Summarize page` 与 `Explain selection` 跟随已解析的界面语言。
- 普通输入框对话继续根据用户输入语言回答，不强制跟随界面语言。
- 不修改全局 Agent 系统提示词的语言策略。
- 保持选区上限 `MAX_SELECTION_CHARS = 4000`。
- 不改变快捷动作展示消息、页面读取流程或会话持久化格式。
- 不增加运行时依赖。

---

### Task 1: 本地化快捷提示词组装

**Files:**
- Create: `lib/chat/shortcut-prompts.test.ts`
- Create: `lib/chat/shortcut-prompts.ts`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/zh.ts`

**Interfaces:**
- Consumes: `Translate` from `lib/i18n/index.tsx`.
- Produces: `buildSummarizePagePrompt(translate: Translate): string`.
- Produces: `buildExplainSelectionPrompt(translate: Translate, selection: string, maxChars: number): string`.
- Produces translation keys `store.summarizePrompt` and `store.explainPrompt`.

- [ ] **Step 1: Write the failing localized prompt tests**

Create `lib/chat/shortcut-prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Translate } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import { buildExplainSelectionPrompt, buildSummarizePagePrompt } from './shortcut-prompts';

const translate = (dict: Record<keyof typeof zh, string>): Translate =>
  ((key) => dict[key]) as Translate;

describe('shortcut action prompts', () => {
  it('asks for an English summary in the English UI', () => {
    const prompt = buildSummarizePagePrompt(translate(en));
    expect(prompt).toContain('Summarize the current page');
    expect(prompt).toContain('Respond in English');
  });

  it('asks for a Chinese summary in the Chinese UI', () => {
    const prompt = buildSummarizePagePrompt(translate(zh));
    expect(prompt).toContain('总结当前网页');
    expect(prompt).toContain('请使用中文回答');
  });

  it('keeps the selected text and asks for an English explanation', () => {
    const prompt = buildExplainSelectionPrompt(translate(en), '选择的原文', 4000);
    expect(prompt).toContain('Explain the selected text');
    expect(prompt).toContain('Respond in English');
    expect(prompt).toContain('"""选择的原文"""');
  });

  it('keeps the selected text and asks for a Chinese explanation', () => {
    const prompt = buildExplainSelectionPrompt(translate(zh), 'selected source', 4000);
    expect(prompt).toContain('解释以下选中的内容');
    expect(prompt).toContain('请使用中文回答');
    expect(prompt).toContain('"""selected source"""');
  });

  it('preserves the existing selection character limit', () => {
    const prompt = buildExplainSelectionPrompt(translate(en), 'x'.repeat(4001), 4000);
    expect(prompt).toContain(`"""${'x'.repeat(4000)}"""`);
    expect(prompt).not.toContain('x'.repeat(4001));
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm vitest run lib/chat/shortcut-prompts.test.ts
```

Expected: FAIL because `lib/chat/shortcut-prompts.ts` and the two translation keys do not exist.

- [ ] **Step 3: Add the translation keys**

Add to `lib/i18n/locales/zh.ts`:

```ts
'store.summarizePrompt':
  '请读取当前网页内容并总结，给出 3-5 个要点和一段简短摘要。请使用中文回答。',
'store.explainPrompt':
  '请解释以下选中的内容，必要时给出背景、定义或通俗说明。请使用中文回答：',
```

Add matching keys to `lib/i18n/locales/en.ts`:

```ts
'store.summarizePrompt':
  'Summarize the current page in 3-5 key points followed by a short overview. Respond in English.',
'store.explainPrompt':
  'Explain the selected text, adding background, definitions, or a plain-language explanation when useful. Respond in English:',
```

- [ ] **Step 4: Implement the minimal prompt builders**

Create `lib/chat/shortcut-prompts.ts`:

```ts
import type { Translate } from '@/lib/i18n';

export function buildSummarizePagePrompt(translate: Translate): string {
  return translate('store.summarizePrompt');
}

export function buildExplainSelectionPrompt(
  translate: Translate,
  selection: string,
  maxChars: number,
): string {
  return `${translate('store.explainPrompt')}\n\n"""${selection.slice(0, maxChars)}"""`;
}
```

- [ ] **Step 5: Run the tests and verify GREEN**

Run:

```bash
pnpm vitest run lib/chat/shortcut-prompts.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add lib/chat/shortcut-prompts.ts lib/chat/shortcut-prompts.test.ts lib/i18n/locales/en.ts lib/i18n/locales/zh.ts
git commit -m "fix: localize shortcut action prompts"
```

---

### Task 2: 接入侧边栏快捷动作并保护普通对话路径

**Files:**
- Modify: `entrypoints/sidepanel/store.ts:23-33`
- Modify: `entrypoints/sidepanel/store.ts:223-273`
- Modify: `lib/final-review.test.ts`

**Interfaces:**
- Consumes: `buildSummarizePagePrompt(t)` from Task 1.
- Consumes: `buildExplainSelectionPrompt(t, selection.text, MAX_SELECTION_CHARS)` from Task 1.
- Preserves: `send(text)` and `editMessage(id, newContent)` pass user content unchanged to `runAgent()`.

- [ ] **Step 1: Write the failing store wiring regression test**

Append to `lib/final-review.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

describe('side-panel shortcut localization wiring', () => {
  const storeSource = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/sidepanel/store.ts'),
    'utf8',
  );

  it('uses localized prompt builders for both shortcut actions', () => {
    expect(storeSource).toContain('buildSummarizePagePrompt(t)');
    expect(storeSource).toContain(
      'buildExplainSelectionPrompt(t, selection.text, MAX_SELECTION_CHARS)',
    );
    expect(storeSource).not.toContain(
      '请读取当前网页内容并总结，给出 3-5 个要点和一段简短摘要。',
    );
    expect(storeSource).not.toContain('请解释以下选中的内容，必要时给出背景、定义或通俗说明');
  });

  it('keeps ordinary user messages unchanged', () => {
    expect(storeSource).toContain(
      "await runAgent(set, get, makeMessage('user', content, 'input'), content);",
    );
    expect(storeSource).toContain(
      "return runAgent(set, get, makeMessage('user', trimmed, 'input'), trimmed, undefined, id);",
    );
  });
});
```

- [ ] **Step 2: Run the wiring tests and verify RED**

Run:

```bash
pnpm vitest run lib/final-review.test.ts
```

Expected: FAIL because `store.ts` still contains the two hard-coded Chinese prompts and does not call the prompt builders.

- [ ] **Step 3: Wire the prompt builders into `store.ts`**

Add the import:

```ts
import {
  buildExplainSelectionPrompt,
  buildSummarizePagePrompt,
} from '@/lib/chat/shortcut-prompts';
```

Replace the summary prompt:

```ts
const prompt = buildSummarizePagePrompt(t);
```

Replace the selection prompt:

```ts
const prompt = buildExplainSelectionPrompt(t, selection.text, MAX_SELECTION_CHARS);
```

Do not modify `send()` or `editMessage()`.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```bash
pnpm vitest run lib/chat/shortcut-prompts.test.ts lib/final-review.test.ts
```

Expected: all localized prompt and store wiring tests pass.

- [ ] **Step 5: Run type checking**

Run:

```bash
pnpm compile
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 6: Commit Task 2**

```bash
git add entrypoints/sidepanel/store.ts lib/final-review.test.ts
git commit -m "fix: follow UI language in shortcut replies"
```

---

### Task 3: 完整验证并重建 V1.1.0 商店包

**Files:**
- Regenerate: `.output/chrome-mv3/`
- Regenerate: `.output/aluminum-1.1.0-chrome.zip`
- Modify: `docs/chrome-store-release-checklist-1.1.md`

**Interfaces:**
- Consumes: completed localized shortcut behavior from Tasks 1 and 2.
- Produces: a production Chrome MV3 build and V1.1.0 ZIP ready to replace the current Web Store draft.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all tests pass with no failed files.

- [ ] **Step 2: Run the final type check**

Run:

```bash
pnpm compile
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Build the production extension**

Run:

```bash
pnpm build
```

Expected: WXT produces `.output/chrome-mv3` and generated `manifest.json` reports version `1.1.0`.

- [ ] **Step 4: Generate the release ZIP**

Run:

```bash
pnpm zip
```

Expected: WXT produces `.output/aluminum-1.1.0-chrome.zip`.

- [ ] **Step 5: Verify the packaged manifest and checksum**

Run:

```powershell
tar -xOf .output/aluminum-1.1.0-chrome.zip manifest.json
Get-FileHash .output/aluminum-1.1.0-chrome.zip -Algorithm SHA256
```

Expected:

- manifest version is `1.1.0`;
- `default_locale` is `en`;
- permissions are `sidePanel`, `storage`, `scripting`, `activeTab`, and `tabs`;
- `userScripts` is absent;
- record the new SHA-256 value.

- [ ] **Step 6: Update the release checklist**

In `docs/chrome-store-release-checklist-1.1.md`:

- replace the old SHA-256 with the value from Step 5;
- record the new test-file and test-count totals;
- add a manual QA item confirming both shortcuts answer in English under the English UI and in Chinese under the Chinese UI.

- [ ] **Step 7: Commit Task 3**

```bash
git add docs/chrome-store-release-checklist-1.1.md
git commit -m "docs: refresh 1.1 release verification"
```

- [ ] **Step 8: Stop before Web Store upload**

Report the new ZIP path and SHA-256. Uploading the replacement package to Chrome Web Store is an external side effect and requires separate user confirmation at action time.
