# 显式任务成败信号 · 设计说明

- 日期：2026-08-27
- 来源：`docs/superpowers/specs/2026-08-26-page-agent-benchmark.md` §三 P2「显式任务成败信号」（对标 `alibaba/page-agent` 的 `done(success, text)`）
- 状态：已评审，待实现

## 1. 问题

Runi 一轮对话结束后，UI 上只有一段文本回复。无论这轮是"改好了三个字段，提交成功"还是"点了半天没找到提交按钮，放弃了"，气泡的视觉呈现完全一样——用户得自己读完文字才知道任务是不是真的做成了，历史记录里也没有任何可供筛选/统计的字段。

`lib/agent/activity-steps.ts` 已经有逐个工具调用的 `running`/`done`/`failed` 状态，但这是会话内瞬时状态：回合一结束就在 `store.ts` 的 `finally` 块里被清空（`set({ activitySteps: [] })`），从不落库。重新打开一个历史会话后，之前哪一轮成功哪一轮失败完全无从得知。

## 2. 目标与非目标

**目标**

- 新增一个模型可调用的收尾工具 `report_task_outcome`，让模型在完成一个"动过页面"的任务后显式声明 `success`/`partial`/`failure` 及简短原因。
- 该声明持久化到对应的 assistant 消息上，重新打开历史会话后依然可见。
- 侧边栏在消息气泡上渲染一个小徽标呈现这个结果。

**非目标（明确不做）**

| 不做 | 理由 |
|------|------|
| 纯问答轮（没有写工具运行）也要求汇报 | 「总结一下这页」之类的请求没有"任务成败"语义，勉强套用只会让徽标变成噪音——见 §3.1 |
| 把用户主动中止 / 模型流错误也折进 `outcome` 字段当成一种失败态 | 这两者是"管道断了"，不是"模型对自己任务的判断"，混在一起会让徽标语义变得含糊——见 §3.3 |
| 本次同时上线历史记录里的成败筛选/统计 UI | YAGNI：先让信号可靠落地、气泡上可见，等有真实数据后再决定筛选维度，是否需要、维度是什么现在都还没有信号——遵循上一个 P1 条目（页面位置感）"先小范围验证再决定要不要扩展"的同一套节奏 |
| 布尔 success/failure（对齐 page-agent 原样） | 真实任务经常是"填了 3 个字段中的 4 个"这种部分成功，硬塞进二选一会逼模型选一个误导性的极端——见 §3.4 |

## 3. 关键决策

### 3.1 触发范围：本轮运行过至少一个写工具，才要求汇报

复用 `permissions.ts` 的 `WRITE_TOOL_NAMES` 判定。`agent.ts` 的 `afterToolCall` 里已经有 `isWriteTool` 判断（`beforeToolCall` 里算出、写工具批准时会调用 `policy.approveWrite()`），新增一个闭包内的 `writeToolRanThisRun` 布尔标记，在写工具成功执行后置位。只有该标记为真时才会在收尾时要求调用 `report_task_outcome`；纯读取/问答轮完全不受影响，行为与今天一致。

`writeToolRanThisRun` 这类闭包状态天然按"一次发送"隔离，不需要额外的重置逻辑：`store.ts:1084` 的 `runAgent` 每次用户发消息都会重新 `createBrowserAgent(...)`，`createBrowserAgentOptions` 内的所有闭包变量（`implementationDossierCollected`、`toolCallCounts` 等既有先例都是这个模式）都是每轮从零开始。

### 3.2 汇报机制：一个结构化收尾工具，而不是文本标记或额外追问

新增工具 `report_task_outcome({ outcome, reason })`，不带 `browser_` 前缀（不触碰页面或浏览器状态，与 `ask_user`/`wait` 同类），登记进 `permissions.ts` 的 `READ_ONLY_TOOL_NAMES`（不进 `WRITE_TOOL_NAMES`，不占写预算，不触发确认卡片）。

选它而不是"回复末尾加一个 `<task_status>` 标记"或"回合结束后再问模型一次"：结构化工具调用是 Runi 一贯的做法（表单提交靠结构探测而不是纯 prompt 约束，写操作靠写前写后指纹校验），弱模型或第三方端点更容易正确产生一次工具调用而不是精确复现一个自定义文本标记格式；且 `lib/agent/tool-call-repair.ts` 已经有工具调用参数修复兜底，两者复用同一条基础设施。追加一次独立问询会让每个写任务多一次完整的模型往返（延迟、成本翻倍），性价比不如"让模型在已经生成的最后一轮里顺手多调一次工具"。

### 3.3 与已有的 abort / 流错误状态的关系：框架层面天然互斥，不需要额外短路代码

