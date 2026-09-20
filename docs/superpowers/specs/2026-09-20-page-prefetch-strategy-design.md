# 页面预取策略设计：快捷方式首轮该把多少正文交给模型

- 日期：2026-09-20
- 来源：用户让评估"总结本页"快捷方式有哪些可优化的地方。评估列出的两条最实质问题——正文被静默截断、空正文也算预取成功——都落在同一段代码里（`entrypoints/sidepanel/store.ts` 的 page-scope 预取），因此并成一份稿子
- 状态：待实现
- 依赖：无新增权限，无新增工具，无新增消息类型（`PageContent` 加一个可选字段）

## 1. 问题

`scope: 'page'` 的快捷方式（总结本页 / 专注阅读 / 帮我填表，以及用户自建的同类）在发给模型之前，会先由面板预取一遍正文塞进首轮 user turn，省掉模型自己调 `browser_read_page` 那一整轮往返（ref: `lib/chat/shortcut-prompts.ts` 头部注释，以及侧边栏耗时实测——LLM 往返占 96%，减少轮数是唯一有效的提速杠杆）。

这层预取目前有两个失效方向：

**一、长正文被静默切掉，模型不知道自己没读完。** `store.ts:1237` 直接 `text.slice(0, DEFAULT_READ_MAX_CHARS)`，然后 `store.shortcutPagePrompt` 告诉模型"请直接使用"。对比 `browser_read_page`（`lib/agent/tools.ts:236-278` + `lib/agent/page-read-window.ts`）：那条路径会回报正文总长、本次窗口区间、剩余字符，并给出可执行的下一步。预取路径把这套全丢了。后果是长报告、长帖、文档页只总结了前 24000 字符，而内置提示词里"如果正文明显不完整就直说"这条约束根本触发不了——模型看到的正文在它眼里是完整的。

**二、空正文也算预取成功。** `shortcut-prompts.ts` 只判断 `if (pagePrefetch)`，而 `entrypoints/content.ts:93` 的 `extractPage` 在 Readability 失败且 `body.innerText` 为空时，会正常返回 `text: ''`。Chrome 内置 PDF 阅读器、canvas 类应用、尚未渲染完的 SPA 都会命中：模型收到一个空 JSON 串，同时被告知"请直接使用，只有需要额外内容时才再调 browser_read_page"，于是倾向于直接回"页面内容太少"，而不是回退到工具路径重试。

两件事是同一个判断的两端：**预取层到底该交出什么，以及什么时候该承认自己交不出来。**

## 2. 为什么不靠 offset 续读

`browser_read_page` 已经支持 `offset` 分段续读（ref: `page-read-window.ts`，起因是 docsify 文档站 38641 字符的一章读不到后半段）。最省事的修法似乎是让预取也回报截断信息，让模型自己续读。不采用，两个原因：

1. **每续读一次多一整轮 LLM 往返**，而轮数正是这条快捷方式当初做预取要省的东西。
2. **边读边丢**：`compactAgentMessages` 会把上一段只读结果压成一行摘要移出上下文（ref: `page-read-window.ts:57-63` 的注释）。读到第三窗时，第一窗只剩一句话。那套机制是为"定位某个小节"设计的，不是为"通读全文后总结"设计的。

真正的关键事实是：**面板这边本来就握着全文**。`EXTRACT_PAGE` 返回的是完整正文，24000 那一刀是我们自己切的。所以这里不需要用往返去换内容，只需要决定单轮之内塞什么。

## 3. 方案

新增 `lib/chat/page-prefetch.ts`，一个纯函数 `planPagePrefetch(page)` 给出三个分支；`store.ts` 只保留 I/O，`shortcut-prompts.ts` 按分支选文案。抽成纯模块的理由与 `fill-form-request.ts` 一致：没有任何 vitest project 匹配 `entrypoints/**/*.test.ts`，逻辑留在 store 里就等于没有测试。

| 分支 | 条件 | 交出什么 |
|---|---|---|
| `skip` | `text.length < MIN_PAGE_PREFETCH_CHARS`（200） | 不设 `pagePrefetch`，退回现有工具路径 |
| `full` | `length <= MAX_PAGE_PREFETCH_CHARS`（48000） | 全文 |
| `windowed` | 超出上限 | 头 32000 + 尾 16000 + 标题骨架 + 省略说明 |

**`skip` 是回退而不是报错**：模型仍然可以自己调 `browser_read_page`，读不到就如实说读不到。这比拿着空串断言"页面内容太少"诚实，也给了 PDF 阅读器这类页面一次正常失败的机会。阈值取 200 字符：比它更短的"正文"在实践中只会是骨架页或错误页，不足以支撑任何 page-scope 任务。

**上限直接取 `MAX_TOOL_RESULT_CHARS`（48000），不新造常量。** 理由同 CLAUDE.md 里"读取上限收拢到单一来源"那条：预取正文和工具结果最终进的是同一个上下文，各写各的迟早分叉，而分叉的表现是模型收到两条互相矛盾的截断提示。

