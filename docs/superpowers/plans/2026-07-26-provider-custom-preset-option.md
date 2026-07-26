# 「添加 Provider」表单自定义厂商入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「添加 Provider」表单的「快速预设」下拉中加入显式的「自定义（手动填写）」选项，选中时把厂商字段回到干净的手填状态。

**Architecture:** 把「自定义」建模为一个空预设 `{ name: '', baseURL: '', model: '' }`，复用 `lib/settings.ts` 中已有的 `applyPresetToDraft`——它的「添加时整体覆盖 / 编辑时非空不覆盖」双分支语义恰好产出目标行为（添加态清空字段、编辑态保护已保存值），因此 `applyPresetToDraft` 本身不改一行。新增两个纯函数 `resolvePresetSelection`（下拉值 → 预设）与 `draftPlaceholders`（下拉值 → 各输入框 placeholder），组件只负责调用。

**Tech Stack:** TypeScript、React 19、WXT（Chromium MV3 扩展）、Vitest、Tailwind CSS。

## Global Constraints

- 不修改 `ProviderConfig` / `Settings` 类型，不新增字段，不写数据迁移。
- 不修改 `applyPresetToDraft` 与 `PROVIDER_PRESETS`。
- 代码注释与提交信息：注释用中文，提交信息用英文 `type: subject` 格式（参考 `git log`）。
- 测试只放在 `lib/**/*.test.ts`——`vitest.config.ts` 的 `include` 为 `['lib/**/*.test.ts']`，`components/` 无测试基建，不新建。
- 哨兵值固定为字符串 `'__custom__'`。
- 「自定义」不影响 API Key、协议类型（`api`）、「其他可用模型」（`extrasText`）三项。
- 下拉不在用户手改字段后自动跳回「自定义」——不实现任何「偏离预设」的推导逻辑。
- 每个任务结束前 `pnpm compile` 与 `pnpm test` 必须通过。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `lib/settings.ts` | 修改 | 新增哨兵值 `CUSTOM_PRESET_VALUE`、空预设 `CUSTOM_PRESET`、纯函数 `resolvePresetSelection`、`draftPlaceholders` 与类型 `DraftPlaceholders`。 |
| `lib/settings.test.ts` | 修改 | 覆盖两个新纯函数，以及空预设穿过 `applyPresetToDraft` 的双分支行为。 |
| `components/ProviderSettings.tsx` | 修改 | 下拉新增分隔项 + 「自定义」项；`applyPreset` 改用 `resolvePresetSelection`；placeholder 改读 `draftPlaceholders`；删除本地的 `extrasPlaceholder`。 |

---

### Task 1: 空预设与 `resolvePresetSelection`

**Files:**
- Modify: `lib/settings.ts`（在 `PROVIDER_PRESETS` 定义之后、`STORAGE_KEY` 之前插入）
- Test: `lib/settings.test.ts`

**Interfaces:**
- Consumes: 现有的 `ProviderConfig`、`PROVIDER_PRESETS`、`applyPresetToDraft`（均不修改）。
- Produces:
  - `export const CUSTOM_PRESET_VALUE = '__custom__'`（类型推断为 `string`，须显式标注为 `string` 以便与任意下拉值比较）
  - `export const CUSTOM_PRESET: Omit<ProviderConfig, 'id' | 'apiKey'>`
  - `export function resolvePresetSelection(value: string): Omit<ProviderConfig, 'id' | 'apiKey'> | undefined`

- [ ] **Step 1: 写失败的测试**

在 `lib/settings.test.ts` 顶部的 import 中加入 `CUSTOM_PRESET`、`CUSTOM_PRESET_VALUE`、`resolvePresetSelection`（与现有 import 同一个 `from './settings'` 语句，按字母序插入）：

```ts
import {
  applyPresetToDraft,
  CUSTOM_PRESET,
  CUSTOM_PRESET_VALUE,
  hasDuplicateProviderName,
  resolvePresetSelection,
  resolveProviderApi,
  trimProviderDraft,
  type ProviderConfig,
} from './settings';
```

在文件末尾追加：

