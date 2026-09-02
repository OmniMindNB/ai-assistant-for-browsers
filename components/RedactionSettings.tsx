import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import {
  REDACTION_STORAGE_KEY,
  loadRedactionSettings,
  newRedactionRuleId,
  previewRedactionMatches,
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
  // 用户粘贴的样例文本，只用于实时预览，不落盘、不随规则一起保存。
  const [previewSample, setPreviewSample] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

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

  // 原生 window.confirm 跟其余自定义 UI 风格割裂（无暗色模式、无法 Tab 走查焦点环）——
  // 换成 HistoryDrawer.tsx / ProviderSettings.tsx 同款的二次点击确认模式。
  function requestDeleteRule(id: string) {
    if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    setConfirmingId(id);
    confirmTimeoutRef.current = window.setTimeout(() => {
      setConfirmingId(null);
      confirmTimeoutRef.current = null;
    }, 3000);
  }

  async function removeRule(rule: RedactionRule) {
    if (!settings || saving) return;
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmingId(null);
    await persist({ ...settings, rules: settings.rules.filter((candidate) => candidate.id !== rule.id) });
  }

  function beginAdd() {
    setDraft({ ...EMPTY_DRAFT });
    setDraftErrors({});
    setPreviewSample('');
    setError(null);
  }

  function cancelAdd() {
    setDraft(null);
    setDraftErrors({});
    setPreviewSample('');
    setError(null);
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
    setPreviewSample('');
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
                  onClick={() =>
                    confirmingId === rule.id ? void removeRule(rule) : requestDeleteRule(rule.id)
                  }
                  aria-label={
                    confirmingId === rule.id
                      ? t('privacy.redaction.confirmDeleteRuleAria', { label: rule.label })
                      : t('privacy.redaction.deleteRuleAria', { label: rule.label })
                  }
                  className={
                    confirmingId === rule.id
                      ? 'shrink-0 rounded border border-red-600 bg-red-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50'
                      : 'shrink-0 rounded px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40'
                  }
                >
                  {confirmingId === rule.id ? t('provider.confirmDelete') : t('common.delete')}
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
            <RulePreview pattern={draft.pattern} sample={previewSample} onSampleChange={setPreviewSample} />
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

// 保存前的实时预览：把草稿里的正则套到用户粘贴的样例文本上，高亮出命中片段——
// 直接复用 lib/redaction.ts 里跟 redactText() 同一套 new RegExp(pattern, 'g') 逻辑，
// 保证"预览看到的"和"保存后实际生效的"不会走两套不同实现而对不上。
function RulePreview({
  pattern,
  sample,
  onSampleChange,
}: {
  pattern: string;
  sample: string;
  onSampleChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const preview = previewRedactionMatches(pattern, sample);

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <label className="block text-xs text-neutral-600 dark:text-neutral-300">
        <span className="mb-1 block">{t('privacy.redaction.previewSampleLabel')}</span>
        <textarea
          value={sample}
          onChange={(event) => onSampleChange(event.target.value)}
          rows={2}
          placeholder={t('privacy.redaction.previewSamplePlaceholder')}
          className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
      </label>
      <div className="mt-2 text-xs">
        {!sample ? (
          <p className="text-neutral-400 dark:text-neutral-500">{t('privacy.redaction.previewEmpty')}</p>
        ) : !preview.ok ? (
          <p className="text-neutral-400 dark:text-neutral-500">{t('privacy.redaction.previewInvalidPattern')}</p>
        ) : (
          <>
            <p className="mb-1 font-medium text-neutral-500 dark:text-neutral-400">
              {t('privacy.redaction.previewMatchCount', { count: preview.matchCount })}
            </p>
            <p className="whitespace-pre-wrap break-words rounded border border-neutral-200 bg-neutral-50 p-2 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
              {preview.segments.map((segment, index) =>
                segment.matched ? (
                  <mark
                    key={index}
                    className="rounded bg-amber-200 px-0.5 text-neutral-900 dark:bg-amber-500/40 dark:text-amber-100"
                  >
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
