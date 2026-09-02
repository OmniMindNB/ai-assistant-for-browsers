// lib/agent/provider-test.ts
// Provider 设置页"测试连接"用的最小连通性探测：发一个 max_tokens:1、非流式的请求，
// 复用 openai-stream.ts/anthropic-stream.ts 已有的 URL 拼接规则和 stream-shared.ts 的
// 错误文案格式化，避免 Provider 保存后要等真正发消息才发现 baseURL/apiKey/model 填错了。
import { openAiCompletionsUrl } from './openai-stream';
import { anthropicMessagesUrl, ANTHROPIC_VERSION } from './anthropic-stream';
import { describeHttpFailure, describeStreamError } from './stream-shared';
import type { ProviderConfig } from '@/lib/settings';

export type ProviderTestResult = { ok: true } | { ok: false; error: string };

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
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, error: describeHttpFailure(response.status, response.statusText, detail, url, config.model) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeStreamError(error, url, config.model) };
  }
}
