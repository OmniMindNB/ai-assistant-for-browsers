import { afterEach, describe, expect, it } from 'vitest';
import { interpolate, loadLocale, localeFromLanguageTag, resolveLocale, saveLocale, t } from './index';
import { en } from './locales/en';
import { zh } from './locales/zh';

const privacyKeys = [
  'privacy.loading',
  'privacy.title',
  'privacy.intro',
  'privacy.pageDataTitle',
  'privacy.pageDataBody',
  'privacy.localDataTitle',
  'privacy.localDataBody',
  'privacy.noBackendTitle',
  'privacy.noBackendBody',
  'privacy.readPolicy',
  'privacy.notNow',
  'privacy.agree',
  'privacy.saving',
  'privacy.deferred',
  'privacy.saveFailed',
] as const;

const contextWorkbenchKeys = [
  'workbench.modeSwitch',
  'workbench.modeAsk',
  'workbench.modeAgent',
  'workbench.emptyAskTitle',
  'workbench.emptyAskDescription',
  'workbench.emptyAgentTitle',
  'workbench.emptyAgentDescription',
  'workbench.untitledPage',
  'agentActivity.cardLabel',
  'agentActivity.liveStatus',
  'provider.setActiveAria',
  'provider.editAria',
  'provider.deleteAria',
  'shortcut.editAria',
  'shortcut.deleteAria',
] as const;

describe('privacy consent translations', () => {
  it('provides every required string in English and Chinese', () => {
    for (const key of privacyKeys) {
      expect(en[key]).toEqual(expect.any(String));
      expect(en[key]).not.toBe('');
      expect(zh[key]).toEqual(expect.any(String));
      expect(zh[key]).not.toBe('');
    }
  });
});

describe('context workbench translations', () => {
  it('provides the required localized workbench and accessible-action copy', () => {
    for (const key of contextWorkbenchKeys) {
      expect(en[key]).toEqual(expect.any(String));
      expect(en[key]).not.toBe('');
      expect(zh[key]).toEqual(expect.any(String));
      expect(zh[key]).not.toBe('');
    }
  });

  it('keeps the English and Chinese dictionaries on the same key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
});

describe('localeFromLanguageTag', () => {
  it('maps zh-prefixed tags to zh', () => {
    expect(localeFromLanguageTag('zh')).toBe('zh');
    expect(localeFromLanguageTag('zh-CN')).toBe('zh');
    expect(localeFromLanguageTag('zh-TW')).toBe('zh');
  });

  it('is case-insensitive', () => {
    expect(localeFromLanguageTag('ZH-Hans')).toBe('zh');
  });

  it('falls back to en for any non-zh tag', () => {
    expect(localeFromLanguageTag('en')).toBe('en');
    expect(localeFromLanguageTag('en-US')).toBe('en');
    expect(localeFromLanguageTag('fr')).toBe('en');
    expect(localeFromLanguageTag('ja')).toBe('en');
  });
});

describe('resolveLocale', () => {
  it('returns zh/en as-is without touching the browser language', () => {
    expect(resolveLocale('zh')).toBe('zh');
    expect(resolveLocale('en')).toBe('en');
  });
});

describe('interpolate', () => {
  it('returns the template unchanged when no vars are given', () => {
    expect(interpolate('例如 {value}')).toBe('例如 {value}');
  });

  it('substitutes known {name} placeholders', () => {
    expect(interpolate('例如 {value}', { value: 'DeepSeek' })).toBe('例如 DeepSeek');
    expect(interpolate('{minutes}分{seconds}秒', { minutes: 1, seconds: 30 })).toBe('1分30秒');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolate('hello {name}', { other: 'x' })).toBe('hello {name}');
  });
});

describe('t (module-level singleton)', () => {
  it('starts already synced with resolveLocale(\'auto\') at module load time', () => {
    expect(resolveLocale('auto')).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
  });
});

describe('loadLocale / saveLocale', () => {
  const originalBrowser = (globalThis as any).browser;

  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
  });

  it('round-trips a saved locale through browser.storage.local', async () => {
    const store: Record<string, unknown> = {};
    (globalThis as any).browser = {
      storage: {
        local: {
          get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
          set: async (items: Record<string, unknown>) => {
            Object.assign(store, items);
          },
        },
      },
    };
    await saveLocale('en');
    expect(await loadLocale()).toBe('en');
  });

  it("falls back to 'auto' when nothing is stored", async () => {
    (globalThis as any).browser = {
      storage: { local: { get: async () => ({}) } },
    };
    expect(await loadLocale()).toBe('auto');
  });
});
