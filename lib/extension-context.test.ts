import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isExtensionContextAlive,
  isExtensionContextInvalidatedError,
  runIgnoringOrphanContext,
} from './extension-context';

const alive = () => true;
const dead = () => false;

describe('isExtensionContextInvalidatedError', () => {
  it('recognizes the exact message Chrome throws after the extension is reloaded', () => {
    expect(
      isExtensionContextInvalidatedError(new Error('Extension context invalidated.'), alive),
    ).toBe(true);
  });

  it('recognizes the message when it is wrapped in a longer sentence', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error('Uncaught (in promise) Error: Extension context invalidated.'),
        alive,
      ),
    ).toBe(true);
  });

  it('recognizes a non-Error rejection carrying the same message', () => {
    expect(isExtensionContextInvalidatedError('Extension context invalidated.', alive)).toBe(true);
  });

  // 孤儿上下文的另一种形态：Chrome 把旧 chrome 对象上的 runtime 整个摘掉，WXT 在模块加载时
  // 缓存的 browser 引用于是变成 browser.runtime === undefined，报错是 TypeError 而不是
  // "Extension context invalidated"。文案里没有任何可匹配的特征，只能看上下文本身是否还活着。
  it('recognizes the TypeError thrown once chrome.runtime has been torn down', () => {
    expect(
      isExtensionContextInvalidatedError(
        new TypeError("Cannot read properties of undefined (reading 'sendMessage')"),
        dead,
      ),
    ).toBe(true);
  });

  it('does not mistake the missing-receiver error for an invalidated context', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error('Could not establish connection. Receiving end does not exist.'),
        alive,
      ),
    ).toBe(false);
  });

  it('does not match unrelated failures while the context is alive', () => {
    expect(isExtensionContextInvalidatedError(new Error('network error'), alive)).toBe(false);
    expect(
      isExtensionContextInvalidatedError(
        new TypeError("Cannot read properties of undefined (reading 'sendMessage')"),
        alive,
      ),
    ).toBe(false);
    expect(isExtensionContextInvalidatedError(undefined, alive)).toBe(false);
    expect(isExtensionContextInvalidatedError(null, alive)).toBe(false);
  });
});

describe('isExtensionContextAlive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is alive when chrome.runtime still carries an extension id', () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', { runtime: { id: 'abc' } });
    expect(isExtensionContextAlive()).toBe(true);
  });

  it('is alive when only the Firefox browser namespace carries an id', () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('browser', { runtime: { id: 'abc' } });
    expect(isExtensionContextAlive()).toBe(true);
  });

  it('is dead once runtime has been removed from the chrome object', () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', {});
    expect(isExtensionContextAlive()).toBe(false);
  });

  it('is dead when runtime remains but its id is gone', () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', { runtime: {} });
    expect(isExtensionContextAlive()).toBe(false);
  });

  it('treats a throwing accessor as dead instead of propagating', () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', {
      get runtime() {
        throw new Error('Extension context invalidated.');
      },
    });
    expect(isExtensionContextAlive()).toBe(false);
  });
});

describe('runIgnoringOrphanContext', () => {
  it('runs the body when the context is alive', () => {
    const body = vi.fn();
    runIgnoringOrphanContext(body, alive);
    expect(body).toHaveBeenCalledTimes(1);
  });

  // 内容脚本启动体里第一句就是 browser.runtime.onMessage.addListener，注入到已失效的上下文时
  // 它同步抛错；WXT 的入口是个没人 catch 的 async IIFE，于是原样变成 Uncaught (in promise)。
  it('swallows a synchronous invalidated-context throw so it cannot escape into WXT’s uncaught entry promise', () => {
    expect(() =>
      runIgnoringOrphanContext(() => {
        throw new Error('Extension context invalidated.');
      }, alive),
    ).not.toThrow();
  });

  it('swallows the TypeError from reading a torn-down browser.runtime at startup', () => {
    expect(() =>
      runIgnoringOrphanContext(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'onMessage')");
      }, dead),
    ).not.toThrow();
  });

  it('still lets a real startup bug propagate', () => {
    expect(() =>
      runIgnoringOrphanContext(() => {
        throw new TypeError('mountOverlay is not a function');
      }, alive),
    ).toThrow(TypeError);
  });
});
