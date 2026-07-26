# 编辑历史消息并从该处重新生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让侧边栏里普通输入的用户消息可以就地编辑，提交后丢弃该条及其之后的全部消息（内存与 IndexedDB 同步），并以新内容从该处重新跑一轮 agent。

**Architecture:** 给消息加客户端生成的稳定 `id`，把「哪些消息可编辑 / 截断到哪 / 落库成什么」四个判断下沉为 `lib/chat/messages.ts` 里的纯函数（唯一有自动化测试覆盖的部分）。持久化从「每轮追加两条」改为「每轮用当前 UI 数组整体重写该会话」——UI 是唯一真相，DB 是它的投影，截断因此退化为纯内存的 `slice`，store 里不需要维护 UI 数组与 Dexie 自增主键的对应关系。重新生成完全复用 `runAgent`：给它加一个 `truncateTo` 参数，截断后的 `history` 天然实现「从这条重跑」，agent 层不加任何分支。

**Tech Stack:** TypeScript、React 19、Zustand、Dexie（IndexedDB）、WXT（Chromium MV3 扩展）、Vitest、Tailwind CSS。

设计文档：`docs/superpowers/specs/2026-07-26-edit-history-message-design.md`

## Global Constraints

- **不做 Dexie 版本迁移。** `ChatMessageRecord.kind` 不建索引，因此 `db.version(1).stores({...})` 一行都不改。
- **不支持编辑助手消息，不支持编辑快捷操作消息**（`kind: 'action'`，即「📄 总结当前网页」/「💬 解释：…」）。
- **不保留编辑前的版本**，不做分支切换。编辑即不可恢复的丢弃，且**不弹确认框**（用编辑框下方的文字提示代替）。
- **不改动 agent 循环、工具、权限门、快照/撤销的任何逻辑**（`lib/agent/**`、`entrypoints/background.ts`、`entrypoints/content.ts` 均不修改）。
- 存量 DB 记录没有 `kind` 字段，一律按 `'input'`（可编辑）处理。
- 测试只放在 `lib/**/*.test.ts`——`vitest.config.ts` 的 `include` 为 `['lib/**/*.test.ts']`、`environment` 为 `'node'`。**不引入 `fake-indexeddb`，不改 `vitest.config.ts`**，`entrypoints/` 不新建测试基建。
- 代码注释用中文，提交信息用英文 `type: subject` 格式（参考 `git log`）。
- 每个任务结束前 `pnpm compile` 与 `pnpm test` 必须通过。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `lib/chat/messages.ts` | 新建 | 消息形状 `ChatMessage` + 五个纯函数：`isEditableMessage`、`findMessageIndex`、`discardedCount`、`toMessageRecords`、`conversationTitle`。本功能全部可测逻辑集中于此。 |
| `lib/chat/messages.test.ts` | 新建 | 上述五个纯函数的单元测试。 |
| `lib/db.ts` | 修改 | `ChatMessageRecord` 加 `kind` 字段；新增 `replaceConversationMessages`（会话消息全量重写事务）。 |
| `entrypoints/sidepanel/store.ts` | 修改 | `UIMessage` 改为 `ChatMessage` 别名；所有消息构造点补 `id`/`createdAt`/`kind`；`persist()` 换成 `replaceConversationMessages` 并移入 `finally`；`runAgent` 加 `truncateTo` 参数；新增 `editMessage` action。 |
| `entrypoints/sidepanel/MessageEditor.tsx` | 新建 | 就地编辑框组件：自动聚焦/自动高度、Enter 提交 / Shift+Enter 换行 / Esc 取消、丢弃条数提示、取消/发送按钮。 |
| `entrypoints/sidepanel/icons.tsx` | 修改 | 新增 `IconPencil`。 |
| `entrypoints/sidepanel/App.tsx` | 修改 | `key={i}` → `key={m.id}`；`Message` 组件接入编辑入口与编辑态；新增本地 `editingId` 状态并在会话切换时重置。 |

