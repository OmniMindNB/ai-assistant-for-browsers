# 设计：编辑历史消息并从该处重新生成

- 状态：已批准 Approved
- 日期：2026-07-26
- 关联：`entrypoints/sidepanel/store.ts`、`entrypoints/sidepanel/App.tsx`、`lib/db.ts`

## 背景

侧边栏对话目前只能往后追加。用户上一个问题问得不好时，唯一的补救方式是再发一条新消息，
错误的提问和基于它的回答都会永久留在上下文里，继续污染后续每一轮——`runAgent` 每轮都用
`get().messages` 全量重建 agent 上下文（`store.ts:385`、`store.ts:411`）。

本设计引入「编辑某条用户消息 → 丢弃其后的全部内容 → 从这条重新生成」，
与 ChatGPT / Claude 的行为一致。

### 现状的三个约束

1. `UIMessage` 只有 `role` / `content`，没有稳定标识，列表渲染用数组下标做 React key（`App.tsx:176`）。
2. `persist()`（`store.ts:645`）在每轮结束时追加两条记录，UI 消息与 IndexedDB 记录之间不存在对应关系，
   无法表达「删除第 N 条之后」。
3. 用户消息有两种来源：普通输入（展示文本 == 发给模型的 prompt）与快捷操作
   （`summarizePage` / `explainSelection`，展示的是「📄 总结当前网页」这类标签，
   真正的 prompt 是另一段文字且**从未持久化**）。

## 目标

- 普通输入的用户消息可就地编辑；提交后丢弃该条及其之后的全部消息，并从新内容重新跑一轮 agent。
- 被丢弃的内容同步从 IndexedDB 删除，重新打开会话时不复活。
- UI 状态与持久化状态始终一致。

## 非目标

- 不支持编辑助手消息。
- 不支持编辑快捷操作产生的消息（见「设计 §1」的取舍）。
- 不保留编辑前的版本，不做分支切换（编辑即不可恢复的丢弃）。
- 不撤销被丢弃轮次对页面造成的改动（见「边界与异常」）。
- 不改变 agent 循环、工具、权限门任何逻辑。

## 用户故事

- 作为用户，我发现上一个问题问偏了，我希望直接改那条消息重问，以便后续对话不被错误的提问干扰。
- 作为用户，我希望编辑提交前知道会丢掉多少条消息，以便避免误操作。

## 设计

### 1. 数据模型

消息形状定义在 `lib/chat/messages.ts`（见 §3）中的 `ChatMessage`，
`store.ts` 的 `UIMessage` 改为它的类型别名并继续 re-export，避免两处各定义一份：

```ts
// lib/chat/messages.ts
export interface ChatMessage {
  id: string;                    // 客户端生成，React key + 编辑定位
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** 仅用户消息有意义：input = 普通输入（可编辑），action = 快捷操作（不可编辑） */
  kind?: 'input' | 'action';
}

// entrypoints/sidepanel/store.ts
export type UIMessage = ChatMessage;
```

```ts
// lib/db.ts
export interface ChatMessageRecord {
  id?: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  kind?: 'input' | 'action';     // 新增
}
```

`kind` 不建索引，因此**不需要 Dexie 版本迁移**。

`App.tsx:176` 的 `key={i}` 改为 `key={m.id}`。下标 key 在列表尾部被截断后重建的场景下会让 React
复用错误的 DOM 节点；现在没有截断所以未暴露，本功能会暴露它。

**取舍：快捷操作消息不可编辑。** 让它可编辑需要把真实 prompt 也持久化（`ChatMessageRecord`
再加一个 `promptContent` 字段），而编辑框里会摊开一大段划词引文，体验反而更差；用户重新点一次
「总结本页」按钮即可达到同样效果。

**取舍：存量记录（无 `kind`）按 `input` 处理。** 历史里的「📄 总结当前网页」会显示编辑入口，
编辑后把标签文字本身当 prompt 发出去，结果平庸但不致错。为此做一次数据迁移不划算。

### 2. 持久化：会话全量重写

新增 `lib/db.ts`：

```ts
/** 用当前 UI 消息整体替换某会话的全部消息，并同步会话标题与 updatedAt */
export async function replaceConversationMessages(
  conversationId: string,
  messages: ChatMessageRecord[],
  title: string,
): Promise<void>;
```

一个 `rw` 事务内：删除该 `conversationId` 的全部 messages → `bulkAdd` 传入的记录 →
upsert `ConversationRecord`（首次写入时设 `createdAt`，每次更新 `title` 与 `updatedAt`）。

`messages` 为空时只删消息，不写会话记录。