**头尾按 2:1 切。** 开头承担"这是什么页面、在讲什么"，结尾承担"结论是什么"——现行的纯头部截断恰好把结论、总结、结语全丢掉了。中段是最能被标题骨架替代的部分。

**适用范围是全部 page-scope 快捷方式**，不新增"读类/写类"维度。只有超过 24000 字符的页面才会多花 token，且只在首轮；"帮我填表"本来就靠页面上下文推断字段值，多出来的正文对它不是坏事。（YAGNI：等真出现费用问题再谈分档，届时还要顺带决定自定义 page 快捷方式归哪一档。）

### 3.1 标题骨架

`lib/page-outline.ts` 导出 `collectOutline(doc)`，`content.ts` 的 `extractPage` 调用它，`PageContent`（`lib/messaging.ts:85`）加可选字段：

```ts
outline?: Array<{ level: 1 | 2 | 3; title: string }>;
```

来源：Readability 解析出的 `article.content`（HTML）用 `DOMParser` 再解一次，取 h1–h3；Readability 整体失败走 `innerText` 回退时，从原始 `document` 取。上限 60 条、单条 80 字符，避免长目录页把骨架撑爆。

**刻意不记录每个标题在正文中的字符偏移。** 偏移很诱人（可以精确标出"中段省略了 §4.2–§7.1"），但 `extractActivePage`（`entrypoints/background.ts:594`）在返回前会跑 `redactText`，脱敏是整串替换、长度会变，正文一改偏移就全错。一个默默偏掉的偏移比没有偏移更坏——它会让模型言之凿凿地引用一个不存在的位置。模型实际需要的信息是"中段还有哪些小节"，拿标题原文配 `browser_find_text` 就够精准。

### 3.2 文案

`store.shortcutPagePrompt` 保持不变，服务 `full` 分支。新增 `store.shortcutPageWindowedPrompt`，服务 `windowed` 分支，要点（参照 `page-read-window.ts:57-63` 的教训——被动的一句"已截断"会让弱模型直接放弃，而不是补读）：

- 正文总长、头尾各自的区间、中段省略的字符数，都给确切数字；
- 明确"这是同一个页面的首尾两段，不是两个页面"；
- 下一步是可执行的：需要中段细节时用 `browser_find_text` 搜小节标题，**不要**用 `browser_read_page` 顺序遍历（会触发边读边丢）；
- 标题骨架单独成块，标明它覆盖全文、包括被省略的中段。

两份 i18n 词典（`lib/i18n/locales/zh.ts` / `en.ts`）同步。

## 4. 安全与预算边界

- **骨架标题同样是页面来源的不可信文本**，在 `background.ts` 跟正文一起过 `redactText`，并沿用既有的"不可信页面内容"前缀，不因为它"只是标题"就放行。
- 权限模型一条都不动：预取仍然只经由 `EXTRACT_PAGE`，不碰任何写工具，不改 `permissions.ts` 的分级。
- **上下文预算**：`full` 分支最大 48000 字符的 user turn，叠加后续工具结果有可能触到 `MAX_CONTEXT_CHARS`（90000）的重切水位。这是可接受的——`compactAgentMessages` 永远保留最后一条消息，且重切每轮至多一次；预取正文进的是 user turn，不会被压成一行摘要。

## 5. 测试

- `lib/chat/page-prefetch.test.ts`（unit）：三个分支的边界（199/200 字符、48000/48001 字符）、头尾切分区间、省略字符数算得对、骨架条数与单条长度截断。
- `lib/page-outline.dom.test.ts`（dom project，jsdom）：h1–h3 层级与顺序、嵌套与空标题、超限截断、Readability 失败时的 `document` 回退。
- `lib/chat/shortcut-prompts.test.ts` 补：`windowed` 结果拼出的 prompt 含头尾两段与骨架；`skip` 结果不带任何页面块（等价于现有的"预取失败"路径）。

## 6. 这份稿子不做的事

- **本地分块 map-reduce**（把全文切块多次调用后合并）。保真度最高，但把一次往返变成 N 次。要做就做成显式的"深度总结"快捷方式，不能是默认行为。
- **改 `browser_read_page` 让它也回报骨架**。`PageContent` 加了字段之后这件事变得很便宜，但它属于工具层，与本稿的单轮预取无关。
- 评估里的另外两条发现——page-scope 快捷方式拿到全量写工具（需要给 `ShortcutScope` 加只读档）、受限页面上快捷方式芯片仍可点（`WorkbenchComposer.tsx:510` 忽略 `pageAttach` 状态）——各自独立，另开稿子。

## 7. 影响面

`lib/chat/page-prefetch.ts`（新）、`lib/page-outline.ts`（新）、`lib/messaging.ts`、`entrypoints/content.ts`、`entrypoints/background.ts`、`lib/chat/shortcut-prompts.ts`、`entrypoints/sidepanel/store.ts`、`lib/i18n/locales/{zh,en}.ts`。

顺手修掉 `shortcut-prompts.ts` 头部注释里过期的"12000 字符"（实际是 `DEFAULT_READ_MAX_CHARS` = 24000，本稿之后是 `MAX_PAGE_PREFETCH_CHARS`）。
