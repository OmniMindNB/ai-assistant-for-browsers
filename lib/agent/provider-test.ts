// lib/agent/provider-test.ts
// Provider 设置页"测试连接"用的最小连通性探测：发一个 max_tokens:1、非流式的请求，
// 避免 Provider 保存后要等真正发消息才发现 baseURL/apiKey/model 填错了。
// 请求与错误文案都在 one-shot-completion.ts，这里只把结果收窄成"通没通"。
import { completeOnce, type CompletionTarget } from './one-shot-completion';

export type ProviderTestResult = { ok: true } | { ok: false; error: string };

export async function testProviderConnection(config: CompletionTarget): Promise<ProviderTestResult> {
  const result = await completeOnce(config, { user: 'ping', maxTokens: 1 });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
