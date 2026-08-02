# 设计：把 Agent 活动卡片（工具名/数量列表）改成单行"当前步骤"提示

- 状态：已批准 Approved
- 日期：2026-08-02
- 关联：`entrypoints/sidepanel/components/AgentActivityCard.tsx`、
  `entrypoints/sidepanel/store.ts`、`entrypoints/sidepanel/App.tsx`、
  `lib/workbench/presentation.ts`、`lib/agent/confirm-summary.ts`（参考实现）、
  `lib/i18n/locales/{zh,en}.ts`

## 背景

`AgentActivityCard` 目前是一张可折叠卡片：收起时显示总体状态文案 + `completed/total`
数字计数，展开后是一份逐条工具调用列表，每条只显示内部工具名（经 `TOOL_LABEL_KEYS`
映射成"点击"「导航」这类词）和状态图标。用户反馈这份信息用处不大——工具名列表和
completed/total 计数都不能告诉用户 agent 具体在做什么（比如点的是哪个按钮、导航去了
哪个网址）。

`lib/agent/confirm-summary.ts` 里已经有一份更有用的先例：`ConfirmationCard` 用
`summarizeToolCallForConfirmation(toolName, args)` 把工具调用翻译成带具体参数的句子
（如 `AI 想要点击 "button.login"。`），但那份文案是"确认前"的语气（"想要…"），且只覆盖
需要用户确认的写/交互类工具，不覆盖只读工具。

本次改动范围只针对"用户不需要确认、单纯展示 agent 正在做什么"这条通路（活动卡片），
不涉及 `ConfirmationCard`/`confirm-summary.ts` 本身，也不涉及展示模型 reasoning/thinking
内容——那是完全独立、需要新增流式解析和 provider 配置的另一个项目，本次不做。

## 目标

- 把"工具名 + completed/total 列表"换成一行会实时更新的"当前步骤"文字，内容尽量带具体
  参数（选择器/URL/输入文本等），复用 `summarizeToolCallForConfirmation` 同等粒度的参数
  提取逻辑，覆盖全部工具（含只读工具）。
- 去掉可展开的历史列表和 `completed/total` 数字计数。
- 工具调用失败/被拦截/被拒绝时，同一行短暂显示失败描述，随后自动消失；不引入新的 UI
  元素承接这类状态。
- 整个 turn 结束后这行文字直接消失，不留痕迹（不作为历史记录展示）。

## 非目标

- 不改动 `ConfirmationCard`、`lib/agent/confirm-summary.ts` 或确认门（confirm-gate）逻辑。
- 不展示模型的 reasoning/thinking 内容——`agent.ts` 目前显式把 `thinkingLevel` 设为
  `'off'`，`anthropic-stream.ts`/`openai-stream.ts` 也完全不解析 thinking 相关的流式
  事件，要做这个需要新增 provider 配置、流式解析、持久化字段和新 UI，工作量和本次改动
  不在一个量级，作为独立项目单独立项。
- 不持久化"当前步骤"文字到 `ChatMessage`/IndexedDB——它纯粹是运行时瞬态状态，turn 结束
  即清空，`lib/chat/messages.ts` 的消息结构不变。
- 不改变 `tool_execution_start/update/end` 事件本身的产生方式，只改变订阅方（store）如何
  处理这些事件。

## 设计

### 1. 描述生成（新增 `lib/agent/activity-description.ts`）

```ts
export type ActivityStatus = 'running' | 'error' | 'blocked' | 'denied';

export function describeToolActivity(toolName: string, args: unknown, status: ActivityStatus): string
```

与 `confirm-summary.ts` 并列的新模块，同样用 `switch (toolName)` 从 `args` 里挑
`selector`/`url`/`text`/`value` 等字段拼句子，但覆盖全部工具（含 `browser_read_page`、
`browser_screenshot` 等只读工具——这些没有值得展示的参数，退化为纯工具名文案）。

区别于 `confirm-summary.ts` 硬编码中文字符串的做法，本模块的文案走现有 i18n 体系（
`AgentActivityCard` 当前就是走 i18n 的，不应该在替换它的新组件里退化成硬编码）：新增
`agentActivity.now.*`（running 态，现在时）与 `agentActivity.failed.*`（error/blocked/
denied 态，共用一套失败文案，不用三份）两组 key，用 `t(key, { target })` 插值，`target`
即从参数提取出的选择器/URL/文本等值。没有可展示参数的只读工具复用现有的
`agentActivity.tool.*` 文案作为 fallback。

