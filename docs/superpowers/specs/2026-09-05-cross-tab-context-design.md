# 跨标签页上下文设计：用户点选的只读标签页引用

- 日期：2026-09-05
- 来源：2026-09-05 对标 Perplexity Comet 的能力盘点。Comet 侧边栏最被称道的能力是"这几个标签页有什么共同点"，而 Runi 在 `lib/agent/tab-session.ts` 顶部的隐私边界里主动放弃了它
- 状态：设计已确认，未实现
- 依赖：无新增 manifest 权限（`tabs` 已有）

## 1. 问题

Runi 的 agent 今天只能看见两类标签页：面板自己绑定的那一个，以及它通过 `browser_open_tab` 自己打开的那些。`TabSessionController` 的文件头注释把这条边界写得很硬——"不查询、不暴露用户自己开着的其他标签页"（ref: 2026-08-26-multi-tab-orchestration-design.md §3.2）。

这条边界保护的是真实的隐私利益，但它同时挡掉了一整类高频任务：

- "把这三个标签页的方案对比一下"
- "这几个页面讲的是不是同一件事"
- "我开着的这两篇文档，哪篇提到了 X"

今天用户只能一个个页面手动切过去问，或者让 agent 用 `browser_open_tab` 重新打开一遍——后者对需要登录态的页面直接不可行，而且丢掉用户已有的滚动位置、已展开的筛选、已填的表单状态。

问题的本质不是"边界划错了"，而是**边界只有一档**：要么 agent 完全看不到，要么它得自己去开。中间缺的是"用户明确点名的这几个页面"。

## 2. 目标 / 非目标

**目标：**

- 用户在输入框用 `@` 点选当前窗口的标签页，被点选的页面进入会话上下文。
- 被点选的页面**只读**：模型可以对它们用全部读类工具，写类工具一律拒绝。
- 授权持续到用户移除、标签页关闭或会话切换，多轮追问不必重选。
- 隐私边界不放松：agent 仍然不能自主枚举用户的标签页。

**非目标：**

- 不做跨窗口列表（见 §3.3）。
- 不做 URL 漂移检测。引用的是标签页而不是"那一版内容"，用户导航走了就是导航走了。
- 不把授权写进 IndexedDB。历史会话不恢复授权（见 §8）。
- 不放宽 Deny-First。本设计只新增拒绝，不新增任何自动执行。

## 3. 设计取舍

### 3.1 为什么是"快照 + 只读工具"，而不是纯快照

纯快照（点选即抓正文、一次性塞进首轮、之后 agent 碰不到这些 tab）实现最简单，且隐私边界最硬。否掉它的原因有两条，第二条是决定性的：

1. 页面正文超出截断上限的部分就永远拿不到了，"去那个标签页里找一下 X"这类任务会失败。
2. **上下文经济性反而更差。** 5 个标签页的正文同时进首轮，按现有 `PAGE_PREFETCH_MAX_CHARS`(12000) 就是 60000 字符，会把 `MAX_CONTEXT_MESSAGES`(48) 的窗口直接挤爆；而按需读取的结果是工具结果，`transformContext` 的压缩管线本来就会处理它们。

完全授权（点选的 tab 与 agent 自开的一视同仁，读写全放开）能力最强，但把用户已登录的页面暴露给写操作，Deny-First 的叙事要整个重写。不做。

### 3.2 为什么授权状态挂在 `TrackedTab` 上

`TrackedTab` 增加 `access: 'full' | 'read'` 字段，而不是另起一张 `referencedTabs` 表。

另起一张表能让隐私边界在类型上更显眼，但 `browser_list_tabs` / `browser_switch_tab` / `browser_close_tab` / 回合目标解析全都已经围绕 `trackedTabs` 写成，两张表意味着每一条路径都要做一次合并——漏掉任何一处就是越权。挂在现有结构上还白拿了 `tab-session-storage.ts` 已经解决的 Service Worker 回收持久化。

### 3.3 为什么只列当前窗口

用户心里的"这几个标签页"几乎总是同一个窗口里的。列出全部窗口会把用户所有开着的页面标题一次性摆到面板上，标签页开得多的人会觉得冒犯，而收益只覆盖很窄的跨窗口对比场景。列表本身只在面板本地渲染、不进模型上下文，但"面板上出现了什么"本身就是用户感知隐私的一部分。