`report_task_outcome` 的强制补调逻辑挂在 `prepareNextTurnWithContext` 钩子上（见 §3.5）。翻看 `pi-agent-core` 的 `agent-loop.js`：

```js
const message = await streamAssistantResponse(...);
if (message.stopReason === "error" || message.stopReason === "aborted") {
  await emit({ type: "turn_end", message, toolResults: [] });
  await emit({ type: "agent_end", messages: newMessages });
  return;   // ← 直接返回，prepareNextTurnWithContext 根本不会被调用
}
```

模型流本身报错或被中止时，循环在到达 `prepareNextTurnWithContext` 之前就直接退出了。用户中途点"停止"（`store.ts` 的 `stop()` 调用 `run.agent?.abort()`）会让底层 provider 流以 `AbortError` 拒绝，`store.ts:1219-1225` 的 `catch` 块捕获后保留已生成的部分内容，同样不会给 `report_task_outcome` 任何补调机会。

也就是说：不需要写"如果是 abort/error 就跳过"这类判断——挂钩子的这个位置，在这两种情况下天生就到达不了。唯一需要处理的分支就是"模型正常停止（这轮消息不含任何工具调用）"，这正是 §3.5 要判断的条件。

### 3.4 outcome 取值：`success` / `partial` / `failure` 三态

对齐问答里已确认的选择：布尔值会把"填了 3 个字段中的 4 个"这类真实的部分成功逼成一个误导性的极端。三态在 UI 上多一种徽标样式（§3.6），代价可以接受。

### 3.5 强制补调：复用 `prepareNextTurnWithContext`，与现有预算耗尽分支并列而非嵌套

`agent.ts` 现有的 `prepareNextTurnWithContext` 已经有一段"预算耗尽/连续被阻断→强制模型立刻用零工具给出最终回答"的逻辑（`policy.prepareFinalResponse()` 为真时触发）。新分支不复用这个已有分支，而是在其 `return undefined` 的位置之后新增一段独立判断：

```ts
prepareNextTurnWithContext: async (context) => {
  const budgetExhausted = policy.exhausted;
  if (policy.prepareFinalResponse()) {
    // 现有逻辑原样保留，不改动
    const finalInstruction: AgentMessage = { /* ... */ };
    return { context: { ...context.context, messages: [...context.context.messages, finalInstruction], tools: [] } };
  }

  // 新增：写工具跑过、这轮消息没有工具调用（模型认为自己已经收尾）、还没汇报过、
  // 还没强制补调过一次 —— 三个条件同时成立才补一轮。
  const hasToolCalls = context.message.content.some((c) => c.type === 'toolCall');
  if (writeToolRanThisRun && !outcomeReported && !outcomeForceAttempted && !hasToolCalls) {
    outcomeForceAttempted = true; // 保证最多补调一次，绝不循环
    options.steer({
      role: 'user',
      content: '任务已结束但还没有汇报结果。请立即调用 report_task_outcome，说明这次操作是 success/partial/failure，并给出一句话原因，然后停止。',
      timestamp: Date.now(),
    });
    return { context: { ...context.context, tools: [reportTaskOutcomeTool] } };
  }
  return undefined;
},
```

两个分支互斥的原因不是代码里显式判断出来的，而是场景本身不重叠：`policy.prepareFinalResponse()` 只在"模型尝试了工具调用但被预算/连续失败阻断"时才为真，此时 `context.message` 必然含有工具调用（`hasToolCalls` 为真），不满足新分支 `!hasToolCalls` 的条件。反过来，新分支要求这轮消息完全不含工具调用（模型认为自己已经说完了），此时预算通常还没耗尽。两者各自处理"收尾"的一种触发原因，不会同时命中。

`options.steer(...)` 让强制指令进入 `steeringQueue`，被 `Agent` 内部的 `getSteeringMessages` 在同一轮 tick 结束前 drain 出来、注入下一轮 provider 请求——这与 `afterToolCall` 里已有的"预算软提醒"（`budgetWarning`）走的是同一条基础设施，不是新机制。`tools: [reportTaskOutcomeTool]` 把下一轮能调的工具收窄到只剩这一个，逼模型只能要么调用它、要么给一段没有工具调用的文本（此时 `outcomeForceAttempted` 已经是 true，不会再触发第二次补调，静默放弃——这是可接受的兜底，好过无限重试）。

`reportTaskOutcomeTool` 是 `createBrowserTools(...)` 返回的工具数组里按 name 找到的那一个引用，不是重新构造。

### 3.6 UI：气泡内小徽标 + 悬浮提示原因，不做成横幅

