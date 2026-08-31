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
