# 页面内容脱敏管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在页面正文（`EXTRACT_PAGE`）和表单渲染输出（`renderFormResultForModel`）离开扩展、进入模型请求之前，接入一道可配置的正则脱敏管线，默认开启，内置手机号/邮箱/身份证号/银行卡号四类规则，用户可在设置页逐条禁用并新增自定义规则。

**Architecture:** 新增 `lib/redaction.ts`（存储 + 纯函数 `redactText`，与 `lib/shortcuts.ts` 同构）。两个接入点各自打在其唯一的消费汇聚点：`entrypoints/background.ts` 的 `extractActivePage()`（覆盖 `EXTRACT_PAGE` 的全部消费方）与 `lib/agent/tools.ts` 的 `browser_get_form`（`renderFormResultForModel` 的唯一调用方）。设置页新增 `components/RedactionSettings.tsx`，挂载进已有的 Privacy 分区。

**Tech Stack:** TypeScript, React (options page), Vitest (`unit`/`ui` projects), `chrome.storage.local`（经 `wxt` 的 `browser` 全局）。

**Spec:** `docs/superpowers/specs/2026-08-31-page-redaction-pipeline-design.md`

## Global Constraints

- 命中敏感信息后替换为**完全占位符**，不保留任何原始字符（如 `[手机号已脱敏]`）——不做部分遮码。
- 总开关默认 `enabled: true`；四条内置规则默认全部 `enabled: true`。
- 无效自定义正则（`new RegExp(pattern)` 抛错）静默跳过，绝不抛出、绝不阻塞整体调用方。
- `lib/redaction.ts` 的存储 key 固定为 `runi:redaction`，不同步到云端（`chrome.storage.local`，不是 `.sync`）。
- 内置四条规则的 `label` 字段是固定中文字符串，**不**走 i18n（它是拼进模型可见占位符文本的数据，不是 UI 文案）；设置页 UI 本身的按钮/标题/复选框标签仍需完整 `zh`/`en` 两份 i18n。
- v1 范围只覆盖 `EXTRACT_PAGE` 正文与表单渲染输出；`browser_get_html`/`browser_query_dom`/`browser_get_computed_style`/`browser_screenshot`/`GET_SELECTION` 不在本计划范围内。

---

## Task 1: `lib/redaction.ts` —— 数据模型、内置规则、脱敏纯函数、存储

**Files:**
- Create: `lib/redaction.ts`
- Test: `lib/redaction.test.ts`

**Interfaces:**
- Produces:
  - `interface RedactionRule { id: string; label: string; pattern: string; enabled: boolean; builtin: boolean }`
  - `interface RedactionSettings { enabled: boolean; rules: RedactionRule[] }`
  - `const REDACTION_STORAGE_KEY = 'runi:redaction'`
  - `const BUILTIN_REDACTION_RULES: RedactionRule[]`（4 条，见下）
  - `function defaultRedactionSettings(): RedactionSettings`
  - `function redactText(text: string, settings: RedactionSettings): string`
  - `function loadRedactionSettings(): Promise<RedactionSettings>`
  - `function saveRedactionSettings(settings: RedactionSettings): Promise<void>`
  - `function newRedactionRuleId(): string`

- [ ] **Step 1: Write the failing tests for `redactText`**

Create `lib/redaction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BUILTIN_REDACTION_RULES, defaultRedactionSettings, redactText, type RedactionSettings } from './redaction';

describe('redactText', () => {
  it('redacts a China mobile number with the built-in label', () => {
    const result = redactText('联系电话 13812345678 谢谢', defaultRedactionSettings());
    expect(result).toBe('联系电话 [手机号已脱敏] 谢谢');
  });

  it('redacts an email address', () => {
    const result = redactText('邮箱是 a.b+test@example.com', defaultRedactionSettings());
    expect(result).toBe('邮箱是 [邮箱已脱敏]');
  });

  it('redacts an 18-digit id card number including a trailing X', () => {
    const result = redactText('身份证 11010119900307775X', defaultRedactionSettings());
    expect(result).toBe('身份证 [身份证号已脱敏]');
  });

  it('redacts a 16-digit bank card number', () => {
    const result = redactText('卡号 6222021234567890', defaultRedactionSettings());
    expect(result).toBe('卡号 [银行卡号已脱敏]');
  });

  it('prefers the more specific idcard label over bankcard for an exact 18-digit run', () => {
    // 18 位数字同时匹配 idcard 与 bankcard 的正则；idcard 排在前面，先命中先占位，
    // bankcard 规则再执行时该子串已经是占位符文本，不会重复匹配。
    const result = redactText('号码 110101199003077758', defaultRedactionSettings());
    expect(result).toBe('号码 [身份证号已脱敏]');
  });

  it('does not match a phone-like substring inside a longer digit run', () => {
    // "9913812345678" 是 13 位：既不落在手机号的 11 位边界内（前后都挨着别的数字，
    // 被 (?<!\d)/(?!\d) 挡住），也不落在银行卡号的 16-19 位或身份证号的精确 18 位区间，
    // 三条规则都不应命中，整段文本原样保留。
    const result = redactText('订单号 9913812345678', defaultRedactionSettings());
    expect(result).toBe('订单号 9913812345678');
  });

  it('leaves ordinary text untouched', () => {
    const result = redactText('今天天气不错，适合出门散步。', defaultRedactionSettings());
    expect(result).toBe('今天天气不错，适合出门散步。');
  });

  it('returns the text unchanged when the master switch is off', () => {
    const settings: RedactionSettings = { enabled: false, rules: BUILTIN_REDACTION_RULES };
    expect(redactText('电话 13812345678', settings)).toBe('电话 13812345678');
  });

  it('skips a disabled rule', () => {
    const settings: RedactionSettings = {
      enabled: true,
      rules: BUILTIN_REDACTION_RULES.map((rule) => (rule.id === 'phone' ? { ...rule, enabled: false } : rule)),
    };
    expect(redactText('电话 13812345678', settings)).toBe('电话 13812345678');
  });

  it('silently skips an invalid custom pattern without throwing or blocking other rules', () => {
    const settings: RedactionSettings = {
      enabled: true,
      rules: [
        { id: 'broken', label: '坏规则', pattern: '(unclosed', enabled: true, builtin: false },
        ...BUILTIN_REDACTION_RULES,
      ],
    };
    expect(() => redactText('电话 13812345678', settings)).not.toThrow();
    expect(redactText('电话 13812345678', settings)).toBe('电话 [手机号已脱敏]');
  });

  it('returns empty text unchanged', () => {
    expect(redactText('', defaultRedactionSettings())).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/redaction.test.ts`
