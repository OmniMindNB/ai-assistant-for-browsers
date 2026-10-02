import { describe, expect, it, vi } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import { DEFAULT_READ_MAX_CHARS } from './context-budget';
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_CODE_CHARS,
  MAX_SCRIPT_TIMEOUT_MS,
  MIN_SCRIPT_TIMEOUT_MS,
  SCRIPT_API_UNAVAILABLE_ERROR,
  SCRIPT_API_UNAVAILABLE_MARKER,
  formatScriptResult,
  parseRunScriptParams,
  runScript,
  scriptActivityHint,
  wrapScript,
  type RunScriptDeps,
} from './run-script';

const redaction = defaultRedactionSettings();

/** 在 node 里模拟 userScripts.execute：把包装后的代码当作脚本求值，取最后一个表达式的值。只在测试里这么做。 */
async function evaluateWrapped(code: string): Promise<unknown> {
  // eslint-disable-next-line no-new-func
  return new Function(`return ${code}`)();
}

describe('parseRunScriptParams', () => {
  it('clamps timeout and fills the default', () => {
    expect(parseRunScriptParams({ code: 'return 1', purpose: 'p' }).timeoutMs).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(parseRunScriptParams({ code: 'return 1', purpose: 'p', timeoutMs: 1 }).timeoutMs).toBe(MIN_SCRIPT_TIMEOUT_MS);
    expect(parseRunScriptParams({ code: 'return 1', purpose: 'p', timeoutMs: 1e9 }).timeoutMs).toBe(MAX_SCRIPT_TIMEOUT_MS);
  });

  it('rejects empty or oversized code and a missing purpose', () => {
    expect(() => parseRunScriptParams({ code: '  ', purpose: 'p' })).toThrow(/code/);
    expect(() => parseRunScriptParams({ code: 'x'.repeat(MAX_SCRIPT_CODE_CHARS + 1), purpose: 'p' })).toThrow(/20000|20,000/);
    expect(() => parseRunScriptParams({ code: 'return 1' })).toThrow(/purpose/);
  });

  it('clips purpose to its limit', () => {
    expect(parseRunScriptParams({ code: 'return 1', purpose: 'a'.repeat(500) }).purpose).toHaveLength(200);
  });
});

describe('wrapScript', () => {
  it('supports await and return', async () => {
    const out = await evaluateWrapped(wrapScript('const v = await Promise.resolve(2); return v * 3;'));
    expect(JSON.parse(out as string)).toEqual({ ok: true, value: 6 });
  });

  it('survives a trailing line comment', async () => {
    const out = await evaluateWrapped(wrapScript('return 1 // done'));
    expect(JSON.parse(out as string)).toEqual({ ok: true, value: 1 });
  });

  it('serializes cycles, undefined, functions and bigint', async () => {
    // Review Focus #2
    const out = await evaluateWrapped(
      wrapScript('const a = { n: 1n, f: function named() {}, u: undefined }; a.self = a; return a;'),
    );
    expect(JSON.parse(out as string)).toEqual({
      ok: true,
      value: { n: '1n', f: '[Function named]', self: '[Circular]' },
    });
    expect(JSON.parse((await evaluateWrapped(wrapScript('return undefined'))) as string)).toEqual({ ok: true, value: null });
  });

  it('turns a thrown error into ok:false instead of rejecting', async () => {
    const out = await evaluateWrapped(wrapScript('throw new Error("boom")'));
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('boom');
  });
});

function deps(overrides: Partial<RunScriptDeps> = {}): RunScriptDeps {
  return {
    ensureWorld: async () => true,
    execute: async (code) => [{ result: await evaluateWrapped(code) }],
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...overrides,
  };
}

describe('runScript', () => {
  it('returns the JSON of the value', async () => {
    expect(await runScript({ code: 'return [1, "a"]', timeoutMs: 1000 }, deps())).toEqual({ json: '[1,"a"]' });
  });

  it('fails with the unavailable error when the world cannot be configured', async () => {
    await expect(runScript({ code: 'return 1', timeoutMs: 1000 }, deps({ ensureWorld: async () => false })))
      .rejects.toThrow(SCRIPT_API_UNAVAILABLE_ERROR);
  });

  it('reports a syntax error carried on the injection result', async () => {
    // Review Focus #1
    await expect(runScript({ code: 'return (', timeoutMs: 1000 }, deps({ execute: async () => [{ error: 'SyntaxError: Unexpected end of input' }] })))
      .rejects.toThrow(/脚本语法错误.*Unexpected end of input/);
  });

  it('reports an exception thrown by the script', async () => {
    await expect(runScript({ code: 'throw new Error("boom")', timeoutMs: 1000 }, deps()))
      .rejects.toThrow(/脚本抛出异常.*boom/);
  });

  it('fails when execute returns nothing', async () => {
    await expect(runScript({ code: 'return 1', timeoutMs: 1000 }, deps({ execute: async () => [] })))
      .rejects.toThrow(/没有返回结果/);
  });

  it('times out once and swallows a late result', async () => {
    // Review Focus #5
    vi.useFakeTimers();
    let resolveLate: (v: { result: unknown }[]) => void = () => {};
    const pending = runScript(
      { code: 'return 1', timeoutMs: 200 },
      deps({ execute: () => new Promise((r) => { resolveLate = r; }) }),
    );
    const assertion = expect(pending).rejects.toThrow(/200ms 内没有结束/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    resolveLate([{ result: JSON.stringify({ ok: true, value: 1 }) }]);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('wraps an execute rejection as a generic failure', async () => {
    await expect(runScript({ code: 'return 1', timeoutMs: 1000 }, deps({ execute: async () => { throw new Error('No tab with id: 9'); } })))
      .rejects.toThrow(/脚本执行失败.*No tab with id: 9/);
  });
});

describe('formatScriptResult', () => {
  it('prefixes untrusted-content note', () => {
    const text = formatScriptResult('{"a":1}', redaction);
    expect(text).toContain('untrusted page content');
    expect(text).toContain('{"a":1}');
  });

  it('redacts before truncating so a phone across the cut never leaks half', () => {
    // Review Focus #3
    // 填充用带空格的串：连续上万个字母会让内置邮箱正则退化成平方级（redaction.ts 的既有问题）。
    const pad = 'x '.repeat(DEFAULT_READ_MAX_CHARS).slice(0, DEFAULT_READ_MAX_CHARS - 5);
    const text = formatScriptResult(JSON.stringify(`${pad}13812345678`), redaction);
    // 先截断再脱敏的话，截断点前会留下 "1381" 四位原文，脱敏正则认不出半截号码。
    expect(text).not.toContain('1381');
  });

  it('notes truncation', () => {
    const text = formatScriptResult(JSON.stringify('y '.repeat(DEFAULT_READ_MAX_CHARS)), redaction);
    expect(text).toMatch(/已截断/);
  });
});

describe('scriptActivityHint', () => {
  it('flags only the unavailable error of browser_run_script', () => {
    expect(scriptActivityHint('browser_run_script', `${SCRIPT_API_UNAVAILABLE_MARKER} x`)).toBe('enable_user_scripts');
    expect(scriptActivityHint('browser_run_script', '脚本抛出异常：boom')).toBeUndefined();
    expect(scriptActivityHint('browser_click', `${SCRIPT_API_UNAVAILABLE_MARKER} x`)).toBeUndefined();
    expect(scriptActivityHint('browser_run_script', undefined)).toBeUndefined();
  });
});
