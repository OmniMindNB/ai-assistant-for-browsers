# 跨轮上下文交接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让图片附件和上一轮的 fieldId 句柄能跨过轮次边界，消除"贴图后追问看不到图"和"接着操作必须重读一遍"两处失效。

**Architecture:** 新建 `lib/agent/turn-context.ts` 收拢"把面板历史翻译成模型上下文"这一件事：`toAgentMessages` 从 `run-registry.ts` 迁入（顺带变成可测），新增纯函数 `buildTurnHandoff` 产出每轮现算、不落库的 `[系统观察]` 交接块。I/O（查 tab URL、读句柄表、读脱敏设置）留在 `run-registry.ts` 的 `startRun` 里，由调用方用例覆盖。

**Tech Stack:** TypeScript、WXT（MV3）、vitest（`unit` project，node 环境）、`@earendil-works/pi-ai` 的 `Message` 类型。

**Spec:** `docs/superpowers/specs/2026-09-22-cross-turn-context-handoff-design.md`

## Global Constraints

- **交接块整块必须过 `redactText`。** 句柄表存的是未脱敏的原始 label，直接拼进上下文等于新开一条绕过 `browser_get_form` 既有脱敏的路（spec §2.3）。对应用例不得删改。
- **`sensitive` 句柄一律不列入**交接块（密码/支付字段本就永不读回、永不写入，Spec-0005）。
- **常量口径不得混用**：`MAX_REPLAYED_IMAGE_BYTES` 量的是解码后字节（与 `MAX_ATTACHMENT_IMAGE_BYTES` 同口径，请求体 base64 约为其 4/3）；`context-budget.ts` 的 `IMAGE_CHAR_EQUIVALENT` 量的是 token 折算当量。两套量表，注释里必须写明，不得互相换算或替代。
- **交接块不落库**：不进 `ChatMessage`、不进 Dexie、不进 `RunSnapshot`。
- **不改** Dexie schema、`lib/messaging.ts`、`run-port-protocol.ts`、面板 UI、manifest 权限。
- 注释与提交信息用中文（仓库既有惯例）。提交直接落在 `main`，不开分支。
- 每个 task 结束前 `pnpm compile` 必须通过。

## 文件结构

| 文件 | 职责 |
|---|---|
| `lib/agent/turn-context.ts` | **新建。** 轮次边界上的全部取舍：历史翻译（含图片回放）+ 交接块生成。纯函数，无 I/O。 |
| `lib/agent/turn-context.test.ts` | **新建。** 上面那个模块的全部用例。 |
| `lib/agent/run-registry.ts` | 删去私有 `toAgentMessages`，改为 import；`startRun` 里采集交接块所需的三份 I/O 并追加消息。 |
| `lib/agent/run-registry.test.ts` | 补调用方用例（`withoutBrowserTools` 跳过、空交接块不追加、URL 查不到时降级）。 |
| `lib/agent/agent.test.ts` | 既有窗口切割 describe 里补一条变体（奇偶断点落在历史末尾）。 |
| `CLAUDE.md` | "Agent runs in the background" 一节补 `turn-context.ts` 条目。 |

---

### Task 1: 把 `toAgentMessages` 迁进 `turn-context.ts`（行为零变化）

**Files:**
- Create: `lib/agent/turn-context.ts`
- Create: `lib/agent/turn-context.test.ts`
- Modify: `lib/agent/run-registry.ts:168-184`（删除私有函数）、import 区

**Interfaces:**
- Consumes: 无
- Produces: `toAgentMessages(messages: ChatMessage[]): AgentLlmMessage[]`（`AgentLlmMessage` 即 `@earendil-works/pi-ai` 的 `Message`）

本 task 只搬家，不改任何行为。先立回归保护，后两个 task 才动语义。

- [ ] **Step 1: 写失败的回归测试**