```ts
describe('resolvePresetSelection', () => {
  it('returns the empty custom preset for the sentinel value', () => {
    expect(resolvePresetSelection(CUSTOM_PRESET_VALUE)).toEqual({
      name: '',
      baseURL: '',
      model: '',
    });
  });

  it('returns the matching built-in preset by name', () => {
    const preset = resolvePresetSelection('DeepSeek');
    expect(preset?.baseURL).toBe('https://api.deepseek.com');
  });

  it('returns undefined for the empty placeholder value', () => {
    expect(resolvePresetSelection('')).toBeUndefined();
  });

  it('returns undefined for an unknown vendor name', () => {
    expect(resolvePresetSelection('NoSuchVendor')).toBeUndefined();
  });
});

describe('applyPresetToDraft with the custom (empty) preset', () => {
  const filled: ProviderConfig = {
    id: '',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-keep-me',
    model: 'deepseek-v4-pro',
    api: 'anthropic-messages',
  };

  it('clears name/baseURL/model when adding a new provider', () => {
    const { draft } = applyPresetToDraft(filled, 'extra-a', CUSTOM_PRESET, false);
    expect(draft.name).toBe('');
    expect(draft.baseURL).toBe('');
    expect(draft.model).toBe('');
  });

  it('leaves apiKey, api and extrasText untouched when adding a new provider', () => {
    const result = applyPresetToDraft(filled, 'extra-a', CUSTOM_PRESET, false);
    expect(result.draft.apiKey).toBe('sk-keep-me');
    expect(result.draft.api).toBe('anthropic-messages');
    expect(result.extrasText).toBe('extra-a');
  });

  it('does not clear already-saved values when editing an existing provider', () => {
    const { draft } = applyPresetToDraft(filled, '', CUSTOM_PRESET, true);
    expect(draft.name).toBe('DeepSeek');
    expect(draft.baseURL).toBe('https://api.deepseek.com');
    expect(draft.model).toBe('deepseek-v4-pro');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: FAIL —— 报错形如 `No "CUSTOM_PRESET" export is defined on the "./settings" module` 或 `resolvePresetSelection is not a function`。

- [ ] **Step 3: 写最小实现**

在 `lib/settings.ts` 中，紧跟 `PROVIDER_PRESETS` 数组定义之后插入：

```ts
/**
 * 「自定义」在「快速预设」下拉中的哨兵值。
 * `__` 前缀确保不与任何 PROVIDER_PRESETS.name 冲突。
 */
export const CUSTOM_PRESET_VALUE: string = '__custom__';

/**
 * 「自定义」= 一个空预设：语义上等价于「不套用任何厂商」。
 * 穿过 applyPresetToDraft 时，添加态（!isEditing）整体覆盖 → 清空字段；
 * 编辑态（isEditing）「非空不覆盖」→ 已保存的值不被误清。
 */
export const CUSTOM_PRESET: Omit<ProviderConfig, 'id' | 'apiKey'> = {
  name: '',
  baseURL: '',
  model: '',
};