Expected: FAIL — `Cannot find module './redaction'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `redactText`, the built-in rules, and `defaultRedactionSettings`**

Create `lib/redaction.ts`:

```ts
// 页面内容脱敏管线：命中敏感信息后替换为完全占位符，不保留任何原始字符
// （ref: docs/superpowers/specs/2026-08-31-page-redaction-pipeline-design.md）。
// 与 lib/shortcuts.ts 同构：chrome.storage.local，不同步到云端。

export interface RedactionRule {
  id: string;
  /** 展示名，同时是占位符文案来源（"手机号" -> "[手机号已脱敏]"）。内置规则的 label 固定中文，不走 i18n。 */
  label: string;
  /** 正则表达式源（不含 flags），运行时以 'g' 编译。 */
  pattern: string;
  enabled: boolean;
  /** true = 内置四类，不可删除，可禁用；false = 用户自定义，可删除可编辑。 */
  builtin: boolean;
}

export interface RedactionSettings {
  enabled: boolean;
  rules: RedactionRule[];
}

export const REDACTION_STORAGE_KEY = 'runi:redaction';

// 顺序即应用顺序：idcard 排在 bankcard 之前，让 18 位数字优先命中更具体的"身份证号"标签
// ——两者的正则都会匹配 18 位数字串，这是已知的简化取舍，不影响脱敏结果本身的正确性。
export const BUILTIN_REDACTION_RULES: RedactionRule[] = [
  { id: 'phone', label: '手机号', pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', enabled: true, builtin: true },
  {
    id: 'email',
    label: '邮箱',
    pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
    enabled: true,
    builtin: true,
  },
  { id: 'idcard', label: '身份证号', pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', enabled: true, builtin: true },
  { id: 'bankcard', label: '银行卡号', pattern: '(?<!\\d)\\d{16,19}(?!\\d)', enabled: true, builtin: true },
];

export function defaultRedactionSettings(): RedactionSettings {
  return { enabled: true, rules: BUILTIN_REDACTION_RULES.map((rule) => ({ ...rule })) };
}

export function redactText(text: string, settings: RedactionSettings): string {
  if (!settings.enabled || !text) return text;
  let result = text;
  for (const rule of settings.rules) {
    if (!rule.enabled) continue;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'g');
    } catch {
      // 用户写坏的自定义正则：静默跳过，不影响其余规则或整体调用方（如页面读取）。
      continue;
    }
    result = result.replace(regex, `[${rule.label}已脱敏]`);
  }
  return result;
}

export function newRedactionRuleId(): string {
  return `redaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
```

Note: this step deliberately does **not** yet include `loadRedactionSettings`/`saveRedactionSettings` — those get their own red/green cycle in Steps 5-8 below, so the storage tests actually start out failing rather than passing against code that already exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/redaction.test.ts`
Expected: PASS, all 12 tests green.

- [ ] **Step 5: Write the failing tests for storage round-trip**

Append to `lib/redaction.test.ts`:

```ts
describe('loadRedactionSettings / saveRedactionSettings', () => {
  function installStorage(initial: Record<string, unknown> = {}) {
    const data = { ...initial };
    const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items));
    (globalThis as any).browser = {
      storage: {
        local: {
          get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
          set,
        },
      },
    };
    return { data, set };
  }

  const originalBrowser = (globalThis as any).browser;
  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
  });

  it('writes through the default settings and returns them when nothing is stored', async () => {
    const { set } = installStorage();
    const loaded = await loadRedactionSettings();
    expect(loaded).toEqual(defaultRedactionSettings());
    expect(set).toHaveBeenCalledWith({ [REDACTION_STORAGE_KEY]: defaultRedactionSettings() });
  });

  it('returns a previously stored value without rewriting it', async () => {
    const stored: RedactionSettings = { enabled: false, rules: [] };
    const { set } = installStorage({ [REDACTION_STORAGE_KEY]: stored });
    const loaded = await loadRedactionSettings();
    expect(loaded).toEqual(stored);
    expect(set).not.toHaveBeenCalled();
  });

  it('falls back to defaults when the stored value is malformed', async () => {
    installStorage({ [REDACTION_STORAGE_KEY]: { enabled: 'yes' } });
    const loaded = await loadRedactionSettings();
    expect(loaded).toEqual(defaultRedactionSettings());
  });

  it('round-trips a save then a load', async () => {
    installStorage();
    const custom: RedactionSettings = {
      enabled: true,
      rules: [{ id: 'custom-1', label: '工号', pattern: 'EMP-\\d{4}', enabled: true, builtin: false }],
    };
    await saveRedactionSettings(custom);
    expect(await loadRedactionSettings()).toEqual(custom);
  });
});
```

Replace the two import lines at the top of `lib/redaction.test.ts` (currently `import { describe, expect, it } from 'vitest';` and the `import { BUILTIN_REDACTION_RULES, ... } from './redaction';` line from Step 1) with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_REDACTION_RULES,
  REDACTION_STORAGE_KEY,
  defaultRedactionSettings,
  loadRedactionSettings,
  redactText,
  saveRedactionSettings,
  type RedactionSettings,
} from './redaction';
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `pnpm vitest run lib/redaction.test.ts`
Expected: FAIL — `loadRedactionSettings`/`saveRedactionSettings` don't exist yet: `SyntaxError: The requested module './redaction' does not provide an export named 'loadRedactionSettings'` (or equivalent).

- [ ] **Step 7: Implement `loadRedactionSettings`/`saveRedactionSettings`**

Append to `lib/redaction.ts` (after `newRedactionRuleId`):

```ts
function isValidRedactionSettings(value: unknown): value is RedactionSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.enabled === 'boolean' && Array.isArray(candidate.rules);
}

