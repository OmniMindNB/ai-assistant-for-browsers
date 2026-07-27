export const PRIVACY_CONSENT_VERSION = 1;
export const PRIVACY_CONSENT_KEY = 'aluminum:privacy-consent';

interface PrivacyConsentRecord {
  version: number;
  acceptedAt: string;
}

export function isCurrentPrivacyConsent(value: unknown): value is PrivacyConsentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PrivacyConsentRecord>;
  return record.version === PRIVACY_CONSENT_VERSION && typeof record.acceptedAt === 'string';
}

export async function loadPrivacyConsent(): Promise<boolean> {
  try {
    const result = await browser.storage.local.get(PRIVACY_CONSENT_KEY);
    return isCurrentPrivacyConsent(result[PRIVACY_CONSENT_KEY]);
  } catch {
    return false;
  }
}

export async function savePrivacyConsent(now = new Date()): Promise<void> {
  await browser.storage.local.set({
    [PRIVACY_CONSENT_KEY]: {
      version: PRIVACY_CONSENT_VERSION,
      acceptedAt: now.toISOString(),
    },
  });
}

export function privacyPolicyUrl(locale: 'en' | 'zh'): string {
  return locale === 'zh'
    ? 'https://omnimindnb.github.io/aluminum-legal/zh-CN/'
    : 'https://omnimindnb.github.io/aluminum-legal/';
}
