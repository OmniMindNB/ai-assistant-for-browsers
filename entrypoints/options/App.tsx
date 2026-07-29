import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import LanguageSettings from '@/components/LanguageSettings';
import ShortcutSettings from '@/components/ShortcutSettings';
import { useTheme } from '@/lib/theme';
import { useTranslation } from '@/lib/i18n';
import { useState } from 'react';

type SettingsSection = 'appearance' | 'language' | 'shortcuts' | 'providers';

export default function App() {
  const { mode, setMode } = useTheme();
  const { t, locale, setLocale } = useTranslation();
  const [section, setSection] = useState<SettingsSection>('appearance');
  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: 'appearance', label: t('settings.navAppearance') },
    { id: 'language', label: t('settings.navLanguage') },
    { id: 'shortcuts', label: t('settings.navShortcuts') },
    { id: 'providers', label: t('settings.navProviders') },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-1 text-xl font-semibold">{t('settings.pageTitle')}</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
          {t('settings.descriptionPrefix')}
          <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
          {t('settings.optionsDescriptionSuffix')}
        </p>
        <div className="gap-8 md:grid md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav
            aria-label={t('common.settings')}
            className="mb-6 flex gap-1 overflow-x-auto border-b border-neutral-200 pb-2 md:mb-0 md:block md:border-b-0 md:pb-0 dark:border-neutral-800"
          >
            {sections.map((item) => {
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors md:mb-1 md:block md:w-full',
                    active
                      ? 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white'
                      : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
          <main className="min-w-0">
            {section === 'appearance' && (
              <AppearanceSettings mode={mode} onSet={setMode} />
            )}
            {section === 'language' && (
              <LanguageSettings mode={locale} onSet={setLocale} />
            )}
            {section === 'shortcuts' && <ShortcutSettings />}
            {section === 'providers' && <ProviderSettings />}
          </main>
        </div>
      </div>
    </div>
  );
}
