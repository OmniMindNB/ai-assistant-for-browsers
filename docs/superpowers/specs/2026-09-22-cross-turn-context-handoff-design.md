# 跨轮上下文交接：把图片和工具足迹带过轮次边界

- 日期：2026-09-22
- 来源：用户问"多轮对话时历史是怎么处理的"，通读后发现两处跨轮失效：贴图后的追问看不到原图；上一轮的工具产物（fieldId 句柄）跨轮全丢，接着操作必须重读一遍
- 状态：设计中
- 依赖：无新增权限、无新增工具、无新增消息类型。不改 Dexie schema，不改 `lib/messaging.ts`，不改 `run-port-protocol.ts`

## 1. 现状：历史在轮次边界上被压平成纯文本

`run-registry.ts` 的 `startRun` 每轮新建一个 `Agent`，用面板传来的 `historyMessages` 做初始上下文。翻译由私有函数 `toAgentMessages`（`run-registry.ts:168`）完成，它对 user 消息只取 `content` 字符串，对 assistant 消息只取文本。

于是**每一次轮次边界都是一道信息闸门**，被关在门外的有三类：

| 内容 | 现在的下场 | 后果 |
|---|---|---|
| user 消息的图片附件 | 丢 | 贴图后的追问，模型手里没有图 |
| 上一轮的 toolCall / toolResult | 丢 | 模型不知道自己上轮做过什么 |
| `browser_get_form` / `browser_find_text` 发放的 fieldId | 丢（模型侧） | 接着操作必须重跑一次读取，而 LLM 往返占端到端 96% |

第三行要说清楚："丢"只发生在**模型的上下文里**。句柄表本身活得好好的——`tab-form-fields.ts` 把它存在 `browser.storage.session` 里，按 tabId 键，而 `clearFormFieldsForTab` **在生产代码里没有任何调用点**，表一直活到浏览器重启。也就是说句柄依然有效，只是模型看不见了，只好重新问一遍。

## 2. 两个失效各自的形状

### 2.1 图片：数据一直都在，只是没被用

先纠正一个容易得出的错误判断："历史只存附件元数据，所以图片跨轮恢复不了"。**不成立。** `ImageAttachment` 带完整的 `dataUrl`（`attachments.ts:26`），`MessageAttachment` 进了 `ChatMessageRecord.attachments`（`db.ts:32`），也就是说图片数据既在内存的 `ChatMessage` 里，也已经落在 IndexedDB 里，面板重载后照样恢复。

真正缺的只是一个分支：`UserMessage.content` 本来就接受 `(TextContent | ImageContent)[]`（`pi-ai/dist/types.d.ts:194`），而 `toAgentMessages` 只往里放字符串。

这条失效在截图侧有个镜像：`agent.ts` 的 `compactWindow` 专门给最新一张截图开了 `lastScreenshotIndex` 豁免，理由写得很清楚——"否则多步视觉任务会退化成看一眼就失忆"。那条豁免只在**单轮内**成立，跨轮一样清零。本设计把同一条心智模型延伸到轮次边界，用的是同一套规则而不是第二套。

### 2.2 工具足迹：安全失败已经由句柄表自己保证了

跨轮复用句柄听起来危险——页面可能已经变了，旧的 fieldId 会不会点到别的元素上？

不会，而且这道锁是现成的：`FormFieldTable` 带 `url`，写入时比对，不符即判"表已过期"（`tab-form-fields.ts:29`）；每次写入还要过结构指纹与读回校验（Spec-0005）。也就是说**失效路径是"报一个 mismatch 失败"，不是"点错元素"**。`field-id-allocation.ts` 里那个"同组 radio 指纹相同"的已知缺口也不因本设计扩大：它是同一张表内的编号问题，与是否跨轮无关。

这让本设计可以走到"句柄级"而不只是"叙事级"——后者（只复述上轮做了什么）根本达不到初衷，模型仍然得重跑一次 `browser_get_form`，省不下那一轮。

### 2.3 ⚠️ 一条必须堵住的脱敏绕过

`browser_get_form` 交给模型的渲染结果是过了 `redactText` 的（`tools.ts:438`）。但 `storage.session` 里存的句柄表是**原始 label**——它存的是写入校验要用的 `expect`，从来没打算给模型看。

所以"直接拿句柄表拼一段文字塞进上下文"会新开一条绕过脱敏的路：同一个手机号，走 `browser_get_form` 被替换成占位符，走本设计的交接块却原样进了模型上下文。**交接块整块必须过 `redactText`**，这是本设计最硬的约束，不是可选的加固。

## 3. 方案：一个模块，一条不变量

新建 **`lib/agent/turn-context.ts`**，主题是"把面板历史翻译成模型上下文"。`toAgentMessages` 从 `run-registry.ts` 迁进来，`buildTurnHandoff` 新增。

