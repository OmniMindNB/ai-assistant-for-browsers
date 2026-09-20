import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READ_MAX_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MIN_READ_MAX_CHARS,
  resolveReadMaxChars,
} from './context-budget';

describe('resolveReadMaxChars', () => {
  it('未指定时用默认读取量', () => {
    expect(resolveReadMaxChars(undefined)).toBe(DEFAULT_READ_MAX_CHARS);
  });

  it('非数字一律回落到默认读取量', () => {
    for (const raw of [null, '20000', NaN, {}, true]) {
      expect(resolveReadMaxChars(raw)).toBe(DEFAULT_READ_MAX_CHARS);
    }
  });

  it('合法区间内的值原样采纳', () => {
    expect(resolveReadMaxChars(20000)).toBe(20000);
  });

  // 会让这个用例失败的 production 改动：去掉下限。模型偶尔会填 10、100 这种值，
  // 读回来的正文根本不足以回答问题，反而要多花一轮重读。
  it('低于下限的值抬到下限', () => {
    expect(resolveReadMaxChars(10)).toBe(MIN_READ_MAX_CHARS);
  });

  // 这是本次重构的核心：工具侧的上限必须就是压缩层的硬上限。
  // 会让这个用例失败的 production 改动：工具侧只做 Math.max 不做 Math.min——
  // 那样模型填 60000 会先被工具切到 60000（不截断），再被 compactAgentMessages
  // 切到 30000，模型同时收到"正文已截断到 60000"和"工具结果已截断"两条互相矛盾的提示。
  it('超过单条工具结果硬上限的值夹到硬上限', () => {
    expect(resolveReadMaxChars(MAX_TOOL_RESULT_CHARS + 1)).toBe(MAX_TOOL_RESULT_CHARS);
    // 用相对硬上限推导的值而不是字面量，避免硬上限再涨一档时这条断言失去意义（评审 F11）。
    expect(resolveReadMaxChars(MAX_TOOL_RESULT_CHARS * 3)).toBe(MAX_TOOL_RESULT_CHARS);
  });

  it('小数向下取整，不把非整数字符数传给 slice', () => {
    expect(resolveReadMaxChars(12345.7)).toBe(12345);
  });
});

describe('读取预算常量之间的不变量', () => {
  // 默认值一旦越过硬上限，每一次不带参数的读取都会触发双重截断。
  it('默认读取量不超过单条工具结果硬上限', () => {
    expect(DEFAULT_READ_MAX_CHARS).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it('下限小于默认读取量', () => {
    expect(MIN_READ_MAX_CHARS).toBeLessThan(DEFAULT_READ_MAX_CHARS);
  });
});
