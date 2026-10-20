// 非流式的一次性补全请求：设置页"测试连接"与保存指令时的"整理通用做法"共用。
// URL 拼接、鉴权头、错误文案全部复用三条流式实现已有的规则，避免另起一份请求代码
// （ref: docs/superpowers/specs/2026-09-23-generalized-task-playbook-design.md §4.1）。
import { openAiCompletionsUrl } from './openai-stream';
import { openAiResponsesUrl } from './openai-responses-stream';
import { anthropicMessagesUrl, ANTHROPIC_VERSION } from './anthropic-stream';
import { describeHttpFailure, describeStreamError } from './stream-shared';
import { resolveProviderApi, type ProviderApi, type ProviderConfig } from '@/lib/settings';

export type CompletionTarget = Pick<ProviderConfig, 'baseURL' | 'apiKey' | 'model' | 'api'>;

export interface CompleteOnceRequest {
  system?: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export type CompleteOnceResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };

/** Responses API 要求 max_output_tokens ≥ 16；连通性探测传的 1 会被直接 400。 */
export const MIN_RESPONSES_OUTPUT_TOKENS = 16;

/**
 * 「HTTP 200 但响应体是一条错误」的识别。部分 OpenAI 兼容网关用这种方式回报配额耗尽、
 * 模型被下线等失败，只看 response.ok 的话，一次明确的失败会被当成成功。
 *
 * 判据刻意收紧成「对象里带真值 error」或 Anthropic 的 `type: 'error'`：正常的补全响应
 * （choices / content / output）绝不会命中——Responses 成功时 error 字段是 null——
 * 宁可漏判一种罕见形状，也不能把一次成功说成失败。
 */
function readBodyError(parsed: unknown, detail: string): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as { error?: unknown; type?: unknown };
  if (record.type !== 'error' && !record.error) return undefined;
  if (typeof record.error === 'string') return record.error;
  const message = (record.error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message : detail.trim();
}

function readReplyText(parsed: unknown, api: ProviderApi): string {
  if (!parsed || typeof parsed !== 'object') return '';
  if (api === 'anthropic-messages') {
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => {
        const item = block as { type?: unknown; text?: unknown };
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
      })
      .join('');
  }
  if (api === 'openai-responses') {
    // output 是条目数组：只有 message 条目里的 output_text 是正文，reasoning 等条目跳过。
    const output = (parsed as { output?: unknown }).output;
    if (!Array.isArray(output)) return '';
    return output
      .flatMap((item) => {
        const entry = item as { type?: unknown; content?: unknown };
        return entry?.type === 'message' && Array.isArray(entry.content) ? entry.content : [];
      })
      .map((part) => {
        const item = part as { type?: unknown; text?: unknown };
        return item?.type === 'output_text' && typeof item.text === 'string' ? item.text : '';
      })
      .join('');
  }
  const choices = (parsed as { choices?: unknown }).choices;
  const content = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content : undefined;
  return typeof content === 'string' ? content : '';
}

/**
 * 回复是否在写完前被截断：Chat Completions 看 choices[0].finish_reason，Responses 看
 * incomplete_details.reason，Anthropic 看顶层 stop_reason。调用方（比如整理通用做法）据此把
 * "解析不出 JSON"和"根本没写完"区分开；testProviderConnection 用极小的 token 上限探测连通性，
 * 回复必然截断，但它只看 ok，不看这个字段。
 */
function readTruncated(parsed: unknown, api: ProviderApi): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  if (api === 'anthropic-messages') {
    return (parsed as { stop_reason?: unknown }).stop_reason === 'max_tokens';
  }
  if (api === 'openai-responses') {
    const details = (parsed as { incomplete_details?: { reason?: unknown } | null }).incomplete_details;
    return details?.reason === 'max_output_tokens';
  }
  const choices = (parsed as { choices?: unknown }).choices;
  const finishReason = Array.isArray(choices) ? (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason : undefined;
  return finishReason === 'length';
}

function buildRequest(
  target: CompletionTarget,
  request: CompleteOnceRequest,
  api: ProviderApi,
): { url: string; body: unknown; headers: Record<string, string> } {
  const userMessage = { role: 'user', content: request.user };
  if (api === 'anthropic-messages') {
    return {
      url: anthropicMessagesUrl(target.baseURL),
      body: {
        model: target.model,
        max_tokens: request.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: [userMessage],
      },
      headers: { 'Content-Type': 'application/json', 'x-api-key': target.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` };
  if (api === 'openai-responses') {
    return {
      url: openAiResponsesUrl(target.baseURL),
      body: {
        model: target.model,
        max_output_tokens: Math.max(request.maxTokens, MIN_RESPONSES_OUTPUT_TOKENS),
        ...(request.system ? { instructions: request.system } : {}),
        input: [userMessage],
        store: false,
      },
      headers,
    };
  }
  return {
    url: openAiCompletionsUrl(target.baseURL),
    body: {
      model: target.model,
      max_tokens: request.maxTokens,
      stream: false,
      messages: request.system ? [{ role: 'system', content: request.system }, userMessage] : [userMessage],
    },
    headers,
  };
}

export async function completeOnce(target: CompletionTarget, request: CompleteOnceRequest): Promise<CompleteOnceResult> {
  const api = resolveProviderApi(target);
  const { url, body, headers } = buildRequest(target, request, api);

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
    return { ok: true, text: readReplyText(parsed, api), truncated: readTruncated(parsed, api) };
  } catch (error) {
    return { ok: false, error: describeStreamError(error, url, target.model) };
  }
}