**任务顺序：** Task 1（纯函数，全部有测试）→ Task 2（持久化重写，行为等价）→ Task 3（`editMessage` 逻辑）→ Task 4（UI）。Task 2 结束时功能上无可见变化但已修掉两个既有缺陷；Task 3 结束时功能可通过 DevTools 控制台验证；Task 4 结束时功能完整。

---

### Task 1: `lib/chat/messages.ts` 纯函数模块

**Files:**
- Modify: `lib/db.ts`（仅给 `ChatMessageRecord` 加一个可选字段）
- Create: `lib/chat/messages.ts`
- Test: `lib/chat/messages.test.ts`

**Interfaces:**
- Consumes: `ChatMessageRecord`（`lib/db.ts`，本任务为其加 `kind` 字段）。
- Produces（后续三个任务全部依赖这些签名）:
  - `export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; kind?: 'input' | 'action' }`
  - `export function isEditableMessage(message: ChatMessage): boolean`
  - `export function findMessageIndex(messages: ChatMessage[], id: string): number`
  - `export function discardedCount(messages: ChatMessage[], id: string): number`
  - `export function toMessageRecords(conversationId: string, messages: ChatMessage[]): ChatMessageRecord[]`
  - `export function conversationTitle(messages: ChatMessage[]): string`

- [ ] **Step 1: 给 `ChatMessageRecord` 加 `kind` 字段**

`lib/db.ts` 第 6-12 行的 interface 改为：

```ts
export interface ChatMessageRecord {
  id?: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  /**
   * 仅用户消息有意义：input = 普通输入（可编辑），action = 快捷操作（不可编辑）。
   * 不建索引，因此无需 Dexie 版本迁移；存量记录无此字段，按 input 处理。
   */
  kind?: 'input' | 'action';
}
```

`this.version(1).stores({...})` **不改**。

- [ ] **Step 2: 写失败的测试**

新建 `lib/chat/messages.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  conversationTitle,
  discardedCount,
  findMessageIndex,
  isEditableMessage,
  toMessageRecords,
  type ChatMessage,
} from './messages';

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  kind?: 'input' | 'action',
): ChatMessage {
  return { id, role, content, createdAt: 1000, kind };
}

describe('isEditableMessage', () => {
  it('普通输入的用户消息可编辑', () => {
    expect(isEditableMessage(msg('a', 'user', '你好', 'input'))).toBe(true);
  });

  it('快捷操作产生的用户消息不可编辑', () => {
    expect(isEditableMessage(msg('a', 'user', '📄 总结当前网页', 'action'))).toBe(false);
  });

  it('助手消息不可编辑', () => {
    expect(isEditableMessage(msg('a', 'assistant', '回答'))).toBe(false);
  });

  it('存量记录无 kind 时按可编辑处理', () => {
    expect(isEditableMessage(msg('a', 'user', '旧消息'))).toBe(true);
  });
});

describe('findMessageIndex', () => {
  const messages = [msg('a', 'user', '一'), msg('b', 'assistant', '二'), msg('c', 'user', '三')];

  it('命中时返回下标', () => {
    expect(findMessageIndex(messages, 'c')).toBe(2);
  });

  it('未命中时返回 -1', () => {
    expect(findMessageIndex(messages, 'zzz')).toBe(-1);
  });
});

describe('discardedCount', () => {
  const messages = [
    msg('a', 'user', '一'),
    msg('b', 'assistant', '二'),
    msg('c', 'user', '三'),
    msg('d', 'assistant', '四'),
  ];

  it('返回该消息之后的消息条数', () => {
    expect(discardedCount(messages, 'a')).toBe(3);
  });

  it('最后一条用户消息只丢弃它后面的那条回复', () => {
    expect(discardedCount(messages, 'c')).toBe(1);
  });

  it('未命中时返回 0', () => {
    expect(discardedCount(messages, 'zzz')).toBe(0);
  });
});

describe('toMessageRecords', () => {
  it('丢弃末尾 content 为空的 assistant 占位消息', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问'), msg('b', 'assistant', '')]);
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe('user');
  });

  it('不丢弃中间的空 assistant 消息', () => {
    const records = toMessageRecords('c-1', [
      msg('a', 'user', '问'),
      msg('b', 'assistant', ''),
      msg('c', 'user', '再问'),
    ]);
    expect(records).toHaveLength(3);
  });

  it('不丢弃有内容的末尾 assistant 消息', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问'), msg('b', 'assistant', '答')]);
    expect(records).toHaveLength(2);
  });

  it('保留 conversationId / createdAt / kind，且不带客户端 id', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问', 'action')]);
    expect(records[0]).toEqual({
      conversationId: 'c-1',
      role: 'user',
      content: '问',
      createdAt: 1000,
      kind: 'action',
    });
  });

  it('空数组返回空数组', () => {
    expect(toMessageRecords('c-1', [])).toEqual([]);
  });
});

describe('conversationTitle', () => {
  it('取首条用户消息内容', () => {
    expect(conversationTitle([msg('a', 'user', '你好'), msg('b', 'assistant', '答')])).toBe('你好');
  });

  it('跳过助手消息取首条用户消息', () => {
    expect(conversationTitle([msg('a', 'assistant', '答'), msg('b', 'user', '问')])).toBe('问');
  });

  it('超长标题截断到 40 字', () => {
    const long = '字'.repeat(100);
    expect(conversationTitle([msg('a', 'user', long)])).toBe('字'.repeat(40));
  });

  it('没有用户消息时返回默认标题', () => {
    expect(conversationTitle([msg('a', 'assistant', '答')])).toBe('新对话');
    expect(conversationTitle([])).toBe('新对话');
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm vitest run lib/chat/messages.test.ts`
Expected: FAIL —— `Failed to load url ./messages`（文件尚不存在）

