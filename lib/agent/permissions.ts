import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { analyzeScript } from '@/lib/security';
import { resolveConfirmGate, type ConfirmFn, type ConfirmGateState } from './confirm-gate';

export type PermissionLevel = 'always_allow' | 'auto_allow' | 'confirm' | 'deny';

export interface PermissionDecision {
  level: PermissionLevel;
  reason?: string;
}

const READ_ONLY_TOOLS = new Set([
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
]);

const AUTO_ALLOW_TOOLS = new Set(['browser_revert_changes']);

const CONFIRM_TOOLS = new Set([
  'browser_inject_script',
  'browser_set_style',
  'browser_modify_dom',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_select',
  'browser_navigate',
  'browser_set_storage',
]);

const DENY_TOOLS = new Set(['browser_eval_raw']);

export function decideToolPermission(toolName: string, args: unknown): PermissionDecision {
  if (DENY_TOOLS.has(toolName)) {
    return { level: 'deny', reason: `工具 ${toolName} 被全局禁止。` };
  }

  if (toolName === 'browser_inject_script') {
    const code = extractStringArg(args, 'code');
    if (!code.trim()) return { level: 'deny', reason: '注入脚本为空。' };
    const report = analyzeScript(code);
    if (!report.valid) {
      return { level: 'deny', reason: `脚本语法错误：${report.syntaxError ?? '未知'}` };
    }
    const danger = report.issues.find((issue) => issue.level === 'danger');
    if (danger) return { level: 'deny', reason: danger.message };
  }

  if (toolName === 'browser_navigate') {
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

  if (READ_ONLY_TOOLS.has(toolName)) return { level: 'always_allow' };
  if (AUTO_ALLOW_TOOLS.has(toolName)) return { level: 'auto_allow' };
  if (CONFIRM_TOOLS.has(toolName)) {
    return { level: 'confirm', reason: `工具 ${toolName} 会修改页面或浏览器状态，需要用户确认。` };
  }

  return { level: 'deny', reason: `未知工具 ${toolName}，已按 Deny-First 策略阻止。` };
}

export interface PermissionGateOptions {
  gateState: ConfirmGateState;
  onConfirm?: ConfirmFn;
  signal?: AbortSignal;
}

export async function beforeToolCallPermissionGate(
  context: BeforeToolCallContext,
  options: PermissionGateOptions,
): Promise<BeforeToolCallResult | undefined> {
  const decision = decideToolPermission(context.toolCall.name, context.args);
  if (decision.level === 'always_allow' || decision.level === 'auto_allow') return undefined;
  if (decision.level === 'deny') {
    return { block: true, reason: decision.reason ?? '该操作已被安全策略阻止。' };
  }
  return resolveConfirmGate(
    options.gateState,
    context.toolCall.id,
    context.toolCall.name,
    context.args,
    decision.reason ?? '该操作会修改页面或浏览器状态，需要用户确认。',
    options.onConfirm,
    options.signal,
  );
}

function extractStringArg(args: unknown, key: string): string {
  if (!args || typeof args !== 'object' || !(key in args)) return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}
