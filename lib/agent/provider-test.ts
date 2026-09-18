// lib/agent/provider-test.ts
// Provider 设置页"测试连接"用的最小连通性探测：发一个 max_tokens:1、非流式的请求，
// 复用 openai-stream.ts/anthropic-stream.ts 已有的 URL 拼接规则和 stream-shared.ts 的
// 错误文案格式化，避免 Provider 保存后要等真正发消息才发现 baseURL/apiKey/model 填错了。
import { openAiCompletionsUrl } from './openai-stream';
import { anthropicMessagesUrl, ANTHROPIC_VERSION } from './anthropic-stream';
import { describeHttpFailure, describeStreamError } from './stream-shared';
import type { ProviderConfig } from '@/lib/settings';

export type ProviderTestResult = { ok: true } | { ok: false; error: string };

/**
 * 「HTTP 200 但响应体是一条错误」的识别。部分 OpenAI 兼容网关用这种方式回报配额耗尽、
 * 模型被下线等失败，只看 response.ok 的话，"✓ 连接成功"会盖在一条明确的失败之上。
 *
 * 判据刻意收紧成「对象里带真值 error」或 Anthropic 的 `type: 'error'`：正常的补全响应
 * （choices / content）绝不会命中，宁可漏判一种罕见形状，也不能把一次成功说成失败。
 */
function readBodyError(detail: string): string | undefined {
  if (!detail.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as { error?: unknown; type?: unknown };
  if (record.type !== 'error' && !record.error) return undefined;
  if (typeof record.error === 'string') return record.error;
  const message = (record.error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message : detail.trim();
}

export async function testProviderConnection(
  config: Pick<ProviderConfig, 'baseURL' | 'apiKey' | 'model' | 'api'>,
): Promise<ProviderTestResult> {
  const isAnthropic = config.api === 'anthropic-messages';
  const url = isAnthropic ? anthropicMessagesUrl(config.baseURL) : openAiCompletionsUrl(config.baseURL);
  const body = isAnthropic
    ? { model: config.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model: config.model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'ping' }] };
  const headers: Record<string, string> = isAnthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` };

  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const detail = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: describeHttpFailure(response.status, response.statusText, detail, url, config.model) };
    }
    const bodyError = readBodyError(detail);
    if (bodyError) {
      return {
        ok: false,
        error: `LLM 返回了 200，但响应体是一条错误：${bodyError}\n请求地址：${url}\n模型：${config.model}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeStreamError(error, url, config.model) };
  }
}
