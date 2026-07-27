import { describe, expect, it } from 'vitest';
import { interpolate, localeFromLanguageTag, resolveLocale } from './index';

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
