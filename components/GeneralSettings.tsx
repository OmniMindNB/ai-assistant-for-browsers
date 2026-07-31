import { useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchPreferences,
} from '@/lib/workbench/preferences';

export default function GeneralSettings() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<WorkbenchPreferences>(DEFAULT_WORKBENCH_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadWorkbenchPreferences()
      .then((preferences) => {
        if (active) setDraft(preferences);
      })
      .catch((reason: unknown) => {
        if (active) setError(messageOf(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  function updateAttachment(attachPageByDefault: boolean) {
    setDraft((current) => ({ ...current, attachPageByDefault }));
    setSaved(false);
    setError(null);
  }

  async function save() {
    if (loading || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await saveWorkbenchPreferences(draft);
      setSaved(true);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="general-settings-heading" className="max-w-2xl">
      <h2 id="general-settings-heading" className="text-xl font-semibold">{t('settings.navGeneral')}</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.generalDescription')}</p>

      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <input
          type="checkbox"
          checked={draft.attachPageByDefault}
          disabled={loading || saving}
          aria-label={t('settings.attachPageByDefault')}
          onChange={(event) => updateAttachment(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-indigo-600"
        />
        <span>
          <span className="block font-medium">{t('settings.attachPageByDefault')}</span>
          <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">{t('settings.attachPageDescription')}</span>
        </span>
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => void save()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
        {loading && <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">{t('settings.loading')}</p>}
        {saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{t('settings.saved')}</p>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{t('settings.saveFailed', { message: error })}</p>}
      </div>
    </section>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
