// OpenAI 兼容的流式对话客户端（ref: technical-plan.md §2.3、§5）。
// Phase 1：在侧边栏页面直接发起流式请求（扩展页面具备 host_permissions，可跨域）。

import type { ProviderConfig } from './settings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  temperature?: number;
}

/**
 * 以 SSE 流式方式调用 OpenAI 兼容的 /chat/completions，逐段产出文本增量。
 */
export async function* chatStream(
  provider: ProviderConfig,
  messages: ChatMessage[],
  options: ChatStreamOptions = {},
): AsyncGenerator<string, void, unknown> {
  const base = provider.baseURL.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: options.temperature ?? 0.7,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败 (${res.status} ${res.statusText})${detail ? `：${detail}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice('data:'.length).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta: string | undefined = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 忽略无法解析的心跳/分片
      }
    }
  }
}
