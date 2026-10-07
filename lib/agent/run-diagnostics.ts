// 会话导出用的运行期诊断信息（ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §3）。
// 纯函数：run-registry.ts 只负责在事件里调用它们，本文件不碰 browser/storage。
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { resolveProviderApi, type ProviderConfig } from '@/lib/settings';
import { WRITE_TOOL_NAMES } from './permissions';
import { supportsVision } from './vision';

export const MAX_STEP_ERROR_CHARS = 300;
/**
 * 成功步骤的结果摘要上限。比报错短：报错是排查的主线索，摘要只是「这一步拿到了什么」，
 * 而且它会随会话历史落进 IndexedDB——历史有意不存页面正文，所以只留一行。
 */
export const MAX_STEP_RESULT_CHARS = 160;
/** find_text 摘要里最多带几个可见命中的文字。 */
const MAX_SUMMARY_MATCHES = 3;
const MAX_SUMMARY_MATCH_TEXT = 24;

export interface RunDiagnostics {
  /** ProviderConfig.name；不含 apiKey。 */
  providerName: string;
  /** resolveProviderApi 的结果。 */
  api: string;
  /** baseURL 只保留 host（含端口）；解析失败记 ''。 */
  baseUrlHost: string;
  modelId: string;
  /** 决定了这一轮有没有 browser_screenshot。 */
  vision: boolean;
  withoutBrowserTools: boolean;
  readToolCallBudget: number;
  writeToolCallBudget: number;
  startedAt: number;
  durationMs: number;
  /** turn_start 事件计数。 */
  llmTurns: number;
  /** tool_execution_start 事件计数。 */
  toolCalls: number;
}

export interface RunDiagnosticsInput {
  provider: ProviderConfig;
  withoutBrowserTools: boolean;
  readToolCallBudget: number;
  writeToolCallBudget: number;
  startedAt: number;
  endedAt: number;
  llmTurns: number;
  toolCalls: number;
}

/**
 * 从 pi-agent-core 的错误结果（createErrorToolResult → { content: [{ type: 'text', text }] }）里取报错原文。
 * 先 redactText 再截断：先截断可能把敏感串切成两半，脱敏正则的 lookaround 就再也匹配不上。
 */
export function extractToolErrorText(result: unknown, redaction: RedactionSettings): string | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) return undefined;
  const redacted = redactText(text, redaction);
  return redacted.length > MAX_STEP_ERROR_CHARS ? `${redacted.slice(0, MAX_STEP_ERROR_CHARS)}…` : redacted;
}

function textParts(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function detailsOf(result: unknown): Record<string, unknown> | undefined {
  const details = (result as { details?: unknown } | null | undefined)?.details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined;
}

function clipChars(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 成功步骤的一行结果摘要，供会话导出排查（2026-10-07 开端口会话导出只有调用参数：等待是成功
 * 还是超时、find_text 命中了几个，事后一概无从知道）。
 *
 * 写工具和 browser_wait_for 的结果本身就是 action-result-text.ts 拼的一句话，取第一行；
 * find_text / get_form 的结果是 JSON 转储，第一行只是标题，改从 details 里数；其余读工具
 * 是大段正文或 DOM，没有值得留的一行，不给摘要。与 extractToolErrorText 同序：先脱敏再截断。
 */
export function summarizeToolResult(toolName: string, result: unknown, redaction: RedactionSettings): string | undefined {
  let summary: string | undefined;
  if (toolName === 'browser_find_text') {
    const matches = detailsOf(result)?.matches;
    if (Array.isArray(matches)) {
      const visible = matches.filter((match) => (match as { visible?: unknown })?.visible === true) as { fieldId?: string; text?: string }[];
      const listed = visible
        .slice(0, MAX_SUMMARY_MATCHES)
        .map((match) => `${match.fieldId ?? ''}「${clipChars(match.text ?? '', MAX_SUMMARY_MATCH_TEXT)}」`)
        .join('、');
      summary = matches.length === 0
        ? '命中 0 个'
        : `命中 ${matches.length} 个（可见 ${visible.length} 个）${listed ? `：${listed}` : ''}`;
    }
  } else if (toolName === 'browser_get_form') {
    const fields = detailsOf(result)?.fields;
    if (Array.isArray(fields)) {
      const visible = fields.filter((field) => (field as { visible?: unknown })?.visible === true).length;
      summary = `${fields.length} 个可交互元素（可见 ${visible} 个）`;
    }
  } else if (toolName === 'browser_wait_for' || WRITE_TOOL_NAMES.has(toolName)) {
    summary = textParts(result).split('\n')[0]?.trim() || undefined;
  }
  if (!summary) return undefined;
  return clipChars(redactText(summary, redaction), MAX_STEP_RESULT_CHARS);
}

/**
 * browser_wait_for 等到超时不抛错（超时不是模型能修正的参数错误，见 tools.ts），工具层面算
 * 成功——但面板和导出里画一个 ✓「已等待」会让人以为条件满足了。步骤状态单独按 met 判定。
 */
export function isUnmetWait(toolName: string, result: unknown): boolean {
  return toolName === 'browser_wait_for' && detailsOf(result)?.met === false;
}

export function baseUrlHost(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return '';
  }
}

export function buildRunDiagnostics(input: RunDiagnosticsInput): RunDiagnostics {
  return {
    providerName: input.provider.name,
    api: resolveProviderApi(input.provider),
    baseUrlHost: baseUrlHost(input.provider.baseURL),
    modelId: input.provider.model,
    vision: supportsVision(input.provider, input.provider.model),
    withoutBrowserTools: input.withoutBrowserTools,
    readToolCallBudget: input.readToolCallBudget,
    writeToolCallBudget: input.writeToolCallBudget,
    startedAt: input.startedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    llmTurns: input.llmTurns,
    toolCalls: input.toolCalls,
  };
}
