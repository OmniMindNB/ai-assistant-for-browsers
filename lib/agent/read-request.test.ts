import { describe, expect, it } from 'vitest';
import { DEFAULT_READ_MAX_CHARS, MAX_TOOL_RESULT_CHARS, MIN_READ_MAX_CHARS } from './context-budget';
import { resolveHtmlRequest, resolveResourceRequest } from './read-request';

describe('resolveHtmlRequest', () => {
  it('缺省选择器是 html', () => {
    expect(resolveHtmlRequest({}).selector).toBe('html');
  });

  // 页面侧原本写的是 `input?.selector || 'html'`：空串按"没给"处理，而不是拿空串去
  // querySelectorAll（那会直接抛 SyntaxError，整次读取失败）。
  it('空选择器回落到 html', () => {
    expect(resolveHtmlRequest({ selector: '' }).selector).toBe('html');
  });

  it('给了选择器就用给的', () => {
    expect(resolveHtmlRequest({ selector: 'body' }).selector).toBe('body');
  });

  it('payload 缺失时不抛，走全部缺省值', () => {
    expect(resolveHtmlRequest(undefined)).toEqual({ selector: 'html', maxChars: DEFAULT_READ_MAX_CHARS });
  });

  it('缺省 maxChars 与 browser_read_page 同源', () => {
    expect(resolveHtmlRequest({}).maxChars).toBe(DEFAULT_READ_MAX_CHARS);
  });

  // 与 browser_read_page 同一个理由：超过硬上限的部分必定被 compactAgentMessages 再切一刀，
  // 放行只会让模型同时收到两条互相矛盾的截断提示。
  it('maxChars 夹到单条工具结果硬上限', () => {
    expect(resolveHtmlRequest({ maxChars: MAX_TOOL_RESULT_CHARS * 3 }).maxChars).toBe(MAX_TOOL_RESULT_CHARS);
  });

  it('maxChars 低于下限时抬到下限', () => {
    expect(resolveHtmlRequest({ maxChars: 1 }).maxChars).toBe(MIN_READ_MAX_CHARS);
  });
});

describe('resolveResourceRequest', () => {
  it('内联与外部资源默认都读', () => {
    expect(resolveResourceRequest({})).toEqual({
      maxChars: DEFAULT_READ_MAX_CHARS,
      includeInline: true,
      includeExternal: true,
    });
  });

  it('显式关掉某一类时保留该选择', () => {
    expect(resolveResourceRequest({ includeInline: false })).toMatchObject({
      includeInline: false,
      includeExternal: true,
    });
    expect(resolveResourceRequest({ includeExternal: false })).toMatchObject({
      includeInline: true,
      includeExternal: false,
    });
  });

  it('payload 缺失时不抛，走全部缺省值', () => {
    expect(resolveResourceRequest(undefined).maxChars).toBe(DEFAULT_READ_MAX_CHARS);
  });

  // 脚本/样式表的 maxChars 是"这一次调用所有资源合计"的预算，整份结果同样是一条工具结果，
  // 所以天花板和 read_page/get_html 完全一致。
  it('maxChars 夹到单条工具结果硬上限', () => {
    expect(resolveResourceRequest({ maxChars: 999999 }).maxChars).toBe(MAX_TOOL_RESULT_CHARS);
  });

  it('maxChars 低于下限时抬到下限', () => {
    expect(resolveResourceRequest({ maxChars: 0 }).maxChars).toBe(MIN_READ_MAX_CHARS);
  });
});