创建 `lib/agent/turn-context.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat/messages';
import { toAgentMessages } from './turn-context';

function userMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'u1', role: 'user', content: '你好', createdAt: 1000, ...over };
}

function assistantMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '好的', createdAt: 2000, ...over };
}

describe('toAgentMessages', () => {
  // 迁移回归保护：纯文本历史的翻译结果必须与迁移前逐字段一致。
  it('纯文本历史原样翻译', () => {
    const result = toAgentMessages([userMsg(), assistantMsg()]);

    expect(result[0]).toEqual({ role: 'user', content: '你好', timestamp: 1000 });
    expect(result[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
      api: 'openai-completions',
      provider: 'history',
      model: 'history',
      stopReason: 'stop',
      timestamp: 2000,
    });
  });

  it('空文本的 assistant 消息翻译成空 content 数组', () => {
    expect(toAgentMessages([assistantMsg({ content: '' })])[0]).toMatchObject({ content: [] });
  });
});
```

- [ ] **Step 2: 跑一次确认它失败**

Run: `pnpm vitest run lib/agent/turn-context.test.ts`
Expected: FAIL —— `Failed to resolve import "./turn-context"`

- [ ] **Step 3: 创建 `lib/agent/turn-context.ts`，把函数原样搬过来**

```ts
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
```

- [ ] **Step 4: 从 `run-registry.ts` 删掉旧的私有实现，改为 import**

删除 `lib/agent/run-registry.ts:168-184` 整个 `function toAgentMessages(...)`，并在 import 区（`import { createBrowserAgent } from './agent';` 之后）加：

```ts
import { toAgentMessages } from './turn-context';
```

`AssistantMessage` / `AgentLlmMessage` 若在 `run-registry.ts` 里已无别的用处，一并从 `@earendil-works/pi-ai` 的 type import 里删掉。删完跑 `pnpm compile`，它会直接指出哪些还在用。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm vitest run lib/agent/turn-context.test.ts lib/agent/run-registry.test.ts && pnpm compile`
Expected: 全部 PASS，`tsc --noEmit` 无输出

- [ ] **Step 6: 提交**

```bash
git add lib/agent/turn-context.ts lib/agent/turn-context.test.ts lib/agent/run-registry.ts
git commit -m "$(cat <<'MSG'
refactor(agent): toAgentMessages 迁入 turn-context.ts

原本是 run-registry.ts 的私有函数，测不到——entrypoints 没有任何
vitest project 匹配，可测的纯逻辑必须落在 lib/ 里。

行为零变化，先立回归保护，跨轮图片与交接块在后续提交里加。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: 图片跨轮回放（spec §3.1）

**Files:**
- Modify: `lib/agent/turn-context.ts`
- Modify: `lib/agent/turn-context.test.ts`

**Interfaces:**
- Consumes: `toAgentMessages`（Task 1）、`toImageContent(attachment: ImageAttachment): ImageContent`（`@/lib/chat/attachments:139`，现成）
- Produces: `MAX_REPLAYED_IMAGE_BYTES: number`

规则：从后往前找**第一条带 image 附件的 user 消息**，它的图片进上下文；更早的降级成一行占位。同一条消息里的图整体保留（按消息划界，不按张数），再叠一道字节兜底。

- [ ] **Step 1: 写失败的测试**

`lib/agent/turn-context.test.ts` 顶部补 import 与 fixture：

```ts
import type { ImageAttachment } from '@/lib/chat/attachments';
import { MAX_REPLAYED_IMAGE_BYTES, toAgentMessages } from './turn-context';

function imageAttachment(over: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: 'i1',
    name: 'a.png',
    mimeType: 'image/png',
    size: 1024,
    kind: 'image',
    dataUrl: 'data:image/png;base64,AAAA',
    ...over,
  };
}

function partsOf(message: unknown): Array<{ type: string; text?: string }> {
  const content = (message as { content: unknown }).content;
  if (!Array.isArray(content)) throw new Error('期望 content 是数组，实际是字符串');
  return content as Array<{ type: string; text?: string }>;
}
```

