import { describe, expect, it } from 'vitest';
import { DEFAULT_READ_MAX_CHARS, MAX_TOOL_RESULT_CHARS, MIN_READ_MAX_CHARS } from './context-budget';
import { resolveHtmlRequest, resolveResourceRequest } from './read-request';
import { parseImplementationInspectionParams } from './tools';

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

// browser_inspect_page_implementation 的卖点是"一次调用拿齐证据、省掉多轮往返"，但它的
// 各段预算缺省值合计 74000 字符（正文 2000 + HTML 12000 + 脚本 30000 + 样式表 30000），
// 远超单条工具结果硬上限——整份结果到了 compactAgentMessages 那里会被直接切掉尾部一截，
// 而且模型只会看到一条笼统的"工具结果已截断"，不知道少的是脚本还是样式表。
describe('aggregate 检查工具的分段预算', () => {
  it('缺省预算合计留在单条工具结果硬上限以内', () => {
    const budget = parseImplementationInspectionParams({});
    const total =
      budget.textMaxChars + budget.htmlMaxChars + budget.scriptMaxChars + budget.stylesheetMaxChars;

    expect(total).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  // 结果里除了这四段还有 meta、DOM 摘要、computed style 和 evidenceSummary，
  // 四段正文占满硬上限就等于把它们全挤掉了。
  it('缺省预算给结果里的其它段落留出余量', () => {
    const budget = parseImplementationInspectionParams({});
    const total =
      budget.textMaxChars + budget.htmlMaxChars + budget.scriptMaxChars + budget.stylesheetMaxChars;

    expect(total).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS * 0.8);
  });

  // 会让这个用例失败的 production 改动：某一段的上限比整条结果的硬上限还大（原本脚本和
  // 样式表各自可以填到 80000）。单段就撑爆整条结果，剩下几段一个字都进不来。
  it('任何单段的上限都不超过整条结果的硬上限', () => {
    const budget = parseImplementationInspectionParams({
      textMaxChars: 999999,
      htmlMaxChars: 999999,
      scriptMaxChars: 999999,
      stylesheetMaxChars: 999999,
    });

    for (const value of [
      budget.textMaxChars,
      budget.htmlMaxChars,
      budget.scriptMaxChars,
      budget.stylesheetMaxChars,
    ]) {
      expect(value).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    }
  });
});