**为什么全量重写而非按主键定位删除**：截断由此退化为纯内存的 `messages.slice(0, i)`，
store 里不需要维护「UI 数组 ↔ DB 自增主键」的双向同步——那是流式渲染过程中最容易写错的一类状态。
代价是每轮 O(n) 次写入，对一个几十条消息的会话而言 IndexedDB 无感。

`persist()` 被完全取代并删除，顺带修掉它的两个现存缺陷：

- `if (!assistantContent) return`：一轮失败或被用户中止时，用户那条消息也不会落库。
  改为只要 UI 上有就写入。
- 编辑首条用户消息后会话标题不更新：改为每次重写时重算标题。

### 3. 纯逻辑下沉：`lib/chat/messages.ts`（新文件）

`vitest.config.ts` 的 `include` 只覆盖 `lib/**`，`entrypoints/` 无测试基建。
本设计的全部可测逻辑放进这个新模块：

除上文的 `ChatMessage` 外，导出以下纯函数：

```ts
/** 该消息是否可编辑：role === 'user' 且 kind !== 'action' */
export function isEditableMessage(message: ChatMessage): boolean;

/** 返回 id 对应消息的下标；未找到返回 -1 */
export function findMessageIndex(messages: ChatMessage[], id: string): number;

/** UI 消息 → DB 记录：丢弃末尾 content 为空的 assistant 消息 */
export function toMessageRecords(
  conversationId: string,
  messages: ChatMessage[],
): ChatMessageRecord[];

/** 会话标题：首条用户消息前 40 字；无用户消息时返回 '新对话' */
export function conversationTitle(messages: ChatMessage[]): string;
```

`toMessageRecords` 丢弃尾部空 assistant 消息的原因：一轮出错或被中止时 UI 上会留下一个空的
assistant 占位（`store.ts:387` 预置），落库后重开会话会渲染成一个空气泡（`App.tsx:564` 的
`content ? … : busy ? … : null` 在非 busy 时渲染空容器）。

### 4. store：`editMessage` 与 `runAgent` 的截断参数

```ts
// ChatState 新增
editMessage: (id: string, newContent: string) => Promise<void>;
```

实现：

1. `get().busy` 为真则直接返回。
2. `findMessageIndex` 定位；下标为 -1、或该消息 `isEditableMessage` 为假，则直接返回。
3. `newContent.trim()` 为空则直接返回。
4. 调用 `runAgent(set, get, display, prompt, undefined, index)`，
   其中 `display = { role: 'user', content: trimmed, kind: 'input', … }`，`prompt` 同为 `trimmed`。

`runAgent` 新增可选参数 `truncateTo?: number`：

```ts
const history = truncateTo === undefined
  ? get().messages
  : get().messages.slice(0, truncateTo);
```

**这一步必须放在 Provider 校验与 `resolveActiveTabId()` 之后**（即紧邻 `store.ts:385` 的
`const history = get().messages`），不能提前到 `editMessage` 内。前置校验失败时 `runAgent`
会 `set({ error })` 直接返回；若截断已经发生，用户的历史就被不可恢复地丢弃了，而这恰恰是
用户完全没有预期的失败路径。截断放在校验之后，前置失败时 UI 保持原样。

`runAgent` 后续逻辑（`set({ messages: [...history, display, 空 assistant] })`、
`toAgentMessages(history)`）全部不变——截断后的 `history` 天然实现了「从这条重跑」，
agent 层不需要任何分支。

持久化调用统一移入 `runAgent` 的 `finally` 块（`store.ts:507`），在 `set({ busy: false })` 之后：

```ts
const final = get().messages;
await replaceConversationMessages(
  get().conversationId,
  toMessageRecords(get().conversationId, final),
  conversationTitle(final),
);
```

`finally` 覆盖成功、模型出错、用户中止（`AbortError`）以及后台协议版本过旧的提前 `return`
四条路径，因此 `store.ts:479` 与 `store.ts:500` 现有的两处 `persist()` 调用一并删除。

`toAgentMessages`、`openConversation`、`clear`、`removeConversation` 需相应补齐
`id` / `createdAt` / `kind` 字段；`openConversation` 从 DB 记录读取 `kind`。

### 5. UI：`MessageEditor.tsx`（新文件）

`App.tsx` 已 933 行，编辑框抽为同目录下的独立组件，不再往 `App.tsx` 里塞。

**编辑入口**：用户消息气泡 hover 时，在气泡**左外侧**（气泡右对齐）浮出铅笔按钮。
样式用 `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`——纯 `hover` 会让该功能
对键盘用户不存在。`busy` 为真时不渲染入口（流式过程中打开一个提交不了的编辑框没有意义）。
`isEditableMessage` 为假的消息不渲染入口。