再追加 describe：

```ts
describe('toAgentMessages：图片跨轮回放', () => {
  it('只有最新那条带图消息保留图片，更早的降级成占位', () => {
    const result = toAgentMessages([
      userMsg({ id: 'u1', content: '看这张', createdAt: 1, attachments: [imageAttachment({ name: 'old.png' })] }),
      assistantMsg({ id: 'a1', createdAt: 2 }),
      userMsg({ id: 'u2', content: '再看这张', createdAt: 3, attachments: [imageAttachment({ name: 'new.png' })] }),
    ]);

    expect(result[0].content).toBe('看这张\n[图片 old.png 已移出上下文，如需要请用户重新发送]');
    expect(partsOf(result[2])).toEqual([
      { type: 'text', text: '再看这张' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  // 按消息划界而不是按张数：用户记得的是"我刚贴的那条消息"。
  it('同一条消息里的多张图整体保留', () => {
    const result = toAgentMessages([
      userMsg({ attachments: [imageAttachment({ id: 'i1' }), imageAttachment({ id: 'i2' })] }),
    ]);

    expect(partsOf(result[0]).filter((part) => part.type === 'image')).toHaveLength(2);
  });

  it('累计字节超过上限后，后续的图降级成占位', () => {
    const result = toAgentMessages([
      userMsg({
        content: '两张',
        attachments: [
          imageAttachment({ id: 'i1', name: 'big.png', size: MAX_REPLAYED_IMAGE_BYTES - 1 }),
          imageAttachment({ id: 'i2', name: 'second.png', size: 2 }),
        ],
      }),
    ]);

    const parts = partsOf(result[0]);
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(1);
    expect(parts[0].text).toBe('两张\n[图片 second.png 已移出上下文，如需要请用户重新发送]');
  });

  // 与 recutStartForCharBudget "末尾那条无条件保留" 同构：一条只剩占位符的图片消息，
  // 比一条超预算的请求更没用。
  it('第一张自身就超预算时仍然保留', () => {
    const result = toAgentMessages([
      userMsg({ attachments: [imageAttachment({ name: 'huge.png', size: MAX_REPLAYED_IMAGE_BYTES * 3 })] }),
    ]);

    expect(partsOf(result[0]).filter((part) => part.type === 'image')).toHaveLength(1);
  });

  it('非图片附件不影响翻译结果', () => {
    const result = toAgentMessages([
      userMsg({
        attachments: [
          { id: 't1', name: 'a.txt', mimeType: 'text/plain', size: 10, kind: 'text', textContent: 'x', truncated: false },
        ],
      }),
    ]);

    expect(result[0].content).toBe('你好');
  });
});
```

- [ ] **Step 2: 跑一次确认它失败**

Run: `pnpm vitest run lib/agent/turn-context.test.ts`
Expected: FAIL —— `MAX_REPLAYED_IMAGE_BYTES` 未导出；断言 `期望 content 是数组`

- [ ] **Step 3: 实现**

`lib/agent/turn-context.ts` 补 import、常量与两个辅助函数：

```ts
import type { ImageAttachment } from '@/lib/chat/attachments';
import { toImageContent } from '@/lib/chat/attachments';
import type { UserMessage } from '@earendil-works/pi-ai';

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
```

`toAgentMessages` 改成：

```ts
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
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm vitest run lib/agent/turn-context.test.ts && pnpm compile`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add lib/agent/turn-context.ts lib/agent/turn-context.test.ts
git commit -m "$(cat <<'MSG'
feat(agent): 最新一条消息的图片跨轮保留

此前 toAgentMessages 对 user 消息只取 content 字符串，贴图之后的
追问模型手里已经没有那张图。图片数据本来就在（ImageAttachment 带
完整 dataUrl，且已随 ChatMessageRecord 落进 IndexedDB），缺的只是
一个分支。