export async function loadRedactionSettings(): Promise<RedactionSettings> {
  const result = await browser.storage.local.get(REDACTION_STORAGE_KEY);
  const stored = result[REDACTION_STORAGE_KEY];
  if (isValidRedactionSettings(stored)) return stored;
  const defaults = defaultRedactionSettings();
  await saveRedactionSettings(defaults);
  return defaults;
}

export async function saveRedactionSettings(settings: RedactionSettings): Promise<void> {
  await browser.storage.local.set({ [REDACTION_STORAGE_KEY]: settings });
}
```

- [ ] **Step 8: Run the full file to verify everything passes**

Run: `pnpm vitest run lib/redaction.test.ts`
Expected: PASS, all tests green (12 + 4 = 16 tests).

- [ ] **Step 9: Typecheck**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add lib/redaction.ts lib/redaction.test.ts
git commit -m "feat: add page content redaction pipeline (lib/redaction.ts)"
```

---

## Task 2: 接入 `EXTRACT_PAGE`（`entrypoints/background.ts`）

**Files:**
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `loadRedactionSettings(): Promise<RedactionSettings>`, `redactText(text: string, settings: RedactionSettings): string` from `lib/redaction.ts` (Task 1).

**Note on testing:** `entrypoints/background.ts` 目前没有对应的 vitest project 覆盖（`fill-form-request.ts` 是"把逻辑下沉到可测试文件"的既有先例；`getActiveTab` 等函数同样没有单测）。这里的改动只是"读配置 + 调用已经在 Task 1 测过的纯函数"，与现有覆盖水平一致，不新增测试文件——用 `pnpm compile` + 全量 `pnpm test` 验证不引入回归即可。

- [ ] **Step 1: Add the import**

In `entrypoints/background.ts`, find the top-of-file import block that pulls types from `@/lib/messaging` (starts `import { ... } from '@/lib/messaging';` near line 1). Add a new import line right after it:

```ts
import { loadRedactionSettings, redactText } from '@/lib/redaction';
```

- [ ] **Step 2: Redact `PageContent.text` in `extractActivePage`**

Find this function (around line 362):

```ts
async function extractActivePage(tabId: number): Promise<PageContent> {
  const tab = await resolveTargetTab(tabId);
  const response = await sendToContentScript<PageContent>(tab.id, {
    id: `extract-${Date.now()}`,
    type: 'EXTRACT_PAGE',
  } satisfies Message);

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '页面提取失败');
  }
  return response.data;
}
```

Replace the final two lines with:

```ts
async function extractActivePage(tabId: number): Promise<PageContent> {
  const tab = await resolveTargetTab(tabId);
  const response = await sendToContentScript<PageContent>(tab.id, {
    id: `extract-${Date.now()}`,
    type: 'EXTRACT_PAGE',
  } satisfies Message);

  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? '页面提取失败');
  }
  const redactionSettings = await loadRedactionSettings();
  return { ...response.data, text: redactText(response.data.text, redactionSettings) };
}
```

Only `.text` is redacted — `title`/`url`/`lang`/`length` pass through unchanged (per spec §5).

- [ ] **Step 3: Typecheck**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 4: Run the full test suite to confirm no regression**

Run: `pnpm test`
Expected: PASS, same test count as before this task plus Task 1's new 16 tests, zero failures.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: redact EXTRACT_PAGE text through the redaction pipeline"
```

---

## Task 3: 接入 `browser_get_form`（`lib/agent/tools.ts`）

**Files:**
- Modify: `lib/agent/tools.ts`
- Test: `lib/agent/form-tools.test.ts`

**Interfaces:**
- Consumes: `loadRedactionSettings(): Promise<RedactionSettings>`, `redactText(text, settings): string`, `defaultRedactionSettings(): RedactionSettings` from `lib/redaction.ts` (Task 1).

**Important — protecting existing tests:** `lib/agent/form-tools.test.ts` 的既有 `RESULT` fixture里 `f1` 字段的 value 恰好是一个邮箱地址（`'a@b.c'`），且既有测试对渲染文本做精确匹配（如 `f1 text「邮箱」value="a@b.c" required`）。一旦接上默认开启的脱敏，这些已有断言会失败，除非测试文件里给 `loadRedactionSettings` 设置一个**默认关闭**的 mock（`beforeEach` 里 `mockResolvedValue({ enabled: false, rules: [] })`），新增的脱敏专项测试再显式用 `mockResolvedValueOnce` 覆盖成开启状态。这样零改动保留全部既有断言，同时新测试能验证真实的开启行为。

- [ ] **Step 1: Add the `@/lib/redaction` mock and default-off `beforeEach`**

At the top of `lib/agent/form-tools.test.ts`, the file currently starts:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { GetFormResult } from '@/lib/messaging';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});
```

