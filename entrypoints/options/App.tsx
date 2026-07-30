import { useState, type ReactNode } from 'react';
import AppearanceSettings from '@/components/AppearanceSettings';
import GeneralSettings from '@/components/GeneralSettings';
import LanguageSettings from '@/components/LanguageSettings';
import ProviderSettings from '@/components/ProviderSettings';
import SettingsShell, { type SettingsSection, type SettingsSectionGroup } from '@/components/SettingsShell';
import ShortcutSettings from '@/components/ShortcutSettings';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

export default function App() {
  const { mode, setMode } = useTheme();
  const { t, locale, setLocale } = useTranslation();
  const [section, setSection] = useState<SettingsSection>('general');
  const groups: SettingsSectionGroup[] = [
    {
      label: t('settings.groupPreferences'),
      sections: [
        { id: 'general', label: t('settings.navGeneral') },
        { id: 'appearance', label: t('settings.navAppearance') },
        { id: 'language', label: t('settings.navLanguage') },
      ],
    },
    {
      label: t('settings.groupAiTools'),
      sections: [
        { id: 'providers', label: t('settings.navProviders') },
        { id: 'shortcuts', label: t('settings.navShortcuts') },
      ],
    },
    {
      label: t('settings.groupSafety'),
      sections: [
        { id: 'privacy', label: t('settings.navPrivacy') },
        { id: 'about', label: t('settings.navAbout') },
      ],
    },
  ];

  return (
    <SettingsShell
      groups={groups}
      activeSection={section}
      onSelect={setSection}
      navigationLabel={t('common.settings')}
    >
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{t('settings.pageTitle')}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.description')}</p>
      </header>
      {section === 'general' && <GeneralSettings />}
      {section === 'appearance' && <SettingsPanel title={t('settings.navAppearance')}><AppearanceSettings mode={mode} onSet={setMode} /></SettingsPanel>}
      {section === 'language' && <SettingsPanel title={t('settings.navLanguage')}><LanguageSettings mode={locale} onSet={setLocale} /></SettingsPanel>}
      {section === 'providers' && <SettingsPanel title={t('settings.navProviders')}><ProviderSettings /></SettingsPanel>}
      {section === 'shortcuts' && <SettingsPanel title={t('settings.navShortcuts')}><ShortcutSettings /></SettingsPanel>}
      {section === 'privacy' && <PrivacySection />}
      {section === 'about' && <AboutSection />}
    </SettingsShell>
  );
}

function SettingsPanel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section aria-labelledby="settings-panel-heading" className="max-w-3xl">
      <h2 id="settings-panel-heading" className="mb-5 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function PrivacySection() {
  const { t } = useTranslation();
  const disclosures = [
    ['privacy.pageDataTitle', 'privacy.pageDataBody'],
    ['privacy.localDataTitle', 'privacy.localDataBody'],
    ['privacy.noBackendTitle', 'privacy.noBackendBody'],
  ] as const;
  return (
    <section aria-labelledby="privacy-settings-heading" className="max-w-2xl">
      <h2 id="privacy-settings-heading" className="text-xl font-semibold">{t('settings.navPrivacy')}</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.privacyDescription')}</p>
      <div className="mt-5 space-y-3">
        {disclosures.map(([title, body]) => (
          <article key={title} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="text-sm font-medium">{t(title)}</h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{t(body)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const version = browser.runtime.getManifest().version;
  return (
    <section aria-labelledby="about-settings-heading" className="max-w-2xl">
      <h2 id="about-settings-heading" className="text-xl font-semibold">{t('settings.navAbout')}</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.aboutDescription')}</p>
      <p className="mt-5 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        {t('settings.version', { version })}
      </p>
    </section>
  );
}
