# 长窗口模型下的上下文预算：把写死的 128k 换成真实窗口

- 日期：2026-09-20
- 来源：用户问 agent 为什么回答"4.4.3 Reflection 提示词的原文未在已读内容中"。排查定位到 `browser_read_page` 默认窗口 24000 小于页面正文 38291；顺着"未来接入的模型窗口普遍到 1M"这个问题，展开成整层预算的重新推导
- 状态：已实现（ada733b..6d83a62，含最终评审的修复波）
- 依赖：无新增权限、无新增工具、无新增消息类型。前置提交 26e9293（移除本地 Ollama 预设）

## 1. 起因：一次真实失效

用户在 `hello-agents.datawhale.cc` 的一章文档页上让 agent 作答，模型回复里带了这么一句：

> 页面正文共 38291 字符，我实际读到的内容截止于 4.3.3 执行器部分，**4.4.3 Reflection 提示词的原文未在已读内容中**

模型说的是实话。`DEFAULT_READ_MAX_CHARS` 是 24000，而 4.4.3 那一节落在 29000 之后，整段在窗口之外。

这是**同一个页面第二次**以不同面貌撞上同一堵墙。`page-read-window.ts` 的头部注释记的就是上一次：那次模型的结论是"当前浏览器标签页没有可用的文档内容"，与事实相反。e1cef7b 引入 `offset` 续读和可执行的截断提示之后，失效模式从"错误结论"改善成了"诚实但不完整"——提升了一档，但没根除。

续读的路本来是通的。`describePageReadWindow` 会返回"整页未超过单次读取上限，把 maxChars 设为 38291 再调用一次即可一次读完，不要就此认为页面没有内容"，`system-prompt.ts:180` 还写了同一条规则。两处都指向"再读一次"，而 glm-5.3 选择了在回答里标注不确定性，不肯多花一轮往返。

**结论：靠提示词说服模型补读，是在给一个本不该存在的坑打补丁。** 真正的问题是默认窗口只有单条结果天花板的一半——`DEFAULT_READ_MAX_CHARS` 24000 对 `MAX_TOOL_RESULT_CHARS` 48000，省下的 24000 字符换来的是一轮额外往返（而 LLM 往返占端到端 96%），在弱模型上换来的是一个不完整的回答。

## 2. 现状：预算的自变量被固化成了字面量

`context-budget.ts:75` 的注释写得很明确，`MAX_CONTEXT_CHARS = 90000` 是这么来的：

> 按最保守的中文口径（1 字符 ≈ 1 token）折算：90000 字符 + 系统提示词 + maxTokens 的输出预算仍在 createModel 声明的 128k 窗口内

也就是说**这一层真正的自变量本来就是上下文窗口大小**，只是它被写死在 `agent.ts:541` 的 `contextWindow: 128000` 里，推导结果被固化成了字面量。窗口一变，整套数字就该重算，但今天没有任何机制让它重算。

## 3. 实测：支持范围内模型的真实窗口

2026-09-20 联网核实（来源见文末）。支持范围经四轮收窄：本地模型（26e9293）、用户判定过期的型号（`glm-4.7`、`glm-4.7-flash`、`kimi-k2.6`、`kimi-k2.7-code`）、智谱 GLM 与 Moonshot 整家移除（两家删掉过期型号后各剩一个在售型号，`models` 列表形同虚设）、通义千问整家移除。剩余预设：

| Provider | 模型 | 上下文窗口 |
|---|---|---|
| DeepSeek | `deepseek-v4-pro` / `deepseek-v4-flash` | 1,048,576 |
| OpenAI | `gpt-5.6-sol` / `terra` / `luna` | 1,050,000 |
| Anthropic（无预设，走 `anthropic-messages`） | `claude-opus-5` / `claude-sonnet-5` | 1,000,000 |

**下限 1,000,000（Anthropic 的 `claude-opus-5` / `claude-sonnet-5`），且表中每一项都经过单独核实**——原先 §10 里"`qwen3.7-plus` 窗口未确认"那个唯一的数字缺口随通义千问一起移除，不再需要单独核实。没有任何一个还停在 128k：写死的 128000 不只是保守，它对所有支持的模型都是错的，而 `pi-agent-core` 拿这个数做自己的窗口管理。