Replace it with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetFormResult } from '@/lib/messaging';
import { defaultRedactionSettings } from '@/lib/redaction';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const loadRedactionSettings = vi.fn();
vi.mock('@/lib/redaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/redaction')>('@/lib/redaction');
  return { ...actual, loadRedactionSettings: (...args: unknown[]) => loadRedactionSettings(...args) };
});

// 默认关闭：既有测试用例对渲染文本做精确匹配，不应受脱敏默认开启影响。
// 新增的脱敏专项测试用 mockResolvedValueOnce 显式覆盖成开启状态。
beforeEach(() => {
  loadRedactionSettings.mockResolvedValue({ enabled: false, rules: [] });
});
```

- [ ] **Step 2: Run the existing suite to confirm it still passes with the default-off mock in place**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: PASS — all existing tests unchanged (the mock is a no-op by default).

- [ ] **Step 3: Write the failing redaction-specific tests**

Append to the `describe('browser_get_form', ...)` block in `lib/agent/form-tools.test.ts` (after the existing tests, before the closing `});` of that describe):

```ts
  it('redacts sensitive values through the redaction pipeline when enabled', async () => {
    loadRedactionSettings.mockResolvedValueOnce(defaultRedactionSettings());
    const resultWithPhone: GetFormResult = {
      ...RESULT,
      fields: [{ ...RESULT.fields[0], value: '13812345678', label: '手机号', name: 'phone' }],
    };
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: resultWithPhone });

    const output = await getFormTool().execute('call-1', {});
    const text = (output.content[0] as { text: string }).text;

    expect(text).toContain('[手机号已脱敏]');
    expect(text).not.toContain('13812345678');
  });

  it('keeps original values when redaction is disabled', async () => {
    loadRedactionSettings.mockResolvedValueOnce({ enabled: false, rules: [] });
    const resultWithPhone: GetFormResult = {
      ...RESULT,
      fields: [{ ...RESULT.fields[0], value: '13812345678', label: '手机号', name: 'phone' }],
    };
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: resultWithPhone });

    const output = await getFormTool().execute('call-1', {});
    const text = (output.content[0] as { text: string }).text;

    expect(text).toContain('13812345678');
  });

  it('still hands the unredacted structured data to the UI via details', async () => {
    loadRedactionSettings.mockResolvedValueOnce(defaultRedactionSettings());
    const resultWithPhone: GetFormResult = {
      ...RESULT,
      fields: [{ ...RESULT.fields[0], value: '13812345678', label: '手机号', name: 'phone' }],
    };
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: resultWithPhone });

    const output = await getFormTool().execute('call-1', {});

    expect(output.details).toMatchObject({ fields: [{ fieldId: 'f1', value: '13812345678' }] });
  });
```

The third test locks in an intentional asymmetry: `details` (the UI-facing structured payload, never sent to the model — see `lib/agent/agent.ts`'s `convertToLlm`) stays unredacted; only the model-facing `content` text is redacted.

- [ ] **Step 4: Run the tests to verify they fail correctly**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: FAIL on the first two new tests — the rendered text still contains the raw phone number (redaction isn't wired into `tools.ts` yet). The third test passes already (details were never touched).

- [ ] **Step 5: Wire redaction into `browser_get_form`**

In `lib/agent/tools.ts`, add the import near the other `./form-render` import (around line 4):

```ts
import { loadRedactionSettings, redactText } from '@/lib/redaction';
```

Find the `browser_get_form` execute function (around line 356-365):

```ts
    execute: async (_toolCallId, params) => {
      const payload = params as GetFormPayload;
      const response = (await sendMessage<GetFormPayload, GetFormResult>('GET_FORM', payload, session.currentTabId)) as MessageResponse<GetFormResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '表单读取失败');

      return textResult(
        renderFormResultForModel(response.data),
        response.data as unknown as Record<string, unknown>,
      );
    },
```

Replace the `return textResult(...)` with:

```ts
      const redactionSettings = await loadRedactionSettings();
      return textResult(
        redactText(renderFormResultForModel(response.data), redactionSettings),
        response.data as unknown as Record<string, unknown>,
      );
    },
```

Note `response.data` (the `details` argument) is intentionally passed through unredacted — it's the UI-facing structured payload, never sent to the model.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: PASS, all tests green (existing + 3 new).

- [ ] **Step 7: Typecheck and run the full suite**

Run: `pnpm compile && pnpm test`
Expected: no errors, no regressions.

- [ ] **Step 8: Commit**

```bash
git add lib/agent/tools.ts lib/agent/form-tools.test.ts
git commit -m "feat: redact browser_get_form output through the redaction pipeline"
```

---

## Task 4: `components/RedactionSettings.tsx` —— 总开关 + 内置规则列表

**Files:**
- Create: `components/RedactionSettings.tsx`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `components/settings-components.test.tsx`

**Interfaces:**
- Consumes: `RedactionSettings`, `RedactionRule`, `REDACTION_STORAGE_KEY`, `loadRedactionSettings`, `saveRedactionSettings` from `lib/redaction.ts` (Task 1).
- Produces: `export default function RedactionSettings(): JSX.Element` — no props. Mounted by Task 6.

**i18n keys added this task** (both `zh.ts` and `en.ts` — `TranslationKey = keyof typeof zh` means a key missing from either file fails `pnpm compile`):

| key | zh | en |
|---|---|---|
| `privacy.redaction.heading` | 页面内容脱敏 | Page content redaction |
| `privacy.redaction.description` | 在页面正文和表单结构离开扩展前，自动把手机号、邮箱等敏感信息替换为占位符。 | Automatically replaces sensitive info like phone numbers and emails with placeholders before page text and form structure leave the extension. |
| `privacy.redaction.enableLabel` | 启用页面内容脱敏 | Enable page content redaction |
| `privacy.redaction.rulesListLabel` | 脱敏规则 | Redaction rules |
| `privacy.redaction.loading` | 正在加载脱敏设置… | Loading redaction settings… |
| `privacy.redaction.storageError` | 无法保存脱敏设置。 | Could not save redaction settings. |

- [ ] **Step 1: Add the i18n keys**

In `lib/i18n/locales/zh.ts`, add after the existing `'privacy.noBackendBody': ...,` line:

```ts
  'privacy.redaction.heading': '页面内容脱敏',
  'privacy.redaction.description': '在页面正文和表单结构离开扩展前，自动把手机号、邮箱等敏感信息替换为占位符。',
  'privacy.redaction.enableLabel': '启用页面内容脱敏',
  'privacy.redaction.rulesListLabel': '脱敏规则',
  'privacy.redaction.loading': '正在加载脱敏设置…',
  'privacy.redaction.storageError': '无法保存脱敏设置。',
