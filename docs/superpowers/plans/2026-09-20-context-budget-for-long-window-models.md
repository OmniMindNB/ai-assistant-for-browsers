# 长窗口模型下的上下文预算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上下文预算从"按写死的 128k 窗口推导"改成"按内容实际需要推导"，消灭 `browser_read_page` 默认窗口只有单条结果上限一半所导致的截断类失效。

**Architecture:** 四个任务，每个都是独立可测的提交。Task 1 改取窗规则（在当前常量下就已修复用户报的 bug）；Task 2 改常量数值并把 `contextWindow` 声明改对；Task 3、4 把两个跟随预算的下游常量重新标定。没有新模块、新工具、新消息类型。

**Tech Stack:** TypeScript、vitest（三个 project：`unit` / `ui` / `dom`，本计划只涉及 `unit`）、pnpm。

**Spec:** `docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md`

**与 spec §12 的顺序差异（刻意）：** spec 把常量变更排在取窗规则之前，本计划调换了两者。原因是「整页放得下就整页」这条规则**在当前常量下就已经修复用户报的失效**——那个页面 38291 字符，小于现行的 48000 上限。先做它，第一个提交就让 §1 的 bug 消失，而不必等整套常量落地。规则本身不依赖新数值，只依赖"有一个上限"。

## Global Constraints

- 注释、提交信息用中文；本计划涉及的模型可见文案（工具描述、`maxChars` 参数说明）用英文，与 `tools.ts` 现有写法一致。
- 直接在 `main` 上提交，不开分支（`CLAUDE.md` → Git）。
- 每个任务结束前必须跑 `pnpm compile`（`tsc --noEmit`）和 `pnpm test`（vitest 全量），两者都通过才提交。
- 测试断言一律从常量推导，不写死数值。本计划存在的直接原因之一就是写死的字面量：`page-read-window.test.ts` 的 `120000` 和 `tab-reference.test.ts` 的 `9600` 都是一改常量就红的用例。
- 提交信息末尾加 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。
- 本计划**不改**这些（spec §9）：`parseImplementationInspectionParams` 的四段 36,000 预算、`tool-call-repair.ts`、`storage-read.ts`、`frame-merge.ts`、`docs/privacy-policy.md`。
- 最终常量目标值（spec §6），Task 2 落地：`MAX_TOOL_RESULT_CHARS` = 200000，`CONTEXT_RECUT_TARGET_CHARS` = 250000，`MAX_CONTEXT_CHARS` = 350000，`createModel().contextWindow` = 1000000。`DEFAULT_READ_MAX_CHARS`（24000）、`MIN_READ_MAX_CHARS`（1000）、`IMAGE_CHAR_EQUIVALENT`（5000）、`MAX_CONTEXT_MESSAGES`（48）、`CONTEXT_RECUT_TARGET`（32）不变。

## File Structure

| 文件 | 职责 | 本计划中的改动 |
|---|---|---|
| `lib/agent/page-read-window.ts` | `browser_read_page` 的取窗层与模型可见的截断提示 | Task 1：新增"未显式指定 maxChars 且整页放得下就整页"的规则；改写"整页放得下"分支的文案 |
| `lib/agent/tools.ts` | 工具定义 | Task 1：同步 `browser_read_page` 的描述与 `maxChars` 参数说明（只改文案，不动逻辑） |
| `lib/agent/context-budget.ts` | 读取量与上下文规模的唯一真相 | Task 2：三个常量数值 + 头部注释推导重写 |
| `lib/agent/agent.ts` | 模型声明与消息压缩 | Task 2：`createModel().contextWindow` |
| `lib/chat/page-prefetch.ts` | page-scope 快捷方式的预取分支 | Task 3：`PAGE_PREFETCH_HEAD_CHARS` 由字面量改为按比例推导 |
| `lib/chat/tab-reference.ts` | 跨标签引用的字符预算 | Task 4：两个上限改为跟随上游常量 |

测试文件与被测代码同目录，均已存在，不新建文件。

---

### Task 1: `browser_read_page` 整页放得下就整页

**Files:**
- Modify: `lib/agent/page-read-window.ts:42-53`（`planPageReadWindow`）、`:58-80`（`describePageReadWindow`）
- Modify: `lib/agent/tools.ts:236`（工具描述）、`:240`（`maxChars` 参数说明）
- Test: `lib/agent/page-read-window.test.ts`

**Interfaces:**
- Consumes: `resolveReadMaxChars(raw: unknown): number`、`MAX_TOOL_RESULT_CHARS`、`DEFAULT_READ_MAX_CHARS`，均来自 `./context-budget`
- Produces: `planPageReadWindow(total: number, params: PageReadParams | undefined | null): PageReadWindow` 与 `describePageReadWindow(window: PageReadWindow): string` 的签名**不变**，只改行为。后续任务不依赖本任务的新导出。

