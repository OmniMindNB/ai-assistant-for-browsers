# Provider Settings Form Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 data-correctness bugs and add 6 usability improvements found in an audit of the "Add Provider" form (`components/ProviderSettings.tsx`), without changing the `ProviderConfig`/`Settings` data model.

**Architecture:** Pure, easily-testable logic (trim-before-save, non-destructive preset merging, duplicate-name detection) is extracted into exported functions in `lib/settings.ts` with unit tests. Everything else (cross-tab sync via `browser.storage.onChanged`, two-step delete confirmation, save-button race guard, required-field markers, Enter-to-submit, API key show/hide) is UI-only wiring inside `components/ProviderSettings.tsx`, verified by `pnpm compile` plus manual checks in `pnpm dev` (this codebase has no component-level test harness — see Global Constraints).

**Tech Stack:** React 19 (function components + hooks, no external state library for this component), WXT's `browser` global (`browser.storage.local`, `browser.storage.onChanged`), Vitest for `lib/` unit tests.

**Spec:** `docs/specs/0003-provider-settings-form-fixes.md` — read it before starting; this plan implements it task by task and does not repeat its rationale.

## Global Constraints

- This codebase's test setup (`vitest.config.ts`) only covers `lib/**/*.test.ts` with `environment: 'node'` — there is no jsdom/`@testing-library/react` harness for `components/` or `entrypoints/`, and this plan does not add one (consistent with the spec's non-goals: no new dependencies). Pure logic that needs test coverage is extracted into `lib/settings.ts`; UI-only behavior is verified manually via `pnpm dev` per CLAUDE.md's guidance for frontend changes.
- Chinese user-facing strings (toasts, labels, banners) must match the existing Chinese-language convention already used throughout `components/ProviderSettings.tsx` — do not introduce English UI copy.
- Run `pnpm compile` after every task that touches TypeScript; it must pass before moving to the next task.
- Run `pnpm test` after every task that touches `lib/settings.ts`; all tests (existing + new) must pass.
- Only `git add` the files a task actually touches, then commit — never a blanket `git add -A`.
- Do not modify the `ProviderConfig`/`Settings` type shapes — only add new exported functions/constants to `lib/settings.ts`.
- Do not use `window.confirm()`/`window.alert()` for the delete confirmation — the spec explicitly calls for an inline two-step button (Task 4).

---

### Task 1: Extract pure helper functions into `lib/settings.ts` with unit tests

**Files:**
- Modify: `lib/settings.ts` (insert after `newProviderId`, i.e. after current line 76)
- Create: `lib/settings.test.ts`