按消息而不是按张数划界：同一条消息的图要么都在要么都不在。再叠一道
MAX_REPLAYED_IMAGE_BYTES 兜底，避免 25MB 的请求体常驻于其后每一轮；
第一张无条件保留。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: `buildTurnHandoff` 纯函数（spec §3.2）

**Files:**
- Modify: `lib/agent/turn-context.ts`
- Modify: `lib/agent/turn-context.test.ts`

**Interfaces:**
- Consumes: `FormFieldTable` / `FormFieldHandle`（`./tab-form-fields`）、`redactText` + `RedactionSettings`（`@/lib/redaction`）、`ChatMessage.activitySteps`
- Produces:
  - `buildTurnHandoff(input: TurnHandoffInput): string | undefined`
  - `interface TurnHandoffInput { lastAssistant?: ChatMessage; table?: FormFieldTable; targetUrl?: string; redaction: RedactionSettings }`
  - `MAX_HANDOFF_STEPS: number`、`MAX_HANDOFF_HANDLES: number`

- [ ] **Step 1: 写失败的测试**

`lib/agent/turn-context.test.ts` 补 import 与 fixture：

```ts
import { defaultRedactionSettings } from '@/lib/redaction';
import type { FormFieldTable } from './tab-form-fields';
import { MAX_HANDOFF_HANDLES, MAX_HANDOFF_STEPS, buildTurnHandoff } from './turn-context';

const redaction = defaultRedactionSettings();

function fieldTable(over: Partial<FormFieldTable> = {}): FormFieldTable {
  return {
    url: 'https://example.com/form',
    fields: {
      f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' },
      f2: { path: [], expect: { tag: 'button', text: '提交' }, sensitive: false, kind: 'button' },
    },
    ...over,
  };
}

function assistantWithSteps(descriptions: string[]): ChatMessage {
  return assistantMsg({
    activitySteps: descriptions.map((description, index) => ({
      id: `s${index}`,
      description,
      status: 'done' as const,
    })),
  });
}
```

再追加 describe：