### 2. Store（`entrypoints/sidepanel/store.ts`）

- `toolActivities: ToolActivity[]` → `currentActivity: ToolActivity | null`（74-78/94 行的
  `ToolActivity` 接口不变，只是从数组变成单值）。
- `upsertToolActivity`（899-915 行）替换为 `setCurrentActivity(set, activity)`：直接
  `set({ currentActivity: activity })`，不再需要按 `id` 查找/拼接/裁剪数组
  （`MAX_TOOL_ACTIVITY_ITEMS`、53 行，一并删除）。
- `tool_execution_start`/`tool_execution_update`（710-724 行）：照旧调用
  `setCurrentActivity`，状态 `running`。
- `tool_execution_end`（726-750 行）：
  - 成功（非 error/blocked）：直接清空 `currentActivity: null`（不再保留"done"态等下一步
    覆盖——单行展示不需要"已完成"这个中间态）。
  - error/blocked：`setCurrentActivity` 设置失败态，并 `setTimeout` 约 2.5 秒后清空（若
    在此期间有新的 `tool_execution_start`/结束调用发生，用一个自增 token 或直接比较
    `toolCallId` 来判断这个定时器是否还对应"最新"的活动，避免清掉了后来居上的新状态）。
- `onConfirm`（671-679 行）：`confirming` 态改为直接触发 `ConfirmationCard`（`set({
  pendingConfirmation })`），不再需要同时维护活动指示——`confirming` 这个中间态本来就和
  `ConfirmationCard` 重复，去掉对 `currentActivity` 的写入。
- `respondToConfirmation`（467-478 行）：拒绝时（`!approved`），用 `describeToolActivity`
  生成 denied 态文案写入 `currentActivity` 并起同样的自动清空定时器，而不是在数组里
  `map` 标记某一项。
- `stop()`（451-465 行）：中止时如果 `currentActivity` 处于 `running`，清空即可（不需要
  "stopped"这个中间态在单行 UI 里展示——直接消失即符合"turn 结束不留痕迹"的目标）。
- 四处 `toolActivities: []` 重置（480-491 clear、498-527 openConversation、661-668 发起新
  一轮）改为 `currentActivity: null`。

`ToolActivity['status']` 的 `'confirming'`/`'done'`/`'stopped'` 三个取值不再被写入（
`confirming` 转交给 `pendingConfirmation`，`done`/`stopped` 都变成直接清空），但类型上
仍保留这几个字面量以免影响其他潜在读者；如实现时发现确实无处使用，可以收窄类型。

### 3. 组件（新增 `CurrentActivityLine.tsx`，替换 `AgentActivityCard.tsx`）

无折叠/展开、无图标列表、无 `completed/total`。只在 `currentActivity` 非空时渲染一行：
`running` 态一个小 spinner + 文字，失败态一个警示色文字（沿用卡片现有的失败色，不新增
配色）。`App.tsx:262` 处的 `{toolActivities.length > 0 && <AgentActivityCard
activities={toolActivities} />}` 改为 `{currentActivity && <CurrentActivityLine
activity={currentActivity} />}`。

`AgentActivityCard.tsx` 整个文件删除。`lib/workbench/presentation.ts` 里的
`ToolActivityStatus`/`ToolActivityLike`/`ToolActivitySummary`/`TOOL_STATUS_PRECEDENCE`/
`summarizeToolActivities`（16-31、79-104 行）不再被任何调用方使用，一并删除，避免留下
死代码。

### 4. i18n（`lib/i18n/locales/zh.ts` / `en.ts`）

- 删除：`agentActivity.showDetails`、`agentActivity.hideDetails`、`agentActivity.cardLabel`、
  `agentActivity.liveStatus`、全部 `agentActivity.status.*`、全部 `agentActivity.detail.*`
  （这些是卡片折叠态/展开态专属文案，新组件不需要总体状态汇总，只需要当前这一条）。