**Interfaces:**
- Produces: `trimProviderDraft(draft: ProviderConfig): ProviderConfig`, `applyPresetToDraft(draft: ProviderConfig, extrasText: string, preset: Omit<ProviderConfig, 'id' | 'apiKey'>): { draft: ProviderConfig; extrasText: string }`, `hasDuplicateProviderName(providers: ProviderConfig[], name: string, excludeId?: string): boolean` — all consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `lib/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyPresetToDraft,
  hasDuplicateProviderName,
  trimProviderDraft,
  type ProviderConfig,
} from './settings';

const baseDraft: ProviderConfig = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
};

describe('trimProviderDraft', () => {
  it('trims leading/trailing whitespace from name, baseURL, model, and apiKey', () => {
    const draft: ProviderConfig = {
      ...baseDraft,
      name: '  DeepSeek  ',
      baseURL: ' https://api.deepseek.com \n',
      apiKey: ' sk-abc123 \n',
      model: ' deepseek-v4-pro ',
    };
    expect(trimProviderDraft(draft)).toEqual({
      ...baseDraft,
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-abc123',
      model: 'deepseek-v4-pro',
    });
  });

  it('leaves already-trimmed values unchanged', () => {
    const draft: ProviderConfig = {
      ...baseDraft,
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-4o-mini',
    };
    expect(trimProviderDraft(draft)).toEqual(draft);
  });

  it('preserves id and models', () => {
    const draft: ProviderConfig = { ...baseDraft, id: 'p-1', name: ' A ', models: ['a', 'b'] };
    expect(trimProviderDraft(draft)).toEqual({ ...draft, name: 'A' });
  });
});

describe('applyPresetToDraft', () => {
  const preset = {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  };

  it('fills empty fields from the preset', () => {
    const { draft } = applyPresetToDraft(baseDraft, '', preset);
    expect(draft.name).toBe('DeepSeek');
    expect(draft.baseURL).toBe('https://api.deepseek.com');
    expect(draft.model).toBe('deepseek-v4-pro');
  });

  it('does not overwrite an existing baseURL (regression: previously always overwrote)', () => {
    const draft = { ...baseDraft, baseURL: 'https://my-proxy.example.com' };
    const result = applyPresetToDraft(draft, '', preset);
    expect(result.draft.baseURL).toBe('https://my-proxy.example.com');
  });

  it('does not overwrite existing name or model', () => {
    const draft = { ...baseDraft, name: 'Custom', model: 'custom-model' };
    const result = applyPresetToDraft(draft, '', preset);
    expect(result.draft.name).toBe('Custom');
    expect(result.draft.model).toBe('custom-model');
  });

  it("backfills extrasText with the preset's other models when extrasText is empty", () => {
    const result = applyPresetToDraft(baseDraft, '', preset);
    expect(result.extrasText).toBe('deepseek-v4-flash');
  });

  it('does not overwrite existing extrasText', () => {
    const result = applyPresetToDraft(baseDraft, 'my-custom-model', preset);
    expect(result.extrasText).toBe('my-custom-model');
  });

  it('produces empty extrasText when the preset has no extra models', () => {
    const singleModelPreset = {
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    };
    const result = applyPresetToDraft(baseDraft, '', singleModelPreset);
    expect(result.extrasText).toBe('');
  });
});

describe('hasDuplicateProviderName', () => {
  const providers: ProviderConfig[] = [
    { id: 'p-1', name: 'DeepSeek', baseURL: 'x', apiKey: '', model: 'm' },
    { id: 'p-2', name: 'OpenAI', baseURL: 'x', apiKey: '', model: 'm' },
  ];

  it('returns true when another provider has the same trimmed name', () => {
    expect(hasDuplicateProviderName(providers, ' DeepSeek ')).toBe(true);
  });

  it('returns false when no other provider matches', () => {
    expect(hasDuplicateProviderName(providers, 'Moonshot')).toBe(false);
  });

  it('excludes the provider being edited via excludeId', () => {
    expect(hasDuplicateProviderName(providers, 'DeepSeek', 'p-1')).toBe(false);
  });

  it('returns false for an empty/whitespace-only name', () => {
    expect(hasDuplicateProviderName(providers, '   ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: FAIL — `trimProviderDraft`, `applyPresetToDraft`, `hasDuplicateProviderName` are not exported from `./settings`.

- [ ] **Step 3: Implement the functions**

In `lib/settings.ts`, insert the following after the closing brace of `newProviderId()` (currently ends at line 76), before the `ensureDevProvider` doc comment:

```ts

/** 保存前统一 trim name/baseURL/model/apiKey，避免粘贴带来的首尾空白静默存入。 */
export function trimProviderDraft(draft: ProviderConfig): ProviderConfig {
  return {
    ...draft,
    name: draft.name.trim(),
    baseURL: draft.baseURL.trim(),
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
  };
}

/**
 * 将预设应用到草稿：仅在字段为空时填充（不覆盖用户已填写的内容）。
 * 「其他可用模型」文本框同理，为空时才用预设中除默认模型外的其余模型回填。
 */
export function applyPresetToDraft(
  draft: ProviderConfig,
  extrasText: string,
  preset: Omit<ProviderConfig, 'id' | 'apiKey'>,
): { draft: ProviderConfig; extrasText: string } {
  const nextDraft: ProviderConfig = {
    ...draft,
    name: draft.name || preset.name,
    baseURL: draft.baseURL || preset.baseURL,
    model: draft.model || preset.model,
  };
  const presetExtras = (preset.models ?? []).filter((m) => m !== preset.model);
  const nextExtrasText = extrasText.trim() ? extrasText : presetExtras.join(', ');
  return { draft: nextDraft, extrasText: nextExtrasText };
}

