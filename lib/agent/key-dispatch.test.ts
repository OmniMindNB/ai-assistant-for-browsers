import { describe, expect, it } from 'vitest';
import { PRESSABLE_KEYS, resolveKeyDescriptor } from './key-dispatch';

describe('resolveKeyDescriptor', () => {
  it('Enter 映射出正确的 code 与 keyCode', () => {
    const resolved = resolveKeyDescriptor('Enter', undefined);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.descriptor.key).toBe('Enter');
      expect(resolved.descriptor.code).toBe('Enter');
      expect(resolved.descriptor.keyCode).toBe(13);
    }
  });

  // 仍有大量页面读已废弃的 keyCode，映射缺失会让这些页面完全无反应。
  it('每个白名单按键都有非零 keyCode 和非空 code', () => {
    for (const key of PRESSABLE_KEYS) {
      const resolved = resolveKeyDescriptor(key, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.descriptor.keyCode).toBeGreaterThan(0);
        expect(resolved.descriptor.code.length).toBeGreaterThan(0);
      }
    }
  });

  // 真实浏览器里这批按键中只有 Enter 产生 keypress，多派发反而与真实行为不符。
  it('只有 Enter 产生 keypress', () => {
    for (const key of PRESSABLE_KEYS) {
      const resolved = resolveKeyDescriptor(key, undefined);
      if (resolved.ok) expect(resolved.descriptor.emitsKeypress).toBe(key === 'Enter');
    }
  });

  it('修饰键写进描述符', () => {
    const resolved = resolveKeyDescriptor('Enter', { ctrl: true, shift: true });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.descriptor.ctrlKey).toBe(true);
      expect(resolved.descriptor.shiftKey).toBe(true);
      expect(resolved.descriptor.altKey).toBe(false);
      expect(resolved.descriptor.metaKey).toBe(false);
    }
  });

  it('拒绝白名单外的按键，并在错误里列出可用按键', () => {
    const resolved = resolveKeyDescriptor('F5', undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain('F5');
      expect(resolved.error).toContain('Enter');
    }
  });

  it('拒绝普通字符——输入文本该用 browser_type', () => {
    const resolved = resolveKeyDescriptor('a', undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('browser_type');
  });

  it('拒绝非字符串', () => {
    expect(resolveKeyDescriptor(13, undefined).ok).toBe(false);
    expect(resolveKeyDescriptor(undefined, undefined).ok).toBe(false);
  });
});
