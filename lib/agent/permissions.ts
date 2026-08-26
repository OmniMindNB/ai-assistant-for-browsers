import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { resolveConfirmGate, type ConfirmFn, type ConfirmGateState } from './confirm-gate';
import type { SubmitIntent } from './form-submit';

export type PermissionLevel = 'always_allow' | 'confirm' | 'confirm_always' | 'deny';

export interface PermissionDecision {
  level: PermissionLevel;
  reason?: string;
}

/**
 * 这几张表是工具分级的唯一来源：系统提示词（system-prompt.ts）列举写工具即从这里推导，
 * 避免新增工具时漏改。
 */
export const READ_ONLY_TOOL_NAMES = new Set([
  'browser_read_page',
  'browser_get_active_tab',
  'browser_query_dom',
  'browser_inspect_page_implementation',
  'browser_get_html',
  'browser_get_scripts',
  'browser_get_stylesheets',
  'browser_get_computed_style',
  'browser_get_page_meta',
  'browser_screenshot',
  'browser_get_form',
  'browser_switch_tab',
  'browser_list_tabs',
  // 不修改页面或浏览器状态——它本身就是"停下来问用户"，不需要写确认闸门再问一遍。
  'ask_user',
  // 同上：纯粹的计时等待，不碰页面或浏览器状态。
  'wait',
]);

export const CONFIRM_TOOL_NAMES = new Set([
  'browser_set_style',
  'browser_modify_dom',
  'browser_click',
  'browser_fill_form',
  'browser_type',
  'browser_scroll',
  'browser_select',
  'browser_navigate',
  'browser_set_storage',
  'browser_open_tab',
  'browser_close_tab',
]);

export const DENY_TOOL_NAMES = new Set(['browser_eval_raw']);

export function decideToolPermission(toolName: string, args: unknown): PermissionDecision {
  if (DENY_TOOL_NAMES.has(toolName)) {
    return { level: 'deny', reason: `工具 ${toolName} 被全局禁止。` };
  }

  if (toolName === 'browser_navigate' || toolName === 'browser_open_tab') {
    const url = extractStringArg(args, 'url');
    let isHttpUrl = false;
    try {
      isHttpUrl = /^https?:$/.test(new URL(url).protocol);
    } catch {
      isHttpUrl = false;
    }
    if (!isHttpUrl) {
      return { level: 'deny', reason: '仅允许跳转到 http/https 地址。' };
    }
  }

  // browser_click 的 fieldId 路径走存好的字段句柄表，不经过 CSS selector，天然不受此检查约束。
  if (toolName === 'browser_click' && !extractStringArg(args, 'fieldId')) {
    const selector = extractStringArg(args, 'selector');
    if (isRootContainerSelector(selector)) {
      return { level: 'deny', reason: 'selector 命中了页面根容器（html/body/#root 等），已阻止。' };
    }
  }

  if (toolName === 'browser_modify_dom') {
    const selector = extractStringArg(args, 'selector');
    if (isRootContainerSelector(selector)) {
      return { level: 'deny', reason: 'selector 命中了页面根容器（html/body/#root 等），已阻止。' };
    }
  }

  if (READ_ONLY_TOOL_NAMES.has(toolName)) return { level: 'always_allow' };
  if (CONFIRM_TOOL_NAMES.has(toolName)) {
    return { level: 'confirm', reason: `工具 ${toolName} 会修改页面或浏览器状态，需要用户确认。` };
  }

  return { level: 'deny', reason: `未知工具 ${toolName}，已按 Deny-First 策略阻止。` };
}

/** 探测返回的写意图：是否提交，外加确认卡片要用的字段 label（args 里只有 fieldId）。 */
export interface ToolWriteIntent extends SubmitIntent {
  fieldLabels?: { fieldId: string; label?: string }[];
}

export interface PermissionGateOptions {
  gateState: ConfirmGateState;
  onConfirm?: ConfirmFn;
  /**
   * 这次工具调用真正落地的目标 tab（多标签页编排下是 session.currentTabId，而不总是面板
   * 绑定的那个 tab）。confirm 缓存按这个值判断是否过期——目标 tab 变了就重新问一次
   * （ref: 最终审查 Important #2）。
   */
  targetTabId: number;
  signal?: AbortSignal;
  /**
   * 「这次点击会不会提交表单」必须看页面实况，而 decideToolPermission 是只看 args 的纯函数。
   * 因此把探测能力作为依赖注入进来：闸门在放行前发一次只读探测，测试里可以直接 stub。
   * 这次探测不计入 tool budget——它不是模型发起的工具调用。
   */
  resolveSubmitIntent?: (toolName: string, args: unknown) => Promise<ToolWriteIntent | undefined>;
}

const SUBMIT_CAPABLE_TOOLS = new Set(['browser_click', 'browser_fill_form']);

export async function beforeToolCallPermissionGate(
  context: BeforeToolCallContext,
  options: PermissionGateOptions,
): Promise<BeforeToolCallResult | undefined> {
  const toolName = context.toolCall.name;
  const decision = decideToolPermission(toolName, context.args);
  if (decision.level === 'always_allow') return undefined;
  if (decision.level === 'deny') {
    return { block: true, reason: decision.reason ?? '该操作已被安全策略阻止。' };
  }

  let always = false;
  let reason = decision.reason ?? '该操作会修改页面或浏览器状态，需要用户确认。';
  let confirmArgs = context.args;

  if (options.resolveSubmitIntent && SUBMIT_CAPABLE_TOOLS.has(toolName)) {
    const intent = await options.resolveSubmitIntent(toolName, context.args);
    if (intent?.isSubmit) {
      always = true;
      reason = intent.formAction
        ? `该操作会把表单提交到 ${intent.formAction}，需要单独确认。`
        : '该操作会提交表单，需要单独确认。';
    }
    const labels = intent?.fieldLabels;
    const record = (context.args ?? {}) as Record<string, unknown>;
    if (labels?.length && Array.isArray(record.fields)) {
      confirmArgs = {
        ...record,
        fields: (record.fields as Record<string, unknown>[]).map((field) => ({
          ...field,
          label: labels.find((entry) => entry.fieldId === field.fieldId)?.label,
        })),
        submit: intent?.isSubmit ? { ...(record.submit as object), formAction: intent?.formAction } : record.submit,
      };
    } else if (labels?.length && typeof record.fieldId === 'string') {
      confirmArgs = { ...record, label: labels.find((entry) => entry.fieldId === record.fieldId)?.label };
    }
  }

  return resolveConfirmGate(
    options.gateState,
    context.toolCall.id,
    toolName,
    confirmArgs,
    reason,
    options.onConfirm,
    options.targetTabId,
    options.signal,
    always,
  );
}

function extractStringArg(args: unknown, key: string): string {
  if (!args || typeof args !== 'object' || !(key in args)) return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

const ROOT_CONTAINER_SELECTORS = new Set(['html', 'body', ':root', '#root', '#app', '*']);

/**
 * selector 兜底路径理论上可以命中 html/body/#root 这类页面根容器（例如对 body 做 remove），
 * 一旦命中就是整页级破坏，值得在 selector 字符串层面直接拦截，不必等到页面里才发现。
 */
export function isRootContainerSelector(selector: string): boolean {
  if (!selector.trim()) return false;
  return selector
    .split(',')
    .some((branch) => ROOT_CONTAINER_SELECTORS.has(branch.trim().toLowerCase()));
}