参照 `ActivityStep` 已有的 `running`/`done`/`failed` 三态视觉语言，在 `App.tsx` 的 `Message` 组件里、assistant 气泡内容之后新增一小块徽标（不是像 `error` 那样的通栏红色 alert，那是给"插件本身出错"用的，语义不同）：

- `success` → 绿色对勾 + 文案（i18n：`chat.taskOutcome.success`）
- `partial` → 琥珀色 + 文案（`chat.taskOutcome.partial`）
- `failure` → 红色 + 文案（`chat.taskOutcome.failure`）

`reason` 只作为徽标的 `title`（悬浮提示）呈现，不在气泡里额外占一行文字——模型自己的最终回复文本通常已经在解释发生了什么，`reason` 是给这个徽标本身的简短依据，重复展示没有必要。

## 4. 数据结构改动

```ts
// lib/agent/task-outcome.ts（新文件）

export type TaskOutcomeValue = 'success' | 'partial' | 'failure';

export interface TaskOutcome {
  outcome: TaskOutcomeValue;
  /** 模型给出的一句话原因；partial/failure 时应说明卡在哪里。 */
  reason: string;
}

export const REPORT_TASK_OUTCOME_TOOL_NAME = 'report_task_outcome';
```

```ts
// lib/agent/tools.ts

import { REPORT_TASK_OUTCOME_TOOL_NAME, type TaskOutcome, type TaskOutcomeValue } from './task-outcome';

// 不带 browser_ 前缀，理由同 ask_user/wait：不修改页面或浏览器状态。
function makeReportTaskOutcomeTool(onTaskOutcome?: (outcome: TaskOutcome) => void): BrowserAgentTool {
  return {
    name: REPORT_TASK_OUTCOME_TOOL_NAME,
    label: 'Report Task Outcome',
    description:
      '当你刚刚完成了一个涉及修改页面或与页面交互的任务并准备结束这一轮时，调用它显式声明这次任务的结果。' +
      '不要在纯问答、没有实际操作页面的轮次里调用它。',
    parameters: Type.Object({
      outcome: Type.Union(
        [Type.Literal('success'), Type.Literal('partial'), Type.Literal('failure')],
        { description: 'success=完全达成；partial=部分达成或做了但不确定是否完全生效；failure=没能达成。' },
      ),
      reason: Type.String({ description: '一句话原因，partial/failure 时说明具体卡在哪一步。' }),
    }),
    execute: async (_toolCallId, params) => {
      const { outcome, reason } = params as { outcome: TaskOutcomeValue; reason: string };
      onTaskOutcome?.({ outcome, reason });
      return textResult(`已记录任务结果：${outcome}。`, { outcome, reason });
    },
  };
}
```

`createBrowserTools` 的返回数组里新增 `makeReportTaskOutcomeTool(config.onTaskOutcome)`（`BrowserToolsConfig` 新增 `onTaskOutcome?: (outcome: TaskOutcome) => void` 字段，与现有 `onAskUser` 同构）。

```ts
// lib/agent/permissions.ts

export const READ_ONLY_TOOL_NAMES = new Set([
  // ...现有条目不变
  'report_task_outcome', // 新增：不修改页面或浏览器状态，同 ask_user/wait
]);
```

```ts
// lib/agent/agent.ts

export interface BrowserAgentOptions {
  // ...现有字段不变
  onTaskOutcome?: (outcome: TaskOutcome) => void; // 新增
}
```

`createBrowserAgentOptions` 内新增三个闭包变量：`writeToolRanThisRun = false`、`outcomeReported = false`、`outcomeForceAttempted = false`；`afterToolCall` 里 `isWriteTool && !context.isError` 时置位 `writeToolRanThisRun`，`toolName === REPORT_TASK_OUTCOME_TOOL_NAME && !context.isError` 时置位 `outcomeReported`；`prepareNextTurnWithContext` 按 §3.5 新增分支。

```ts
// lib/chat/messages.ts

export interface ChatMessage {
  // ...现有字段不变
  /** 本轮任务成败信号；仅当模型在一个动过页面的回合里调用了 report_task_outcome 才会有值。 */
  taskOutcome?: TaskOutcome; // 新增
}
```

`toMessageRecords` 的映射里新增 `taskOutcome: message.taskOutcome`。

```ts
// lib/db.ts

export interface ChatMessageRecord {
  // ...现有字段不变
  /**
   * 本轮任务成败信号，仅当模型调用过 report_task_outcome 才有值。
   * 不建索引，同 kind/quotedText/attachments 一样无需 Dexie 版本迁移；存量记录无此字段即视为没有信号。
   */
  taskOutcome?: TaskOutcome; // 新增
}
```