预设收窄到两家之后，自定义端点成为主要接入方式，而自定义端点的窗口完全不可知。这不改变本设计的推导（预算不依赖窗口，见 §5），但它把 §10 第一条那个权衡从边缘情况变成了常规情况：用户在中转站后面接什么模型我们无从知道，撞 400 的概率随之上升。

这条"预设只收窗口 ≥1M 的在售模型"的约束已写进 `settings.ts` 的 `PROVIDER_PRESETS` 头注释——它是本设计整层推导的前提，往预设里加一个窗口更小的模型会让推导失去依据，而表现是用户撞供应商 400，不是代码报错。

## 4. 为什么不做"按模型查表"

设计过程中先选定的方案是：预设内置一张模型 ID 到窗口的表，未知端点回退保守值，预算按窗口推导。查到真实数据后废弃，理由是**表的前提不成立了**。

那张表存在的意义是"窗口差异大，需要分档"。删掉本地模型、再排除过期型号之后，剩下模型的窗口全在 1M 上下，而本设计选定的预算量级远低于这个下限——窗口那一项**永远不会成为约束**，表里每一行查出来的结果都一样。为一个永不生效的分支维护一张会过期的模型表，是纯负债。

同样被废弃的还有"档位枚举"形状（`baseline` / `long`）：`budget-profile.ts` 已经有语义完全不同的 `BudgetProfile = 'standard' | 'generous'`（工具调用次数档位，用户可选），两个 profile 在 `store.ts` 里并排传递，迟早传错。

保留下来的只有一条：**把写死的 128000 改对**。

## 5. 新的锚点：内容，而不是窗口

窗口不再是约束之后，预算需要一个新锚点。本设计取的是：

> 单条只读结果要能装下"最长的一个真实网页正文"。

网页可读正文超过 20 万字符的实际上不存在——触发本设计的那个 docsify 章节是 38,291，长文档页的典型量级是 3 万到 8 万。取 200,000 覆盖到极端情况。

明确排除的两个候选锚点：

- **按窗口比例放大**（如 0.7 × 1M）。1M 窗口下的实际约束不是窗口，而是首 token 延迟与长上下文的中间遗忘效应。用户的取舍是"够用就好：只消灭截断类失效，不主动占满窗口"，按比例放大与之矛盾。
- **按计价悬崖倒推**。设计中途一度以 GPT-5.6 的 272K 输入 2 倍计价阈值为锚点，用户明确指示不考虑价格，已废弃。留档是因为如果将来重新纳入成本考量，这条阈值是现成的锚点。

对应的余量校验：最坏情况 350,000（历史）+ 约 25,000（系统提示词与工具表，沿用 §2 那套推导里的隐含余量，未实测）+ 16,000（`maxTokens`）= **391,000 token**，按 1 字符 ≈ 1 token 的中文极端口径算仍只占 1M 窗口的 39%；按中文实际 token 率（约 0.65）约 25%。

Anthropic 自 Opus 4.7 起同样文本多出约 30% token，这一项**不另外扣**：1 字符 ≈ 1 token 的口径本身就远比实际保守（中文约 0.65，英文约 0.25），那 30% 已被这层余量吸收，再叠一道等于重复计算同一个保守量。

## 6. 常量变更

`lib/agent/context-budget.ts`：

| 常量 | 现值 | 新值 | 依据 |
|---|---|---|---|
| `MAX_TOOL_RESULT_CHARS` | 48,000 | **200,000** | 一整页，完整 |
| `CONTEXT_RECUT_TARGET_CHARS` | 60,000 | **250,000** | 一次满额读取 + 工作余量 |
| `MAX_CONTEXT_CHARS` | 90,000 | **350,000** | 重切前的高水位 |
| `DEFAULT_READ_MAX_CHARS` | 24,000 | 不变 | 见 §7 |
| `MIN_READ_MAX_CHARS` | 1,000 | 不变 | 与预算规模无关 |
| `IMAGE_CHAR_EQUIVALENT` | 5,000 | 不变 | 图片的 token 当量与预算规模无关 |

`lib/agent/agent.ts`：

