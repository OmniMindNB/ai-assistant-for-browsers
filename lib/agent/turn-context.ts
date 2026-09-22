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
import { redactText, type RedactionSettings } from '@/lib/redaction';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

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

/** 足迹段最多列几步。再多是噪声——模型要的是"上轮走到哪了"，不是完整流水。 */
export const MAX_HANDOFF_STEPS = 8;
/** 句柄段最多列几个。超出的让模型自己调 browser_get_form 拿完整列表。 */
export const MAX_HANDOFF_HANDLES = 20;

export interface TurnHandoffInput {
  /** 历史里最后一条 assistant 消息，取它随轮次存档的 activitySteps。 */
  lastAssistant?: ChatMessage;
  /** 当前操作目标 tab 的句柄表（storage.session），可能来自别的页面。 */
  table?: FormFieldTable;
  /** 当前操作目标 tab 的真实地址；查不到即 undefined，此时不输出句柄段。 */
  targetUrl?: string;
  redaction: RedactionSettings;
}

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

/**
 * 每轮现算一条的交接块：上一轮做过什么 + 现在还有哪些句柄能直接用。
 *
 * 它不进 ChatMessage、不落 Dexie、不进 RunSnapshot——下一轮的历史里不会有这一条，
 * 所以不会逐轮累积。追加在历史末尾，不动供应商前缀缓存的稳定前缀。
 *
 * ⚠️ 整块必须过 redactText：句柄表存的是写入校验要用的原始 expect，从来没打算给模型看，
 * 而 browser_get_form 的模型可见渲染是脱敏过的（tools.ts）。少这一道，这里就是一条
 * 绕过脱敏的新路（ref: 设计稿 §2.3）。
 */
export function buildTurnHandoff(input: TurnHandoffInput): string | undefined {
  const sections: string[] = [];

  const steps = (input.lastAssistant?.activitySteps ?? []).filter(
    (step) => step.status === 'done' || step.status === 'failed',
  );
  if (steps.length > 0) {
    const shown = steps.slice(0, MAX_HANDOFF_STEPS);
    const lines = shown.map((step) => `- ${step.description}${step.status === 'failed' ? '（失败）' : ''}`);
    if (steps.length > shown.length) lines.push(`- 另有 ${steps.length - shown.length} 步未列出`);
    // 时效用措辞点明，而不是加一个没有依据的时间阈值（ref: 设计稿 §3.2）。
    sections.push(`本会话上一轮的执行足迹（可能已过时，页面当前状态以工具读取为准）：\n${lines.join('\n')}`);
  }

  const handles = renderHandleSection(input.table, input.targetUrl);
  if (handles) sections.push(handles);

  if (sections.length === 0) return undefined;
  return redactText(`[系统观察] ${sections.join('\n\n')}`, input.redaction);
}

function renderHandleSection(table: FormFieldTable | undefined, targetUrl: string | undefined): string | undefined {
  // 新鲜度不另造判断：FormFieldTable.url 就是写入时用来判"表已过期"的那道锁。
  if (!table || !targetUrl || table.url !== targetUrl) return undefined;

  // sensitive（密码/支付）永远不读回、不写入，也就不该被单独铺一条路送进上下文。
  const entries = Object.entries(table.fields).filter(([, handle]) => !handle.sensitive);
  if (entries.length === 0) return undefined;

  const shown = entries.slice(0, MAX_HANDOFF_HANDLES);
  const lines = shown.map(([fieldId, handle]) => `- ${fieldId}：${handleLabel(handle)}`);
  if (entries.length > shown.length) {
    lines.push(`- 另有 ${entries.length - shown.length} 个未列出，调用 browser_get_form 查看完整列表`);
  }
  return `上一轮在当前页面（${targetUrl}）发放的字段句柄仍然可用，可直接使用，不必重新读取：\n${lines.join('\n')}`;
}

function handleLabel(handle: FormFieldHandle): string {
  const expect = handle.expect;
  return expect.label || expect.text || expect.name || expect.tag;
}