### 3.4 为什么不复用 `EXTRACT_PAGE` 之外的抓取通道

`EXTRACT_PAGE` 在 `entrypoints/background.ts` 的 `extractActivePage()` 里统一做脱敏（ref: 2026-08-31-page-redaction-pipeline-design.md §5）。任何新开的正文抓取通道都等于绕过脱敏管线。复用它，脱敏是白拿的。

## 4. 状态与权限模型

### 4.1 `TrackedTab.access`

```ts
export interface TrackedTab {
  id: number;
  title?: string;
  url?: string;
  /** 'full' = agent 通过 browser_open_tab 自己打开的；'read' = 用户 @ 点选引用进来的。缺省视为 'full'（向后兼容已持久化的快照）。 */
  access?: 'full' | 'read';
}
```

- `openAndSwitch()` 登记的 tab 是 `'full'`（行为不变）。
- 新增 `reference(tabs: TrackedTab[])`：以 `'read'` 登记用户点选的标签页，**不改变** `currentTabId`——引用不等于把操作目标挪过去。语义是**按传入列表全量同步 `'read'` 项**（新增、更新 title/url、移除不在列表里的），`'full'` 项一律不动。全量而不是增量，是因为每一轮 `StartRunRequest` 都会带上面板当前的完整引用列表；增量语义下用户移除 chip 这件事就传不过来，授权会悄悄留在后台。
- 面板绑定的 tab 永远是 `'full'`，被点选时不降级、不重复登记。
- 引用上限 `MAX_REFERENCED_TABS = 5`（定义在 `tab-session.ts`，与控制器同处一文件，避免上限和执行分家），与 `MAX_ATTACHMENTS_PER_MESSAGE` 对齐，用户对这个数已有直觉。`TAB_REF_TOTAL_MAX_CHARS` 与 `planTabRefBudget` 同处一个新文件 `lib/chat/tab-reference.ts`——它属于"消息怎么拼"，不属于标签页会话状态。

### 4.2 `lib/agent/tab-access.ts`（新增，纯函数）

`decideToolPermission(toolName, args)` 是只看参数的纯函数，压根不知道目标是哪个 tab。把 per-tab 规则塞进去会毁掉"工具分级只有一处事实来源"这条性质（`permissions.ts` 顶部的表注释）。所以新开一道闸门：

```ts
export type TabAccessDecision = { allowed: true } | { allowed: false; reason: string };

export function decideTabAccess(toolName: string, target: TrackedTab | undefined): TabAccessDecision;
```

规则：

1. `WRITE_TOOL_NAMES` 中的工具作用在 `access: 'read'` 的 tab 上 → 拒绝。`browser_close_tab` 已在该表内，因此本条已覆盖它；但它的后果不可逆（关掉的是用户自己的页），实现时要有一条独立用例把它锁住，避免日后有人把它挪出写工具表时悄悄放行。
2. 目标 tab 在 `trackedTabs` 里查不到（`target === undefined`）→ 拒绝。保守默认：解析不出目标意味着状态已经不一致，此时放行等于赌一把。
3. 其余情况放行——本闸门只新增拒绝，不为任何工具放宽既有分级。

拒绝理由必须对模型可执行，而不只是一句"不允许"：明确告诉它这是用户引用的只读标签页，要做写操作应当 `browser_open_tab` 另开一个页，或者用 `ask_user` 请用户授权。否则模型会原地重试直到预算耗尽。

### 4.3 闸门顺序

插在 `lib/agent/agent.ts` 的 `beforeToolCall` 中，**权限门之后、接管门之前**：

```
tool-policy 预算 → beforeToolCallPermissionGate → decideTabAccess → resolveTakeoverGate → 写预算记账 → 遮罩
```

- 排在权限门之后：权限门是全局分级，被它拦下的调用不该再惊动下游任何一层。
- 排在接管门之前：接管门自己的注释写明"是体贴，不是安全边界"（`takeover-gate.ts`），而 tab-access 是硬边界。硬边界不应该排在软提示后面——那样用户会为一个注定被拒绝的调用被打断一次。
- 被 tab-access 拦下的调用走既有的 `recordPreExecutionBlock` 路径，与其他闸门一致。