/** 是否存在另一个（id 不同于 excludeId）Provider 与给定名称（trim 后）重复。 */
export function hasDuplicateProviderName(
  providers: ProviderConfig[],
  name: string,
  excludeId?: string,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return providers.some((p) => p.id !== excludeId && p.name.trim() === trimmed);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run lib/settings.test.ts`
Expected: PASS (11 tests)

Then run the full suite to confirm nothing else broke: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/settings.ts lib/settings.test.ts
git commit -m "feat: add pure helpers for provider draft trimming, preset merge, dup-name check"
```

---

### Task 2: Wire trim / non-destructive preset merge / duplicate-name toast into the form

**Files:**
- Modify: `components/ProviderSettings.tsx:4-12` (imports), `:74-106` (`applyPreset`, `saveDraft`)

**Interfaces:**
- Consumes: `trimProviderDraft`, `applyPresetToDraft`, `hasDuplicateProviderName` from Task 1.
- Produces: `saveDraft`/`applyPreset` behavior consumed by Task 3 and Task 5 (both further modify `saveDraft`).

- [ ] **Step 1: Update the import block**

Current (lines 4-12):

```tsx
import { useEffect, useState } from 'react';
import {
  loadSettings,
  saveSettings,
  newProviderId,
  PROVIDER_PRESETS,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';
```

New:

```tsx
import { useEffect, useState } from 'react';
import {
  loadSettings,
  saveSettings,
  newProviderId,
  applyPresetToDraft,
  hasDuplicateProviderName,
  trimProviderDraft,
  PROVIDER_PRESETS,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';
```

- [ ] **Step 2: Replace `applyPreset` and `saveDraft`**

Current (lines 74-106):

```tsx
  function applyPreset(name: string) {
    const preset = PROVIDER_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    setDraft((d) => ({
      ...d,
      name: d.name || preset.name,
      baseURL: preset.baseURL,
      model: d.model || preset.model,
    }));
  }

  async function saveDraft() {
    if (!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim()) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
    const finalDraft = withExtras(draft, extrasText);
    const providers = [...settings.providers];
    if (isEditing) {
      const idx = providers.findIndex((p) => p.id === finalDraft.id);
      if (idx >= 0) providers[idx] = finalDraft;
    } else {
      const created = { ...finalDraft, id: newProviderId() };
      providers.push(created);
    }
    const next: Settings = {
      providers,
      activeProviderId: settings.activeProviderId ?? providers[0]?.id,
    };
    await persist(next);
    resetDraft();
    flash('已保存');
  }
```

New:

```tsx
  function applyPreset(name: string) {
    const preset = PROVIDER_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    const result = applyPresetToDraft(draft, extrasText, preset);
    setDraft(result.draft);
    setExtrasText(result.extrasText);
  }

  async function saveDraft() {
    const trimmed = trimProviderDraft(draft);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
    const finalDraft = withExtras(trimmed, extrasText);
    const isDuplicateName = hasDuplicateProviderName(
      settings.providers,
      finalDraft.name,
      isEditing ? finalDraft.id : undefined,
    );
    const providers = [...settings.providers];
    if (isEditing) {
      const idx = providers.findIndex((p) => p.id === finalDraft.id);
      if (idx >= 0) providers[idx] = finalDraft;
    } else {
      const created = { ...finalDraft, id: newProviderId() };
      providers.push(created);
    }
    const next: Settings = {
      providers,
      activeProviderId: settings.activeProviderId ?? providers[0]?.id,
    };
    await persist(next);
    resetDraft();
    flash(isDuplicateName ? '已保存（存在同名 Provider）' : '已保存');
  }
```

- [ ] **Step 3: Type-check**

Run: `pnpm compile`
Expected: PASS, no errors.

- [ ] **Step 4: Manually verify in the browser**

Run `pnpm dev`, load the unpacked extension, open the options page:
1. Add a provider, paste a Base URL with a trailing space (e.g. `https://api.deepseek.com ` — leave the trailing space) and a name with leading spaces. Save, then click "编辑" on it — confirm the displayed values have no stray whitespace.
2. Click "添加" to start a new draft, type a custom Base URL, then select the "DeepSeek" preset from "快速预设" — confirm your custom Base URL is **not** overwritten.
3. Start a new draft (Base URL empty), select the "DeepSeek" preset — confirm Base URL/模型 fill in, **and** confirm "其他可用模型" fills in with `deepseek-v4-flash`.
4. Add two providers with the same name — confirm the second save shows the "已保存（存在同名 Provider）" toast and both still exist in the list.

- [ ] **Step 5: Commit**

```bash
git add components/ProviderSettings.tsx
git commit -m "fix: trim provider fields before validation/save, stop preset from overwriting baseURL"
```

---

### Task 3: Cross-tab/cross-context sync via `browser.storage.onChanged`

**Files:**
- Modify: `lib/settings.ts:42` (export `STORAGE_KEY`)
- Modify: `components/ProviderSettings.tsx` (imports, state, `loadDraft`/`resetDraft`, new effect, `saveDraft` guard, banner JSX)

**Interfaces:**
- Consumes: `STORAGE_KEY` (newly exported), `Settings` type.
- Produces: `editingRemoved: boolean` state — read by Task 6's submit button (kept disabled-independent; only gates the save action here) and by the banner JSX added in this task.

- [ ] **Step 1: Export `STORAGE_KEY` from `lib/settings.ts`**

Current (line 42):

```ts
const STORAGE_KEY = 'aluminum:settings';
```

New:

```ts
export const STORAGE_KEY = 'aluminum:settings';
```

- [ ] **Step 2: Add the import and `editingRemoved` state**

In `components/ProviderSettings.tsx`, update the import block (from Task 2) to add `STORAGE_KEY`:

```tsx
import {
  loadSettings,
  saveSettings,
  newProviderId,
  applyPresetToDraft,
  hasDuplicateProviderName,
  trimProviderDraft,
  PROVIDER_PRESETS,
  STORAGE_KEY,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';
```

Add a new state variable next to `toast` (currently `const [toast, setToast] = useState<string | null>(null);`):

```tsx
  const [editingRemoved, setEditingRemoved] = useState(false);
```

- [ ] **Step 3: Clear `editingRemoved` in `loadDraft`/`resetDraft`**

Current:

```tsx
  function loadDraft(p: ProviderConfig) {
    setDraft(p);
    setExtrasText(extrasOf(p));
  }

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setExtrasText('');
  }
```

New:

```tsx
  function loadDraft(p: ProviderConfig) {
    setDraft(p);
    setExtrasText(extrasOf(p));
    setEditingRemoved(false);
  }

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setExtrasText('');
    setEditingRemoved(false);
  }
```

- [ ] **Step 4: Add the `storage.onChanged` effect**

Add this effect after the existing `useEffect(() => { loadSettings().then(setSettings); }, []);`:

```tsx
  useEffect(() => {
    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (!change) return;
      const next = (change.newValue as Settings | undefined) ?? { providers: [] };
      setSettings(next);
      if (isEditing && !next.providers.some((p) => p.id === draft.id)) {
        setEditingRemoved(true);
      }
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, [isEditing, draft.id]);
```

- [ ] **Step 5: Guard `saveDraft` against saving a draft whose provider was removed elsewhere**

Add this check at the top of `saveDraft` (before the `trimProviderDraft` call added in Task 2):

```tsx
  async function saveDraft() {
    if (editingRemoved) {
      flash('该 Provider 已在别处被删除，请放弃编辑');
      return;
    }
    const trimmed = trimProviderDraft(draft);
    // ...(rest unchanged from Task 2)
```

- [ ] **Step 6: Add the banner JSX**

In the render, right after the `<h2>{isEditing ? '编辑 Provider' : '添加 Provider'}</h2>` line, add:

```tsx
        {editingRemoved && (
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            此 Provider 已在别处被删除，继续保存不会生效。
            <button type="button" onClick={resetDraft} className="ml-2 underline">
              放弃编辑
            </button>
          </p>
        )}
```

- [ ] **Step 7: Type-check and run the lib test suite**

Run: `pnpm compile`
Expected: PASS

Run: `pnpm test`
Expected: PASS (the `STORAGE_KEY` export change doesn't affect any existing test)

- [ ] **Step 8: Manually verify cross-tab sync**

Run `pnpm dev`. Open the options page in one tab and the sidepanel's settings view in another (or two options-page tabs).
1. In tab A, click "编辑" on a provider (draft open). In tab B, delete that same provider. Confirm tab A shows the amber "此 Provider 已在别处被删除" banner, and clicking "保存修改" no longer silently succeeds (should show the "该 Provider 已在别处被删除" toast instead once you also try saving).
2. In tab A, add a new provider. Confirm tab B's list updates without needing a manual refresh, and without clearing anything you were mid-typing in tab B's own (unrelated) draft.

- [ ] **Step 9: Commit**

```bash
git add lib/settings.ts components/ProviderSettings.tsx
git commit -m "feat: sync provider list across tabs via storage.onChanged, guard save against externally-deleted drafts"
```

---

### Task 4: Two-step delete confirmation

**Files:**
- Modify: `components/ProviderSettings.tsx` (imports, state + timeout ref, new handlers, delete button JSX)

**Interfaces:**
- Produces: `requestDelete(id: string): void`, `confirmDelete(id: string): Promise<void>` — used only within this component's render; no other task depends on these.

- [ ] **Step 1: Add `useRef` to the React import**

Current:

```tsx
import { useEffect, useState } from 'react';
```

New:

```tsx
import { useEffect, useRef, useState } from 'react';
```

- [ ] **Step 2: Add confirmation state and handlers**

Add next to the other `useState` declarations:

```tsx
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);
```

Add these functions next to `remove`:

```tsx
  function requestDelete(id: string) {
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
    }
    setConfirmingDeleteId(id);
    confirmTimeoutRef.current = window.setTimeout(() => {
      setConfirmingDeleteId(null);
      confirmTimeoutRef.current = null;
    }, 3000);
  }

  async function confirmDelete(id: string) {
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmingDeleteId(null);
    await remove(id);
  }
```

Add a cleanup effect (so a pending timeout doesn't fire after unmount) next to the other `useEffect` calls:

```tsx
  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) {
        window.clearTimeout(confirmTimeoutRef.current);
      }
    };
  }, []);
```

- [ ] **Step 3: Update the delete button JSX**

Current (inside the `providers.map` list item):

```tsx
                  <button
                    onClick={() => remove(p.id)}
                    className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    删除
                  </button>
```

New:

```tsx
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

- [ ] **Step 4: Type-check**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 5: Manually verify**

Run `pnpm dev`, open the options page:
1. Click "删除" once — confirm the button turns red and reads "确认删除？", and the provider is NOT yet removed.
2. Wait 4+ seconds without clicking again — confirm the button reverts to "删除" and nothing was deleted.
3. Click "删除" then click "确认删除？" within 3 seconds — confirm the provider is removed.
4. With two providers, click "删除" on the first, then click "删除" (not "确认删除？") on the second — confirm the first button reverts to its normal state (only one item can be "pending confirm" at a time).

- [ ] **Step 6: Commit**

```bash
git add components/ProviderSettings.tsx
git commit -m "feat: require a second click within 3s to delete a provider"
```

---

### Task 5: Save-button race guard (disable while saving + functional state update)

**Files:**
- Modify: `components/ProviderSettings.tsx` (state, `saveDraft` rewrite)

**Interfaces:**
- Produces: `saving: boolean` state — consumed by Task 6's submit button (`disabled={saving}`).

- [ ] **Step 1: Add `saving` state**

Add next to the other `useState` declarations:

```tsx
  const [saving, setSaving] = useState(false);
```

- [ ] **Step 2: Rewrite `saveDraft` to use a functional `setSettings` update and guard re-entrancy**

Current (after Task 2 + Task 3's edits):

```tsx
  async function saveDraft() {
    if (editingRemoved) {
      flash('该 Provider 已在别处被删除，请放弃编辑');
      return;
    }
    const trimmed = trimProviderDraft(draft);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
    const finalDraft = withExtras(trimmed, extrasText);
    const isDuplicateName = hasDuplicateProviderName(
      settings.providers,
      finalDraft.name,
      isEditing ? finalDraft.id : undefined,
    );
    const providers = [...settings.providers];
    if (isEditing) {
      const idx = providers.findIndex((p) => p.id === finalDraft.id);
      if (idx >= 0) providers[idx] = finalDraft;
    } else {
      const created = { ...finalDraft, id: newProviderId() };
      providers.push(created);
    }
    const next: Settings = {
      providers,
      activeProviderId: settings.activeProviderId ?? providers[0]?.id,
    };
    await persist(next);
    resetDraft();
    flash(isDuplicateName ? '已保存（存在同名 Provider）' : '已保存');
  }
```

New:

```tsx
  async function saveDraft() {
    if (saving) return;
    if (editingRemoved) {
      flash('该 Provider 已在别处被删除，请放弃编辑');
      return;
    }
    const trimmed = trimProviderDraft(draft);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
    const finalDraft = withExtras(trimmed, extrasText);
    setSaving(true);
    try {
      let next: Settings = { providers: [] };
      let isDuplicateName = false;
      setSettings((prev) => {
        isDuplicateName = hasDuplicateProviderName(
          prev.providers,
          finalDraft.name,
          isEditing ? finalDraft.id : undefined,
        );
        const providers = [...prev.providers];
        if (isEditing) {
          const idx = providers.findIndex((p) => p.id === finalDraft.id);
          if (idx >= 0) providers[idx] = finalDraft;
        } else {
          providers.push({ ...finalDraft, id: newProviderId() });
        }
        next = { providers, activeProviderId: prev.activeProviderId ?? providers[0]?.id };
        return next;
      });
      await saveSettings(next);
      onChange?.();
      resetDraft();
      flash(isDuplicateName ? '已保存（存在同名 Provider）' : '已保存');
    } finally {
      setSaving(false);
    }
  }
```

Note: this bypasses the `persist()` helper (which takes a plain value, not an updater) specifically for `saveDraft` to close the stale-closure race on `settings.providers`. `persist()` itself is untouched and still used by `remove()`/`setActive()` — the spec does not require changing those.

- [ ] **Step 3: Type-check**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 4: Manually verify**

Run `pnpm dev`, open the options page, fill in a valid new provider, and click "添加" twice as fast as you can. Confirm exactly one provider was added (check the list count), not zero or two.

- [ ] **Step 5: Commit**

```bash
git add components/ProviderSettings.tsx
git commit -m "fix: guard saveDraft against stale-closure races on rapid double-submit"
```

---

### Task 6: Required-field markers, Enter-to-submit, API key show/hide

**Files:**
- Modify: `components/ProviderSettings.tsx` (form JSX, `Field` component, button JSX)

**Interfaces:**
- Consumes: `saving` from Task 5 (for the submit button's `disabled` state).

- [ ] **Step 1: Wrap the form fields in a `<form>` with `onSubmit`**

Current (the "添加/编辑 Provider" section — this reflects the file state after Task 3 added the
`editingRemoved` banner right after the `<h2>`):

```tsx
      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
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
            value=""
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">选择以填充 Base URL / 模型…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <Field
          label="名称"
          value={draft.name}
          placeholder="例如 DeepSeek"
          onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
        />
        <Field
          label="Base URL"
          value={draft.baseURL}
          placeholder="https://api.deepseek.com"
          onChange={(v) => setDraft((d) => ({ ...d, baseURL: v }))}
        />
        <Field
          label="模型（默认）"
          value={draft.model}
          placeholder="deepseek-v4-pro"
          onChange={(v) => setDraft((d) => ({ ...d, model: v }))}
        />
        <Field
          label="其他可用模型（逗号分隔，可选）"
          value={extrasText}
          placeholder="例如 deepseek-v4-flash"
          onChange={setExtrasText}
        />
        <Field
          label="API Key"
          type="password"
          value={draft.apiKey}
          placeholder="sk-..."
          onChange={(v) => setDraft((d) => ({ ...d, apiKey: v }))}
        />

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={saveDraft}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {isEditing ? '保存修改' : '添加'}
          </button>
          {isEditing && (
            <button
              onClick={resetDraft}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              取消
            </button>
          )}
          {toast && <span className="text-xs text-green-600 dark:text-green-400">{toast}</span>}
        </div>
      </section>
```

New:

```tsx
      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
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
            value=""
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">选择以填充 Base URL / 模型…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <Field
            label="名称"
            value={draft.name}
            placeholder="例如 DeepSeek"
            required
            onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
          />
          <Field
            label="Base URL"
            value={draft.baseURL}
            placeholder="https://api.deepseek.com"
            required
            onChange={(v) => setDraft((d) => ({ ...d, baseURL: v }))}
          />
          <Field
            label="模型（默认）"
            value={draft.model}
            placeholder="deepseek-v4-pro"
            required
            onChange={(v) => setDraft((d) => ({ ...d, model: v }))}
          />
          <Field
            label="其他可用模型（逗号分隔，可选）"
            value={extrasText}
            placeholder="例如 deepseek-v4-flash"
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
        </form>
      </section>
```

- [ ] **Step 2: Update the `Field` component with `required` and `toggleable` support**

Current (lines 253-278):

```tsx
function Field({
  label,
  value,
  placeholder,
  type = 'text',
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600"
      />
    </label>
  );
}
```

New:

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
  const resolvedType = toggleable ? (revealed ? 'text' : 'password') : type;
  return (
    <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
      {label}
      {required && <span className="text-red-500"> *</span>}
      <div className="relative mt-1">
        <input
          type={resolvedType}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600"
        />
        {toggleable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute inset-y-0 right-2 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            {revealed ? '隐藏' : '显示'}
          </button>
        )}
      </div>
    </label>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm compile`
Expected: PASS

- [ ] **Step 4: Manually verify**

Run `pnpm dev`, open the options page:
1. Confirm 名称/Base URL/模型（默认） show a red `*`; 其他可用模型/API Key do not.
2. Fill in the three required fields and press Enter while focused in any of them — confirm the form submits (same as clicking Add/Save).
3. Type something into API Key, click "显示" — confirm it becomes plain text; click "隐藏" — confirm it masks again.

- [ ] **Step 5: Commit**

```bash
git add components/ProviderSettings.tsx
git commit -m "feat: mark required fields, support Enter-to-submit, add API key show/hide toggle"
```

---

### Task 7: Full verification pass against the spec's acceptance criteria

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated check**

Run: `pnpm compile`
Expected: PASS

Run: `pnpm test`
Expected: PASS (all `lib/**/*.test.ts` files, including the new `lib/settings.test.ts`)

- [ ] **Step 2: Walk every acceptance criterion in `docs/specs/0003-provider-settings-form-fixes.md`**

Run `pnpm dev`, open the options page and the sidepanel's settings view side by side, and check off each of the 9 acceptance criteria in the spec one by one (trim-on-save, non-destructive preset merge, preset extras backfill, cross-tab sync without clobbering an in-progress edit, two-step delete confirmation, no duplicate/lost provider on rapid double-save, required markers + Enter-to-submit, non-blocking duplicate-name toast, API key show/hide).

- [ ] **Step 3: Update the spec's status**

In `docs/specs/0003-provider-settings-form-fixes.md`, change:

```markdown
- 状态：草稿 Draft
```

to:

```markdown
- 状态：已实现 Implemented
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/0003-provider-settings-form-fixes.md
git commit -m "docs: mark Spec-0003 as implemented"
```
