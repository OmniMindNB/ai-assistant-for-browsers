import { describe, expect, it } from 'vitest';
import { DEFAULT_READ_MAX_CHARS, MAX_TOOL_RESULT_CHARS } from './context-budget';
import { describePageReadWindow, planPageReadWindow } from './page-read-window';

describe('planPageReadWindow', () => {
  it('不传参数时从头读，按默认上限切', () => {
    expect(planPageReadWindow(38641, undefined)).toEqual({
      offset: 0,
      end: DEFAULT_READ_MAX_CHARS,
      total: 38641,
      remaining: 38641 - DEFAULT_READ_MAX_CHARS,
      truncated: true,
      exhausted: false,
    });
  });

  it('正文短于上限时一次读完，不报截断', () => {
    expect(planPageReadWindow(800, undefined)).toMatchObject({
      offset: 0,
      end: 800,
      remaining: 0,
      truncated: false,
    });
  });

  // 这是这次修复的核心：24000 之后的正文此前完全读不到（ref: hello-agents 第四章 4.4.3 在 29155）
  it('offset 从指定位置开始切，而不是永远从 0 开始', () => {
    expect(planPageReadWindow(38641, { offset: 24000 })).toMatchObject({
      offset: 24000,
      end: 38641,
      remaining: 0,
      truncated: false,
    });
  });

  it('offset 与 maxChars 可以叠加，窗口是 [offset, offset+maxChars)', () => {
    expect(planPageReadWindow(38641, { offset: 10000, maxChars: 5000 })).toMatchObject({
      offset: 10000,
      end: 15000,
      remaining: 38641 - 15000,
      truncated: true,
    });
  });

  it('负数和小数 offset 归一到合法整数', () => {
    expect(planPageReadWindow(1000, { offset: -50 })).toMatchObject({ offset: 0 });
    expect(planPageReadWindow(1000, { offset: 12.7 })).toMatchObject({ offset: 12 });
  });

  it('offset 越界时窗口为空并标记 exhausted，而不是静默返回空正文', () => {
    expect(planPageReadWindow(1000, { offset: 5000 })).toMatchObject({
      offset: 1000,
      end: 1000,
      remaining: 0,
      exhausted: true,
    });
  });

  it('maxChars 仍然被夹在 context-budget 的区间内', () => {
    expect(planPageReadWindow(200000, { maxChars: 999999 })).toMatchObject({ end: MAX_TOOL_RESULT_CHARS });
    expect(planPageReadWindow(200000, { maxChars: 1 })).toMatchObject({ end: 1000 });
  });
});

describe('describePageReadWindow', () => {
  it('没截断时不产生任何提示', () => {
    expect(describePageReadWindow(planPageReadWindow(800, undefined))).toBe('');
  });

  // 之前只有一句被动的"正文已截断到 24000 字符"，模型无从判断该怎么办，
  // 实测直接放弃并谎称"页面没有可用内容"。提示必须是可执行的。
  it('整页能塞进单次上限时，直接告诉模型把 maxChars 调到多少能一次读完', () => {
    const note = describePageReadWindow(planPageReadWindow(38641, undefined));
    expect(note).toContain('还有 14641 字符未返回');
    expect(note).toContain('maxChars');
    expect(note).toContain('38641');
    expect(note).not.toContain('browser_find_text');
  });

  it('整页超过单次上限时，给出下一段的 offset 并提示可改用定位工具', () => {
    const note = describePageReadWindow(planPageReadWindow(120000, undefined));
    expect(note).toContain(`offset=${DEFAULT_READ_MAX_CHARS}`);
    expect(note).toContain('browser_find_text');
    // 分段读会触发上下文压缩把上一段压成一行摘要，不提醒模型就会读了后面丢前面
    expect(note).toContain('摘要');
  });

  it('offset 越界时明确说超出范围，避免模型把空正文读成"页面没有内容"', () => {
    const note = describePageReadWindow(planPageReadWindow(1000, { offset: 5000 }));
    expect(note).toContain('超出');
    expect(note).toContain('1000');
  });
});
