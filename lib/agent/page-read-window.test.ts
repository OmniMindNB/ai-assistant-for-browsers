import { describe, expect, it } from 'vitest';
import { DEFAULT_READ_MAX_CHARS, MAX_TOOL_RESULT_CHARS } from './context-budget';
import { describePageReadWindow, planPageReadWindow } from './page-read-window';

describe('planPageReadWindow', () => {
  // 本任务的核心：整页塞得进单条结果上限时，不传 maxChars 就该一次读完。
  // 修复前这里切在 DEFAULT_READ_MAX_CHARS，用户问的小节落在窗口之外
  // （ref: hello-agents 第四章，正文 38291，4.4.3 在 29000 之后）。
  it('不传 maxChars 且整页塞得下时，一次读完整页', () => {
    expect(planPageReadWindow(38291, undefined)).toEqual({
      offset: 0,
      end: 38291,
      total: 38291,
      remaining: 0,
      truncated: false,
      exhausted: false,
    });
  });

  it('不传 maxChars 但整页超过上限时，仍回落到默认分段量', () => {
    const total = MAX_TOOL_RESULT_CHARS + 50000;
    expect(planPageReadWindow(total, undefined)).toMatchObject({
      offset: 0,
      end: DEFAULT_READ_MAX_CHARS,
      truncated: true,
    });
  });

  // 模型显式调小窗口是它的权利（可能在有意节省上下文），不能被整页规则覆盖。
  it('显式传入的小 maxChars 不会被放大成整页', () => {
    expect(planPageReadWindow(38291, { maxChars: 3000 })).toMatchObject({
      offset: 0,
      end: 3000,
      remaining: 38291 - 3000,
      truncated: true,
    });
  });

  it('整页规则同样从 offset 起算，不把窗口拉回 0', () => {
    expect(planPageReadWindow(38291, { offset: 10000 })).toMatchObject({
      offset: 10000,
      end: 38291,
      remaining: 0,
      truncated: false,
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
  // 改规则之后这条分支只可能由"模型自己把窗口调小"触发，文案必须相应改口径。
  // 这个变化本身就是验收信号：该提示从常规路径上的补救，退回成例外提醒。
  it('整页塞得下却仍被截断时，指出是调用方自己缩小了窗口', () => {
    const note = describePageReadWindow(planPageReadWindow(38291, { maxChars: 3000 }));
    expect(note).toContain('还有 35291 字符未返回');
    expect(note).toContain('maxChars');
    expect(note).not.toContain('browser_find_text');
  });

  it('不传 maxChars 且整页塞得下时不产生任何提示', () => {
    expect(describePageReadWindow(planPageReadWindow(38291, undefined))).toBe('');
  });

  it('整页超过单次上限时，给出下一段的 offset 并提示可改用定位工具', () => {
    const note = describePageReadWindow(planPageReadWindow(MAX_TOOL_RESULT_CHARS + 50000, undefined));
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
