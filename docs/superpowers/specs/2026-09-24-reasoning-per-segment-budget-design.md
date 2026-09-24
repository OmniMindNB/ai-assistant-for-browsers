# 推理限量改为按段：段数不再倒退，快照只带增量

- 日期：2026-09-24
- 来源：推理过程显示上线后的使用反馈，用户确认修订方向：每段单独限长，总量上限放宽作兜底，运行中快照不重复发已完成的段
- 修订对象：`2026-09-24-reasoning-display-design.md` 的 §3.2（累积与限量）和 §3.4（标题与省略提示）。其余章节不变
- 状态：待审
- 依赖：无新增权限、工具或消息类型。`ChatMessage` / `ChatMessageRecord` 新增两个可选字段，不建索引，不升 Dexie 版本

## 1. 问题

1. **很容易超过上限。** `MAX_REASONING_CHARS = 20_000` 是按消息算的总量，而一次 agent 运行的所有 LLM 调用都累积在同一条 assistant 消息上。推理模型每次调用通常会想 1,000–3,000 字，读完大段页面内容后还会更多；工具预算是读阶段 20 次，写阶段再加 40 次，宽松档翻倍。所以大约 10 次调用就会碰到上限。
2. **段数会倒退。** 超过上限后，`appendReasoning` 从最早的段开始删，删空的段整段移除。"已思考 · n 段"里的 n 因此可能停住，甚至变小。一次追加可能一下删掉好几段短的，最后一段自己在变长时也会把前面的段挤掉。
3. **编号会漂移。** "第 N 次思考"用的是数组下标，前面的段被删掉之后，剩下的段会重新编号，不再对应真实的第几次调用。
4. **运行中标题会误导人。** `live = busy && isLastMessage && !content`，模型只要说过一句正文，标题就会变成"已思考 · n 段"，哪怕推理还在继续。

20,000 这个上限原本是为了控制快照体积：快照每 48ms 整份经 Port 发给面板，并写进 `storage.session`。所以不能只把常量调大，传输方式也要一起改。

## 2. 目标与非目标

**目标**

- 段数 n 等于这条消息真实产生过推理的 LLM 调用次数。只要推理总量没超过兜底上限，段就不会被删。
- 编号"第 N 次思考"始终对应真实的调用序号，删掉前面的段也不影响。
- 运行中，每一帧快照里的推理体积有上限，而且不随运行长度增长。
- 运行期间，标题要能看出"还在进行"。

**非目标**

- 不改推理的来源和解析（原设计稿 §3.1）、不回传、不进导出、不进上下文，这些都维持原样。
- 不回填存量记录。旧记录按旧字段照常显示（§3.5）。

## 3. 设计

### 3.1 常量

定义在 `lib/agent/reasoning.ts`：

| 常量 | 值 | 作用 |
|---|---|---|
| `MAX_REASONING_SEGMENT_CHARS` | 6,000 | 单段上限 |
| `REASONING_SEGMENT_HEAD_CHARS` | 1,500 | 单段超限时保留的开头长度 |
| `MAX_REASONING_TOTAL_CHARS` | 100,000 | 每条消息的兜底总量上限 |

原来的 `MAX_REASONING_CHARS` 删除。

**这几个数怎么来的**：6,000 字大约是推理模型一次调用推理量的 2–6 倍，正常调用基本不会被截断。开头保留 1,500 字，因为模型往往在一开始写下对任务的理解和计划；结尾保留 4,500 字，因为那部分离这次调用最终的动作最近，也是用户最常想看的。100,000 字相当于约 16 段满额的推理，或者几十段正常长度的推理。按宽松档最坏 120 次调用算，这个兜底真的会触发，但对应的是极端长的运行。

### 3.2 单段：保留开头和结尾，省略中间

`appendReasoning` 按段维护：

- 段长在 `MAX_REASONING_SEGMENT_CHARS` 以内时，照常追加。
- 超过之后，这一段存成 `开头 1,500 字 + 结尾 4,500 字`：开头固定下来不再变，结尾是一个随新增量滑动的窗口，中间被挤掉的字数记进这一段的 `trimmedChars`。
- 截断点固定在 `REASONING_SEGMENT_HEAD_CHARS` 这个位置。界面据此在这一处插入"中间省略 N 字"，不需要额外存截断位置。只有段长超过上限才会截断，所以被截断的段开头一定正好是 1,500 字。