```

In `lib/i18n/locales/en.ts`, add after the existing `'privacy.noBackendBody': ...,` line:

```ts
  'privacy.redaction.heading': 'Page content redaction',
  'privacy.redaction.description':
    'Automatically replaces sensitive info like phone numbers and emails with placeholders before page text and form structure leave the extension.',
  'privacy.redaction.enableLabel': 'Enable page content redaction',
  'privacy.redaction.rulesListLabel': 'Redaction rules',
  'privacy.redaction.loading': 'Loading redaction settings…',
  'privacy.redaction.storageError': 'Could not save redaction settings.',
```

- [ ] **Step 2: Write the failing component tests**

Append to `components/settings-components.test.tsx`, inside the top-level `describe('grouped options settings', ...)` block that already sets up `storageData`/`browser.storage` mocks (add the import at the top of the file alongside the other component imports first):

```ts
import RedactionSettings from './RedactionSettings';
```

Then add these tests near the end of the `describe('grouped options settings', ...)` block, right before its closing `});`:

```ts
  it('loads default redaction settings enabled with all four built-in rules', async () => {
    renderWithLocale(<RedactionSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    expect(toggle).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '手机号' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '邮箱' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '身份证号' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '银行卡号' })).toBeChecked();
  });

  it('persists toggling the master switch off', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    const persisted = set.mock.calls.at(-1)?.[0]['runi:redaction'];
    expect(persisted.enabled).toBe(false);
  });

  it('persists disabling a single built-in rule', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    const phoneToggle = await screen.findByRole('checkbox', { name: '手机号' });
    await user.click(phoneToggle);

    expect(phoneToggle).not.toBeChecked();
    const persisted = set.mock.calls.at(-1)?.[0]['runi:redaction'];
    expect(persisted.rules.find((rule: { id: string }) => rule.id === 'phone').enabled).toBe(false);
  });

  it('reverts the toggle and shows an error when persisting fails', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    expect(toggle).toBeChecked();

    set.mockRejectedValueOnce(new Error('write rejected'));
    await user.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save redaction settings.');
    expect(toggle).toBeChecked();
  });

  it('refreshes from a live storage change', async () => {
    renderWithLocale(<RedactionSettings />);
    await screen.findByRole('checkbox', { name: 'Enable page content redaction' });

    act(() => {
      providerStorageListener?.(
        {
          'runi:redaction': {
            newValue: {
              enabled: false,
              rules: [{ id: 'phone', label: '手机号', pattern: '1[3-9]\\d{9}', enabled: true, builtin: true }],
            },
          },
        },
        'local',
      );
    });

    expect(screen.getByRole('checkbox', { name: 'Enable page content redaction' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '邮箱' })).not.toBeInTheDocument();
  });
```

Note: `providerStorageListener` is the existing shared variable already declared at the top of the file — it captures whatever the *last-mounted* component registered via `browser.storage.onChanged.addListener`, so this test relies on `RedactionSettings` being the only component mounted in that test body (it is — `renderWithLocale(<RedactionSettings />)` only).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: FAIL — `Cannot find module './RedactionSettings'`.

- [ ] **Step 4: Implement `components/RedactionSettings.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import {
  REDACTION_STORAGE_KEY,
  loadRedactionSettings,
  saveRedactionSettings,
  type RedactionSettings as RedactionSettingsData,
} from '@/lib/redaction';