/** 下拉值 → 预设；返回 undefined 表示占位符态（不做任何填充）。 */
export function resolvePresetSelection(
  value: string,
): Omit<ProviderConfig, 'id' | 'apiKey'> | undefined {
  // 哨兵优先判断：即使将来出现同名预设也不会被误解析。
  if (value === CUSTOM_PRESET_VALUE) return CUSTOM_PRESET;
  return PROVIDER_PRESETS.find((p) => p.name === value);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: PASS（全部用例，含原有用例）

Run: `pnpm compile`
Expected: 无输出、退出码 0

- [ ] **Step 5: 提交**

```bash
git add lib/settings.ts lib/settings.test.ts
git commit -m "feat: model the custom provider option as an empty preset

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `draftPlaceholders`

**Files:**
- Modify: `lib/settings.ts`（紧跟 Task 1 新增的 `resolvePresetSelection` 之后）
- Test: `lib/settings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CUSTOM_PRESET_VALUE`；现有的 `PROVIDER_PRESETS`。
- Produces:
  - `export interface DraftPlaceholders { name: string; baseURL: string; model: string; extras: string }`
  - `export function draftPlaceholders(value: string): DraftPlaceholders`

三个分支：哨兵值 → 与厂商无关的通用示例；命中预设 → 以该预设自身值为示例；未命中（含占位符态 `''`）→ 现状的 DeepSeek 风格示例。

- [ ] **Step 1: 写失败的测试**

在 `lib/settings.test.ts` 的 import 语句中追加 `draftPlaceholders`（按字母序放在 `CUSTOM_PRESET_VALUE` 之后）：

```ts
import {
  applyPresetToDraft,
  CUSTOM_PRESET,
  CUSTOM_PRESET_VALUE,
  draftPlaceholders,
  hasDuplicateProviderName,
  resolvePresetSelection,
  resolveProviderApi,
  trimProviderDraft,
  type ProviderConfig,
} from './settings';
```

在文件末尾追加：

```ts
describe('draftPlaceholders', () => {
  it('gives vendor-neutral examples for the custom selection', () => {
    const p = draftPlaceholders(CUSTOM_PRESET_VALUE);
    expect(p.name).toBe('例如 我的中转站');
    expect(p.baseURL).toBe('https://your-host/v1');
    expect(p.model).toBe('例如 gpt-4o');
    expect(p.extras).toBe('例如 gpt-4o-mini, o3-mini');
  });

  it('never mentions DeepSeek under the custom selection', () => {
    const p = draftPlaceholders(CUSTOM_PRESET_VALUE);
    expect(JSON.stringify(p)).not.toContain('deepseek');
  });

  it('uses the selected preset own values as examples', () => {
    const p = draftPlaceholders('OpenAI');
    expect(p.name).toBe('例如 OpenAI');
    expect(p.baseURL).toBe('https://api.openai.com/v1');
    expect(p.model).toBe('gpt-5.6-sol');
    expect(p.extras).toBe('例如 gpt-5.6-terra, gpt-5.6-luna');
  });

  it('keeps the existing DeepSeek-flavoured examples for the empty placeholder state', () => {
    const p = draftPlaceholders('');
    expect(p.name).toBe('例如 DeepSeek');
    expect(p.baseURL).toBe('https://api.deepseek.com');
    expect(p.model).toBe('deepseek-v4-pro');
    expect(p.extras).toBe('例如 deepseek-v4-flash');
  });

  it('falls back to the default placeholders for an unknown vendor name', () => {
    expect(draftPlaceholders('NoSuchVendor')).toEqual(draftPlaceholders(''));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: FAIL —— `No "draftPlaceholders" export is defined on the "./settings" module`

- [ ] **Step 3: 写最小实现**

在 `lib/settings.ts` 中，紧跟 `resolvePresetSelection` 之后插入：

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
  model: '例如 gpt-4o',
  extras: '例如 gpt-4o-mini, o3-mini',
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
    extras: extras.length ? `例如 ${extras.join(', ')}` : DEFAULT_PLACEHOLDERS.extras,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: PASS

Run: `pnpm compile`
Expected: 无输出、退出码 0

- [ ] **Step 5: 提交**

```bash
git add lib/settings.ts lib/settings.test.ts
git commit -m "feat: derive provider form placeholders from the preset selection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 表单接线

**Files:**
- Modify: `components/ProviderSettings.tsx`

**Interfaces:**
- Consumes: Task 1 的 `CUSTOM_PRESET_VALUE`、`resolvePresetSelection`；Task 2 的 `draftPlaceholders`。
- Produces: 无新导出（本任务是纯 UI 接线）。

`components/` 无测试基建（`vitest.config.ts` 的 `include` 仅 `lib/**/*.test.ts`），本任务用类型检查 + 手动验收把关，不新建测试文件。

- [ ] **Step 1: 更新 import，删除本地的 `extrasPlaceholder`**

把 `components/ProviderSettings.tsx` 顶部的 import 改为（新增三项，按现有顺序风格插入）：

```tsx
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

删除整个本地函数（连同其上方的注释）：

```tsx
/** 「其他可用模型」输入框的提示文案：随当前选中的预设切换，展示该厂商的其他模型示例。 */
function extrasPlaceholder(selectedPreset: string): string {
  const preset = PROVIDER_PRESETS.find((p) => p.name === selectedPreset);
  const extras = (preset?.models ?? []).filter((m) => m !== preset?.model);
  return extras.length ? `例如 ${extras.join(', ')}` : '例如 deepseek-v4-flash';
}
```

- [ ] **Step 2: `applyPreset` 改用 `resolvePresetSelection`**

把 `applyPreset` 函数体中的这一行：

```tsx
    const preset = PROVIDER_PRESETS.find((p) => p.name === name);
```

改为：

```tsx
    const preset = resolvePresetSelection(name);
```

函数其余部分（`setSelectedPreset(name)`、`if (!preset) return;`、`applyPresetToDraft(...)`）保持不变。

- [ ] **Step 3: 在组件内计算 placeholder**

在 `ProviderSettings` 组件体内、`return (` 之前（例如紧跟 `async function setActive` 定义之后）加入一行：

```tsx
  const placeholders = draftPlaceholders(selectedPreset);
```

- [ ] **Step 4: 下拉新增分隔项与「自定义」项**

把「快速预设」`<select>` 内的 options 改为：

```tsx
            <option value="">选择以填充 Base URL / 模型…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            {/* 用 disabled option 而非 <hr>：<hr> in <select> 仅较新 Chromium 支持，项目同时构建 Firefox */}
            <option disabled>──────────</option>
            <option value={CUSTOM_PRESET_VALUE}>自定义（手动填写）</option>
```

- [ ] **Step 5: 四个输入框改读 `placeholders`**

把表单中的四个 `placeholder` 属性依次改为：

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
```

以及（协议类型 `<select>` 之后的两项）：

```tsx
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
```

API Key 的 `placeholder="sk-..."` 与协议类型 `<select>` 保持不变。

- [ ] **Step 6: 类型检查与全量测试**

Run: `pnpm compile`
Expected: 无输出、退出码 0（若报 `'PROVIDER_PRESETS' is declared but its value is never read`，说明 Step 4 的 `.map` 被误删——PROVIDER_PRESETS 仍在使用）

Run: `pnpm test`
Expected: 全部测试文件 PASS

- [ ] **Step 7: 手动验收**

Run: `pnpm build`，然后在 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`，打开扩展的「设置」页，逐条核对：

1. 「快速预设」下拉末尾出现一条不可选的 `──────────` 分隔项，其下是「自定义（手动填写）」。
2. 添加态：先选 DeepSeek（字段被填充）→ 再选「自定义」→ 名称 / Base URL / 模型（默认）三个框被清空。
3. 承上：API Key、协议类型、「其他可用模型」的内容保持不变。
4. 承上：三个空框的 placeholder 变为「例如 我的中转站」「https://your-host/v1」「例如 gpt-4o」，「其他可用模型」的 placeholder 为「例如 gpt-4o-mini, o3-mini」。
5. 编辑态：先添加并保存一条 Provider → 点「编辑」→ 选「自定义」→ 已填字段不被清空。
6. 选中某预设后手改 Base URL，下拉仍显示该预设名（不自动跳回「自定义」）。

- [ ] **Step 8: 提交**

```bash
git add components/ProviderSettings.tsx
git commit -m "feat: add a custom option to the provider preset dropdown

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 更新进度看板

**Files:**
- Modify: `docs/PROGRESS.md`

**Interfaces:**
- Consumes: Task 1–3 的成果。
- Produces: 无代码产物。

- [ ] **Step 1: 定位「变更日志」表格**

Run: `grep -n "^## 变更日志" -A 3 docs/PROGRESS.md`
Expected: 输出表头 `| 日期 | 内容 | 关联 |`、分隔行 `|------|------|------|`，以及当前最新一行（`2026-07-26 | LLM HTTP 报错自带上下文…`）。表格按日期倒序，新行插在分隔行的正下方。

- [ ] **Step 2: 在分隔行下方插入一行**

```markdown
| 2026-07-26 | 「添加 Provider」表单的「快速预设」下拉新增「自定义（手动填写）」选项（末尾，上方带不可选分隔项）。自定义被建模为空预设 `{ name: '', baseURL: '', model: '' }`，复用 `applyPresetToDraft` 已有的双分支语义：添加态整体覆盖 → 清空厂商字段，编辑态「非空不覆盖」→ 保护已保存值不被误清。新增 `resolvePresetSelection()`/`draftPlaceholders()` 两个纯函数，后者把组件内写死的 DeepSeek 风格 placeholder 收进 `lib/settings.ts` 并按选中预设切换（自定义态给与厂商无关的通用示例）。起因：厂商字段本就是自由文本、配置任意中转站早已可行，但下拉只列内置厂商，用户会误以为必须从中选一个 | [[2026-07-26-provider-custom-preset-option-design]], 2026-07-26-provider-custom-preset-option.md |
```

- [ ] **Step 3: 提交**

```bash
git add docs/PROGRESS.md
git commit -m "docs: log the custom provider preset option in the PROGRESS changelog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 验收标准回查（对应 spec）

| Spec 验收项 | 覆盖任务 |
| --- | --- |
| 下拉末尾出现「自定义（手动填写）」+ 分隔项 | Task 3 Step 4 / Step 7.1 |
| 添加态选自定义清空三个必填字段 | Task 1（单测）、Task 3 Step 7.2 |
| API Key / 协议类型 / 其他可用模型不受影响 | Task 1（单测）、Task 3 Step 7.3 |
| placeholder 变为通用示例、不再是 DeepSeek 专属 | Task 2（单测）、Task 3 Step 7.4 |
| 编辑态选自定义不清空已保存值 | Task 1（单测）、Task 3 Step 7.5 |
| 下拉不自动跳回「自定义」 | Task 3 Step 7.6（不实现任何推导逻辑即满足） |
| `pnpm compile` 与 `pnpm test` 通过 | Task 1/2 Step 4、Task 3 Step 6 |
