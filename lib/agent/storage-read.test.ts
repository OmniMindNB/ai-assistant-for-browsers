import { describe, expect, it } from 'vitest';
import type { RawStorageArea } from './storage-read';
import {
  LIST_VALUE_MAX_CHARS,
  buildStorageView,
  isSensitiveStorageKey,
  looksLikeCredentialValue,
  renderStorageView,
} from './storage-read';

function area(entries: Record<string, string>, kind: 'local' | 'session' = 'local'): RawStorageArea {
  return { area: kind, entries: Object.entries(entries).map(([key, value]) => ({ key, value })) };
}

describe('isSensitiveStorageKey', () => {
  it('命中常见的凭证键名', () => {
    for (const key of [
      'access_token',
      'refreshToken',
      'jwt',
      'authToken',
      'sessionId',
      'apiKey',
      'client_secret',
      'password',
      'user-credential',
    ]) {
      expect(isSensitiveStorageKey(key), key).toBe(true);
    }
  });

  it('放过普通业务键名', () => {
    for (const key of ['theme', 'cart_count', 'user_profile', 'lastVisitedPage']) {
      expect(isSensitiveStorageKey(key), key).toBe(false);
    }
  });

  // 子串匹配会把 author/authorized 全部误判成 auth，导致大量普通键的值被无谓屏蔽。
  it('按分段匹配而非子串匹配', () => {
    expect(isSensitiveStorageKey('article_author')).toBe(false);
    expect(isSensitiveStorageKey('authorizedDealers')).toBe(false);
  });
});

describe('looksLikeCredentialValue', () => {
  // 不少站点把 token 存在 state、u 这类看不出用途的键名下，只看键名会漏。
  it('识别 JWT 形状的值', () => {
    expect(looksLikeCredentialValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.7HkQ-abc_123')).toBe(true);
  });

  it('不把普通 JSON 或短字符串当凭证', () => {
    expect(looksLikeCredentialValue('{"name":"张三","city":"北京"}')).toBe(false);
    expect(looksLikeCredentialValue('dark')).toBe(false);
    expect(looksLikeCredentialValue('a.b.c')).toBe(false);
  });
});

describe('buildStorageView 清单模式', () => {
  it('普通短值原样返回，并给出字符数', () => {
    const view = buildStorageView([area({ theme: 'dark' })], {});
    expect(view.areas[0].entries).toEqual([
      { key: 'theme', value: 'dark', bytes: 4, sensitive: false, truncated: false },
    ]);
  });

  it('长值截断到清单上限，bytes 仍是原长', () => {
    const long = 'x'.repeat(LIST_VALUE_MAX_CHARS + 50);
    const view = buildStorageView([area({ blob: long })], {});
    const entry = view.areas[0].entries[0];
    expect(entry.value).toHaveLength(LIST_VALUE_MAX_CHARS);
    expect(entry.truncated).toBe(true);
    expect(entry.bytes).toBe(long.length);
  });

  it('凭证键名列出但不给值', () => {
    const view = buildStorageView([area({ access_token: 'abcdef' })], {});
    expect(view.areas[0].entries[0]).toEqual({
      key: 'access_token',
      value: undefined,
      bytes: 6,
      sensitive: true,
      truncated: false,
    });
  });

  it('键名无害但值形似 JWT 时同样不给值', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.7HkQ-abc_123';
    const view = buildStorageView([area({ u: jwt })], {});
    expect(view.areas[0].entries[0].sensitive).toBe(true);
    expect(view.areas[0].entries[0].value).toBeUndefined();
  });

  it('总预算耗尽后的键只计数不渲染值', () => {
    const view = buildStorageView([area({ a: 'x'.repeat(60), b: 'y'.repeat(60), c: 'z' })], {
      maxChars: 100,
    });
    const [first, second] = view.areas[0].entries;
    expect(first.value).toBe('x'.repeat(60));
    expect(second.value).toBeUndefined();
    expect(view.areas[0].omitted).toBe(2);
  });

  // 敏感键没有渲染任何值，不该挤占别的键的预算。
  it('敏感键不消耗预算', () => {
    const view = buildStorageView(
      [area({ access_token: 'x'.repeat(500), theme: 'dark' })],
      { maxChars: 100 },
    );
    expect(view.areas[0].entries[1].value).toBe('dark');
    expect(view.areas[0].omitted).toBe(0);
  });

  it('透传某个存储区的读取错误', () => {
    const view = buildStorageView(
      [{ area: 'local', entries: [], error: 'SecurityError' }],
      {},
    );
    expect(view.areas[0].error).toBe('SecurityError');
  });
});

describe('buildStorageView 取值模式', () => {
  it('只返回指定键，且不受清单截断上限约束', () => {
    const long = 'x'.repeat(LIST_VALUE_MAX_CHARS + 50);
    const view = buildStorageView([area({ theme: 'dark', blob: long })], { key: 'blob' });
    expect(view.areas[0].entries).toHaveLength(1);
    expect(view.areas[0].entries[0].value).toBe(long);
    expect(view.areas[0].entries[0].truncated).toBe(false);
  });

  // 否则模型看完清单直接点名取值，屏蔽就形同虚设。
  it('点名取凭证键依然不给值', () => {
    const view = buildStorageView([area({ access_token: 'abcdef' })], { key: 'access_token' });
    expect(view.areas[0].entries[0].sensitive).toBe(true);
    expect(view.areas[0].entries[0].value).toBeUndefined();
  });

  it('键不存在时标记 notFound', () => {
    const view = buildStorageView([area({ theme: 'dark' })], { key: 'missing' });
    expect(view.notFound).toBe('missing');
    expect(view.areas[0].entries).toHaveLength(0);
  });

  it('取值模式仍然受总预算约束', () => {
    const view = buildStorageView([area({ blob: 'x'.repeat(500) })], { key: 'blob', maxChars: 100 });
    const entry = view.areas[0].entries[0];
    expect(entry.value).toHaveLength(100);
    expect(entry.truncated).toBe(true);
  });
});

describe('renderStorageView', () => {
  it('标注内容不可信', () => {
    const text = renderStorageView(buildStorageView([area({ theme: 'dark' })], {}));
    expect(text).toContain('untrusted page content');
  });

  it('敏感值渲染成占位符而不是原文', () => {
    const text = renderStorageView(buildStorageView([area({ access_token: 'abcdef' })], {}));
    expect(text).toContain('access_token = [sensitive, 6 chars]');
    expect(text).not.toContain('abcdef');
  });

  it('截断的值带省略标记', () => {
    const long = 'x'.repeat(LIST_VALUE_MAX_CHARS + 50);
    const text = renderStorageView(buildStorageView([area({ blob: long })], {}));
    expect(text).toContain(`… (truncated, ${long.length} chars total)`);
  });

  it('空存储区明确说明为空，而不是留一片空白', () => {
    const text = renderStorageView(buildStorageView([area({}, 'session')], {}));
    expect(text).toContain('sessionStorage: (empty)');
  });

  it('预算截断的键数量对模型可见', () => {
    const view = buildStorageView([area({ a: 'x'.repeat(60), b: 'y'.repeat(60) })], { maxChars: 100 });
    expect(renderStorageView(view)).toContain('1 more key omitted');
  });

  it('取值模式下键不存在时给出明确结论', () => {
    const text = renderStorageView(buildStorageView([area({ theme: 'dark' })], { key: 'missing' }));
    expect(text).toContain('"missing"');
    expect(text).toContain('not found');
  });
});