内部 buffer 从 `segments: string[]` 改成：

```ts
interface ReasoningBuffer {
  segments: string[];          // 每段存的文本（已截断的就是 开头 + 结尾）
  trimmedChars: number[];      // 与 segments 等长，每段中间被省略的字数
  droppedSegments: number;     // 兜底上限从最前面整段丢掉的段数
  droppedChars: number;        // 这些段合计的字数
  lastTurn: number | null;
}
```

### 3.3 兜底总量：整段丢最早的，但编号和段数照算

追加后如果所有段的存储总长超过 `MAX_REASONING_TOTAL_CHARS`，就从最前面**整段**丢弃，不再在段中间截断，直到总长回到上限以内。丢掉的段数和字数分别累加到 `droppedSegments` 和 `droppedChars`。**最后一段（正在增长的那段）永远不丢**：单段上限 6,000 远小于总量上限 100,000，所以这一条一定能满足。

段数 n 和编号都按 `droppedSegments + 下标` 计算，所以即使兜底触发，n 也不会倒退，编号也不会漂移。

### 3.4 消息字段

`ChatMessage` 和 `ChatMessageRecord` 的变化：

| 字段 | 状态 | 含义 |
|---|---|---|
| `reasoning?: string[]` | 不变 | 每段存的文本 |
| `reasoningTrimmedChars?: number[]` | 新增 | 与 `reasoning` 等长；只要有一段被截断就整组写出，否则不写 |
| `reasoningDroppedSegments?: number` | 新增 | 最前面有多少段不在 `reasoning` 里；为 0 时不写 |
| `reasoningOmittedChars?: number` | 保留 | 改为只表示"最前面被丢掉的段合计多少字"；为 0 时不写 |

`reasoningOmittedChars` 保留原名：存量记录里它表示"最前面被删掉的字数"，与新含义一致，所以旧记录不需要迁移。

`toMessageRecords`、`store.ts` 的读库映射，以及 `reasoningMessageFields` 都要补上这两个新字段。`conversation-export.ts` 的守卫测试也要覆盖它们，确保不会进入导出。

### 3.5 快照：已完成的段不重复发送

运行中（busy）的快照在现有的 `stripHistoryReasoning`（去掉历史消息的推理）之外，对**最后一条消息**再做一次瘦身：

- **平时**：`reasoning` 只带最后一段（`reasoningTrimmedChars` 同样只带最后一个元素），另设一个**只在传输中使用**的字段 `reasoningUnsentSegments = 没发送的已完成段数`。`reasoningDroppedSegments` 和 `reasoningOmittedChars` 仍然只表示兜底真实丢弃的部分。
  - 为什么要单独设一个字段，而不是把没发送的段也计进 `reasoningDroppedSegments`：那样的话，收尾的完整快照到达时，面板分不清"前面这些段是被兜底丢掉的"还是"只是这一帧没发"，就会把真正已经丢弃的段从自己手里补回来，界面显示的内容和落库的对不上。
  - `reasoningUnsentSegments` 挂在 `ChatMessage` 上，但 `toMessageRecords` 不写它，所以不会进入 Dexie。
- **段数变化的那一帧发完整的**：新的一段刚出现时（即 `droppedSegments + segments.length` 比上一次广播时大），这一帧带上所有已完成的段。这时上一段已经定型，面板收到的就是它的最终版本。
- **`attachPort` 返回完整快照**：面板中途重开或新挂上来时，手里什么都没有，所以第一帧要完整。

实现上，`snapshotOf` 增加一个参数 `full: boolean`；`RunState` 记录上次广播时的段数，用来判断"段数变化"。

