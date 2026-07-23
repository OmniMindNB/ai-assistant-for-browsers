import { describe, expect, it } from 'vitest';
import { isUserScriptsToggleBlocked } from './inject-script-blocked';

describe('isUserScriptsToggleBlocked', () => {
  it('detects the userScripts-disabled error from browser_inject_script', () => {
    const result = {
      content: [
        {
          type: 'text',
          text:
            '脚本注入失败：Cannot read properties of undefined (reading \'execute\')。请在 chrome://extensions ' +
            '打开本扩展详情页，开启「允许用户脚本」（Allow User Scripts）开关后重试。',
        },
      ],
      details: {},
    };
    expect(isUserScriptsToggleBlocked('browser_inject_script', result)).toBe(true);
  });

  it('ignores other browser_inject_script failures (e.g. empty script)', () => {
    const result = { content: [{ type: 'text', text: '脚本为空' }], details: {} };
    expect(isUserScriptsToggleBlocked('browser_inject_script', result)).toBe(false);
  });

  it('ignores failures from other tools even if the text happens to match', () => {
    const result = {
      content: [{ type: 'text', text: '开启「允许用户脚本」（Allow User Scripts）开关后重试。' }],
      details: {},
    };
    expect(isUserScriptsToggleBlocked('browser_set_style', result)).toBe(false);
  });

  it('handles non-JSON-serializable result without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => isUserScriptsToggleBlocked('browser_inject_script', circular)).not.toThrow();
    expect(isUserScriptsToggleBlocked('browser_inject_script', circular)).toBe(false);
  });
});
