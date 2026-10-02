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
  MAX_SCRIPT_ERROR_CHARS,
  formatScriptError,
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
    invalidateWorld: () => {},
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
      .rejects.toThrow(/脚本执行出错（可能是语法错误）.*Unexpected end of input/);
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

describe('review fixes', () => {
  // I-1：序列化器自己抛错时也必须落进 {ok:false} 信封，不能变成被拒的 Promise。
  it.each([
    ['a throwing getter', 'return { get x() { throw new Error("getter"); } }'],
    ['a throwing toJSON', 'return { toJSON() { throw new Error("tojson"); } }'],
    ['a thrown null-prototype object', 'throw Object.create(null)'],
  ])('keeps %s inside the error envelope', async (_label, code) => {
    const out = await evaluateWrapped(wrapScript(code));
    expect(typeof out).toBe('string');
    expect(JSON.parse(out as string).ok).toBe(false);
  });

  it('does not call every injection error a syntax error', async () => {
    await expect(runScript({ code: 'return 1', timeoutMs: 1000 }, deps({ execute: async () => [{ error: 'Error: getter' }] })))
      .rejects.toThrow(/^脚本执行出错（可能是语法错误）：Error: getter/);
  });

  // I-3：开关在用过之后被关掉——execute 抛错时要重新探测，探测失败就报"未启用"而不是泛泛的失败。
  it('re-probes the world when execute throws and reports unavailable', async () => {
    const invalidateWorld = vi.fn();
    let available = true;
    const err = runScript(
      { code: 'return 1', timeoutMs: 1000 },
      deps({
        ensureWorld: async () => available,
        invalidateWorld: () => { invalidateWorld(); available = false; },
        execute: async () => { throw new Error('userScripts is disabled'); },
      }),
    );
    await expect(err).rejects.toThrow(SCRIPT_API_UNAVAILABLE_ERROR);
    expect(invalidateWorld).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic failure when the world is still available', async () => {
    await expect(runScript({ code: 'return 1', timeoutMs: 1000 }, deps({ invalidateWorld: () => {}, execute: async () => { throw new Error('No tab with id: 9'); } })))
      .rejects.toThrow(/脚本执行失败.*No tab with id: 9/);
  });
});

describe('formatScriptError', () => {
  // I-2：脚本异常文本同样是页面数据，进模型前要脱敏、截断、标为不可信。
  it('redacts, clips and labels the error text', () => {
    const text = formatScriptError(`脚本抛出异常：Error: 13812345678 ${'e '.repeat(5000)}`, redaction);
    expect(text).not.toContain('13812345678');
    expect(text).toContain('untrusted page content');
    expect(text.length).toBeLessThan(MAX_SCRIPT_ERROR_CHARS + 300);
  });

  it('keeps the unavailable marker intact so the panel hint still fires', () => {
    expect(formatScriptError(SCRIPT_API_UNAVAILABLE_ERROR, redaction)).toContain(SCRIPT_API_UNAVAILABLE_MARKER);
  });
});

describe('formatScriptResult on huge input', () => {
  // M-2（升为 Important）：只脱敏会留下的那一段，不能对整份超长返回值跑脱敏正则。
  it('only redacts what survives truncation', () => {
    const json = JSON.stringify(`${'a '.repeat(DEFAULT_READ_MAX_CHARS)}${'z'.repeat(60_000)}`);
    const started = Date.now();
    formatScriptResult(json, redaction);
    expect(Date.now() - started).toBeLessThan(1500);
  }, 120_000);
});