```ts
describe('buildTurnHandoff', () => {
  it('足迹与句柄都没有时返回 undefined（绝不发空消息）', () => {
    expect(buildTurnHandoff({ redaction })).toBeUndefined();
  });

  it('同时给出足迹段与句柄段', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantWithSteps(['读取了页面内容', '点击了「下一步」']),
      table: fieldTable(),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).toContain('[系统观察]');
    expect(result).toContain('点击了「下一步」');
    expect(result).toContain('f1：邮箱');
    expect(result).toContain('f2：提交');
  });

  // 句柄的新鲜度判断复用 FormFieldTable.url 那道现成的锁，不另造一套。
  it('句柄表的 url 与当前目标不符时不输出句柄段，足迹段照常', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantWithSteps(['读取了页面内容']),
      table: fieldTable(),
      targetUrl: 'https://example.com/another',
      redaction,
    });

    expect(result).toContain('读取了页面内容');
    expect(result).not.toContain('f1');
  });

  it('targetUrl 查不到时不输出句柄段', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantWithSteps(['读取了页面内容']),
      table: fieldTable(),
      redaction,
    });

    expect(result).not.toContain('f1');
  });

  // ⚠️ 这条用例是 spec §2.3 那条约束的执行者，不得删改：句柄表存的是未脱敏的原始 label，
  // 而 browser_get_form 交给模型的渲染结果是过了 redactText 的。少这一道，交接块就是
  // 一条绕过脱敏的新路。
  it('句柄 label 里的敏感串被脱敏', () => {
    const result = buildTurnHandoff({
      table: fieldTable({
        fields: {
          f1: { path: [], expect: { tag: 'input', label: '联系电话 13812345678' }, sensitive: false, kind: 'text' },
        },
      }),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).not.toContain('13812345678');
  });

  it('sensitive 句柄不出现在输出里', () => {
    const result = buildTurnHandoff({
      table: fieldTable({
        fields: {
          f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' },
          f2: { path: [], expect: { tag: 'input', label: '支付密码' }, sensitive: true, kind: 'text' },
        },
      }),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).toContain('f1：邮箱');
    expect(result).not.toContain('支付密码');
  });

  it('步数超上限时截断并报出剩余数量', () => {
    const descriptions = Array.from({ length: MAX_HANDOFF_STEPS + 3 }, (_, index) => `第 ${index} 步`);
    const result = buildTurnHandoff({ lastAssistant: assistantWithSteps(descriptions), redaction });

    expect(result).toContain(`第 ${MAX_HANDOFF_STEPS - 1} 步`);
    expect(result).not.toContain(`第 ${MAX_HANDOFF_STEPS} 步`);
    expect(result).toContain('另有 3 步未列出');
  });

  it('句柄数超上限时截断并报出剩余数量', () => {
    const fields: FormFieldTable['fields'] = {};
    for (let index = 0; index < MAX_HANDOFF_HANDLES + 5; index += 1) {
      fields[`f${index}`] = { path: [], expect: { tag: 'input', label: `字段 ${index}` }, sensitive: false, kind: 'text' };
    }

    const result = buildTurnHandoff({
      table: fieldTable({ fields }),
      targetUrl: 'https://example.com/form',
      redaction,
    });

    expect(result).toContain('另有 5 个未列出');
  });

  it('只有 running / notice 状态的步骤时不输出足迹段', () => {
    const result = buildTurnHandoff({
      lastAssistant: assistantMsg({ activitySteps: [{ id: 's0', description: '正在读取', status: 'running' }] }),
      redaction,
    });

    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑一次确认它失败**

Run: `pnpm vitest run lib/agent/turn-context.test.ts`
Expected: FAIL —— `buildTurnHandoff` 未导出

- [ ] **Step 3: 实现**

`lib/agent/turn-context.ts` 追加：

```ts
import { redactText, type RedactionSettings } from '@/lib/redaction';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

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
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm vitest run lib/agent/turn-context.test.ts && pnpm compile`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add lib/agent/turn-context.ts lib/agent/turn-context.test.ts
git commit -m "$(cat <<'MSG'
feat(agent): 新增 buildTurnHandoff——上一轮足迹与仍然可用的句柄

跨轮之后模型看不见自己上一轮做过什么，也看不见已经发放的 fieldId，
接着操作只能重跑一次 browser_get_form，白花一轮往返。

足迹取已落库的 activitySteps；句柄段只在 FormFieldTable.url 与当前
目标一致时输出——复用写入时那道"表已过期"的锁，而不是另造判断。
sensitive 句柄不列入；整块过 redactText，否则句柄表里未脱敏的原始
label 就绕过了 browser_get_form 已有的脱敏。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: 在 `startRun` 里接线（spec §3.2 末、§3.3）

**Files:**
- Modify: `lib/agent/run-registry.ts`（import 区；`startRun` 里 `const agent = createBrowserAgent({` 之前）
- Modify: `lib/agent/run-registry.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `toAgentMessages`、`buildTurnHandoff`（Task 1/3）、`getFormFieldsForTab`（`./tab-form-fields`）、`loadRedactionSettings` / `defaultRedactionSettings`（`@/lib/redaction`）、`session.currentTabId`（`TabSessionController`）
- Produces: 无新导出

- [ ] **Step 1: 写失败的调用方测试**

`lib/agent/run-registry.test.ts` 的 `vi.hoisted` 里给 `mocks` 追加一个替身：

```ts
    getFormFieldsForTab: vi.fn(async () => ({
      url: 'https://example.com/form',
      fields: { f1: { path: [], expect: { tag: 'input', label: '邮箱' }, sensitive: false, kind: 'text' } },
    })),
```

并在现有 `vi.mock(...)` 区追加：

```ts
vi.mock('./tab-form-fields', () => ({ getFormFieldsForTab: mocks.getFormFieldsForTab }));
```

`browser.tabs` 在 `lib/test-setup.ts` 的全局替身里不存在，在 `installAlarmsStub` 旁边补一个装配函数：

```ts
/** startRun 现在要查目标 tab 的真实地址来判断句柄表是否过期；全局替身里没有 tabs。 */
function installTabsStub(url = 'https://example.com/form'): void {
  (globalThis as any).browser = {
    ...(globalThis as any).browser,
    tabs: { get: vi.fn(async () => ({ id: 7, url })) },
  };
}
```

再追加 describe：

```ts
describe('run-registry 轮次交接块', () => {
  beforeEach(() => {
    mocks.getFormFieldsForTab.mockClear();
  });

  function historyWithSteps() {
    return [
      { id: 'u0', role: 'user' as const, content: '填一下表单', createdAt: 1 },
      {
        id: 'a0',
        role: 'assistant' as const,
        content: '已经读取了表单。',
        createdAt: 2,
        activitySteps: [{ id: 's0', description: '读取了表单结构', status: 'done' as const }],
      },
    ];
  }

  it('把足迹与句柄作为一条 [系统观察] 消息追加在历史末尾', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 7, historyMessages: historyWithSteps() }));
    await vi.waitFor(() => expect(getRunState(7)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const last = options.messages[options.messages.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('[系统观察]');
    expect(String(last.content)).toContain('读取了表单结构');
    expect(String(last.content)).toContain('f1：邮箱');
  });

  it('withoutBrowserTools 的轮次不追加交接块', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 8, historyMessages: historyWithSteps(), withoutBrowserTools: true }));
    await vi.waitFor(() => expect(getRunState(8)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    expect(options.messages.some((message) => String(message.content).includes('[系统观察]'))).toBe(false);
  });

  it('没有足迹也没有句柄时不追加空消息', async () => {
    installAlarmsStub();
    installTabsStub();
    mocks.getFormFieldsForTab.mockResolvedValueOnce(undefined as never);
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 11, historyMessages: [] }));
    await vi.waitFor(() => expect(getRunState(11)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: unknown[] };
    expect(options.messages).toHaveLength(0);
  });

  // 查不到 URL 属于降级而不是失败：整轮照常开跑，只是这一轮没有句柄段。
  it('tabs.get 抛错时照常开跑，只少句柄段', async () => {
    installAlarmsStub();
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      tabs: {
        get: vi.fn(async () => {
          throw new Error('no such tab');
        }),
      },
    };
    mocks.createBrowserAgent.mockReturnValue(makeFakeAgent([]));

    await startRun(makeRequest({ tabId: 12, historyMessages: historyWithSteps() }));
    await vi.waitFor(() => expect(getRunState(12)?.busy).toBe(false));

    const options = mocks.createBrowserAgent.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    const joined = options.messages.map((message) => String(message.content)).join('\n');
    expect(joined).toContain('读取了表单结构');
    expect(joined).not.toContain('f1：邮箱');
  });
});
```

- [ ] **Step 2: 跑一次确认它失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: FAIL —— 最后一条消息不含 `[系统观察]`

- [ ] **Step 3: 实现**

`lib/agent/run-registry.ts` 的 import 区追加（Task 1 已加过 `toAgentMessages`，合并成一行）：

```ts
import { buildTurnHandoff, toAgentMessages } from './turn-context';
import { getFormFieldsForTab } from './tab-form-fields';
import { defaultRedactionSettings, loadRedactionSettings } from '@/lib/redaction';
```

在 `startRun` 外面加两个私有辅助：

```ts
/** browser.tabs 在某些环境里整个不存在，属性访问就会同步抛；catch 必须裹住整段。 */
async function fetchTargetUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await browser.tabs.get(tabId);
    return tab?.url;
  } catch {
    return undefined;
  }
}

/**
 * 交接块的 I/O 采集。三份数据任意一份拿不到都只是少一段内容，绝不阻塞开跑——
 * 与 beforeToolCall 里 resolveSubmitIntent 的"失败即降级"一致。
 */
async function collectTurnHandoff(
  request: StartRunRequest,
  session: TabSessionController,
): Promise<string | undefined> {
  if (request.withoutBrowserTools) return undefined;

  const targetTabId = session.currentTabId;
  const [targetUrl, table, redaction] = await Promise.all([
    fetchTargetUrl(targetTabId),
    getFormFieldsForTab(targetTabId).catch(() => undefined),
    loadRedactionSettings().catch(() => defaultRedactionSettings()),
  ]);

  const lastAssistant = [...request.historyMessages].reverse().find((message) => message.role === 'assistant');
  return buildTurnHandoff({ lastAssistant, table, targetUrl, redaction });
}
```

在 `startRun` 里、`const agent = createBrowserAgent({` **之前**插入：

```ts
  // 轮次交接：历史在翻译时被压平成纯文本，上一轮的工具产物一条都不剩。这里把"做过什么"
  // 和"还有哪些句柄能用"补回去，每轮现算一条，不落库、不累积（ref: 设计稿 §3.3）。
  const priorMessages = toAgentMessages(request.historyMessages);
  const handoff = await collectTurnHandoff(request, session);
  if (handoff) priorMessages.push({ role: 'user', content: handoff, timestamp: Date.now() });
```

并把 `createBrowserAgent` 的

```ts
    messages: toAgentMessages(request.historyMessages),
```

改成

```ts
    messages: priorMessages,
```

这里多了一次 `await`，但三份 I/O 是 `Promise.all` 并行的两次 storage 读 + 一次 `tabs.get`，都在毫秒级；`startRun` 在它前面本来就有 `loadTabSession` 和 `persistMessages` 两次 await，量级一致。**不要**为了省这一次 await 把交接块挪到 `agent.prompt()` 之后——那时模型已经看过上下文了。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm vitest run lib/agent/run-registry.test.ts lib/agent/turn-context.test.ts && pnpm compile`
Expected: 全部 PASS

- [ ] **Step 5: 更新 `CLAUDE.md`**

在 "Agent runs in the background" 一节的 `lib/agent/run-state-storage.ts` 条目之后插入：

```markdown
- **`lib/agent/turn-context.ts`** — the one place that decides what survives a turn boundary. `toAgentMessages` flattens the panel's `ChatMessage` history into model messages, replaying the images of the **newest** image-bearing user message (earlier ones degrade to a one-line placeholder; `MAX_REPLAYED_IMAGE_BYTES` caps the replay so a 25MB request body can't take up permanent residence — that constant counts decoded bytes, unlike `context-budget.ts`'s `IMAGE_CHAR_EQUIVALENT`, which counts token-equivalent chars, and the two must never be converted into each other). `buildTurnHandoff` produces the per-turn `[系统观察]` block that hands the next turn what the last one did (from the archived `activitySteps`) plus which `fieldId` handles are still usable — the latter only when `FormFieldTable.url` still matches the operating target, reusing the same staleness lock write verification uses, and never for `sensitive` handles. The block is recomputed every turn and never persisted, so it cannot accumulate, and it is appended at the end of history, so it doesn't disturb the cached prefix. It goes through `redactText` as a whole: the handle table stores the raw, unredacted `expect` labels that write verification needs, while `browser_get_form`'s model-facing rendering is redacted — skipping this would open a second, unredacted path for the same page text.
```

- [ ] **Step 6: 全量测试 + 提交**

Run: `pnpm test && pnpm compile`
Expected: 全部 PASS。仓库级守卫测试（`brand-namespace.test.ts` 等）也要绿——本改动没有引入新的 storage key，本不该受影响；若红了说明改动超出了计划范围，停下来报告。

```bash
git add lib/agent/run-registry.ts lib/agent/run-registry.test.ts CLAUDE.md
git commit -m "$(cat <<'MSG'
feat(agent): startRun 每轮追加一条轮次交接块

采集三份现成数据（目标 tab 的地址、storage.session 里的句柄表、脱敏
设置）交给 buildTurnHandoff，产出的一条 [系统观察] 消息追加在翻译后的
历史末尾。任意一份拿不到都只是少一段内容，不阻塞开跑。

withoutBrowserTools 的轮次整块跳过：那种轮次里句柄和足迹都没有意义。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: 窗口切割回归变体（spec §3.3 末）

**Files:**
- Modify: `lib/agent/agent.test.ts`（`describe('上下文压缩：窗口边界不得切出无主的 toolResult')` 内，约 `:1362` 起）

**Interfaces:**
- Consumes: 该 describe 里现成的 `runtimeOptions` / `userMessage` / `assistantToolCallMessage` / `toolResultMessage` 夹具与 `MAX_CONTEXT_MESSAGES`
- Produces: 无

交接块在消息序列里的形状与 `afterToolCall` 的 steer 完全一致（单条 user 消息打破奇偶），而那个形状已经有用例覆盖。**不要复制一条几乎一样的用例**——现有夹具只覆盖"断点落在历史中段"，交接块的真实位置是历史末尾，补的是这个未覆盖的下标。

- [ ] **Step 1: 写测试**

在该 describe 内、现有 `it(...)` 之后追加：

```ts
  // 交接块（turn-context.ts 的 buildTurnHandoff）在序列里的形状与上面的 steer 一样是单条
  // user 消息，但位置不同：它固定落在历史末尾、本轮工具调用之前。这里补的是那个下标。
  it('历史末尾的单条 user 消息（轮次交接块）不会让窗口以无主 toolResult 开头', async () => {
    const hooks = runtimeOptions();
    const messages: AgentMessage[] = [userMessage('开始')];
    for (let index = 0; index < MAX_CONTEXT_MESSAGES; index += 1) {
      messages.push(assistantToolCallMessage(`call-c${index}`, 'browser_type', { text: `c${index}` }));
      messages.push(toolResultMessage(`call-c${index}`, 'browser_type', `已输入 c${index}。`));
    }
    messages.push(userMessage('[系统观察] 本会话上一轮的执行足迹（可能已过时）：\n- 读取了表单结构'));

    const compacted = await hooks.transformContext!(messages);

    expect(messages.length).toBeGreaterThan(MAX_CONTEXT_MESSAGES);
    expect((compacted[0] as unknown as { role: string }).role).not.toBe('toolResult');
    // 交接块本身必须留在窗口里——它是给本轮用的，被切掉等于白算。
    const last = compacted[compacted.length - 1] as unknown as { content: unknown };
    expect(String(last.content)).toContain('[系统观察]');
  });
```

- [ ] **Step 2: 跑一次**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: PASS（`windowWithIntactToolCalls` 已为这个形状加固过）。**若 FAIL，停下来报告**——那说明窗口逻辑对这个下标确实有缺口，是真 bug，不要改测试去迁就实现。

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm compile`
Expected: 全部 PASS

- [ ] **Step 4: 把设计稿状态行改成已实现**

`docs/superpowers/specs/2026-09-22-cross-turn-context-handoff-design.md` 的 `- 状态：设计中` 改成 `- 状态：已实现（<Task 1 到 Task 5 的提交范围>）`。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/agent.test.ts docs/superpowers/specs/2026-09-22-cross-turn-context-handoff-design.md
git commit -m "$(cat <<'MSG'
test(agent): 补窗口切割在历史末尾断奇偶的用例

既有用例只覆盖了 steer 落在历史中段的情形；轮次交接块的位置固定在
历史末尾，是另一个下标。同时确认交接块本身不会被窗口切掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## 执行顺序说明

Task 1 → 2 → 3 严格按序，每个自带测试与提交。Task 4 依赖 1 和 3（import 两个函数），Task 5 依赖 4 落地后的真实形状。

Task 2 与 Task 3 之间没有逻辑依赖，但都会改 `turn-context.ts` 和 `turn-context.test.ts`（不同段落）——并行分派时注意 import 区的合并冲突。
