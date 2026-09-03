import { describe, expect, it, vi } from 'vitest';
import { isExtensionContextInvalidatedError, runIgnoringOrphanContext } from './extension-context';

describe('isExtensionContextInvalidatedError', () => {
  it('recognizes the exact message Chrome throws after the extension is reloaded', () => {
    expect(isExtensionContextInvalidatedError(new Error('Extension context invalidated.'))).toBe(
      true,
    );
  });

  it('recognizes the message when it is wrapped in a longer sentence', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error('Uncaught (in promise) Error: Extension context invalidated.'),
      ),
    ).toBe(true);
  });

  it('recognizes a non-Error rejection carrying the same message', () => {
    expect(isExtensionContextInvalidatedError('Extension context invalidated.')).toBe(true);
  });

  it('does not mistake the missing-receiver error for an invalidated context', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error('Could not establish connection. Receiving end does not exist.'),
      ),
    ).toBe(false);
  });

  it('does not match unrelated failures', () => {
    expect(isExtensionContextInvalidatedError(new Error('network error'))).toBe(false);
    expect(isExtensionContextInvalidatedError(undefined)).toBe(false);
    expect(isExtensionContextInvalidatedError(null)).toBe(false);
  });
});

describe('runIgnoringOrphanContext', () => {
  it('runs the body when the context is alive', () => {
    const body = vi.fn();
    runIgnoringOrphanContext(body);
    expect(body).toHaveBeenCalledTimes(1);
  });

  // 内容脚本启动体里第一句就是 browser.runtime.onMessage.addListener，注入到已失效的上下文时
  // 它同步抛错；WXT 的入口是个没人 catch 的 async IIFE，于是原样变成 Uncaught (in promise)。
  it('swallows a synchronous invalidated-context throw so it cannot escape into WXT’s uncaught entry promise', () => {
    expect(() =>
      runIgnoringOrphanContext(() => {
        throw new Error('Extension context invalidated.');
      }),
    ).not.toThrow();
  });

  it('still lets a real startup bug propagate', () => {
    expect(() =>
      runIgnoringOrphanContext(() => {
        throw new TypeError('mountOverlay is not a function');
      }),
    ).toThrow(TypeError);
  });
});