**背景（实现者必读）：** 触发本任务的失效是——用户页面正文 38291 字符，模型不传 `maxChars` 调用 `browser_read_page`，只拿到前 24000 字符，于是回答"4.4.3 Reflection 提示词的原文未在已读内容中"。`resolveReadMaxChars` 把"没传 maxChars"和"传了但要默认值"抹成同一件事（`undefined` 直接返回 `DEFAULT_READ_MAX_CHARS`），而这里恰恰需要那个差别：模型显式传了小值可能是在有意节省上下文，强行灌回整页是把一种失效换成另一种。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/page-read-window.test.ts` 的 `describe('planPageReadWindow')` 块内，**替换**现有的第一个用例（`不传参数时从头读，按默认上限切`），并新增两个用例：

```ts
  // 本任务的核心：整页塞得进单条结果上限时，不传 maxChars 就该一次读完。
  // 修复前这里切在 DEFAULT_READ_MAX_CHARS，用户问的小节落在窗口之外
  // （ref: hello-agents 第四章，正文 38291，4.4.3 在 29000 之后）。
  it('不传 maxChars 且整页塞得下时，一次读完整页', () => {
    expect(planPageReadWindow(38291, undefined)).toEqual({
      offset: 0,
      end: 38291,
      total: 38291,
      remaining: 0,
      truncated: false,
      exhausted: false,
    });
  });

  it('不传 maxChars 但整页超过上限时，仍回落到默认分段量', () => {
    const total = MAX_TOOL_RESULT_CHARS + 50000;
    expect(planPageReadWindow(total, undefined)).toMatchObject({
      offset: 0,
      end: DEFAULT_READ_MAX_CHARS,
      truncated: true,
    });
  });

  // 模型显式调小窗口是它的权利（可能在有意节省上下文），不能被整页规则覆盖。
  it('显式传入的小 maxChars 不会被放大成整页', () => {
    expect(planPageReadWindow(38291, { maxChars: 3000 })).toMatchObject({
      offset: 0,
      end: 3000,
      remaining: 38291 - 3000,
      truncated: true,
    });
  });

  it('整页规则同样从 offset 起算，不把窗口拉回 0', () => {
    expect(planPageReadWindow(38291, { offset: 10000 })).toMatchObject({
      offset: 10000,
      end: 38291,
      remaining: 0,
      truncated: false,
    });
  });
```

在 `describe('describePageReadWindow')` 块内，**替换**现有的 `整页能塞进单次上限时，直接告诉模型把 maxChars 调到多少能一次读完` 用例：

```ts
  // 改规则之后这条分支只可能由"模型自己把窗口调小"触发，文案必须相应改口径。
  // 这个变化本身就是验收信号：该提示从常规路径上的补救，退回成例外提醒。
  it('整页塞得下却仍被截断时，指出是调用方自己缩小了窗口', () => {
    const note = describePageReadWindow(planPageReadWindow(38291, { maxChars: 3000 }));
    expect(note).toContain('还有 35291 字符未返回');
    expect(note).toContain('maxChars');
    expect(note).not.toContain('browser_find_text');
  });

  it('不传 maxChars 且整页塞得下时不产生任何提示', () => {
    expect(describePageReadWindow(planPageReadWindow(38291, undefined))).toBe('');
  });