| 常量 | 现值 | 新值 |
|---|---|---|
| `createModel().contextWindow` | 128,000 | **1,000,000** |
| `MAX_CONTEXT_MESSAGES` / `CONTEXT_RECUT_TARGET` | 48 / 32 | 不变 |

**比例关系只保留了一半。** 旧值里 `MAX_TOOL_RESULT` 是重切目标的 0.8、重切目标是高水位的 2/3。新值维持了前者（200,000 / 250,000 = 0.8），后者漂到约 0.71（250,000 / 350,000）——那是取整到可读数字的结果，不是设计意图。真正的变化在锚点：`MAX_TOOL_RESULT` 现在锚在"一整页"这个绝对量上，不再是上下文的一个分数，所以比例成了推导的副产物而不是约束。这样做安全，是因为 `compactAgentMessages` 会把**非最新**的只读结果压成一行摘要——历史里不可能同时存在两份满额读取，所以高水位不需要是单条上限的两倍。

声明 1,000,000 只是不再谎报窗口。真正生效的闸门始终是我们自己的字符预算（350,000 字符处收口），它先于 `pi-agent-core` 的窗口管理触发。

## 7. `browser_read_page`：整页放得下就整页

`DEFAULT_READ_MAX_CHARS` 保持 24000 不动，改的是 `planPageReadWindow`（`lib/agent/page-read-window.ts`）的取窗规则：

> **未显式指定 `maxChars`** 且 `total <= MAX_TOOL_RESULT_CHARS` 时，窗口取 `[offset, total]`。

"未显式指定"这个区分是必需的，而 `resolveReadMaxChars` 今天刻意抹掉了它（`undefined` 直接返回默认值）。实现时必须在调用它之前先判断 `params?.maxChars` 是不是有限数字——否则模型显式传 `maxChars: 3000` 想省上下文时会被强行灌回整页，那是把一种失效换成另一种。

这条规则改完之后，`describePageReadWindow` 里"整页未超过单次读取上限，把 maxChars 设为 N 再调一次"这个分支**只在模型自己把窗口调小时才会触发**，文案要相应改写成"你指定的 maxChars 小于整页长度"。这个变化本身就是验收信号：那条提示从常规路径上的一句补救，退回成一个例外提醒——失效模式被消除了，而不是靠提示词兜住。

`DEFAULT_READ_MAX_CHARS` 不动，是因为改完之后它只再管 `browser_get_html` / `browser_get_scripts` / `browser_get_stylesheets`（经 `read-request.ts`）。那三个是低密度内容，HTML 200,000 字符里大部分是标签和类名，且目前没有任何"读不全导致失败"的证据。有证据再动。

同步要改的文案：`tools.ts:236`（工具描述里写着 "a page longer than 24000 characters..."）和 `tools.ts:240`（`maxChars` 参数描述）。模型自以为的上限和真正执行的上限必须来自同一个常量——这正是 `context-budget.ts` 头部注释在防的那件事。

## 8. 预取与跨标签引用：跟着涨

`MAX_PAGE_PREFETCH_CHARS` 保持等于 `MAX_TOOL_RESULT_CHARS`（c2ec362 定下的单一来源），因此自动变成 200,000。

这里有一个**真实存在但被接受的代价，机制描述在初稿里是错的，已在兄弟设计稿的复审中更正**（ref: `docs/superpowers/specs/2026-09-20-page-prefetch-strategy-design.md` §4「上下文预算（2026-09-20 复审更正）」）。初稿的论证是"预取正文进的是 user 消息，而 user 消息永远不会被摘要压缩，所以会永久钉在上下文里"——这句话本身没错，但保护不到预取正文：`recutStartForCharBudget`（`agent.ts:636-647`）是从**最新一条往回**累加到 `CONTEXT_RECUT_TARGET_CHARS`，而预取正文是窗口里**最旧**的那条 user 消息，是第一个被切掉的，不是被保护的最后一条；`planContextWindow` 又只让 `state.start` 单调前进（`agent.ts:760-764`），切掉之后整场对话都回不来。