**编辑态**：气泡原地替换为 `<textarea>`，自动聚焦、光标置于末尾、随内容自动调整高度。
下方一行：左侧小字 `提交后将丢弃后续 N 条消息`（`N > 0` 时才显示），右侧「取消」「发送」。

**键盘**：Enter 提交，Shift+Enter 换行（与 `Composer` 的 `onKeyDown` 一致），Esc 取消。

**提交条件**：内容为空时禁用发送；内容未改动时**允许**提交——等价于「重新生成一次」，
是合理诉求，不应拦截。

**编辑态归属**：`editingMessageId` 放在 `App.tsx` 的本地 `useState`，不进 store。
它是纯视图状态，与现有的 `view` / `sidebarOpen` 处理方式一致。`conversationId` 变化时
（切换会话 / 新建会话 / 删除当前会话）重置为 `null`。

## 边界与异常

- **重跑使用当前活动标签页**，可能已不是原轮次的页面。不做特殊处理：侧边栏本就跟随当前 tab，
  用户的心智模型里「重问一次」就是对着眼前的页面问，绑回旧 tab 反而反直觉。
- **被丢弃轮次对页面的改动不会撤销**。撤销条（`turnHasChanges`）本就只覆盖最新一轮，
  `RESET_TURN_SNAPSHOT` 也只管当前轮，行为与现状一致。
- **同一会话在两个侧边栏同时打开时，全量重写会互相覆盖**。这是本方案的已知代价；
  `tab-conversation.ts` 按 tab 分配会话使该场景罕见，且现有的追加式写入在该场景下同样不正确。
- **编辑期间发起其他操作**：`busy` 时不渲染编辑入口，已打开的编辑框在 `conversationId` 变化时关闭。
- **`role: 'system'` 记录**：`openConversation` 现在会过滤掉它们（`store.ts:300`），
  全量重写会将其删除。当前代码库中没有任何位置写入 system 记录，无实际影响。

## 安全与隐私

不新增权限、网络请求或页面内容访问路径。编辑只改变发送给已配置 Provider 的对话内容，
数据流与现有的 `send()` 完全相同。删除操作仅作用于本地 IndexedDB。

## 测试

新增 `lib/chat/messages.test.ts`：

- `isEditableMessage`：普通用户消息 → true；`kind: 'action'` 的用户消息 → false；
  助手消息 → false；无 `kind` 的存量用户消息 → true。
- `findMessageIndex`：命中返回正确下标；未命中返回 -1。
- `toMessageRecords`：末尾空 assistant 被丢弃；中间的空 assistant **不**被丢弃；
  `kind` / `createdAt` 被保留；空数组返回空数组。
- `conversationTitle`：取首条用户消息前 40 字；超长被截断；仅有助手消息或空数组时返回 `新对话`。

不新增 `replaceConversationMessages` 的测试：它是几行 Dexie 事务，测它需要引入 `fake-indexeddb`
并改动 `vitest.config.ts` 的 `environment`（当前为 `node`），为几行 CRUD 建一套测试基建不划算。

不新增组件测试：`vitest.config.ts` 的 `include` 仅覆盖 `lib/**`，`entrypoints/` 无测试基建，
本设计已将全部可测逻辑下沉到 `lib/chat/messages.ts`。

## 验收标准

- [ ] 普通输入的用户消息 hover 时出现铅笔按钮；Tab 键也能聚焦到它。
- [ ] 快捷操作消息（「📄 总结当前网页」/「💬 解释：…」）不显示铅笔按钮。
- [ ] 助手消息不显示铅笔按钮。
- [ ] `busy` 期间不显示铅笔按钮。
- [ ] 点击铅笔后气泡变为 textarea，内容为原文，光标在末尾；Esc 取消，Shift+Enter 换行，Enter 提交。
- [ ] 编辑框下方显示「提交后将丢弃后续 N 条消息」，N 与实际丢弃数一致；编辑最后一条用户消息时 N = 1。
- [ ] 提交后该条之后的消息从界面消失，agent 以新内容重跑一轮。
- [ ] 关闭侧边栏后从历史列表重新打开该会话，被丢弃的消息不复活。
- [ ] 编辑首条用户消息后，历史列表中该会话的标题随之更新。
- [ ] 未配置 Provider 时点击编辑并提交：显示错误提示，且**历史消息未被丢弃**。
- [ ] 一轮对话被中止（点「停止」）后重开会话，用户消息与已生成的部分回复都在。
- [ ] `pnpm compile` 与 `pnpm test` 通过。

## 开放问题

- 无。
