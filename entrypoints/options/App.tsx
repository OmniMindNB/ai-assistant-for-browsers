import { useState, type ReactNode } from 'react';
import AppearanceSettings from '@/components/AppearanceSettings';
import LanguageSettings from '@/components/LanguageSettings';
import ProviderSettings from '@/components/ProviderSettings';
import {
  IconAbout,
  IconAppearance,
  IconLanguage,
  IconModelProviders,
  IconPrivacy,
  IconShortcuts,
} from '@/components/settings-icons';
import SettingsShell, {
  type SettingsSection,
  type SettingsSectionDescriptor,
  type SettingsSectionGroup,
} from '@/components/SettingsShell';
import ShortcutSettings from '@/components/ShortcutSettings';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

export default function App() {
  const { mode, setMode } = useTheme();
  const { t, locale, setLocale } = useTranslation();
  const [section, setSection] = useState<SettingsSection>('providers');
  const version = browser.runtime.getManifest().version;

  const groups: SettingsSectionGroup[] = [
    {
      label: t('settings.groupAiTools'),
      sections: [
        { id: 'providers', label: t('settings.navProviders'), icon: IconModelProviders },
      ],
    },
    {
      label: t('settings.groupPreferences'),
      sections: [
        { id: 'appearance', label: t('settings.navAppearance'), icon: IconAppearance },
        { id: 'language', label: t('settings.navLanguage'), icon: IconLanguage },
        { id: 'shortcuts', label: t('settings.navShortcuts'), icon: IconShortcuts },
      ],
    },
    {
      label: t('settings.groupSafety'),
      sections: [
        { id: 'privacy', label: t('settings.navPrivacy'), icon: IconPrivacy },
      ],
    },
  ];
  const footerSections: SettingsSectionDescriptor[] = [
    { id: 'about', label: t('settings.navAboutVersion', { version }), icon: IconAbout },
  ];

  return (
    <SettingsShell
      groups={groups}
      footerSections={footerSections}
      activeSection={section}
      onSelect={setSection}
      navigationLabel={t('common.settings')}
    >
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.pageTitle')}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.description')}</p>
      </header>
      {section === 'appearance' && <SettingsPanel><AppearanceSettings mode={mode} onSet={setMode} /></SettingsPanel>}
      {section === 'language' && <SettingsPanel><LanguageSettings mode={locale} onSet={setLocale} /></SettingsPanel>}
      {section === 'providers' && <SettingsPanel><ProviderSettings /></SettingsPanel>}
      {section === 'shortcuts' && <SettingsPanel><ShortcutSettings /></SettingsPanel>}
      {section === 'privacy' && <PrivacySection />}
      {section === 'about' && <AboutSection />}
    </SettingsShell>
  );
}

function SettingsPanel({ children }: { children: ReactNode }) {
  return <section className="max-w-3xl">{children}</section>;
}

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

function AboutSection() {
  const { t } = useTranslation();
  const version = browser.runtime.getManifest().version;
  return (
    <section className="max-w-2xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('settings.aboutDescription')}</p>
      <p className="mt-5 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        {t('settings.version', { version })}
      </p>
    </section>
  );
}