真实代价因此不是"贵"，而是**页面正文连同用户本轮的指令被整条逐出且不可恢复**——不是压缩成摘要，是从窗口里彻底消失。预取正文、快捷方式的 prompt、跨标签引用正文是同一条 user 消息（`entrypoints/sidepanel/store.ts:1439` 把引用正文前置拼到 `committedAgentUserContent`），所以逐出连带丢掉的是用户这一轮想问的问题本身。设计过程中提出过三条路——跟着涨 / 预取单设更低常量 / 让预取正文可被压缩——用户选定第一条。

连带的重新标定：

- `PAGE_PREFETCH_HEAD_CHARS` 现在是字面量 32,000，从旧上限 48,000 按 2:1 拆出来的。必须改成**按比例从 `MAX_PAGE_PREFETCH_CHARS` 推导**（头 2/3、尾 1/3），否则 25 万字符的页面只拿到 48,000（19%）的正文，比 `full` 分支退步。
- `windowed` 分支**保留**。门槛升到 200,000 后它只在超长日志、连载、法条这类页面命中，仍是真实路径而非死代码。空大纲分支（`shortcutPageWindowedNoOutlinePrompt`）同理保留。
- `TAB_REF_TOTAL_MAX_CHARS`（今天是硬编码的 48,000）改为跟随 `MAX_TOOL_RESULT_CHARS`。
- `TAB_REF_SINGLE_MAX_CHARS` 改为跟随 `MAX_PAGE_PREFETCH_CHARS`。这顺带修掉一处已经失真的注释：`tab-reference.ts:13` 写着"只引 1 个页时行为与 store.ts 的 page-scope 预取一致"，而 c2ec362 把预取上限提到 48,000 之后这句话就不再成立（24,000 对 48,000）。改完重新成立。

## 9. 不动的东西

- **`parseImplementationInspectionParams` 的四段 36,000 预算**（`tools.ts`）。它压在旧上限 48,000 以下是为了让整份档案装进单条结果；天花板抬到 200,000 后这个约束自动满足。"要不要多采集"是另一个需要证据的问题，不在本设计范围。
- **`tool-call-repair.ts`**。它服务的是弱模型，而 Qwen / GLM 都是云端的——删掉本地模型支持不会让 tool call 不规范的问题消失。触发本设计的那次失效正是 glm-5.3 造成的。
- **`storage-read.ts` 的渲染预算**、**`frame-merge.ts` 的多帧截断**。各有自己的语义，与上下文规模不直接相关。
- **`docs/privacy-policy.md:69`** 关于 `http://localhost` 可作为 Provider 地址的表述。删预设不阻止用户手填，该句描述的行为仍然成立。

## 10. 权衡与已知代价

**一、中转端点跑老模型会撞供应商 400。** 今天 `MAX_CONTEXT_CHARS = 90000` 顺带保护了窗口 128K 的端点；抬到 350,000 之后不再保护。而这道字符闸门当初存在的理由恰恰是"不要让失败发生在服务端、用户等完一整轮却拿不到任何回答"（`context-budget.ts:71`）。这是用一种失效换另一种，按用户"不考虑老模型"的判断接受。~~没有触发器能让"撞 400 的用户不在少数"这件事被发现~~——已解决：`stream-shared.ts` 的 `describeHttpFailure` 现在对 400 且 detail 命中 `context`/`length`/`token` 关键字的响应给出专门诊断（提示可能是上下文超长，建议换更大窗口的模型或减少引用/附件），2026-09-20 最终评审加入。

**二、一份最大 200,000 字符的预取正文被整条逐出上下文且不可恢复的风险。** 机制描述见 §8（2026-09-20 复审已更正：不是"永久钉住"，而是作为窗口里最旧的 user 消息第一个被切掉，且切掉后不会恢复）。已接受。

**三、~~`qwen3.7-plus` 的窗口未单独确认~~** 已随通义千问预设整家移除而消解。剩余预设的窗口全部单独核实过，见 §3。

**四、自定义端点的窗口完全不可知，且已成为主要接入方式。** 预设只剩 DeepSeek 与 OpenAI 两家，其余全走自定义/中转端点。本设计的预算不依赖窗口（§5），所以推导不受影响；但第一条那个权衡因此从边缘情况变成常规情况。如果后续发现撞 400 的用户不在少数，正确的补救方向不是把预算调回保守值（那会让 §1 的失效重现），而是给 `ProviderConfig` 加一个用户可填的窗口上限——即本设计 §4 废弃的那张表的"用户声明"变体。届时它有了真实依据，不再是为空分支维护的负债。