export default function RedactionSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<RedactionSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadRedactionSettings()
      .then((loaded) => {
        if (active) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (active) setError(storageErrorMessage(err));
      });

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[REDACTION_STORAGE_KEY];
      if (change) setSettings(change.newValue as RedactionSettingsData);
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function storageErrorMessage(err: unknown) {
    console.error('[RedactionSettings] storage operation failed:', err);
    return t('privacy.redaction.storageError');
  }

  async function persist(next: RedactionSettingsData) {
    const previous = settings;
    setSaving(true);
    setError(null);
    setSettings(next);
    try {
      await saveRedactionSettings(next);
    } catch (err) {
      setSettings(previous);
      setError(storageErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!settings || saving) return;
    await persist({ ...settings, enabled: !settings.enabled });
  }

  async function toggleRule(id: string) {
    if (!settings || saving) return;
    const rules = settings.rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule));
    await persist({ ...settings, rules });
  }

  if (!settings) {
    return (
      <section className="mt-6">
        {error ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </p>
        ) : (
          <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('privacy.redaction.loading')}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {t('privacy.redaction.heading')}
      </h3>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {t('privacy.redaction.description')}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={saving}
          onChange={() => void toggleEnabled()}
          className="h-4 w-4 rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-700"
        />
        {t('privacy.redaction.enableLabel')}
      </label>

      <ul aria-label={t('privacy.redaction.rulesListLabel')} className="mt-3 space-y-2">
        {settings.rules.map((rule) => (
          <li
            key={rule.id}
            className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <label className="flex min-w-0 items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={saving || !settings.enabled}
                onChange={() => void toggleRule(rule.id)}
                className="h-4 w-4 shrink-0 rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-700"
              />
              <span className="truncate">{rule.label}</span>
            </label>
            <code className="truncate text-xs text-neutral-400 dark:text-neutral-500">{rule.pattern}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: PASS, all tests green.

- [ ] **Step 6: Typecheck**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/RedactionSettings.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts components/settings-components.test.tsx
git commit -m "feat: add RedactionSettings master toggle and built-in rule list"
```

---

## Task 5: `components/RedactionSettings.tsx` —— 自定义规则增删

**Files:**
- Modify: `components/RedactionSettings.tsx`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `components/settings-components.test.tsx`

**Interfaces:**
- Consumes: `newRedactionRuleId(): string` from `lib/redaction.ts` (Task 1); everything Task 4 already produces in `RedactionSettings.tsx`.

**i18n keys added this task** (both `zh.ts` and `en.ts`):

| key | zh | en |
|---|---|---|
| `privacy.redaction.addRule` | 添加自定义规则 | Add custom rule |
| `privacy.redaction.addRuleHeading` | 添加自定义脱敏规则 | Add custom redaction rule |
| `privacy.redaction.ruleLabel` | 规则名称 | Rule label |
| `privacy.redaction.rulePattern` | 正则表达式 | Regular expression |
| `privacy.redaction.ruleLabelRequired` | 请输入规则名称 | Enter a rule label |
| `privacy.redaction.rulePatternRequired` | 请输入正则表达式 | Enter a regular expression |
| `privacy.redaction.invalidPattern` | 正则表达式无效：{message} | Invalid regular expression: {message} |
| `privacy.redaction.confirmDeleteRule` | 确定删除这条自定义规则吗？ | Delete this custom rule? |
| `privacy.redaction.deleteRuleAria` | 删除规则 {label} | Delete rule {label} |
| `privacy.redaction.save` | 保存 | Save |
| `privacy.redaction.cancel` | 取消 | Cancel |

- [ ] **Step 1: Add the i18n keys**

In `lib/i18n/locales/zh.ts`, add after the `privacy.redaction.storageError` line from Task 4:

```ts
  'privacy.redaction.addRule': '添加自定义规则',
  'privacy.redaction.addRuleHeading': '添加自定义脱敏规则',
  'privacy.redaction.ruleLabel': '规则名称',
  'privacy.redaction.rulePattern': '正则表达式',
  'privacy.redaction.ruleLabelRequired': '请输入规则名称',
  'privacy.redaction.rulePatternRequired': '请输入正则表达式',
  'privacy.redaction.invalidPattern': '正则表达式无效：{message}',
  'privacy.redaction.confirmDeleteRule': '确定删除这条自定义规则吗？',
  'privacy.redaction.deleteRuleAria': '删除规则 {label}',
  'privacy.redaction.save': '保存',
  'privacy.redaction.cancel': '取消',
```

In `lib/i18n/locales/en.ts`, add after the `privacy.redaction.storageError` line from Task 4:

```ts
  'privacy.redaction.addRule': 'Add custom rule',
  'privacy.redaction.addRuleHeading': 'Add custom redaction rule',
  'privacy.redaction.ruleLabel': 'Rule label',
  'privacy.redaction.rulePattern': 'Regular expression',
  'privacy.redaction.ruleLabelRequired': 'Enter a rule label',
  'privacy.redaction.rulePatternRequired': 'Enter a regular expression',
  'privacy.redaction.invalidPattern': 'Invalid regular expression: {message}',
  'privacy.redaction.confirmDeleteRule': 'Delete this custom rule?',
  'privacy.redaction.deleteRuleAria': 'Delete rule {label}',
  'privacy.redaction.save': 'Save',
  'privacy.redaction.cancel': 'Cancel',
```

- [ ] **Step 2: Write the failing tests**

Append to the same `describe('grouped options settings', ...)` block in `components/settings-components.test.tsx`, after Task 4's tests:

```ts
  it('adds a valid custom rule and persists it', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    await user.click(screen.getByRole('button', { name: 'Add custom rule' }));
    await user.type(screen.getByLabelText('Rule label'), '工号');
    await user.type(screen.getByLabelText('Regular expression'), 'EMP-\\d{4}');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('checkbox', { name: '工号' })).toBeChecked();
    const persisted = set.mock.calls.at(-1)?.[0]['runi:redaction'];
    expect(persisted.rules.find((rule: { label: string }) => rule.label === '工号')).toMatchObject({
      pattern: 'EMP-\\d{4}',
      enabled: true,
      builtin: false,
    });
  });

  it('rejects an invalid regular expression without saving', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    await user.click(screen.getByRole('button', { name: 'Add custom rule' }));
    await user.type(screen.getByLabelText('Rule label'), '坏规则');
    await user.type(screen.getByLabelText('Regular expression'), '(unclosed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText(/Invalid regular expression/)).toBeVisible();
    expect(set).not.toHaveBeenCalled();
  });

  it('requires both a label and a pattern before saving', async () => {
    const user = userEvent.setup();
    renderWithLocale(<RedactionSettings />);

    await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    await user.click(screen.getByRole('button', { name: 'Add custom rule' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Enter a rule label')).toBeVisible();
    expect(screen.getByText('Enter a regular expression')).toBeVisible();
  });

  it('deletes a custom rule after confirmation', async () => {
    storageData['runi:redaction'] = {
      enabled: true,
      rules: [{ id: 'custom-1', label: '工号', pattern: 'EMP-\\d{4}', enabled: true, builtin: false }],
    };
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithLocale(<RedactionSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete rule 工号' }));

    expect(screen.queryByRole('checkbox', { name: '工号' })).not.toBeInTheDocument();
    const persisted = set.mock.calls.at(-1)?.[0]['runi:redaction'];
    expect(persisted.rules).toHaveLength(0);
  });

  it('does not delete a custom rule when confirmation is declined', async () => {
    storageData['runi:redaction'] = {
      enabled: true,
      rules: [{ id: 'custom-1', label: '工号', pattern: 'EMP-\\d{4}', enabled: true, builtin: false }],
    };
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithLocale(<RedactionSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete rule 工号' }));

    expect(set).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: '工号' })).toBeInTheDocument();
  });

  it('does not offer a delete button for built-in rules', async () => {
    renderWithLocale(<RedactionSettings />);

    await screen.findByRole('checkbox', { name: '手机号' });
    expect(screen.queryByRole('button', { name: 'Delete rule 手机号' })).not.toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: FAIL — no "Add custom rule" button exists yet.

- [ ] **Step 4: Implement the add/delete UI**

Replace the full contents of `components/RedactionSettings.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import {
  REDACTION_STORAGE_KEY,
  loadRedactionSettings,
  newRedactionRuleId,
  saveRedactionSettings,
  type RedactionRule,
  type RedactionSettings as RedactionSettingsData,
} from '@/lib/redaction';

interface RuleDraft {
  label: string;
  pattern: string;
}

interface DraftErrors {
  label?: string;
  pattern?: string;
}

const EMPTY_DRAFT: RuleDraft = { label: '', pattern: '' };

export default function RedactionSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<RedactionSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});

  useEffect(() => {
    let active = true;
    loadRedactionSettings()
      .then((loaded) => {
        if (active) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (active) setError(storageErrorMessage(err));
      });

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[REDACTION_STORAGE_KEY];
      if (change) setSettings(change.newValue as RedactionSettingsData);
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function storageErrorMessage(err: unknown) {
    console.error('[RedactionSettings] storage operation failed:', err);
    return t('privacy.redaction.storageError');
  }

  async function persist(next: RedactionSettingsData) {
    const previous = settings;
    setSaving(true);
    setError(null);
    setSettings(next);
    try {
      await saveRedactionSettings(next);
    } catch (err) {
      setSettings(previous);
      setError(storageErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!settings || saving) return;
    await persist({ ...settings, enabled: !settings.enabled });
  }

  async function toggleRule(id: string) {
    if (!settings || saving) return;
    const rules = settings.rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule));
    await persist({ ...settings, rules });
  }

  async function removeRule(rule: RedactionRule) {
    if (!settings || saving) return;
    if (!window.confirm(t('privacy.redaction.confirmDeleteRule'))) return;
    await persist({ ...settings, rules: settings.rules.filter((candidate) => candidate.id !== rule.id) });
  }

  function beginAdd() {
    setDraft({ ...EMPTY_DRAFT });
    setDraftErrors({});
    setError(null);
  }

  function cancelAdd() {
    setDraft(null);
    setDraftErrors({});
  }

  async function saveDraft() {
    if (!draft || !settings || saving) return;
    const label = draft.label.trim();
    const pattern = draft.pattern.trim();
    const nextErrors: DraftErrors = {
      ...(!label ? { label: t('privacy.redaction.ruleLabelRequired') } : {}),
      ...(!pattern ? { pattern: t('privacy.redaction.rulePatternRequired') } : {}),
    };
    if (nextErrors.label || nextErrors.pattern) {
      setDraftErrors(nextErrors);
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (err) {
      setDraftErrors({});
      setError(t('privacy.redaction.invalidPattern', { message: err instanceof Error ? err.message : String(err) }));
      return;
    }

    const newRule: RedactionRule = { id: newRedactionRuleId(), label, pattern, enabled: true, builtin: false };
    await persist({ ...settings, rules: [...settings.rules, newRule] });
    setDraft(null);
    setDraftErrors({});
  }

  if (!settings) {
    return (
      <section className="mt-6">
        {error ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </p>
        ) : (
          <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('privacy.redaction.loading')}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {t('privacy.redaction.heading')}
          </h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('privacy.redaction.description')}
          </p>
        </div>
        <button
          type="button"
          disabled={saving || Boolean(draft)}
          onClick={beginAdd}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          {t('privacy.redaction.addRule')}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={saving}
          onChange={() => void toggleEnabled()}
          className="h-4 w-4 rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-700"
        />
        {t('privacy.redaction.enableLabel')}
      </label>

      <ul aria-label={t('privacy.redaction.rulesListLabel')} className="mt-3 space-y-2">
        {settings.rules.map((rule) => (
          <li
            key={rule.id}
            className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <label className="flex min-w-0 items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={saving || !settings.enabled}
                onChange={() => void toggleRule(rule.id)}
                className="h-4 w-4 shrink-0 rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-700"
              />
              <span className="truncate">{rule.label}</span>
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <code className="truncate text-xs text-neutral-400 dark:text-neutral-500">{rule.pattern}</code>
              {!rule.builtin && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void removeRule(rule)}
                  aria-label={t('privacy.redaction.deleteRuleAria', { label: rule.label })}
                  className="shrink-0 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  {t('common.delete')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {draft && (
        <form
          aria-label={t('privacy.redaction.addRuleHeading')}
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
          className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/60"
        >
          <h4 className="mb-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {t('privacy.redaction.addRuleHeading')}
          </h4>
          <div className="space-y-3">
            <label className="block text-xs text-neutral-600 dark:text-neutral-300">
              <span className="mb-1 block">{t('privacy.redaction.ruleLabel')}</span>
              <input
                value={draft.label}
                disabled={saving}
                onChange={(event) => {
                  setDraft((current) => (current ? { ...current, label: event.target.value } : current));
                  setDraftErrors((current) => ({ ...current, label: undefined }));
                }}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {draftErrors.label && (
                <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{draftErrors.label}</span>
              )}
            </label>
            <label className="block text-xs text-neutral-600 dark:text-neutral-300">
              <span className="mb-1 block">{t('privacy.redaction.rulePattern')}</span>
              <input
                value={draft.pattern}
                disabled={saving}
                onChange={(event) => {
                  setDraft((current) => (current ? { ...current, pattern: event.target.value } : current));
                  setDraftErrors((current) => ({ ...current, pattern: undefined }));
                }}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {draftErrors.pattern && (
                <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{draftErrors.pattern}</span>
              )}
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={cancelAdd}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {t('privacy.redaction.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('privacy.redaction.save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: PASS, all tests green.

- [ ] **Step 6: Typecheck**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/RedactionSettings.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts components/settings-components.test.tsx
git commit -m "feat: add custom redaction rule add/delete UI"
```

---

## Task 6: 挂载进设置页 Privacy 分区

**Files:**
- Modify: `entrypoints/options/App.tsx`
- Modify: `components/settings-components.test.tsx`

**Interfaces:**
- Consumes: `export default function RedactionSettings()` from `components/RedactionSettings.tsx` (Tasks 4-5).

- [ ] **Step 1: Write the failing integration test**

Append to the `describe('grouped options settings', ...)` block in `components/settings-components.test.tsx`, after the existing `'navigates between grouped settings sections...'` test:

```ts
  it('shows the redaction settings inside the Privacy section', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    await user.click(screen.getByRole('button', { name: 'Privacy & permissions' }));

    expect(await screen.findByRole('checkbox', { name: 'Enable page content redaction' })).toBeVisible();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: FAIL — `RedactionSettings` isn't mounted in `PrivacySection` yet, so the checkbox doesn't exist.

- [ ] **Step 3: Mount `RedactionSettings` in `PrivacySection`**

In `entrypoints/options/App.tsx`, add the import near the other component imports:

```ts
import RedactionSettings from '@/components/RedactionSettings';
```

Find `PrivacySection` (around line 80-100):

```tsx
function PrivacySection() {
  const { t } = useTranslation();
  const disclosures = [
    ['privacy.pageDataTitle', 'privacy.pageDataBody'],
    ['privacy.localDataTitle', 'privacy.localDataBody'],
    ['privacy.noBackendTitle', 'privacy.noBackendBody'],
  ] as const;
  return (
    <section className="max-w-2xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('settings.privacyDescription')}</p>
      <div className="mt-5 space-y-3">
        {disclosures.map(([title, body]) => (
          <article key={title} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <h3 className="text-sm font-medium">{t(title)}</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{t(body)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
```

Add `<RedactionSettings />` right after the closing `</div>` of the disclosures list, still inside `<section>`:

```tsx
function PrivacySection() {
  const { t } = useTranslation();
  const disclosures = [
    ['privacy.pageDataTitle', 'privacy.pageDataBody'],
    ['privacy.localDataTitle', 'privacy.localDataBody'],
    ['privacy.noBackendTitle', 'privacy.noBackendBody'],
  ] as const;
  return (
    <section className="max-w-2xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('settings.privacyDescription')}</p>
      <div className="mt-5 space-y-3">
        {disclosures.map(([title, body]) => (
          <article key={title} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <h3 className="text-sm font-medium">{t(title)}</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{t(body)}</p>
          </article>
        ))}
      </div>
      <RedactionSettings />
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `pnpm compile && pnpm test`
Expected: no errors, no regressions.

- [ ] **Step 6: Manual smoke check**

Run: `pnpm dev`, load the unpacked extension from `.output/chrome-mv3` (`chrome://extensions` → Developer mode → Load unpacked), open the extension's options page, click into "Privacy & permissions", and confirm:
- The four built-in rule checkboxes are visible and checked.
- Unchecking one and reloading the options page keeps it unchecked (persistence).
- "Add custom rule" opens the form; saving an invalid pattern (e.g. `(unclosed`) shows an inline error and does not add a row.
- Visit a page with a visible phone number or email in its body text, ask the assistant to read the page (triggers `browser_read_page`), and confirm the model's response — or the raw tool call result if visible in the activity timeline — shows `[手机号已脱敏]`/`[邮箱已脱敏]` instead of the real value.

- [ ] **Step 7: Commit**

```bash
git add entrypoints/options/App.tsx components/settings-components.test.tsx
git commit -m "feat: mount redaction settings in the Privacy settings section"
```

---

## Plan Self-Review Notes

- **Spec coverage:** §3 data model → Task 1. §4 pure function → Task 1. §5 pipeline wiring (both call sites) → Tasks 2-3. §6 settings UI → Tasks 4-6. §7 testing plan → covered inline in every task (unit tests for `lib/redaction.ts`, `form-tools.test.ts` coverage for `browser_get_form`, `settings-components.test.tsx` coverage for the UI; `background.ts` intentionally left without a dedicated test file per the spec's own §7 reasoning, matching the existing `getActiveTab` precedent). §8 known trade-offs are captured as code comments in Task 1 (rule ordering) and are otherwise informational, not actionable.
- **Type consistency:** `RedactionRule`/`RedactionSettings` (Task 1) are the only two exported types consumed downstream; every later task imports them by these exact names. `loadRedactionSettings`/`saveRedactionSettings`/`redactText`/`newRedactionRuleId`/`defaultRedactionSettings`/`BUILTIN_REDACTION_RULES`/`REDACTION_STORAGE_KEY` are the complete export surface of `lib/redaction.ts` and every later task's imports were checked against this exact list.
