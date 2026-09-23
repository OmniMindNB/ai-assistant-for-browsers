// 非流式的一次性补全请求：设置页"测试连接"与保存指令时的"整理通用做法"共用。
// URL 拼接、鉴权头、错误文案全部复用两条流式实现已有的规则，避免第三份请求代码
// （ref: docs/superpowers/specs/2026-09-23-generalized-task-playbook-design.md §4.1）。
import { openAiCompletionsUrl } from './openai-stream';
import { anthropicMessagesUrl, ANTHROPIC_VERSION } from './anthropic-stream';
import { describeHttpFailure, describeStreamError } from './stream-shared';
import type { ProviderConfig } from '@/lib/settings';

export type CompletionTarget = Pick<ProviderConfig, 'baseURL' | 'apiKey' | 'model' | 'api'>;

export interface CompleteOnceRequest {
  system?: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export type CompleteOnceResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * 「HTTP 200 但响应体是一条错误」的识别。部分 OpenAI 兼容网关用这种方式回报配额耗尽、
 * 模型被下线等失败，只看 response.ok 的话，一次明确的失败会被当成成功。
 *
 * 判据刻意收紧成「对象里带真值 error」或 Anthropic 的 `type: 'error'`：正常的补全响应
 * （choices / content）绝不会命中，宁可漏判一种罕见形状，也不能把一次成功说成失败。
 */
function readBodyError(parsed: unknown, detail: string): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as { error?: unknown; type?: unknown };
  if (record.type !== 'error' && !record.error) return undefined;
  if (typeof record.error === 'string') return record.error;
  const message = (record.error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message : detail.trim();
}

function readReplyText(parsed: unknown, isAnthropic: boolean): string {
  if (!parsed || typeof parsed !== 'object') return '';
  if (isAnthropic) {
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => {
        const item = block as { type?: unknown; text?: unknown };
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
      })
      .join('');
  }
  const choices = (parsed as { choices?: unknown }).choices;
  const content = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content : undefined;
  return typeof content === 'string' ? content : '';
}

export async function completeOnce(target: CompletionTarget, request: CompleteOnceRequest): Promise<CompleteOnceResult> {
  const isAnthropic = target.api === 'anthropic-messages';
  const url = isAnthropic ? anthropicMessagesUrl(target.baseURL) : openAiCompletionsUrl(target.baseURL);
  const userMessage = { role: 'user', content: request.user };
  const body = isAnthropic
    ? {
        model: target.model,
        max_tokens: request.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: [userMessage],
      }
    : {
        model: target.model,
        max_tokens: request.maxTokens,
        stream: false,
        messages: request.system ? [{ role: 'system', content: request.system }, userMessage] : [userMessage],
      };
  const headers: Record<string, string> = isAnthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': target.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` };

  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal });
    const detail = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: describeHttpFailure(response.status, response.statusText, detail, url, target.model) };
    }
    let parsed: unknown;
    try {
      parsed = detail.trim() ? JSON.parse(detail) : undefined;
    } catch {
      parsed = undefined;
    }
    const bodyError = readBodyError(parsed, detail);
    if (bodyError) {
      return {
        ok: false,
        error: `LLM 返回了 200，但响应体是一条错误：${bodyError}\n请求地址：${url}\n模型：${target.model}`,
      };
    }
    return { ok: true, text: readReplyText(parsed, isAnthropic) };
  } catch (error) {
    return { ok: false, error: describeStreamError(error, url, target.model) };
  }
}
