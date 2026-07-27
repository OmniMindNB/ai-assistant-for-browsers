import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n';
import { loadPrivacyConsent, privacyPolicyUrl, savePrivacyConsent } from '@/lib/privacy-consent';

export default function PrivacyConsentGate({ children }: { children: ReactNode }) {
  const { t, resolved } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadPrivacyConsent().then((current) => {
      setAccepted(current);
      setLoading(false);
    });
  }, []);

  async function accept() {
    setSaving(true);
    setError(false);
    try {
      await savePrivacyConsent();
      setAccepted(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main aria-busy="true">{t('privacy.loading')}</main>;
  if (accepted) return <>{children}</>;

  const disclosures = [
    ['privacy.pageDataTitle', 'privacy.pageDataBody'],
    ['privacy.localDataTitle', 'privacy.localDataBody'],
    ['privacy.noBackendTitle', 'privacy.noBackendBody'],
  ] as const;

  return (
    <main className="min-h-screen bg-neutral-50 p-6 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <section className="mx-auto max-w-lg rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-xl font-semibold">{t('privacy.title')}</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{t('privacy.intro')}</p>
        <div className="my-5 space-y-3">
          {disclosures.map(([title, body]) => (
            <div key={title} className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800">
              <h2 className="text-sm font-medium">{t(title)}</h2>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">{t(body)}</p>
            </div>
          ))}
        </div>
        <a href={privacyPolicyUrl(resolved)} target="_blank" rel="noreferrer">{t('privacy.readPolicy')}</a>
        {deferred && <p>{t('privacy.deferred')}</p>}
        {error && <p role="alert">{t('privacy.saveFailed')}</p>}
        <button type="button" onClick={() => setDeferred(true)}>{t('privacy.notNow')}</button>
        <button type="button" onClick={accept} disabled={saving}>
          {saving ? t('privacy.saving') : t('privacy.agree')}
        </button>
      </section>
    </main>
  );
}