## 5. 数据流

1. **列表**：`@` 触发时，面板发新 MessageType `LIST_WINDOW_TABS`（无 payload；`MessageType` 联合、payload/result 接口、`handleMessage` 分支按 CLAUDE.md 的既定流程一并加齐）。background 取面板绑定 tab 的 `windowId` 做 `tabs.query`，过滤到只剩 http/https 页——与 `browser_navigate` 同一条边界。受限页（`chrome://`、扩展页、Web Store）在列表里就不出现：列出来只会让用户选中一个 `executeScript` 根本打不进去的死项。返回 `{ id, title, url, favIconUrl }[]`，**只在面板本地渲染，不进模型上下文**。它是面板专用消息，因此**不加入 `background.ts` 的 `SUPPORTED_MESSAGE_TYPES`**——那张表是「模型可见/可调用」的清单（`SET_AGENT_OVERLAY` 同样有意缺席）。
2. **点选**：面板本地状态维护引用列表，渲染成 chip。
3. **抓快照**：在**发送时**、而不是点选时，对每个引用 tab 发 `EXTRACT_PAGE`。放在发送时是因为用户很可能选完之后又去那个页面点了两下；复用 `EXTRACT_PAGE` 的理由见 §3.4。
4. **字符预算**：新增纯函数 `planTabRefBudget(n): number`，总预算 `TAB_REF_TOTAL_MAX_CHARS = 24000` 按引用数均分——1 个引用拿满 12000（与现有 `pagePrefetch` 行为完全一致），5 个各 4800。截断在这里不是信息丢失：模型要更多就 `browser_switch_tab` 过去 `browser_read_page`，这正是混合方案存在的理由。
5. **拼装**：快照进 user turn，逐 tab 标注 title/url，沿用 `browser_read_page` 那段 untrusted page content 措辞——引用页的正文和当前页的正文是同一类不可信数据，措辞不该有第二套。
6. **每个引用只注入一次快照。** 授权持续到用户移除（§2），但快照不是：一个引用只在它加入后的第一次发送时带正文，此后留在授权列表里，模型改用读类工具访问它。否则每一轮都重新注入 24000 字符，`MAX_CONTEXT_MESSAGES`(48) 的窗口会被自己的快照吃光——这恰恰是 §3.1 否掉纯快照方案的那条理由。面板据此为每个引用维护一个 `snapshotSent` 标记；用户移除后重新点选算作新的引用，会再注入一次。
7. **过河**：引用列表随 `StartRunRequest`（`run-port-protocol.ts`）传到 background，`run-registry` 建 session 时调 `TabSessionController.reference()` 以 `'read'` 登记。

## 6. UI

- chip 区在输入框上方，与附件 chip 并排，但是**独立组件**（`TabRefChip`）：生命周期和失效态都与附件不同，塞进 `AttachmentChip` 只会让两边都变复杂。
- `@` 弹层**不能照抄** `/` 快捷指令面板。`startsSlashCommand` 是 `input.trim().startsWith('/')` 的整串前缀判断，而 `@` 会出现在句子中间（"对比一下 @A 和 @B"）。需要按光标位置取当前 token。这是本功能里唯一一处真正新的交互逻辑，拆成纯函数（取 token + 过滤候选）单独测试。
- 面板绑定的 tab 在列表里标为"当前页面 · 默认已包含"，不可选、不计入上限。

## 7. 失效处理

| 时机 | 处理 |
|------|------|
| 发送时目标已关闭 | 静默剔除该引用 + 面板一条非阻塞提示；**不阻塞发送**，其余引用照常 |
| 发送时 `EXTRACT_PAGE` 失败（受限页、内容脚本未注入） | 静默降级，不设该 tab 的快照；模型仍可切过去自己读。与现有 `pagePrefetch` 的降级策略一致 |
| 运行中标签页被关闭 | `resolveTargetTab` 已经会抛"目标标签页已关闭"，工具层有现成路径；chip 由**面板自己**监听 `browser.tabs.onRemoved` 摘掉（面板是扩展页，本来就能用 `tabs` API）。background 侧不做清理：session 以面板 tab 为键持久化，要摘掉一个被引用的 tab 得扫描整张 `storage.session` 表，而这对正确性并无必要——`reference()` 每轮全量同步，下一次发送就会自愈 |
| 引用页被用户导航到别处 | 不做检测（§2 非目标）。chip 显示实时 title 已足够让用户看出来 |

