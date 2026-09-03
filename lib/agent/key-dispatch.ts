// browser_press_key 的按键规范化。纯函数，不碰 DOM。
//
// 只支持具名功能键，不支持任意字符：输入文本走 browser_type / browser_fill_form，
// 一次一个字符地按键既慢又绕过了写入验证。

export type PressableKey =
  | 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown';

export interface KeyModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface KeyDescriptor {
  key: PressableKey;
  code: string;
  /** 已废弃但仍被大量页面读取；缺了它这些页面会完全无反应。 */
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** 真实浏览器里只有 Enter 会在这批按键中产生 keypress。 */
  emitsKeypress: boolean;
}

const KEY_TABLE: Record<PressableKey, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

export const PRESSABLE_KEYS = Object.keys(KEY_TABLE) as PressableKey[];

export function resolveKeyDescriptor(
  key: unknown,
  modifiers: unknown,
): { ok: true; descriptor: KeyDescriptor } | { ok: false; error: string } {
  if (typeof key !== 'string' || !(key in KEY_TABLE)) {
    const shown = typeof key === 'string' ? `"${key}"` : String(key);
    const hint =
      typeof key === 'string' && key.length === 1
        ? '输入单个字符请用 browser_type 或 browser_fill_form，不要逐字符按键。'
        : '';
    return {
      ok: false,
      error: `不支持的按键 ${shown}。可用按键：${PRESSABLE_KEYS.join('、')}。${hint}`,
    };
  }

  const record = modifiers && typeof modifiers === 'object' ? (modifiers as Record<string, unknown>) : {};
  const entry = KEY_TABLE[key as PressableKey];
  return {
    ok: true,
    descriptor: {
      key: key as PressableKey,
      code: entry.code,
      keyCode: entry.keyCode,
      ctrlKey: record.ctrl === true,
      shiftKey: record.shift === true,
      altKey: record.alt === true,
      metaKey: record.meta === true,
      emitsKeypress: key === 'Enter',
    },
  };
}