两件事合成一个模块而不是两份改动，是因为它们共用同一条不变量：**轮次边界上做什么取舍，只有这一处**。拆开会让这条不变量分居两地，正是仓库里反复出现的常量漂移形状（见 `context-budget.ts` 头注释记的那次：模型自以为的上限和真正执行的上限来自两个常量，结果模型收到两条互相矛盾的截断提示）。

迁出 `run-registry.ts` 还顺带解决一件事：`toAgentMessages` 现在是私有函数，测不到；而 `entrypoints/` 没有任何 vitest project 匹配（`vitest.config.ts` 的三个 project 都只覆盖 `lib/**` 和 `components/**`）。这与 `fill-form-request.ts`、`read-request.ts`、`lib/chat/messages.ts` 的提取理由完全相同，是仓库里已经成立过三次的模式。

### 3.1 Part A：图片跨轮回放

`toAgentMessages` 增加分支：

1. 从后往前找**第一条带 image 附件的 user 消息**，记为"回放消息"。
2. 回放消息的 content 渲染成 `[{ type: 'text', text }, ...images]`，图片用现成的 `toImageContent`（`attachments.ts:139`）转换。
3. 更早的带图 user 消息，在文本末尾缀一行占位：`[图片 <name> 已移出上下文，如需要请用户重新发送]`。

按**消息**而不是按**张数**划界，是因为用户的心智是"我刚贴的那几张还在"——同一条消息里的 1-5 张图要么都在要么都不在，中间砍一刀解释不通。上限由 `MAX_ATTACHMENTS_PER_MESSAGE`（5）天然兜住。

占位文案与 `agent.ts` 里 `[截图已移出上下文，如需重新查看请再次截图]` 同一套口吻，但**不能照抄结尾**：用户附件重截不了，唯一的出路是请用户重发，文案必须指向那条出路而不是一个模型做不到的动作。

**字节兜底。** 单张附件上限 5MB、每条最多 5 张，所以"整条消息的图全回放"最坏情况是 25MB 的请求体。这个体积今天在第一轮就已经可能发生，回放不会抬高峰值——但会让它**常驻**于其后每一轮。因此：

```
MAX_REPLAYED_IMAGE_BYTES = 4 * 1024 * 1024
```

按 `attachment.size` 从第一张开始累加，装不下的降级为占位。第一张**无条件保留**，哪怕它自己就超预算——这与 `recutStartForCharBudget` 里"末尾那条无条件保留"是同构的兜底：一条只剩占位符的图片消息，比一条超预算的请求更没用。

口径必须写在常量旁边：这里量的是**解码后字节**（与 `MAX_ATTACHMENT_IMAGE_BYTES` 同口径），请求体里的 base64 实际约为其 4/3；它与 `context-budget.ts` 的 `IMAGE_CHAR_EQUIVALENT`（字符当量，5000）是**两套量表，不得互相换算或替代**——后者量的是"折算成 token 有多贵"，前者量的是"请求体有多大"，正是 `contextCostChars` 头注释里强调过的那个区别。

预算侧零改动：`contextCostChars` 已经按 `IMAGE_CHAR_EQUIVALENT` 计图片，`compactWindow` 只摘要 toolResult，user 消息本来就豁免压缩。

### 3.2 Part B：轮次交接块

```ts
export function buildTurnHandoff(input: {
  lastAssistant?: ChatMessage;      // 取 activitySteps
  table?: FormFieldTable;           // storage.session 里的句柄表
  targetUrl?: string;               // 当前操作目标 tab 的真实 URL
  redaction: RedactionSettings;
}): string | undefined;
```

产出一条 `[系统观察]` 前缀的文本，由 `startRun` 包成 user 消息，**追加在翻译后的历史之后、本轮用户内容之前**。前缀沿用 `agent.ts:391` 导航通知已有的口吻，模型已经在同一套约定下工作。

两段，各自可缺省，都缺则返回 `undefined`（绝不发空消息）：

**足迹段** — 取最后一条 assistant 消息已落库的 `activitySteps`（`ChatMessage.activitySteps` 现成，无需新数据），只要 `done` / `failed`，上限 `MAX_HANDOFF_STEPS = 8`，超出只报"另有 N 步"。

措辞必须点明时效：`本会话上一轮的执行足迹（可能已过时，页面当前状态以工具读取为准）`。这是有意用文案而不是用时效阈值来处理"隔了三天重开会话"那种情况——阈值需要一个没有依据的魔数，而同样的危害用一句措辞就能零成本消掉。

**句柄段** — **仅当 `table.url === targetUrl` 时输出**，复用 §2.2 那道现成的锁，而不是自己发明一套新鲜度判断。输出 fieldId + label，上限 `MAX_HANDOFF_HANDLES = 20`，超出报"另有 N 个，调用 `browser_get_form` 查看完整列表"。