- [ ] **Step 4: 写实现**

新建 `lib/chat/messages.ts`：

```ts
import type { ChatMessageRecord } from '@/lib/db';

// 侧边栏消息的形状与派生规则（ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §3）。
// 本功能的全部可测逻辑集中在这里：vitest 只覆盖 lib/**，entrypoints/ 没有测试基建。

export interface ChatMessage {
  /** 客户端生成的稳定标识：React key + 编辑定位。不落库。 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** 仅用户消息有意义：input = 普通输入（可编辑），action = 快捷操作（不可编辑） */
  kind?: 'input' | 'action';
}

const TITLE_MAX_CHARS = 40;
const DEFAULT_TITLE = '新对话';

/**
 * 只有普通输入的用户消息可编辑。
 * 快捷操作消息展示的是标签（如「📄 总结当前网页」），真正的 prompt 是另一段文字且未持久化，
 * 编辑它会把标签本身当 prompt 发出去，所以直接禁掉。
 * 存量记录没有 kind，按 input 处理。
 */
export function isEditableMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.kind !== 'action';
}

/** 返回 id 对应消息的下标；未找到返回 -1 */
export function findMessageIndex(messages: ChatMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id);
}

/** 编辑该条消息后将被一并丢弃的后续消息条数；id 未命中时返回 0 */
export function discardedCount(messages: ChatMessage[], id: string): number {
  const index = findMessageIndex(messages, id);
  if (index < 0) return 0;
  return messages.length - index - 1;
}

/**
 * UI 消息 → DB 记录。
 * 丢弃末尾 content 为空的 assistant 占位：一轮出错或被中止时 UI 会留下这个占位，
 * 落库后重开会话会渲染成一个空气泡。中间的空 assistant 保留，因为它承载了轮次结构。
 */
export function toMessageRecords(
  conversationId: string,
  messages: ChatMessage[],
): ChatMessageRecord[] {
  const last = messages[messages.length - 1];
  const end = last && last.role === 'assistant' && !last.content ? messages.length - 1 : messages.length;
  return messages.slice(0, end).map((message) => ({
    conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    kind: message.kind,
  }));
}

/** 会话标题取首条用户消息的前 40 字；没有用户消息时给默认标题 */
export function conversationTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  const text = first?.content.trim();
  return text ? text.slice(0, TITLE_MAX_CHARS) : DEFAULT_TITLE;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run lib/chat/messages.test.ts`