## 8. 持久化

授权只活在 session 层（`tab-session-storage.ts`，`browser.storage.session`），跟着 Service Worker 回收一起被救回，跟着浏览器重启一起清空。

历史消息里像附件那样只保留被引用页的 **title/url 元数据**，不保留快照正文。回看历史能知道这一轮参考了哪几页，但重开会话**不恢复授权**：tab id 重启即失效，"恢复"出来的只会是一份假授权，指向一个可能已经是完全不同页面的标签页。

## 9. 隐私边界的表述改写

边界没有放松，但表述必须改，否则代码和文档会对不上——而这条边界现在是对外卖点。

旧表述（`lib/agent/tab-session.ts` 文件头）：
> 不查询、不暴露用户自己开着的其他标签页

新表述：
> agent 永远不能自主枚举用户的标签页；只有用户在 `@` 选择器里显式点选的才进入会话，且只读。

同步清单：

- `lib/agent/tab-session.ts` 文件头注释
- `CLAUDE.md` 中 `tab-session.ts` 的描述（"it never queries or exposes tabs the user opened themselves (privacy boundary)"）
- `README.md` / `README.en.md` 的功能列表
- `docs/chrome-store-listing.*.md`
- `docs/privacy-policy*.md`
- `lib/agent/tools.ts` 的 `browser_list_tabs` 描述 + `formatTabList` 的备注列：模型需要知道引用 tab 是只读的，否则会先试写、被拒、再重试。**不动 `system-prompt.ts`**——那里目前根本没有标签页章节，为一句话新开一节不成比例；工具描述、列表备注和拒绝理由三处已经足够

`browser_list_tabs` 会列出被引用的 tab 并标注其 `access`——不列出来模型就无法寻址；但它仍然看不到任何未被点选的标签页。

## 10. 测试策略

**unit（node）：**

- `tab-access.test.ts`：写工具 × read tab → 拒；读工具 × read tab → 放行；写工具 × full tab → 放行；`browser_close_tab` × read tab → 拒；目标 tab 未知 → 拒（保守默认）。
- `tab-session.test.ts` 增补：`reference()` 以 read 登记且不改 `currentTabId`；`MAX_REFERENCED_TABS` 上限；面板 tab 去重且不降级；`access` 缺省视为 full 的向后兼容。
- `planTabRefBudget` 的边界（0/1/5/超限）。
- `reference()` 的全量同步语义：移除后不再出现在 `trackedTabs`，`'full'` 项不受影响。
- 快照只注入一次：同一引用第二轮发送时不再带正文。
- `@` token 提取的纯函数（句中、连续 `@`、光标在 token 中间、已选中的候选过滤）。
- `agent.test.ts` 增补：闸门顺序——权限门先拦下的调用不进 tab-access；tab-access 拦下的调用不触发接管提示、不记写预算、不亮遮罩。

**ui（jsdom）：**

- composer 的选择 / 移除 / 超限 / 已关闭降级 / 面板 tab 不可选。

**run-registry：**

- `StartRunRequest` 携带引用列表 → session 中以 `'read'` 登记。

## 11. 残留风险

- **引用页扩大了间接提示注入的接触面。** 一次点选把 5 个页面的正文送进上下文，其中任何一页藏着的指令都可能污染这一轮。缓解仍是既有的三层：untrusted 措辞、写操作只能落在 `full` tab 上、表单提交逐次确认。值得注意的是只读约束在这里是**真的在起作用**——被注入的引用页无法驱动对它自己的写操作。
- **`@` 让"授权"变得很轻。** 点四下就能把四个页面交给模型。缓解靠 chip 常驻可见（授权持续到移除，所以它必须一直在视线里）和 5 个上限。
- **title/url 不脱敏。** `redactText` 只处理 `.text`（ref: 2026-08-31 spec §5 的已知残留），引用 chip 和快照头部都会带原始 URL，查询参数里的 PII 会直接进上下文。这是既有缺口，本设计只是把它的暴露面从 1 个页面扩大到最多 6 个；是否收口留给脱敏管线自己的后续版本。