`targetUrl` 取 `session.currentTabId`（`startRun` 里已经 `loadTabSession` 过）对应 tab 的当前地址，经 `browser.tabs.get` 查询；查不到就跳过句柄段——失败即降级、不阻塞，与 `beforeToolCall` 里 `resolveSubmitIntent` 的既有处理一致。

整块过 `redactText`，见 §2.3。

`withoutBrowserTools`（`selection` / `none` scope 的快捷指令，本来就不给浏览器工具）时整块跳过：那种轮次里句柄和足迹都没有意义。

### 3.3 两条关键性质

**不累积。** 交接块不进 `ChatMessage`、不落 Dexie、不进 `RunSnapshot`，每轮由 background 现算一条。所以第 N 轮的交接块不会出现在第 N+1 轮的历史里——不存在滚雪球。

**不动稳定前缀。** 它追加在历史末尾，`anthropic-stream.ts` 的两个 cache breakpoint（`system` 的稳定半截、最新消息的最后一个 block）都不受影响；它落在最新消息一侧，本来就是每轮都变的那一半。

**已知的次要影响**：交接块多插一条 user 消息，会改变消息的奇偶。`agent.ts:744` 的注释记过这个坑——切点落到无主 toolResult 上会让供应商直接判 400，而当初正是 `afterToolCall` 的 steer 插入单条 user 消息才暴露出来的。`windowWithIntactToolCalls` / `alignToToolCallBoundary` 已经为此加固过，本设计不引入新的切点形状（交接块在 run 开始时插入，位置固定，后面才产生 tool 消息），但回归用例要覆盖"带交接块的历史被窗口切过"这一种。

## 4. 被否掉的方案

**只做叙事级足迹（复述上轮做了什么，不带句柄）。** 数据全现成、风险最低，但达不到初衷：模型仍看不到 fieldId，接着操作还是得重跑一次 `browser_get_form`，省不下那一轮往返——而"省那一轮"正是 #2 存在的理由。

**只做句柄级（每轮注入可用句柄，不管上轮做过什么）。** 最直接地对准"省一轮"，但模型不知道上轮已经点过提交、已经填过哪几项，重复操作的风险反而上升。

**按张数回放最近 N 张图。** 与用户心智不符：用户记得的是“我刚贴的那条消息”，不是“最近 3 张”，同一条消息里的图被拦腰砍开没法解释。按消息划界还让上限由既有的 `MAX_ATTACHMENTS_PER_MESSAGE` 天然给出，不必再引入一个张数常量。§3.1 的字节兜底是架在这之上的次级保险，不是划界依据。

**给足迹加时效阈值。** 见 §3.2：魔数换措辞。

**把 `toAgentMessages` 留在 `run-registry.ts` 原地改。** 测不到——`entrypoints/` 没有 vitest project 匹配。

## 5. 测试

新增 `lib/agent/turn-context.test.ts`（`unit` project，node 环境）：

*Part A*
- 只有最新那条带图 user 消息保留 `ImageContent`，更早的降级成占位文本
- 同一条消息里的多张图整体保留（按消息划界）
- 累计字节超过 `MAX_REPLAYED_IMAGE_BYTES` 时后续张降级为占位
- 第一张自身即超预算时仍然保留（无条件兜底）
- 无图历史的翻译结果与现状逐字节一致（回归保护）

*Part B*
- `table.url` 与 `targetUrl` 不符时不输出句柄段，足迹段照常
- 足迹与句柄都为空时返回 `undefined`
- 句柄 label 里的敏感串确实被 `redactText` 替换（**这条用例就是 §2.3 那条约束的执行者，不得删改**）
- 步数/句柄数超上限时截断并报出剩余数量

*调用方*（`run-registry.test.ts`，`buildTurnHandoff` 本身不知道有没有浏览器工具——那是 `startRun` 的决定，用例也就该落在调用方）
- `withoutBrowserTools` 时不追加交接消息
- 交接块为 `undefined` 时不追加空消息

*回归*
- `agent.test.ts` 补一条：历史里带交接块时，窗口重切后不产生无主 toolResult

## 6. 影响面清单

| 文件 | 改动 |
|---|---|
| `lib/agent/turn-context.ts` | 新建：迁入 `toAgentMessages`，新增 `buildTurnHandoff` 与三个常量 |
| `lib/agent/run-registry.ts` | 删去私有 `toAgentMessages`，改为 import；`startRun` 里查 URL、读句柄表、追加交接消息 |
| `lib/agent/turn-context.test.ts` | 新建 |
| `lib/agent/run-registry.test.ts` | 补调用方用例 |
| `lib/agent/agent.test.ts` | 补一条回归用例 |
| `CLAUDE.md` | "Agent runs in the background" 一节补 `turn-context.ts` 的条目 |

不改：Dexie schema、`lib/messaging.ts`、`run-port-protocol.ts`、面板 UI、权限清单。