Expected: PASS，18 个用例全绿

- [ ] **Step 6: 全量校验**

Run: `pnpm compile && pnpm test`
Expected: 两条命令均退出码 0

- [ ] **Step 7: 提交**

```bash
git add lib/chat/messages.ts lib/chat/messages.test.ts lib/db.ts
git commit -m "feat: add pure chat message helpers for history editing"
```

---

### Task 2: 会话持久化改为全量重写

**Files:**
- Modify: `lib/db.ts`（新增 `replaceConversationMessages`）
- Modify: `entrypoints/sidepanel/store.ts`（`UIMessage` 别名、消息构造点、持久化调用点）

**Interfaces:**
- Consumes: Task 1 的 `ChatMessage`、`toMessageRecords`、`conversationTitle`。
- Produces:
  - `export async function replaceConversationMessages(conversationId: string, messages: ChatMessageRecord[], title: string): Promise<void>`（`lib/db.ts`）
  - `export type UIMessage = ChatMessage`（`entrypoints/sidepanel/store.ts`，替换原来的 interface）
  - store 内部私有：`function makeMessage(role: 'user' | 'assistant', content: string, kind?: 'input' | 'action'): UIMessage`

本任务不改变任何可见行为，但修掉两个既有缺陷：一轮出错/中止时用户消息不落库；编辑首条消息后会话标题不更新（后者要等 Task 3 才看得到）。

- [ ] **Step 1: 新增 `replaceConversationMessages`**

在 `lib/db.ts` 末尾（`deleteConversation` 之后）追加：

```ts
/**
 * 用给定记录整体替换某会话的全部消息，并同步标题与 updatedAt。
 *
 * UI 是唯一真相，DB 是它的投影：这样「编辑历史消息」的截断就退化为纯内存的 slice，
 * store 不需要维护 UI 数组与 Dexie 自增主键的双向对应
 * （ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §2）。
 */
export async function replaceConversationMessages(
  conversationId: string,
  messages: ChatMessageRecord[],
  title: string,
): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.where('conversationId').equals(conversationId).delete();
    if (messages.length === 0) return;
    await db.messages.bulkAdd(messages);
    const now = Date.now();
    const existing = await db.conversations.get(conversationId);
    await db.conversations.put({
      id: conversationId,
      title,
      url: existing?.url,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  });
}
```

- [ ] **Step 2: store 中把 `UIMessage` 换成 `ChatMessage` 别名**

`entrypoints/sidepanel/store.ts` 第 74-77 行的

```ts
export interface UIMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

替换为：

```ts
export type UIMessage = ChatMessage;
```

并在 import 区补上（`lib/db` 的 import 之后）：

```ts
import {
  conversationTitle,
  toMessageRecords,
  type ChatMessage,
} from '@/lib/chat/messages';
```

同时把 `@/lib/db` 的 import 里加上 `replaceConversationMessages`，并**删掉 `db`**（下一步 `persist()` 一并删除后就没有别的地方用 `db` 了）。改完后该 import 为：

```ts
import {
  deleteConversation,
  getConversationMessages,
  listConversations,
  replaceConversationMessages,
  type ConversationRecord,
} from '@/lib/db';
```

- [ ] **Step 3: 新增消息构造辅助函数**

在 `genConversationId`（第 152 行附近）之后追加：

```ts
function genMessageId(): string {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  kind?: 'input' | 'action',
): UIMessage {
  return { id: genMessageId(), role, content, createdAt: Date.now(), kind };
}
```

- [ ] **Step 4: 改造全部消息构造点**

`send`（第 209 行）：

```ts
    await runAgent(set, get, makeMessage('user', content, 'input'), content);
```

`summarizePage`（第 214 行）：

```ts
    const display = makeMessage('user', '📄 总结当前网页', 'action');
