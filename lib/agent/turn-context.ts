// 轮次边界上的上下文取舍，全部集中在这里：把面板的 ChatMessage 历史翻译成模型看到的
// 消息，以及每轮现算一条的交接块。
//
// 为什么是独立模块而不是留在 run-registry.ts：① 那里是 I/O 编排，这里是纯函数，
// 而 `entrypoints/` 没有任何 vitest project 匹配，同 fill-form-request.ts /
// read-request.ts / lib/chat/messages.ts 的提取理由；② 轮次边界上做什么取舍只有这一处，
// 拆开会让这条不变量分居两地
// （ref: docs/superpowers/specs/2026-09-22-cross-turn-context-handoff-design.md §3）。
import type { AssistantMessage, Message as AgentLlmMessage, UserMessage } from '@earendil-works/pi-ai';
import type { ChatMessage } from '@/lib/chat/messages';
import type { ImageAttachment } from '@/lib/chat/attachments';
import { toImageContent } from '@/lib/chat/attachments';

/**
 * 跨轮回放图片的字节上限。
 *
 * 单张附件上限 5MB、每条最多 5 张，"整条消息的图全回放"最坏是 25MB 的请求体——这个体积
 * 今天在第一轮就可能发生，回放不抬高峰值，但会让它常驻于其后每一轮。
 *
 * ⚠️ 口径是**解码后字节**（与 MAX_ATTACHMENT_IMAGE_BYTES 同口径），请求体里的 base64
 * 约为其 4/3。它与 context-budget.ts 的 IMAGE_CHAR_EQUIVALENT 是两套量表：那个量的是
 * "折算成 token 有多贵"，这个量的是"请求体有多大"。不得互相换算或替代。
 */
export const MAX_REPLAYED_IMAGE_BYTES = 4 * 1024 * 1024;

function imageAttachmentsOf(message: ChatMessage): ImageAttachment[] {
  return (message.attachments ?? []).filter(
    (attachment): attachment is ImageAttachment => attachment.kind === 'image',
  );
}

/** 最新一条带图 user 消息的下标；没有则 -1。 */
function findReplayIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && imageAttachmentsOf(message).length > 0) return index;
  }
  return -1;
}

function toUserMessage(message: ChatMessage, replay: boolean): UserMessage {
  const images = imageAttachmentsOf(message);
  if (images.length === 0) {
    return { role: 'user', content: message.content, timestamp: message.createdAt };
  }

  const kept: ImageAttachment[] = [];
  const dropped: ImageAttachment[] = [];
  let bytes = 0;
  for (const image of images) {
    // 第一张无条件保留，哪怕它自己就超预算（同 recutStartForCharBudget 的末条保留）。
    const fits = kept.length === 0 || bytes + image.size <= MAX_REPLAYED_IMAGE_BYTES;
    if (replay && fits) {
      bytes += image.size;
      kept.push(image);
    } else {
      dropped.push(image);
    }
  }

  // 占位文案刻意不照抄 agent.ts 的"请再次截图"：用户附件重截不了，唯一的出路是请用户重发。
  const text = [message.content, ...dropped.map((image) => `[图片 ${image.name} 已移出上下文，如需要请用户重新发送]`)]
    .filter((line) => line.length > 0)
    .join('\n');

  if (kept.length === 0) return { role: 'user', content: text, timestamp: message.createdAt };
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...kept.map(toImageContent)],
    timestamp: message.createdAt,
  };
}

export function toAgentMessages(messages: ChatMessage[]): AgentLlmMessage[] {
  const replayIndex = findReplayIndex(messages);
  return messages.map((message, index) => {
    if (message.role === 'user') return toUserMessage(message, index === replayIndex);
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
