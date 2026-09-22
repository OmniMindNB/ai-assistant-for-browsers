// 轮次边界上的上下文取舍，全部集中在这里：把面板的 ChatMessage 历史翻译成模型看到的
// 消息，以及每轮现算一条的交接块。
//
// 为什么是独立模块而不是留在 run-registry.ts：① 那里是 I/O 编排，这里是纯函数，
// 而 `entrypoints/` 没有任何 vitest project 匹配，同 fill-form-request.ts /
// read-request.ts / lib/chat/messages.ts 的提取理由；② 轮次边界上做什么取舍只有这一处，
// 拆开会让这条不变量分居两地
// （ref: docs/superpowers/specs/2026-09-22-cross-turn-context-handoff-design.md §3）。
import type { AssistantMessage, Message as AgentLlmMessage } from '@earendil-works/pi-ai';
import type { ChatMessage } from '@/lib/chat/messages';

export function toAgentMessages(messages: ChatMessage[]): AgentLlmMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content, timestamp: message.createdAt };
    }
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
      api: 'openai-completions',
      provider: 'history',
      model: 'history',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: message.createdAt,
    } satisfies AssistantMessage;
  });
}