```

`explainSelection`（第 240 行）：

```ts
    const display = makeMessage('user', `💬 解释：${preview}`, 'action');
```

`openConversation`（第 299-301 行）的 map：

```ts
    const messages: UIMessage[] = records
      .filter((r) => r.role !== 'system')
      .map((r) => ({
        id: genMessageId(),
        role: r.role as 'user' | 'assistant',
        content: r.content,
        createdAt: r.createdAt,
        kind: r.kind,
      }));
```

`runAgent` 里预置空 assistant 占位的那行（第 387 行）：

```ts
    messages: [...history, display, makeMessage('assistant', '')],
```

- [ ] **Step 5: 让 `replaceLastAssistant` 保留消息标识**

第 514-523 行的函数体改为展开原消息，而不是重新构造一个字面量——否则每来一个 token 就换一个 `id`，React 会在流式过程中不断卸载重建气泡：

```ts
function replaceLastAssistant(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  content: string,
): void {
  set((state) => {
    const messages = state.messages.slice();
    const last = messages[messages.length - 1];
    if (!last) return { error: null };
    messages[messages.length - 1] = { ...last, content };
    return { messages, error: null };
  });
}
```

- [ ] **Step 6: 用 `persistConversation` 取代 `persist`**

删除第 645-670 行的整个 `persist` 函数，在原位置放入：

```ts
/**
 * 每轮结束时用当前 UI 消息整体重写该会话。
 * 放在 runAgent 的 finally 里，覆盖成功 / 模型出错 / 用户中止 / 后台协议过旧提前 return 四条路径。
 */
async function persistConversation(get: () => ChatState): Promise<void> {
  const conversationId = get().conversationId;
  const messages = get().messages;
  try {
    await replaceConversationMessages(
      conversationId,
      toMessageRecords(conversationId, messages),
      conversationTitle(messages),
    );
  } catch (e) {
    console.error('[Aluminum] 持久化会话失败', e);
  }
}
```

- [ ] **Step 7: 挪动持久化调用点**

删除 `runAgent` 里现有的两处 `await persist(...)` 调用——第 479 行（后台协议过旧分支）与第 500 行（正常分支）。

把 `finally` 块（第 507-511 行）改为：

```ts
  } finally {
    unsubscribe();
    set({ busy: false });
    if (activeAgent === agent) activeAgent = null;
    await persistConversation(get);
  }
```

- [ ] **Step 8: 顺手让历史消息带上真实时间戳**

`toAgentMessages`（第 525-548 行）里两处 `timestamp: Date.now()` 改为 `timestamp: message.createdAt`。用户分支：

```ts
    if (message.role === 'user') {
      return { role: 'user', content: message.content, timestamp: message.createdAt };
    }
```

助手分支里的 `timestamp: Date.now(),` 改为 `timestamp: message.createdAt,`。

- [ ] **Step 9: 校验**

Run: `pnpm compile && pnpm test`
Expected: 两条命令均退出码 0。若 `pnpm compile` 报 `'db' is declared but its value is never read`，说明 Step 2 漏删了 `db` 的 import。

- [ ] **Step 10: 手动验证持久化行为**

```bash
pnpm build
```

在 `chrome://extensions` 加载 `.output/chrome-mv3`，打开侧边栏（需先在设置里配好 Provider）：

1. 发一条消息，等回复完成 → 打开侧边栏历史列表，会话标题为该消息前 40 字。
2. 再发一条消息，回复中途点「停止」→ 关闭侧边栏再从历史列表打开该会话 → 用户消息与已生成的部分回复都在（改造前用户消息会丢失）。
3. 会话里的消息没有重复条目（验证「删除后重建」没有写成「只追加」）。

- [ ] **Step 11: 提交**

```bash
git add lib/db.ts entrypoints/sidepanel/store.ts
git commit -m "refactor: rewrite conversation messages wholesale on each turn"
```

---

