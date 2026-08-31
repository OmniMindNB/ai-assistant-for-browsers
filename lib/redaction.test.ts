import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_REDACTION_RULES,
  REDACTION_STORAGE_KEY,
  defaultRedactionSettings,
  loadRedactionSettings,
  redactText,
  saveRedactionSettings,
  type RedactionSettings,
} from './redaction';

describe('redactText', () => {
  it('redacts a China mobile number with the built-in label', () => {
    const result = redactText('联系电话 13812345678 谢谢', defaultRedactionSettings());
    expect(result).toBe('联系电话 [手机号已脱敏] 谢谢');
  });

  it('redacts an email address', () => {
    const result = redactText('邮箱是 a.b+test@example.com', defaultRedactionSettings());
    expect(result).toBe('邮箱是 [邮箱已脱敏]');
  });

  it('redacts an 18-digit id card number including a trailing X', () => {
    const result = redactText('身份证 11010119900307775X', defaultRedactionSettings());
    expect(result).toBe('身份证 [身份证号已脱敏]');
  });

  it('redacts a 16-digit bank card number', () => {
    const result = redactText('卡号 6222021234567890', defaultRedactionSettings());
    expect(result).toBe('卡号 [银行卡号已脱敏]');
  });

  it('prefers the more specific idcard label over bankcard for an exact 18-digit run', () => {
    // 18 位数字同时匹配 idcard 与 bankcard 的正则；idcard 排在前面，先命中先占位，
    // bankcard 规则再执行时该子串已经是占位符文本，不会重复匹配。
    const result = redactText('号码 110101199003077758', defaultRedactionSettings());
    expect(result).toBe('号码 [身份证号已脱敏]');
  });

  it('does not match a phone-like substring inside a longer digit run', () => {
    // "9913812345678" 是 13 位：既不落在手机号的 11 位边界内（前后都挨着别的数字，
    // 被 (?<!\d)/(?!\d) 挡住），也不落在银行卡号的 16-19 位或身份证号的精确 18 位区间，
    // 三条规则都不应命中，整段文本原样保留。
    const result = redactText('订单号 9913812345678', defaultRedactionSettings());
    expect(result).toBe('订单号 9913812345678');
  });

  it('leaves ordinary text untouched', () => {
    const result = redactText('今天天气不错，适合出门散步。', defaultRedactionSettings());
    expect(result).toBe('今天天气不错，适合出门散步。');
  });

  it('returns the text unchanged when the master switch is off', () => {
    const settings: RedactionSettings = { enabled: false, rules: BUILTIN_REDACTION_RULES };
    expect(redactText('电话 13812345678', settings)).toBe('电话 13812345678');
  });

  it('skips a disabled rule', () => {
    const settings: RedactionSettings = {
      enabled: true,
      rules: BUILTIN_REDACTION_RULES.map((rule) => (rule.id === 'phone' ? { ...rule, enabled: false } : rule)),
    };
    expect(redactText('电话 13812345678', settings)).toBe('电话 13812345678');
  });

  it('silently skips an invalid custom pattern without throwing or blocking other rules', () => {
    const settings: RedactionSettings = {
      enabled: true,
      rules: [
        { id: 'broken', label: '坏规则', pattern: '(unclosed', enabled: true, builtin: false },
        ...BUILTIN_REDACTION_RULES,
      ],
    };
    expect(() => redactText('电话 13812345678', settings)).not.toThrow();
    expect(redactText('电话 13812345678', settings)).toBe('电话 [手机号已脱敏]');
  });

  it('returns empty text unchanged', () => {
    expect(redactText('', defaultRedactionSettings())).toBe('');
  });
});

describe('loadRedactionSettings / saveRedactionSettings', () => {
  function installStorage(initial: Record<string, unknown> = {}) {
    const data = { ...initial };
    const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items));
    (globalThis as any).browser = {
      storage: {
        local: {
          get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
          set,
        },
      },
    };
    return { data, set };
  }

  const originalBrowser = (globalThis as any).browser;
  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
  });

  it('writes through the default settings and returns them when nothing is stored', async () => {
    const { set } = installStorage();
    const loaded = await loadRedactionSettings();
    expect(loaded).toEqual(defaultRedactionSettings());
    expect(set).toHaveBeenCalledWith({ [REDACTION_STORAGE_KEY]: defaultRedactionSettings() });
  });

  it('returns a previously stored value without rewriting it', async () => {
    const stored: RedactionSettings = { enabled: false, rules: [] };
    const { set } = installStorage({ [REDACTION_STORAGE_KEY]: stored });
    const loaded = await loadRedactionSettings();
    expect(loaded).toEqual(stored);
    expect(set).not.toHaveBeenCalled();
  });

  it('falls back to defaults when the stored value is malformed', async () => {
    installStorage({ [REDACTION_STORAGE_KEY]: { enabled: 'yes' } });
    const loaded = await loadRedactionSettings();
    expect(loaded).toEqual(defaultRedactionSettings());
  });

  it('round-trips a save then a load', async () => {
    installStorage();
    const custom: RedactionSettings = {
      enabled: true,
      rules: [{ id: 'custom-1', label: '工号', pattern: 'EMP-\\d{4}', enabled: true, builtin: false }],
    };
    await saveRedactionSettings(custom);
    expect(await loadRedactionSettings()).toEqual(custom);
  });
});
