/**
 * background.ts 里几个只读工具（GET_HTML / GET_SCRIPTS / GET_STYLESHEETS）的参数归一层。
 *
 * 抽出来有两个理由，都和 fill-form-request.ts 当初被抽出来的理由一样：
 * 1. `entrypoints/**\/*.test.ts` 没有对应的 vitest project，逻辑留在 background.ts 就等于没有
 *    测试覆盖；
 * 2. GET_HTML 的截断发生在注入页面的函数里，而注入函数会被 executeScript 序列化、不能引用
 *    模块作用域的任何东西——它没法自己 import 上限常量，只能由调用方在注入前就把参数解析好
 *    传进去。于是"解析"必须独立于"注入"存在。
 *
 * 归一后这三个工具与 browser_read_page 共用同一组上限（context-budget.ts），不再各写一份
 * `Math.max(1000, input.maxChars ?? 12000)`。
 */

import { resolveReadMaxChars } from './context-budget';

export interface ResolvedHtmlRequest {
  selector: string;
  /** 已归一，注入函数可以直接用，不必再写 `?? 默认值`。 */
  maxChars: number;
}

export interface ResolvedResourceRequest {
  maxChars: number;
  includeInline: boolean;
  includeExternal: boolean;
}

/** 空选择器按"没给"处理：拿空串去 querySelectorAll 会直接抛 SyntaxError，整次读取失败。 */
export function resolveHtmlRequest(payload: { selector?: string; maxChars?: number } | undefined | null): ResolvedHtmlRequest {
  return {
    selector: payload?.selector || 'html',
    maxChars: resolveReadMaxChars(payload?.maxChars),
  };
}

export function resolveResourceRequest(
  payload: { maxChars?: number; includeInline?: boolean; includeExternal?: boolean } | undefined | null,
): ResolvedResourceRequest {
  return {
    maxChars: resolveReadMaxChars(payload?.maxChars),
    includeInline: payload?.includeInline ?? true,
    includeExternal: payload?.includeExternal ?? true,
  };
}