### Task 3: `editMessage` 与 `runAgent` 的 `truncateTo`

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`

**Interfaces:**
- Consumes: Task 1 的 `findMessageIndex`、`isEditableMessage`；Task 2 的 `makeMessage`、`runAgent`。
- Produces: `ChatState` 新增 `editMessage: (id: string, newContent: string) => Promise<void>`（Task 4 的 UI 调用它）。

- [ ] **Step 1: 补充 import**

`entrypoints/sidepanel/store.ts` 中 `@/lib/chat/messages` 的 import 改为：

```ts
import {
  conversationTitle,
  findMessageIndex,
  isEditableMessage,
  toMessageRecords,
  type ChatMessage,
} from '@/lib/chat/messages';
```

- [ ] **Step 2: 给 `runAgent` 加 `truncateTo` 参数**

函数签名（第 350-356 行）末尾追加一个可选参数：

```ts
async function runAgent(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  display: UIMessage,
  agentUserContent: string,
  presetTabId?: number,
  truncateTo?: number,
): Promise<void> {
```

- [ ] **Step 3: 在前置校验之后应用截断**

第 385 行的 `const history = get().messages;` 替换为：

```ts
  // 截断必须放在 Provider 校验与 resolveActiveTabId 之后：那两处失败会 set({ error }) 直接 return，
  // 若此时历史已被截断，用户的消息就被不可恢复地丢弃了，而这是用户完全没有预期的失败路径
  // （ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §4）。
  const history = truncateTo === undefined ? get().messages : get().messages.slice(0, truncateTo);
```

`runAgent` 其余部分一行不改——截断后的 `history` 同时喂给 `set({ messages: [...history, ...] })` 和 `toAgentMessages(history)`，「从这条重跑」自然成立。

- [ ] **Step 4: 在 `ChatState` 接口里声明 `editMessage`**

第 120 行 `send` 声明之后插入：

```ts
  editMessage: (id: string, newContent: string) => Promise<void>;
```

- [ ] **Step 5: 实现 `editMessage` action**

在 store 的 `send` 实现（第 206-210 行）之后插入：

```ts
  editMessage: async (id, newContent) => {
    const trimmed = newContent.trim();
    if (!trimmed || get().busy) return;
    const messages = get().messages;
    const index = findMessageIndex(messages, id);
    if (index < 0 || !isEditableMessage(messages[index])) return;
    await runAgent(set, get, makeMessage('user', trimmed, 'input'), trimmed, undefined, index);
  },
```

- [ ] **Step 6: 校验**

Run: `pnpm compile && pnpm test`
Expected: 两条命令均退出码 0

- [ ] **Step 7: 在真实扩展里验证逻辑（UI 尚未接线，走控制台）**

`store.ts` 末尾的 `if (import.meta.env.DEV)` 只在开发构建挂 `__useChat`，所以本步用 `pnpm dev`
而不是 `pnpm build`：

```bash
pnpm dev
```

在 `chrome://extensions` 加载 `.output/chrome-mv3`，打开侧边栏，右键侧边栏 →「检查」打开
DevTools 控制台，依次执行：

1. 先发两轮普通对话（共 4 条消息）。
2. 执行 `__useChat.getState().messages.map(m => [m.id, m.role, m.kind])`，记下第一条用户消息的 id。
3. 执行 `await __useChat.getState().editMessage('<那个 id>', '换一个问题')`。
4. 预期：界面上第一条之后的三条消息消失，新问题与新回复出现，`messages.length === 2`。
5. 关闭侧边栏再从历史列表打开该会话，预期看到的仍是编辑后的两条，被丢弃的三条没有复活。
6. 对快捷操作消息（先点「总结本页」产生一条）调用 `editMessage` 应当无任何反应（静默 return）。

- [ ] **Step 8: 提交**

```bash
git add entrypoints/sidepanel/store.ts
git commit -m "feat: add editMessage action that truncates history and reruns"
```

---

### Task 4: 编辑入口与编辑框 UI

**Files:**
- Modify: `entrypoints/sidepanel/icons.tsx`（末尾追加 `IconPencil`）
- Create: `entrypoints/sidepanel/MessageEditor.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`（第 1 行 import、第 36-65 行 store 解构、第 68-74 行本地状态、第 176-178 行渲染、第 540-574 行 `Message` 组件）

**Interfaces:**
- Consumes: Task 1 的 `isEditableMessage`、`discardedCount`；Task 2 的 `UIMessage` 类型；Task 3 的 `editMessage` action。
- Produces: `MessageEditor` 默认导出，props 为 `{ initialContent: string; discardCount: number; onCancel: () => void; onSubmit: (content: string) => void }`。

- [ ] **Step 1: 新增 `IconPencil`**

`entrypoints/sidepanel/icons.tsx` 末尾追加（该文件的定义顺序是追加式的，不是字母序）：

```tsx
export function IconPencil({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}
```

- [ ] **Step 2: 新建 `MessageEditor.tsx`**

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

// 用户消息的就地编辑框。提交后由 store 的 editMessage 截断历史并重跑
// （ref: docs/superpowers/specs/2026-07-26-edit-history-message-design.md §5）。
export default function MessageEditor({
  initialContent,
  discardCount,
  onCancel,
  onSubmit,
}: {
  initialContent: string;
  discardCount: number;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [text, setText] = useState(initialContent);
  const ref = useRef<HTMLTextAreaElement>(null);

  // 挂载时聚焦并把光标置于末尾；setSelectionRange 必须在 focus 之后调用。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // 随内容自动调整高度：先归零再读 scrollHeight，否则删字时高度只增不减。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const canSubmit = text.trim().length > 0;

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    // 与 Composer 的快捷键保持一致：Enter 提交，Shift+Enter 换行。
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) onSubmit(text);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="编辑消息"
        className="w-full resize-none rounded-2xl border border-neutral-300 bg-white px-4 py-2.5 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
          {discardCount > 0 ? `提交后将丢弃后续 ${discardCount} 条消息` : ''}
        </span>
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(text)}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700"
          >
            发送
          </button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `App.tsx` 补 import**

第 12 行的 store 类型 import 加上 `UIMessage`：

```ts
import type { PendingConfirmation, ToolActivity, UIMessage } from './store';
```

在 `import type { ConversationRecord } from '@/lib/db';` 之后追加：

```ts
import { discardedCount, isEditableMessage } from '@/lib/chat/messages';
import MessageEditor from './MessageEditor';
```

第 13-30 行的图标 import 中，按字母序在 `IconMonitor,` 与 `IconPlus,` 之间插入 `IconPencil,`。

- [ ] **Step 4: `App.tsx` 解构 `conversationId` 与 `editMessage`**

第 36-65 行的 `useChat()` 解构中，在 `conversations,` 之后加 `conversationId,`，在 `send,` 之后加 `editMessage,`。

- [ ] **Step 5: `App.tsx` 新增编辑态并在会话切换时重置**

第 75 行 `const scrollRef = ...` 之前插入：

```tsx
  const [editingId, setEditingId] = useState<string | null>(null);
```

第 90 行（resize 的 useEffect）之后插入：

```tsx
  // 切换会话 / 新建会话 / 删除当前会话时，关闭尚未提交的编辑框。
  useEffect(() => {
    setEditingId(null);
  }, [conversationId]);

  async function submitEdit(id: string, content: string) {
    setEditingId(null);
    await editMessage(id, content);
  }
```

- [ ] **Step 6: `App.tsx` 改渲染循环**

第 176-178 行替换为：

```tsx
                messages.map((m) => (
                  <Message
                    key={m.id}
                    message={m}
                    busy={busy}
                    editing={editingId === m.id}
                    discardCount={editingId === m.id ? discardedCount(messages, m.id) : 0}
                    onBeginEdit={() => setEditingId(m.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onSubmitEdit={(content) => submitEdit(m.id, content)}
                  />
                ))
```

`key={i}` 改成 `key={m.id}` 是必须的：列表尾部被截断后重建时，下标 key 会让 React 复用错误的 DOM 节点。

- [ ] **Step 7: `App.tsx` 改写 `Message` 组件**

第 540-574 行整个 `Message` 函数替换为：

```tsx
function Message({
  message,
  busy,
  editing,
  discardCount,
  onBeginEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UIMessage;
  busy: boolean;
  editing: boolean;
  discardCount: number;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (content: string) => void;
}) {
  const { role, content } = message;

  if (role === 'user') {
    if (editing) {
      return (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%]">
            <MessageEditor
              initialContent={content}
              discardCount={discardCount}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="group flex items-center justify-end gap-1.5">
        {!busy && isEditableMessage(message) && (
          <button
            type="button"
            onClick={onBeginEdit}
            aria-label="编辑这条消息"
            title="编辑这条消息"
            // 只挂 hover 会让这个功能对键盘用户不存在，因此同时响应 focus-visible。
            className="shrink-0 rounded-md p-1.5 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 group-hover:opacity-100 dark:hover:text-neutral-200"
          >
            <IconPencil className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-sm text-white dark:bg-neutral-700">
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-900 text-[11px] font-bold text-white dark:bg-neutral-800">
        Al
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-sm ring-1 ring-neutral-200/70 dark:bg-neutral-900 dark:ring-neutral-800">
        {content ? (
          <Suspense fallback={<span className="whitespace-pre-wrap">{content}</span>}>
            <Markdown content={content} />
          </Suspense>
        ) : busy ? (
          <TypingDots />
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: 校验**

Run: `pnpm compile && pnpm test`
Expected: 两条命令均退出码 0

- [ ] **Step 9: 手动走完整套验收标准**

```bash
pnpm build
```

在 `chrome://extensions` 重新加载 `.output/chrome-mv3`，打开侧边栏逐条核对：

1. 普通输入的用户消息 hover 时，气泡左侧出现铅笔按钮；反复按 Tab 也能聚焦到它（按钮显现）。
2. 点「总结本页」产生的「📄 总结当前网页」消息 hover 时**没有**铅笔按钮。
3. 助手消息 hover 时没有铅笔按钮。
4. 生成过程中（busy）所有铅笔按钮消失。
5. 点铅笔 → 气泡变为 textarea，内容为原文、光标在末尾；输入多行时高度自动增长，删字时高度回缩。
6. Esc 取消回到气泡；Shift+Enter 换行不提交；Enter 提交。
7. 清空编辑框内容后「发送」按钮变灰不可点。
8. 发两轮对话（4 条消息），编辑第 1 条：提示显示「提交后将丢弃后续 3 条消息」；编辑第 3 条（最后一条用户消息）：显示「后续 1 条」。
9. 提交后该条之后的消息从界面消失，agent 以新内容重跑一轮。
10. 关闭侧边栏后从历史列表重开该会话，被丢弃的消息没有复活。
11. 编辑首条用户消息并提交后，历史列表中该会话的标题变为新内容的前 40 字。
12. 在「设置」里删掉全部 Provider，回到对话点编辑并提交：出现「未配置 Provider」错误提示，且**历史消息一条没少**。
13. 编辑框打开状态下从历史列表切到另一个会话，编辑框关闭。

- [ ] **Step 10: 更新 `docs/PROGRESS.md`**

在 Phase 1 的清单中，`- [x] 历史会话列表 UI（查看/打开/删除，`lib/db.ts` 辅助函数）` 这一行之后插入：

```markdown
- [x] 编辑历史用户消息并从该处重新生成（截断后续消息 + 会话全量重写持久化，
      见 [设计](superpowers/specs/2026-07-26-edit-history-message-design.md)）
```

- [ ] **Step 11: 提交**

```bash
git add entrypoints/sidepanel/App.tsx entrypoints/sidepanel/MessageEditor.tsx entrypoints/sidepanel/icons.tsx docs/PROGRESS.md
git commit -m "feat: edit a past user message and rerun from there"
```