```

**同时**把现有的 `整页超过单次上限时，给出下一段的 offset 并提示可改用定位工具` 用例里的 `120000` 改成从常量推导（Task 2 抬高上限后它会越界，现在就改掉）：

```ts
  it('整页超过单次上限时，给出下一段的 offset 并提示可改用定位工具', () => {
    const note = describePageReadWindow(planPageReadWindow(MAX_TOOL_RESULT_CHARS + 50000, undefined));
    expect(note).toContain(`offset=${DEFAULT_READ_MAX_CHARS}`);
    expect(note).toContain('browser_find_text');
    // 分段读会触发上下文压缩把上一段压成一行摘要，不提醒模型就会读了后面丢前面
    expect(note).toContain('摘要');
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run lib/agent/page-read-window.test.ts`

Expected: FAIL。`不传 maxChars 且整页塞得下时，一次读完整页` 报 `end` 收到 24000 而期望 38291；`不传 maxChars 且整页塞得下时不产生任何提示` 报收到截断提示而期望空串。

- [ ] **Step 3: 实现取窗规则**

在 `lib/agent/page-read-window.ts` 中，把导入行改为同时引入默认值：

```ts
import { DEFAULT_READ_MAX_CHARS, MAX_TOOL_RESULT_CHARS, resolveReadMaxChars } from './context-budget';
```

在 `resolveOffset` 函数下方新增：

```ts
/**
 * 本次窗口该取多大。
 *
 * 模型显式给了 maxChars 就照办（仍夹在 context-budget 的区间内）——它可能正在有意节省
 * 上下文，强行灌回整页是把一种失效换成另一种。没给的时候才由我们决定：整页塞得进单条
 * 结果上限就一次给完，塞不进才回落到默认分段量。
 *
 * 之所以要这个区分，是因为 resolveReadMaxChars 刻意抹掉了"没传"和"传了"的差别
 * （undefined 直接返回默认值），而这里恰恰需要那个差别。
 */
function resolveWindowSize(total: number, params: PageReadParams | undefined | null): number {
  const raw = params?.maxChars;
  if (typeof raw === 'number' && Number.isFinite(raw)) return resolveReadMaxChars(raw);
  return total <= MAX_TOOL_RESULT_CHARS ? MAX_TOOL_RESULT_CHARS : DEFAULT_READ_MAX_CHARS;
}
```

把 `planPageReadWindow` 里的这一行：

```ts
  const maxChars = resolveReadMaxChars(params?.maxChars);
```

改成：

```ts
  const maxChars = resolveWindowSize(total, params);
```

- [ ] **Step 4: 改写截断提示的"整页塞得下"分支**

在 `describePageReadWindow` 中，把这个分支：

```ts
  if (window.total <= MAX_TOOL_RESULT_CHARS) {
    return `${head}整页未超过单次读取上限，把 maxChars 设为 ${window.total} 再调用一次 browser_read_page 即可一次读完，不要就此认为页面没有内容。`;
  }
```

改成：

```ts
  if (window.total <= MAX_TOOL_RESULT_CHARS) {
    // 走到这里只可能是调用方自己传了更小的 maxChars：不传的话整页早就一次给完了。
    // 所以文案的口径是"你缩小了窗口"，而不是从前那种"系统截断了你"。
    return (
      `${head}整页只有 ${window.total} 字符、并未超过单次读取上限，是你传入的 maxChars 把窗口调小了。` +
      '需要完整正文时不要传 maxChars，再调用一次 browser_read_page 即可一次读完，不要就此认为页面没有内容。'
    );
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/page-read-window.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 6: 同步模型可见的工具文案**

`lib/agent/tools.ts:236` 的 `description`，整段替换为：

```ts
      `Read the current page title, URL, language, and readable text content. This is read-only and should be used for summaries and page-grounded Q&A. Omit maxChars and a page whose text fits under ${MAX_TOOL_RESULT_CHARS} characters is returned whole in one call — only pass maxChars when you deliberately want a smaller window. A page longer than that is returned one window at a time: the result always states the full text length and how much was left out, so continue by moving offset forward — never assume the page is empty because the part you needed was not in the first window.`,
```

`lib/agent/tools.ts:240` 的 `maxChars` 参数说明，整段替换为：

```ts
          description: `Maximum number of page text characters to return. Omit it to get the whole page when it fits under ${MAX_TOOL_RESULT_CHARS}, or ${DEFAULT_READ_MAX_CHARS} per window when it does not. Values are capped at ${MAX_TOOL_RESULT_CHARS}.`,
```

`tools.ts` 已经同时导入了 `DEFAULT_READ_MAX_CHARS` 和 `MAX_TOOL_RESULT_CHARS`（见 `lib/agent/tools.ts:12`），无需改导入。

- [ ] **Step 7: 全量校验**

Run: `pnpm compile && pnpm test`

Expected: `tsc --noEmit` 无输出；vitest 全部通过。

- [ ] **Step 8: 提交**

```bash
git add lib/agent/page-read-window.ts lib/agent/page-read-window.test.ts lib/agent/tools.ts
git commit -F - <<'MSG'
fix(agent): browser_read_page 整页放得下就一次读完

修复用户报的失效：页面正文 38291 字符，模型不传 maxChars 时只拿到前 24000，
于是回答"4.4.3 Reflection 提示词的原文未在已读内容中"。默认读取量只有单条
结果上限的一半，省下的字符换来的是一轮额外往返，在弱模型上换来的是不完整的回答。

规则：未显式指定 maxChars 且整页不超过 MAX_TOOL_RESULT_CHARS 时，窗口取
[offset, total]。"未显式指定"这个区分是必需的——resolveReadMaxChars 刻意
把"没传"和"传了"抹成同一件事，而模型显式传小值可能是在有意节省上下文，
强行灌回整页是把一种失效换成另一种。

describePageReadWindow 的"整页塞得下"分支因此只可能由调用方自己缩小窗口触发，
文案口径从"系统截断了你"改成"你缩小了窗口"。这个退化本身就是验收信号：
该提示从常规路径上的补救变成了例外提醒。

ref: docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §7

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: 预算常量改按内容推导，窗口声明改对

**Files:**
- Modify: `lib/agent/context-budget.ts:1-30`（头部注释与三个常量）、`:63-80`（水位注释）
- Modify: `lib/agent/agent.ts:541`（`createModel().contextWindow`）
- Test: `lib/agent/agent.test.ts`（新增一个不变量用例）

**Interfaces:**
- Consumes: Task 1 已落地的取窗规则（本任务抬高 `MAX_TOOL_RESULT_CHARS` 后，"整页放得下"覆盖的页面范围随之扩大，无需改代码）
- Produces: `MAX_TOOL_RESULT_CHARS = 200000`、`CONTEXT_RECUT_TARGET_CHARS = 250000`、`MAX_CONTEXT_CHARS = 350000`；`createModel(provider).contextWindow = 1_000_000`。Task 3、4 依赖前两个值。

**背景：** `context-budget.ts` 现有注释明确写着 `MAX_CONTEXT_CHARS = 90000` 是从 `createModel` 声明的 128k 窗口推导的，而那个 128000 是写死的。实测（spec §3）支持范围内模型的窗口下限已是 1,048,576，写死的值对所有模型都是错的。新锚点不是窗口而是内容：单条只读结果要能装下最长的一个真实网页正文。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/agent.test.ts` 已有的常量不变量 `describe` 块内（即包含 `expect(MAX_CONTEXT_CHARS).toBeGreaterThan(MAX_TOOL_RESULT_CHARS + IMAGE_CHAR_EQUIVALENT)` 那一组，约 `:1755-1770`）追加：

```ts
  // 新锚点是内容而不是窗口（spec §5），但仍要校验最坏情况落在声明窗口内，
  // 且给系统提示词和输出留出余量——否则抬高水位的代价是供应商 400，
  // 而那正是这道字符闸门当初存在的理由。
  it('最坏情况的上下文预算仍在声明窗口内，并留有系统提示词与输出的余量', () => {
    const model = createModel({
      id: 'p-test',
      name: 'test',
      baseURL: 'https://example.test/v1',
      apiKey: 'k',
      model: 'test-model',
    });
    // 系统提示词 + 工具表的估算值，沿用 spec §5 的口径（未实测）
    const SYSTEM_PROMPT_ALLOWANCE = 25_000;
    // 中文最保守口径：1 字符 ≈ 1 token
    const worstCaseTokens = MAX_CONTEXT_CHARS + SYSTEM_PROMPT_ALLOWANCE + model.maxTokens;
    expect(worstCaseTokens).toBeLessThan(model.contextWindow);
    // 不是"刚好塞下"：留至少一倍余量，给 tokenizer 差异和估算误差
    expect(worstCaseTokens * 2).toBeLessThan(model.contextWindow);
  });
```

两处依赖，实现前先确认：

1. 该测试文件是否已导入 `createModel`；若未导入，在文件顶部的 `./agent` 导入列表中加上。`MAX_CONTEXT_CHARS` 与 `IMAGE_CHAR_EQUIVALENT` 已在该文件导入（见 `lib/agent/agent.test.ts:35-39` 一带）。
2. `model.maxTokens` 是否在 `Model<Api>` 类型上可访问。`createModel` 的返回对象里有这个字段，正常应可直接读；若 `tsc` 报该属性不存在，改用字面量并加注释：

```ts
    // createModel 里声明的输出预算；类型未暴露该字段时在这里重复一次，
    // 改动时两处要一起改（lib/agent/agent.ts 的 maxTokens）。
    const MAX_OUTPUT_TOKENS = 16_000;
```

并把断言里的 `model.maxTokens` 换成 `MAX_OUTPUT_TOKENS`。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run lib/agent/agent.test.ts -t '最坏情况的上下文预算'`

Expected: FAIL。当前 `MAX_CONTEXT_CHARS`（90000）+ 25000 + 16000 = 131000，大于当前声明的 `contextWindow`（128000），第一条断言就不通过。

- [ ] **Step 3: 改 `createModel` 的窗口声明**

`lib/agent/agent.ts:541`，把：

```ts
    contextWindow: 128000,
```

改成：

```ts
    // 实测（2026-09）：支持范围内模型的窗口下限已是 1,048,576，写死的 128000 对所有
    // 模型都偏低八倍，而 pi-agent-core 拿这个数做自己的窗口管理。声明它只是不再谎报——
    // 真正生效的闸门始终是 context-budget.ts 的字符预算，它先于这里触发。
    // ref: docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §3
    contextWindow: 1_000_000,
```

- [ ] **Step 4: 改三个预算常量并重写推导注释**

`lib/agent/context-budget.ts`，把文件头部注释（第 1-13 行那段 `/** ... */`）整段替换为：

```ts
/**
 * 读取量与上下文规模的唯一真相。
 *
 * 此前这两个数字分居两处、互不知情：`tools.ts` 的 `browser_read_page` 默认读 12000 字符
 * 且对模型填的 maxChars 只有下限没有上限，而 `agent.ts` 的 compactAgentMessages 又会把
 * 任何工具结果切到 30000。于是模型填 60000 时会先拿到一条"正文已截断到 60000 字符"，
 * 再被压缩层切一刀补上一条"工具结果已截断"，两条提示互相矛盾，而模型无从知道真正的
 * 天花板是多少——它只会继续把 maxChars 往上加。
 *
 * 这里的分工与 `system-prompt.ts` 收拢工具预算常量是同一个理由：模型自以为的上限和真正
 * 执行的上限必须来自同一个常量，否则一定会漂移。
 *
 * ⚠️ 数值的锚点是**内容**，不是窗口（2026-09-20 重新推导，ref:
 * docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §5）。
 * 早先这套数字是从 `createModel` 声明的 128k 窗口倒推的，而支持范围内模型的窗口下限现在
 * 已是 1M——窗口不再是约束。取而代之的判据是"单条只读结果要能装下最长的一个真实网页
 * 正文"：网页可读正文超过 20 万字符的实际上不存在（典型长文档页 3 万到 8 万）。
 * 没有按窗口比例放大，是因为 1M 下的实际约束变成了首 token 延迟和长上下文的中间遗忘，
 * 而产品取舍是"够用就好：只消灭截断类失效，不主动占满窗口"。
 */
```

把三个常量的定义与注释改成：

```ts
/**
 * 单条只读工具结果在上下文里保留的硬上限（compactAgentMessages 执行）。
 * 这是所有读取路径真正的天花板，`resolveReadMaxChars` 据此夹取。
 * 取值依据见文件头：装得下最长的一个真实网页正文。
 */
export const MAX_TOOL_RESULT_CHARS = 200_000;
```

```ts
/**
 * 上下文字符预算的高水位 / 低水位，语义与 MAX_CONTEXT_MESSAGES / CONTEXT_RECUT_TARGET
 * 完全对应：超过高水位才重切一次到低水位，两次重切之间窗口起点不动，请求前缀只增不改。
 *
 * 为什么条数之外还要一道字符预算：条数裁剪的隐含前提是「每条消息都不大」，而这个前提有
 * 两个现成的破法——带附件的 user 消息（永远不进摘要压缩），以及只读结果的上限。两者都不会
 * 让条数越线，于是窗口一条都不切，请求直接撞供应商的 400 context length exceeded：失败
 * 发生在服务端，用户等完一整轮却拿不到任何回答。
 *
 * 低水位取 MAX_TOOL_RESULT_CHARS 之上一档，保证一次满额读取加上少量历史仍装得下；
 * 高水位再留一层缓冲。注意两者不再维持旧版 2/3 的比例——锚点换成绝对量之后，比例是
 * 推导的副产物而不是约束。这样做安全，是因为 compactAgentMessages 会把**非最新**的只读
 * 结果压成一行摘要，历史里不可能同时存在两份满额读取。
 *
 * 最坏情况校验（中文最保守口径 1 字符 ≈ 1 token）：350000 + 约 25000 的系统提示词与工具表
 * + 16000 的 maxTokens ≈ 391000 token，仍只占 1M 窗口的四成，agent.test.ts 有对应的不变量用例。
 *
 * ⚠️ 这是兜底，不是日常路径：典型会话只有几千到几万字符，正常运行碰不到高水位。
 */
export const MAX_CONTEXT_CHARS = 350_000;
export const CONTEXT_RECUT_TARGET_CHARS = 250_000;
```

`DEFAULT_READ_MAX_CHARS`、`MIN_READ_MAX_CHARS`、`IMAGE_CHAR_EQUIVALENT`、`resolveReadMaxChars`、`contextCostChars` 一律不动。在 `DEFAULT_READ_MAX_CHARS` 的注释上补一句说明它的适用面已经收窄：

```ts
/**
 * 只读工具未指定 maxChars 时的默认读取量。
 *
 * `browser_read_page` 改走"整页放得下就整页"之后（page-read-window.ts），这个值只在两种
 * 情况下生效：正文超过 MAX_TOOL_RESULT_CHARS 时的分段起步量，以及 browser_get_html /
 * get_scripts / get_stylesheets（经 read-request.ts）。后三者是低密度内容——HTML 里大部分
 * 是标签和类名——没有证据表明需要跟着上限一起放大。
 */
export const DEFAULT_READ_MAX_CHARS = 24000;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/agent.test.ts lib/agent/context-budget.test.ts lib/agent/page-read-window.test.ts`

Expected: PASS。这三个文件的断言都是从常量推导的，新值下应全部通过。若 `page-read-window.test.ts` 里还有写死的数值导致失败，说明 Task 1 Step 1 漏改了某处，回去改成常量推导而不是改常量。

- [ ] **Step 6: 全量校验**

Run: `pnpm compile && pnpm test`

Expected: `tsc --noEmit` 无输出；vitest 全部通过。

注意：`agent.test.ts` 里若干用例会构造 `MAX_CONTEXT_CHARS / 3` 级别的字符串，随高水位从 90000 抬到 350000，这些字符串会从约 3 万字符变成约 11.7 万字符，全量测试耗时可能小幅上升（当前约 17 秒）。这是预期的，不要为此把断言改回写死的小数值。

- [ ] **Step 7: 提交**

```bash
git add lib/agent/context-budget.ts lib/agent/agent.ts lib/agent/agent.test.ts
git commit -F - <<'MSG'
feat(agent): 上下文预算改按内容推导，窗口声明改对

context-budget.ts 的注释一直写明 MAX_CONTEXT_CHARS 是从 createModel 声明的
128k 窗口推导的，而那个 128000 是写死的。实测支持范围内模型的窗口下限已是
1,048,576——写死的值对所有模型都偏低八倍，而 pi-agent-core 拿它做窗口管理。

新锚点是内容而不是窗口：单条只读结果要能装下最长的一个真实网页正文（网页可读
正文超过 20 万字符的实际上不存在）。没有按窗口比例放大，因为 1M 下的实际约束
变成了首 token 延迟和长上下文的中间遗忘，而取舍是"够用就好"。

MAX_TOOL_RESULT_CHARS 48000 → 200000
CONTEXT_RECUT_TARGET_CHARS 60000 → 250000
MAX_CONTEXT_CHARS 90000 → 350000
createModel().contextWindow 128000 → 1000000

高低水位不再维持旧版 2/3 的比例——锚点换成绝对量之后比例是副产物不是约束。
新增不变量用例：最坏情况 350000 + 25000 + 16000 ≈ 391000 token 仍在声明窗口内
且留有一倍以上余量。

ref: docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §5、§6

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 3: 预取的头尾切分改为按比例推导

**Files:**
- Modify: `lib/chat/page-prefetch.ts:30-32`（`PAGE_PREFETCH_HEAD_CHARS` / `PAGE_PREFETCH_TAIL_CHARS`）
- Test: `lib/chat/page-prefetch.test.ts`

**Interfaces:**
- Consumes: `MAX_TOOL_RESULT_CHARS = 200000`（Task 2），经由 `MAX_PAGE_PREFETCH_CHARS = MAX_TOOL_RESULT_CHARS`
- Produces: `PAGE_PREFETCH_HEAD_CHARS`（= `Math.round(MAX_PAGE_PREFETCH_CHARS * 2 / 3)` = 133333）与 `PAGE_PREFETCH_TAIL_CHARS`（= 66667）。Task 4 依赖 `MAX_PAGE_PREFETCH_CHARS`，不依赖这两个。

**背景：** `PAGE_PREFETCH_HEAD_CHARS` 现在是字面量 32000，是从旧上限 48000 按头尾 2:1 拆出来的。Task 2 把上限抬到 200000 之后，字面量不动的话 `windowed` 分支会给 25 万字符的页面只有 48000（19%）的正文，比 `full` 分支退步。头尾 2:1 本身不变：开头承担"这是什么页面"，结尾承担"结论是什么"，纯头部截断恰好把结论全丢掉。

- [ ] **Step 1: 写失败的测试**

在 `lib/chat/page-prefetch.test.ts` 的 `describe('planPagePrefetch')` 块内，**替换**现有的第一个用例：

```ts
  it('shares its ceiling with the tool-result limit instead of inventing one', () => {
    expect(MAX_PAGE_PREFETCH_CHARS).toBe(MAX_TOOL_RESULT_CHARS);
    expect(PAGE_PREFETCH_HEAD_CHARS + PAGE_PREFETCH_TAIL_CHARS).toBe(MAX_PAGE_PREFETCH_CHARS);
  });

  // 头尾切分必须随上限缩放，不能是从某一版上限拆出来的字面量：
  // 上限抬高而切分不动时，windowed 分支给出的正文比例会不断缩水。
  it('derives the head/tail split from the ceiling at a 2:1 ratio', () => {
    expect(PAGE_PREFETCH_HEAD_CHARS).toBe(Math.round((MAX_PAGE_PREFETCH_CHARS * 2) / 3));
    expect(PAGE_PREFETCH_HEAD_CHARS).toBeGreaterThan(PAGE_PREFETCH_TAIL_CHARS);
    // 头段至少占上限的六成——纯头部截断会丢结论，纯比例失衡会丢开头
    expect(PAGE_PREFETCH_HEAD_CHARS / MAX_PAGE_PREFETCH_CHARS).toBeGreaterThan(0.6);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run lib/chat/page-prefetch.test.ts`

Expected: FAIL。`derives the head/tail split from the ceiling at a 2:1 ratio` 报 `PAGE_PREFETCH_HEAD_CHARS` 收到 32000 而期望 133333。

- [ ] **Step 3: 改成按比例推导**

`lib/chat/page-prefetch.ts`，把：

```ts
/** 头尾 2:1：开头承担「这是什么页面」，结尾承担「结论是什么」——纯头部截断恰好把结论全丢掉。 */
export const PAGE_PREFETCH_HEAD_CHARS = 32000;
export const PAGE_PREFETCH_TAIL_CHARS = MAX_PAGE_PREFETCH_CHARS - PAGE_PREFETCH_HEAD_CHARS;
```

改成：

```ts
/**
 * 头尾 2:1：开头承担「这是什么页面」，结尾承担「结论是什么」——纯头部截断恰好把结论全丢掉。
 *
 * 必须从上限推导而不是写字面量：这个值曾是 32000，从当时 48000 的上限按 2:1 拆出来的，
 * 上限抬到 200000 之后字面量不动的话，windowed 分支给超长页的正文比例会从 2/3 缩水到 16%，
 * 反而比 full 分支退步。
 */
export const PAGE_PREFETCH_HEAD_CHARS = Math.round((MAX_PAGE_PREFETCH_CHARS * 2) / 3);
export const PAGE_PREFETCH_TAIL_CHARS = MAX_PAGE_PREFETCH_CHARS - PAGE_PREFETCH_HEAD_CHARS;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/chat/page-prefetch.test.ts`

Expected: PASS，全部用例通过（含现有的 `windows a body past the ceiling into head and tail`，它本来就从常量构造正文）。

- [ ] **Step 5: 全量校验**

Run: `pnpm compile && pnpm test`

Expected: `tsc --noEmit` 无输出；vitest 全部通过。

- [ ] **Step 6: 提交**

```bash
git add lib/chat/page-prefetch.ts lib/chat/page-prefetch.test.ts
git commit -F - <<'MSG'
fix(chat): 预取头尾切分改为按上限推导，不再是写死的 32000

PAGE_PREFETCH_HEAD_CHARS 是从旧上限 48000 按头尾 2:1 拆出来的字面量。上限抬到
200000 之后字面量不动的话，windowed 分支给 25 万字符的页面只有 48000（19%）的
正文，比 full 分支退步。

头尾 2:1 的理由不变：开头承担"这是什么页面"，结尾承担"结论是什么"，纯头部截断
恰好把结论全丢掉。改的只是它随上限缩放，新增用例把这个性质锁住。

ref: docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §8

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: 跨标签引用的预算改为跟随上游常量

**Files:**
- Modify: `lib/chat/tab-reference.ts:6`（导入）、`:8-13`（两个常量）
- Test: `lib/chat/tab-reference.test.ts:32-45`（`planTabRefBudget` 块）

**Interfaces:**
- Consumes: `MAX_TOOL_RESULT_CHARS`（Task 2，来自 `@/lib/agent/context-budget`）、`MAX_PAGE_PREFETCH_CHARS`（Task 2 经 `lib/chat/page-prefetch`）
- Produces: `TAB_REF_TOTAL_MAX_CHARS = 200000`、`TAB_REF_SINGLE_MAX_CHARS = 200000`。无后续任务依赖。

**背景：** `TAB_REF_SINGLE_MAX_CHARS` 的注释声称"只引 1 个页时行为与 store.ts 的 page-scope 预取一致"，但它等于 `DEFAULT_READ_MAX_CHARS`（24000），而预取上限是 `MAX_PAGE_PREFETCH_CHARS`（今天 48000，Task 2 后 200000）——这句话在 c2ec362 之后就不再成立。本任务让它重新成立，并把断言写进测试，使它从"注释声称的性质"变成"测试保障的性质"。`lib/chat/page-prefetch.ts` 不导入 `tab-reference.ts`，新增的反向导入不构成循环。

- [ ] **Step 1: 写失败的测试**

在 `lib/chat/tab-reference.test.ts` 的 `describe('planTabRefBudget')` 块内，**替换**前两个用例：

```ts
  // 这条断言把注释声称的性质变成测试保障的性质：注释曾声称"只引 1 个页时与
  // page-scope 预取一致"，而实际两个数字在 c2ec362 之后就分叉了（24000 对 48000）。
  it('gives a lone reference exactly the page-scope prefetch budget', () => {
    expect(TAB_REF_SINGLE_MAX_CHARS).toBe(MAX_PAGE_PREFETCH_CHARS);
    expect(planTabRefBudget(1)).toBe(MAX_PAGE_PREFETCH_CHARS);
  });

  it('splits the total budget across references', () => {
    expect(planTabRefBudget(5)).toBe(Math.floor(TAB_REF_TOTAL_MAX_CHARS / 5));
    expect(planTabRefBudget(2)).toBe(Math.floor(TAB_REF_TOTAL_MAX_CHARS / 2));
  });
```

在该测试文件顶部的导入区加上：

```ts
import { MAX_PAGE_PREFETCH_CHARS } from './page-prefetch';
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run lib/chat/tab-reference.test.ts`

Expected: FAIL。`gives a lone reference exactly the page-scope prefetch budget` 报 `TAB_REF_SINGLE_MAX_CHARS` 收到 24000 而期望 200000。

- [ ] **Step 3: 改成跟随上游常量**

`lib/chat/tab-reference.ts`，把导入行：

```ts
import { DEFAULT_READ_MAX_CHARS } from '@/lib/agent/context-budget';
```

改成：

```ts
import { MAX_TOOL_RESULT_CHARS } from '@/lib/agent/context-budget';
import { MAX_PAGE_PREFETCH_CHARS } from './page-prefetch';
```

把两个常量：

```ts
/** 跨全部引用页的正文总预算。引用页正文进的是 user 消息、永远不会被摘要压缩，5 个引用各拿满
 * 单页上限就能自己把上下文顶到 CONTEXT_RECUT_TARGET_CHARS 以上，所以必须有一道总量封顶。 */
export const TAB_REF_TOTAL_MAX_CHARS = 48000;
/** 单个引用页的正文上限，与 browser_read_page 的默认 maxChars 同源（lib/agent/context-budget.ts）：
 * 只引 1 个页时行为与 store.ts 的 page-scope 预取一致。 */
export const TAB_REF_SINGLE_MAX_CHARS = DEFAULT_READ_MAX_CHARS;
```

改成：

```ts
/** 跨全部引用页的正文总预算。引用页正文进的是 user 消息、永远不会被摘要压缩，5 个引用各拿满
 * 单页上限就能自己把上下文顶到 CONTEXT_RECUT_TARGET_CHARS 以上，所以必须有一道总量封顶。
 * 与单条只读结果同源：两者最终进的是同一个上下文，各写各的迟早分叉。 */
export const TAB_REF_TOTAL_MAX_CHARS = MAX_TOOL_RESULT_CHARS;
/**
 * 单个引用页的正文上限，与 page-scope 预取同源：只引 1 个页时行为与 store.ts 的预取一致。
 *
 * 这个"一致"曾经只是注释里的说法——该常量原本等于 DEFAULT_READ_MAX_CHARS（24000），
 * 而预取上限是 MAX_PAGE_PREFETCH_CHARS（48000），c2ec362 之后两者就分叉了。
 * 现在它由同一个常量推导，且 tab-reference.test.ts 有对应断言把这个性质锁住。
 */
export const TAB_REF_SINGLE_MAX_CHARS = MAX_PAGE_PREFETCH_CHARS;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/chat/tab-reference.test.ts`

Expected: PASS，包括现有的两条不变量用例——`TAB_REF_TOTAL_MAX_CHARS`（200000）≤ `CONTEXT_RECUT_TARGET_CHARS`（250000），`TAB_REF_SINGLE_MAX_CHARS`（200000）≤ `TAB_REF_TOTAL_MAX_CHARS`（200000），两者都成立。

- [ ] **Step 5: 全量校验**

Run: `pnpm compile && pnpm test`

Expected: `tsc --noEmit` 无输出；vitest 全部通过。

- [ ] **Step 6: 提交**

```bash
git add lib/chat/tab-reference.ts lib/chat/tab-reference.test.ts
git commit -F - <<'MSG'
fix(chat): 跨标签引用预算改为跟随上游常量

TAB_REF_SINGLE_MAX_CHARS 的注释声称"只引 1 个页时行为与 page-scope 预取一致"，
但它等于 DEFAULT_READ_MAX_CHARS（24000）而预取上限是 MAX_PAGE_PREFETCH_CHARS，
c2ec362 之后两者就分叉了。这次让它重新成立，并把断言写进测试——注释声称的性质
只有变成测试保障的性质才不会再次漂移。

TAB_REF_TOTAL_MAX_CHARS 也从硬编码的 48000 改为跟随 MAX_TOOL_RESULT_CHARS：
引用正文和只读结果最终进的是同一个上下文，各写各的迟早分叉。

ref: docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §8

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## 收尾：设计稿状态更新

四个任务全部完成后，把 spec 头部的 `- 状态：设计待实现` 改为 `- 状态：已实现（<Task 1 的 commit>..<Task 4 的 commit>）`，与 `2026-09-20-page-prefetch-strategy-design.md` 的写法一致，单独提交：

```bash
git add docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md
git commit -m "docs: 上下文预算设计稿标记为已实现

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

## 验收：手工验证原始失效

代码改动之外，建议在真实页面上确认 §1 的失效确实消失（`pnpm dev` 后加载 `.output/chrome-mv3`）：

1. 打开 `hello-agents.datawhale.cc` 第四章（正文约 38291 字符）
2. 选中习题区的第 6 题，用选中提问发起一轮，让模型作答
3. 预期：模型能引用 4.4.3 小节的 Reflection 提示词原文，回答里不再出现"未在已读内容中"之类的免责声明
4. 在活动步骤时间线里确认 `browser_read_page` 只调用了一次

这一步不是自动化测试，不阻塞提交，但它是唯一能验证"模型实际行为改变"的手段——单元测试只能证明取窗函数返回了整页。
