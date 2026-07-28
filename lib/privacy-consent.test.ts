import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRIVACY_CONSENT_KEY,
  PRIVACY_CONSENT_VERSION,
  isCurrentPrivacyConsent,
  loadPrivacyConsent,
  privacyPolicyUrl,
  savePrivacyConsent,
} from './privacy-consent';

describe('privacy consent', () => {
  const originalBrowser = (globalThis as any).browser;
  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
    vi.restoreAllMocks();
  });

  it('accepts only the current version with an acceptedAt timestamp', () => {
    expect(isCurrentPrivacyConsent({ version: PRIVACY_CONSENT_VERSION, acceptedAt: '2026-07-27T00:00:00.000Z' })).toBe(true);
    expect(isCurrentPrivacyConsent({ version: PRIVACY_CONSENT_VERSION - 1, acceptedAt: '2026-07-27T00:00:00.000Z' })).toBe(false);
    expect(isCurrentPrivacyConsent({ version: PRIVACY_CONSENT_VERSION })).toBe(false);
  });

  it('fails closed when storage is empty or throws', async () => {
    (globalThis as any).browser = { storage: { local: { get: async () => ({}) } } };
    expect(await loadPrivacyConsent()).toBe(false);
    (globalThis as any).browser.storage.local.get = async () => { throw new Error('blocked'); };
    expect(await loadPrivacyConsent()).toBe(false);
  });

  it('writes the current version and timestamp', async () => {
    const set = vi.fn(async () => {});
    (globalThis as any).browser = { storage: { local: { set } } };
    await savePrivacyConsent(new Date('2026-07-27T00:00:00.000Z'));
    expect(set).toHaveBeenCalledWith({
      [PRIVACY_CONSENT_KEY]: {
        version: PRIVACY_CONSENT_VERSION,
        acceptedAt: '2026-07-27T00:00:00.000Z',
      },
    });
  });

  it('returns stable localized policy URLs', () => {
    expect(privacyPolicyUrl('en')).toBe('https://omnimindnb.github.io/aluminum-legal/');
    expect(privacyPolicyUrl('zh')).toBe('https://omnimindnb.github.io/aluminum-legal/zh-CN/');
  });
});
