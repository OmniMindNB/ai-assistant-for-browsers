// Provider 配置 UI（列表 + 新增/编辑表单）。
// 同时供 options 页与侧边栏内嵌「设置」视图复用，避免重复实现。
// 配置存于 chrome.storage.local（ref: lib/settings.ts）。
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

const EMPTY_DRAFT: ProviderConfig = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
  api: 'openai-completions',
};

/** 默认模型之外的其他可用模型（逗号分隔展示）。 */
function extrasOf(p: ProviderConfig): string {
  return (p.models ?? []).filter((m) => m !== p.model).join(', ');
}

/** 根据默认模型 + 其他模型文本，重建去重后的 models 列表。 */
function withExtras(p: ProviderConfig, extrasText: string): ProviderConfig {
  const extras = extrasText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const models = [p.model, ...extras].filter(Boolean);
  const seen = new Set<string>();
  const deduped = models.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  return { ...p, models: deduped.length ? deduped : undefined };
}

export default function ProviderSettings({ onChange }: { onChange?: () => void }) {
  const { t, resolved } = useTranslation();
  const [settings, setSettings] = useState<Settings>({ providers: [] });
  const [draft, setDraft] = useState<ProviderConfig>(EMPTY_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  // 独立于 draft 的原始文本，避免每次按键都经过 withExtras 的去重/过滤——
  // 那样会在用户粘贴的内容恰好等于「模型（默认）」时把输入静默清空（看起来像粘贴无效）。
  const [extrasText, setExtrasText] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingRemoved, setEditingRemoved] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirmTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const isEditing = draft.id !== '';

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

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) {
        window.clearTimeout(confirmTimeoutRef.current);
      }
    };
  }, []);

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  }

  function loadDraft(p: ProviderConfig) {
    setDraft(p);
    setExtrasText(extrasOf(p));
    setSelectedPreset('');
    setEditingRemoved(false);
    setEditorOpen(true);
    setSaveError(null);
  }

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setExtrasText('');
    setSelectedPreset('');
    setEditingRemoved(false);
    setEditorOpen(false);
    setSaveError(null);
  }

  function beginAdd() {
    resetDraft();
    setEditorOpen(true);
  }

  async function persist(next: Settings) {
    setSettings(next);
    await saveSettings(next);
    onChange?.();
  }

  function applyPreset(name: string) {
    setSelectedPreset(name);
    const preset = resolvePresetSelection(name);
    if (!preset) return;
    const result = applyPresetToDraft(draft, extrasText, preset, isEditing);
    setDraft(result.draft);
    setExtrasText(result.extrasText);
  }

  async function saveDraft() {
    if (saving) return;
    if (editingRemoved) {
      flash(t('provider.removedElsewhereFlash'));
      return;
    }
    const trimmed = trimProviderDraft(draft);
    setSaveError(null);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash(t('provider.flashFillRequired'));
      return;
    }
    const finalDraft = withExtras(trimmed, extrasText);
    const newId = newProviderId();
    setSaving(true);
    try {
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
        providers.push({ ...finalDraft, id: newId });
      }
      const next: Settings = {
        providers,
        activeProviderId: settings.activeProviderId ?? providers[0]?.id,
      };
      await persist(next);
      resetDraft();
      flash(isDuplicateName ? t('provider.flashSavedDuplicate') : t('provider.flashSaved'));
    } catch {
      setSaveError(t('provider.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const providers = settings.providers.filter((p) => p.id !== id);
    const activeProviderId =
      settings.activeProviderId === id ? providers[0]?.id : settings.activeProviderId;
    await persist({ providers, activeProviderId });
    if (draft.id === id) resetDraft();
  }

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

  async function setActive(id: string) {
    await persist({ ...settings, activeProviderId: id });
  }

  const placeholders = draftPlaceholders(selectedPreset, resolved);

  return (
    <>
      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {t('provider.configuredHeading')}
          </h3>
          <button
            type="button"
            onClick={beginAdd}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {t('provider.addHeading')}
          </button>
        </div>
        {settings.providers.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-4 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
            {t('provider.emptyList')}
          </p>
        ) : (
          <ul aria-label={t('provider.configuredHeading')} className="space-y-2">
            {settings.providers.map((p) => {
              const active = p.id === settings.activeProviderId;
              return (
                <li
                  key={p.id}
                  className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <input
                      type="radio"
                      name="active"
                      checked={active}
                      onChange={() => void setActive(p.id)}
                      aria-label={`${t('provider.setActiveTitle')}: ${p.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        <span className="truncate" title={p.name}>{p.name}</span>
                        {active && (
                          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/40 dark:text-green-300">
                            {t('provider.activeBadge')}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                        <span>{p.apiKey ? t('provider.keyConfigured') : t('provider.keyMissing')}</span>
                        <span>{t('provider.modelCount', { count: p.models?.length ?? 1 })}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => loadDraft(p)}
                        aria-label={`${t('common.edit')} ${p.name}`}
                        className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          confirmingDeleteId === p.id ? confirmDelete(p.id) : requestDelete(p.id)
                        }
                        aria-label={`${t('common.delete')} ${p.name}`}
                        className={
                          confirmingDeleteId === p.id
                            ? 'rounded border border-red-600 bg-red-600 px-2 py-1 text-xs text-white transition-colors hover:bg-red-700'
                            : 'rounded border border-red-200 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40'
                        }
                      >
                        {confirmingDeleteId === p.id ? t('provider.confirmDelete') : t('common.delete')}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editorOpen && <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h3 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {isEditing ? t('provider.editHeading') : t('provider.addHeading')}
        </h3>

        {editingRemoved && (
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {t('provider.removedElsewhere')}
            <button type="button" onClick={resetDraft} className="ml-2 underline">
              {t('provider.discardEdit')}
            </button>
          </p>
        )}
        {saveError && (
          <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            {saveError}
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

        <form
          aria-label="Provider editor"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
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
            {toast && <span role="status" className="text-xs text-green-600 dark:text-green-400">{toast}</span>}
          </div>
        </form>
      </section>}
    </>
  );
}

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
  const resolvedType = toggleable ? (revealed ? 'text' : 'password') : type;
  return (
    <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
      {label}
      {required && <span className="text-red-500"> *</span>}
      <div className="relative mt-1">
        <input
          type={resolvedType}
          aria-label={label}
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
            {revealed ? t('common.hide') : t('common.show')}
          </button>
        )}
      </div>
    </label>
  );
}