- 保留并复用：`agentActivity.tool.*`（只读工具/无参数场景的 fallback 文案）。
- 新增：`agentActivity.now.*`（每个有参数的工具一条，如
  `agentActivity.now.click: '正在点击 "{target}"'`）、`agentActivity.failed.*`（同样每个
  有参数的工具一条失败文案，如 `agentActivity.failed.click: '点击 "{target}" 失败'`；
  error/blocked/denied 三种状态共用同一条文案，不需要按状态再拆三份）。
- 中英文两个文件保持 key 对齐。

## 边界与异常

- **同一 turn 内工具连续调用**：新的 `tool_execution_start` 直接覆盖
  `currentActivity`，不需要等上一条的自动清空定时器——`setCurrentActivity` 是单值覆盖
  语义，天然处理这种情况；旧的失败态定时器触发时若发现 `currentActivity` 已经是别的
  `toolCallId`，直接跳过清空（不能无条件清空，否则会误删已经覆盖上去的新状态）。
- **`tool_execution_end` 里 `blocked` 的判定**（727 行 `isToolGuardBlockResult`）不变，
  只是产出文案换成 `describeToolActivity(name, args, 'blocked')`。
- **失败原因不上 UI**：现有代码已经明确"活动卡片不展示原始 tool result，失败详情只打
  console.error"（728-730 行注释），新的单行失败文案同样只给出
  `describeToolActivity` 生成的简短描述（"点击失败"一类），不拼接原始错误信息，安全
  考虑不变。
- **多个工具并发执行**：本项目的 agent 循环里 `tool_execution_start`/`_end` 是否可能并发
  出现未专门验证；即使出现，单行覆盖语义下也只会展示"最新开始的那个"，属于可接受的
  降级（不是本次要解决的场景）。

## 安全与隐私

不改变数据可见范围——`describeToolActivity` 展示的参数（selector/url/text 等）本来就是
`ConfirmationCard` 场景下已经展示给用户的同类信息，只是现在只读工具也用同样粒度展示。
失败态依旧不泄露原始工具结果（同上一节）。

## 测试

- 新增 `lib/agent/activity-description.test.ts`：覆盖每个工具在 `running` 态下生成的文案
  含有正确的参数插值；`error`/`blocked`/`denied` 三态共用同一文案的断言；无参数只读工具
  fallback 到 `agentActivity.tool.*` 文案。
- 更新 `lib/workbench/presentation.test.ts`：删除 `summarizeToolActivities` 相关的
  describe 块（76-124 行一带）。
- `entrypoints/` 目前没有测试基础设施覆盖（CLAUDE.md 已注明），store/组件层的自动清空
  定时器、覆盖语义等行为改为 `pnpm dev` 加载解包扩展手动验证：
  - 连续触发多个工具调用（如一句话里要求点击后再输入文本），确认单行文字随每一步实时
    切换，不残留历史。
  - 触发一次会被拒绝的写操作确认（如 `browser_click`），确认拒绝后单行显示失败文案并在
    约 2.5 秒后消失。
  - 触发一次会被拦截的操作（如非 http(s) 的 `browser_navigate`），确认同样短暂显示后
    消失。
  - 一轮对话正常结束后，确认这一行不再残留任何文字。
- `pnpm compile`、`pnpm test`、`pnpm build` 收尾验证。

## 验收标准

- [ ] `AgentActivityCard.tsx` 已删除，`App.tsx` 改为渲染 `CurrentActivityLine`。
- [ ] `store.ts` 中 `toolActivities` 数组已替换为 `currentActivity: ToolActivity | null`，
      `upsertToolActivity`/`MAX_TOOL_ACTIVITY_ITEMS` 已移除。
- [ ] `lib/agent/activity-description.ts` 新增，覆盖全部工具，含只读工具 fallback。
- [ ] `lib/workbench/presentation.ts` 中不再使用的
      `ToolActivityStatus`/`ToolActivityLike`/`ToolActivitySummary`/
      `summarizeToolActivities`/`TOOL_STATUS_PRECEDENCE` 已删除。
- [ ] i18n key 按上文清单增删，中英文成对。
- [ ] 工具调用失败/拦截/拒绝时单行文字显示后自动消失；turn 结束后不留痕迹。
- [ ] `lib/agent/activity-description.test.ts` 新增；`presentation.test.ts` 中失效用例已
      删除。
- [ ] `pnpm compile`、`pnpm test`、`pnpm build` 通过。

## 开放问题

- 无。