```ts
// entrypoints/sidepanel/store.ts

interface ActiveRun {
  // ...现有字段不变
  taskOutcome: TaskOutcome | null; // 新增，初始化为 null
}
```

`runAgent` 里 `createBrowserAgent(...)` 的调用新增：
```ts
onTaskOutcome: (outcome) => {
  if (!isCurrentRun(run, get)) return;
  run.taskOutcome = outcome;
},
```
`finally` 块里、`persistConversationSnapshot` 之前，若 `run.taskOutcome` 非空，把它合并到当前最后一条 assistant 消息（新增一个与 `replaceLastAssistant` 同构的小函数，例如 `attachTaskOutcome(set, run.taskOutcome)`，只 patch `taskOutcome` 字段，不动 `content`）。

`openConversation` 的记录映射新增 `taskOutcome: r.taskOutcome`。

## 5. 影响面

| 文件 | 改动 |
|------|------|
| `lib/agent/task-outcome.ts`（新文件） | `TaskOutcomeValue`/`TaskOutcome`/`REPORT_TASK_OUTCOME_TOOL_NAME` |
| `lib/agent/tools.ts` | 新增 `makeReportTaskOutcomeTool`；`BrowserToolsConfig.onTaskOutcome`；`createBrowserTools` 数组里注册 |
| `lib/agent/permissions.ts` | `READ_ONLY_TOOL_NAMES` 新增 `report_task_outcome` |
| `lib/agent/agent.ts` | `BrowserAgentOptions.onTaskOutcome`；`writeToolRanThisRun`/`outcomeReported`/`outcomeForceAttempted` 闭包状态；`afterToolCall`/`prepareNextTurnWithContext` 按 §3.1/§3.5 扩展 |
| `lib/agent/system-prompt.ts` | `task_execution` 分区追加一句：动过页面的任务收尾前必须调用 `report_task_outcome` |
| `lib/chat/messages.ts` | `ChatMessage.taskOutcome`；`toMessageRecords` 透传 |
| `lib/db.ts` | `ChatMessageRecord.taskOutcome`（不建索引，无迁移） |
| `entrypoints/sidepanel/store.ts` | `ActiveRun.taskOutcome`；`onTaskOutcome` 回调；`finally` 块里落到最后一条 assistant 消息；`openConversation` 记录映射透传 |
| `entrypoints/sidepanel/App.tsx` | `Message` 组件渲染徽标（或拆成独立 `TaskOutcomeBadge.tsx` 组件，视实现时代码量决定） |
| `lib/i18n/locales/zh.ts` / `en.ts` | `chat.taskOutcome.success` / `.partial` / `.failure` 文案 |

## 6. 测试

**单测（`unit` project，node env）：**

1. `agent.ts`（或抽出的纯函数，视实现时是否值得单独提取）：`writeToolRanThisRun` 只在写工具成功执行后置位，读工具/失败的写工具不置位。
2. `prepareNextTurnWithContext` 新分支：写工具跑过 + 消息无工具调用 + 未汇报 + 未强制过 → 触发一次补调，`tools` 收窄为仅 `report_task_outcome`；已经强制过一次后同样条件不再重复触发（验证 `outcomeForceAttempted` 生效，不会死循环）。
3. 该分支与既有 `policy.prepareFinalResponse()` 分支互斥：构造"消息含工具调用 + 预算耗尽"场景，验证走的是原有分支而不是新分支。
4. `lib/chat/messages.ts`：`toMessageRecords` 正确透传 `taskOutcome`；无该字段的消息不受影响（回归保护）。
5. `report_task_outcome` 工具的 `execute`：正确调用 `onTaskOutcome` 回调并返回预期文本。

**UI 测试（`ui` project，jsdom）：**

6. `Message` 组件：`taskOutcome` 为 `success`/`partial`/`failure` 三种取值时渲染对应徽标文案；无 `taskOutcome` 时不渲染徽标（回归保护，覆盖存量历史消息场景）。

消息协议/store 状态的类型收敛由 `pnpm compile` 保证。`agent-loop.js` 内部的 abort/error 短路行为属于第三方依赖 `pi-agent-core` 的既有实现，不在本项目测试范围内，§3.3 的结论靠阅读其源码得出。

**自动测不了、需手动验证的清单：**

1. 真实场景下让模型执行一个多步写任务（如填表单），确认收尾时确实调用了 `report_task_outcome` 且徽标正确显示；再试一个模型"忘记调用"的场景（如果能构造出来），确认强制补调分支生效。
2. 用户中途点击"停止"，确认不会出现半吊子的 `report_task_outcome` 调用或卡住的补调逻辑。
3. 关闭再重新打开一个带 `taskOutcome` 的历史会话，确认徽标在重新加载后依然渲染正确。