**面板合并**：`restoreStrippedReasoning` 扩展为按段合并。收到带 `reasoningUnsentSegments = k` 的消息时，从自己手里同 id 的消息中，按绝对段号（`droppedSegments + 下标`）取出缺的那 k 段补在前面，并去掉这个传输字段。补不上的时候（理论上不会发生，因为 Port 消息是有序的，而且挂载时的第一帧是完整的），就把 k 并进 `reasoningDroppedSegments`，同时去掉 `reasoningOmittedChars`，因为这时已经说不准省略了多少字。这样编号仍然正确，块顶显示"更早的 k 段已省略"。这个"并进去"的操作叫 `foldUnsentReasoning`。

**体积**：平时每帧最多约 6,000 字；完整帧每次 LLM 调用只发一次，最多 100,000 字。

**孤儿恢复的代价**：`storage.session` 里存的是瘦身后的快照。worker 中途被回收时，`scanForOrphans` 写回 Dexie 之前先对消息做 `foldUnsentReasoning`，所以最后一条消息只有最后一段的推理，但编号正确，块顶会显示"更早的 k 段已省略"。这和原设计稿已经接受的"孤儿恢复会丢历史推理"是同一类代价，而且只影响推理，不影响正文。

### 3.6 界面

- **标题**
  - 运行中且是最后一条消息：显示"思考中 · 第 n 段"（只有一段时显示"思考中…"），与有没有正文无关，n 为 `droppedSegments + segments.length`。
  - 结束后，或者不是最后一条消息：显示"已思考 · n 段"（只有一段时显示"已思考"）。
  - **自动展开**仍然按原来的 `live` 条件（`busy && isLastMessage && !content`）判断：正文出来后照样自动折叠，只是标题保持进行时。所以 `ReasoningBlock` 的属性要把 `live` 拆成两个：`running`（决定标题）和 `autoExpand`（决定默认展开）。
- **编号**：显示"第 {droppedSegments + index + 1} 次思考"。
- **省略提示**
  - 段内：被截断的段，在第 1,500 字之后插入一行"…中间省略 N 字…"。
  - 块顶：`reasoningDroppedSegments > 0` 时显示"更早的 {k} 段已省略"，如果有字数就追加"（约 N 字）"。旧记录只有 `reasoningOmittedChars` 而没有 `reasoningDroppedSegments`，这时沿用原来的"更早的 N 字已省略"。
- 新增文案走 `lib/i18n`，zh 和 en 都要加：`chat.reasoning.liveSegment`、`chat.reasoning.trimmed`、`chat.reasoning.droppedSegments`、`chat.reasoning.droppedSegmentsWithChars`。

## 4. 测试

| 层 | 文件 | 覆盖点 |
|---|---|---|
| 纯函数 | `lib/agent/reasoning.test.ts` | 单段超过 6,000 字后是"开头 1,500 + 结尾 4,500"，并且开头不再变化；`trimmedChars` 累加正确；超过总量上限时整段丢弃最早的段，最后一段永远保留；`droppedSegments + segments.length` 单调不减；最后一段变长时不会挤掉前面的段（除非触发兜底） |
| 快照瘦身 | `lib/agent/reasoning.test.ts` | 平时只带最后一段，并且 `droppedSegments` 偏移正确；`full` 时完整；历史消息剥离仍然生效 |
| 后台 | `run-registry.test.ts` | 新段出现的那一帧是完整的；`attachPort` 返回完整快照；busy:false 的收尾快照完整；落库的是完整数据 |
| 面板合并 | `lib/chat/messages.test.ts` | 能按段补齐；补不上时保留偏移、不崩；旧的按消息补回逻辑保持不变 |
| 持久化 | `messages` / `store-context` / `conversation-export` 测试 | 新字段往返一致；不进导出 |
| 界面 | `ReasoningBlock.test.tsx` | 运行中有正文时标题仍然是"思考中 · 第 n 段"，并且已经折叠；编号带偏移；段内省略提示插在截断点；块顶显示"更早的 k 段已省略"；旧记录显示原来的字数文案 |

## 5. 待验证事项

- 6,000 / 1,500 / 100,000 这几个值要在 DeepSeek-reasoner、Qwen3 的真实长任务上看一看：大多数段是否都在 6,000 字以内，以及完整帧带来的一次性传输有没有造成可感知的卡顿。
