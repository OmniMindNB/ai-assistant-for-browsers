// 会话导出用的运行期诊断信息（ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §3）。
// 纯函数：run-registry.ts 只负责在事件里调用它们，本文件不碰 browser/storage。
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { resolveProviderApi, type ProviderConfig } from '@/lib/settings';
import { supportsVision } from './vision';

export const MAX_STEP_ERROR_CHARS = 300;

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
