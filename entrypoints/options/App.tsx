import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import LanguageSettings from '@/components/LanguageSettings';
import { useTheme } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';

export default function App() {
  const { mode, setMode } = useTheme();
  const { t, locale, setLocale } = useTranslation();
  return (
    <div className="min-h-screen bg-neutral-50 p-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold">{t('settings.pageTitle')}</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
          {t('settings.descriptionPrefix')}
          <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
          {t('settings.optionsDescriptionSuffix')}
        </p>
        <AppearanceSettings mode={mode} onSet={setMode} />
        <LanguageSettings mode={locale} onSet={setLocale} />
        <ProviderSettings />
      </div>
    </div>
  );
}