**五、后续可选项（记录，本次不实现）：**

1. 让只读工具在"本轮 user turn 已携带预取正文"时自动降低默认窗口。兄弟设计稿 `2026-09-20-page-prefetch-strategy-design.md` §4 已提出这条，是针对 §8 真实机制的最小补救，比本节第二条一度考虑又被否掉的"预取单设更低常量"更精准——它只在预取与满额只读结果真正会在同一轮里叠加冲突时生效，不会像调低常量那样牺牲不冲突的常规路径。
2. `MAX_PAGE_PREFETCH_CHARS`（200,000）+ `TAB_REF_TOTAL_MAX_CHARS`（200,000）= 400,000，**超过 `MAX_CONTEXT_CHARS` 本身**（350,000）；而 `MAX_CONTEXT_CHARS` 并不是硬上限——`recutStartForCharBudget` 无条件保留最后一条消息，即使它自己就超预算。所以 §5 那句"最坏情况 350,000"用的量偏小，真实最坏情况约 400,000（预取+引用）+ 25,000（系统提示词与工具表）+ 16,000（`maxTokens`）≈ 441,000。结论不变——441,000 仍在 1M 窗口内——但这一点是运气而非论证：如果窗口下限比今天核实到的 1,000,000 更低，这条余量会先被吃掉。
3. `describeHttpFailure` 的 400 诊断（本节第一条）已实现，原先"没有触发器能让这件事被发现"的问题标注为已解决。

## 11. 测试

- `page-read-window.test.ts`：新增"未指定 maxChars 且整页放得下 → 窗口覆盖整页、`truncated` 为 false、提示为空串"；"显式指定更小的 maxChars → 不被放大，提示改走新文案"；"整页超过上限 → 仍分段，`offset` 续读行为不变"。
- `context-budget.test.ts`：`resolveReadMaxChars` 的夹取边界按新上限重算。
- `page-prefetch.test.ts`：`full` / `windowed` 的分界按新上限重算；头尾比例改为从上限推导后，断言头尾长度随上限缩放而非硬编码。
- `tab-reference.test.ts`：单页与总量上限按新常量重算；补一个"只引 1 个页时的正文量与 page-scope 预取一致"的断言，把 §8 那处注释所声称的性质变成测试保障的性质。
- `agent.test.ts`：`compactAgentMessages` 的高水位/重切目标用例按新常量重算。

## 12. 实施顺序

1. ~~预设清理~~ **已完成**：智谱 GLM 与 Moonshot 两个预设整体移除，剩 DeepSeek / OpenAI / 通义千问。原计划只删过期型号，但删完两家各剩一个在售型号，改为整家移除。已有用户保存的 Provider 配置不受影响——预设只作用于「添加 Provider」表单的快速填充，不回写既有配置。
2. `context-budget.ts` 与 `agent.ts` 的常量变更（§6），连同各自的注释重写——注释里的推导过程必须跟着新锚点改，否则下一个读代码的人会拿着 128k 的论证去理解 1M 的数字。
3. `planPageReadWindow` 的整页规则与文案（§7），含 `tools.ts` 的工具描述。
4. 预取与跨标签引用的重新标定（§8）。

## 来源

- [DeepSeek V4 Preview Release | DeepSeek API Docs](https://api-docs.deepseek.com/news/news260424/)
- [GPT-5.6 Sol Model | OpenAI API](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI GPT-5.6 Sol, Terra, and Luna now support 1M token context windows on Amazon Bedrock | AWS](https://aws.amazon.com/about-aws/whats-new/2026/08/gpt-sol-terra-luna-long-context-bedrock/)
- [Qwen3.7 Max — API Pricing & Benchmarks | OpenRouter](https://openrouter.ai/qwen/qwen3.7-max)
- [Qwen3.6 Flash — API Pricing & Providers | OpenRouter](https://openrouter.ai/qwen/qwen3.6-flash)
- [GLM 5.2 — API Pricing & Benchmarks | OpenRouter](https://openrouter.ai/z-ai/glm-5.2)
- [Kimi K3 — Kimi API Platform](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Context windows — Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/context-windows)
