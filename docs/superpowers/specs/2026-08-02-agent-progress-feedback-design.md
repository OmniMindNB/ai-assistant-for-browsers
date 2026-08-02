# 设计：Agent 运行过程的进度反馈增强（步骤历史 + 思考间隙提示 + 慢工具升级）

- 状态：已批准 Approved
- 日期：2026-08-02
- 关联：`entrypoints/sidepanel/store.ts`、`entrypoints/sidepanel/App.tsx`、
  `entrypoints/sidepanel/components/CurrentActivityLine.tsx`（本次替换）、
  `lib/agent/activity-description.ts`、`lib/i18n/locales/{zh,en}.ts`
- 前置：`2026-08-02-single-line-activity-indicator-design.md`（今天早些时候刚落地的单行活动
  指示，本设计是在其基础上的延伸，不是推倒重来）

## 背景

单行活动指示（`CurrentActivityLine`）刚刚上线，解决了"工具调用列表信息量不够"的问题，但
真机体验后用户反馈：任务耗时较长时，整体感知仍然是"看不到反馈"。具体拆解为三类场景：

1. **思考间隙**：一个工具刚结束、下一个还没开始，或者模型正在组织最终回答时，`currentActivity`
   已被清空，`Message` 组件的 `TypingDots` 只在"本条消息还没收到第一个 token"时显示——一旦
   前面已经流出过文本，这段间隙里界面完全静默。
2. **多步骤任务的整体进度**：当前设计里成功完成的步骤会立刻从界面消失（`setCurrentActivity(set,
   null)`），用户只能看到"现在这一步"，看不到"到目前为止做了什么"，无法建立任务正在推进的信任感。
3. **单个工具调用本身很慢**：已有脉冲动画点+文字描述，但耗时明显超出正常范围时，文案不会变化，
   用户无法区分"还在正常工作"和"卡住了"。

## 目标

- 工具调用之间/结束后的静默间隙里，复用现有的 `TypingDots` 视觉语言给出"仍在进行"的提示。
- 把"只展示当前一步"换成"本轮内累积的步骤历史"：已完成的步骤保留在列表里（用过去式文案+勾选
  图标区分，而非只改图标不改文案），当前步骤仍然高亮/带动画，失败或被拒绝的步骤永久保留在本轮
  历史里，不再需要 2.5 秒后自动消失。
- 单个工具调用运行超过 6 秒仍未结束时，追加一句通用的"时间较长，可能需要更长时间"提示，不做
  实时秒数计时。

## 非目标

- 不改变"本轮结束后整份历史清空、不写入 `ChatMessage`/IndexedDB"的既有原则——这仍然是运行时
  瞬态状态，只是"瞬态"的范围从单条目扩展为"本轮全部步骤"。
- 不展示模型 reasoning/thinking 内容，原因同前一份设计（需要新增 provider 配置和流式解析，
  是独立项目）。
- 不改变 `ConfirmationCard`/`confirm-gate.ts` 本身的确认流程。
- 不为 `stop()` 手动中止新增"已停止"这一可视状态——中止后维持现状（列表立即清空），这不在本次
  反馈范围内，如后续需要可另外立项。
- 不引入实时跳动的秒数计时器（用户已明确选择"6 秒后换一句文案，不带实时秒数"这一更简单的方案）。

## 设计

### 1. `lib/agent/activity-description.ts`：新增 `done` 状态

```ts
export type ActivityStatus = 'running' | 'done' | 'failed';
```

- `withTarget()` 增加第三个 key 参数（`nowKey`/`doneKey`/`failedKey`），按 `status` 选择对应
  文案。
- `plain()`（无参数的只读工具，如"读取页面""获取脚本"）不需要改动：这些标签本身是无时态的名词
  短语，running/done 场景下直接复用同一段文案即可，只有 `failed` 分支已经在做
  `{action}失败` 的包装。
- 涉及 `withTarget` 的 12 个工具（`inspectFocus`/`queryDom`/`getHtml`/`getComputedStyle`/
  `setStyle`/`modifyDom`/`click`/`type`/`select`/`scrollTo`/`navigate`/`setStorage`）各新增一条
  `agentActivity.done.*` key，过去式表达（如 `agentActivity.done.click: '已点击 "{target}"'` /
  `'Clicked "{target}"'`），中英文成对，共 24 条新增字符串。

### 2. 慢工具升级：不新增按工具的文案

不做成第三套"慢速"专属文案（会再翻倍新增 12×2 条字符串），而是一条通用后缀 key：

```
agentActivity.slowSuffix: '……时间较长，可能需要更长时间'
agentActivity.slowSuffix (en): '… this is taking longer than usual'
```

`ActivityStep` 新增 `slow?: boolean` 字段。`tool_execution_start` 时为该 `toolCallId` 启动一个
6 秒定时器；到点时若该步骤仍是 `running` 状态，把 `slow` 置为 `true`（只翻一次，不再变化，不
逐秒刷新）；步骤提前结束（`tool_execution_end`/被拒绝/`stop()`）则清掉对应定时器。渲染层在
`status === 'running' && slow` 时，把 `describeToolActivity(...)` 的结果与
`t('agentActivity.slowSuffix')` 拼接展示，不改变 `describeToolActivity` 本身的返回值。

### 3. Store（`entrypoints/sidepanel/store.ts`）

```ts
export interface ActivityStep {
  id: string; // toolCallId
  description: string;
  status: 'running' | 'done' | 'failed';
  slow?: boolean;
}
```

- `currentActivity: ToolActivity | null` → `activitySteps: ActivityStep[]`。
- `setCurrentActivity`（覆盖单槽语义）替换为两个操作：
  - `upsertActivityStep(set, get, step)`：按 `id` 查找，命中则原地替换该条目（用于
    `tool_execution_start`/`tool_execution_update` 反复更新同一个 `toolCallId` 时不产生重复
    条目），未命中则 `push` 到数组末尾（用于确认被拒绝时——这种情况下从未收到过
    `tool_execution_start`，数组里没有对应条目）。
  - `finishActivityStep(set, get, id, status)`：按 `id` 查找并把该条目的 `status` 原地改成
    `'done'` 或 `'failed'`（同时用 `describeToolActivity(toolName, args, status)` 重新生成对应
    文案），条目本身**不删除**，留在数组里作为历史记录。
- `tool_execution_start`/`tool_execution_update`：`upsertActivityStep` 写入 `running` 态 +
  启动/复用慢速定时器。
- `tool_execution_end`：成功 → `finishActivityStep(..., 'done')`；失败/被拦截 →
  `finishActivityStep(..., 'failed')`；同时清掉该 `id` 的慢速定时器。
- `respondToConfirmation` 拒绝分支：`upsertActivityStep` 直接写入一条 `failed` 条目（沿用现有
  逻辑，只是从"覆盖单槽"变成"追加一条"）。
- 重置点（`activitySteps: []`，替换原来的 `currentActivity: null`）：新一轮开始（发消息/编辑
  重发）、`clear()`、`openConversation()`、运行结束的 `finally` 块。`stop()` 保持现状——立即把
  `activitySteps` 清空，不做"已停止"标记（见非目标）。
- 慢速定时器改用 `Map<string, ReturnType<typeof setTimeout>>` 按 `toolCallId` 管理（替换原来
  只支持单个活动的 `failureClearTimer` 单变量），在 `finishActivityStep`、`stop()`、`clear()`、
  `openConversation()` 时清理对应/全部定时器，避免不再展示的步骤因迟到的定时器回调被误更新（
  更新前先确认该 `id` 仍在数组中且仍是 `running`，否则跳过——用来防御新一轮已经把数组清空、旧
  定时器却仍在排队触发的边界情况）。

不再需要"失败态 2.5 秒后自动清空"的定时器和相关逻辑——失败条目现在是永久的历史记录，随本轮
结束一起清空，`FAILURE_DISPLAY_MS` 常量和相关分支一并删除。

### 4. 思考间隙提示（`entrypoints/sidepanel/App.tsx` 的 `Message`）

现状：`content ? <Markdown/> : busy ? <TypingDots/> : null`——一旦 `content` 非空，`TypingDots`
永远不再出现。

改为：在已渲染的 `content`（如果有）之后，追加一个条件渲染的小号 `TypingDots`：当
`busy && !pendingConfirmation && activitySteps 中没有 status === 'running' 的条目` 时展示。
这样"等待第一个 token""两次工具调用之间""最后一次工具调用后组织回答"这三种此前互不覆盖的
静默间隙，统一由同一个视觉信号覆盖；一旦有工具在跑，`ActivityStepList`（见下）接管"正在
工作"的信号，`Message` 内部不再重复展示动效。

判断"是否存在 running 条目"直接读 `activitySteps`（新状态已经是数组，无需额外计算字段）。

### 5. 组件：`ActivityStepList.tsx`（替换 `CurrentActivityLine.tsx`）

- 文件重命名：`CurrentActivityLine.tsx` → `ActivityStepList.tsx`，`App.tsx:262` 处
  `{currentActivity && !pendingConfirmation && <CurrentActivityLine ... />}` 改为
  `{activitySteps.length > 0 && !pendingConfirmation && <ActivityStepList steps={activitySteps} />}`。
- 容器：`max-h-32 overflow-y-auto`（约 4-5 行可视高度），跟随现有消息区域的自动滚动到底部逻辑，
  不需要额外的"折叠/展开"或"还有 N 条"分页 UI。
- 每一行：
  - `running`：现有的蓝色脉冲小圆点 + 文案（`slow` 为真时文案追加 `agentActivity.slowSuffix`）。
  - `done`：灰色勾选图标 + 过去式文案（沿用现有失败态配色规范，不新增配色 token）。
  - `failed`：现有的红色 ✗ + 失败文案（不变）。
- `role="status"`/`aria-live="polite"` 保留在容器级别（不需要每行都是 live region，避免多条
  历史同时触发屏幕阅读器重复播报——只有新增/变更的那一行的语义变化需要播报，交给
  `aria-live="polite"` 的默认合并行为即可）。

## 边界与异常

- **同一 `toolCallId` 的 `start`→`update`→`end` 序列**：`upsertActivityStep` 处理前两个（原地
  替换），`finishActivityStep` 处理最后一个（原地翻转状态），不会在数组里产生 3 条记录。
- **确认被拒绝**：从未有 `tool_execution_start`，`respondToConfirmation` 直接 `upsertActivityStep`
  推入一条新的 `failed` 记录；由于 `id` 此前不存在，走 push 分支，不会误伤已有条目。
- **`stop()` 中止**：沿用现状——`activitySteps` 立即清空，慢速定时器全部清理。不引入"已停止"
  视觉状态（见非目标）。
- **迟到的慢速定时器回调**：数组已重置（新一轮/`clear()`/`openConversation()`）后，任何仍在
  排队的定时器回调必须先确认目标 `id` 仍存在且仍是 `running` 才写入，否则直接跳过——防止写入
  一个已经不存在于当前数组语境里的孤立 `slow: true`。
- **列表长度**：读工具预算 12、写工具预算 24，理论上单轮最多可积累三十余条记录；用固定高度
  `overflow-y-auto` 而非截断/分页处理，代价是长任务里需要手动滚动查看早期步骤，可接受（这是
  运行时反馈而非需要检索的历史记录）。

## 安全与隐私

不改变数据可见范围——沿用 `describeToolActivity` 已有的参数提取粒度，不展示原始 tool result；
过去式文案与现在时文案暴露的信息量完全相同，只是时态不同。慢速提示追加的是固定文案，不携带
任何运行时数据。

## 测试

- `lib/agent/activity-description.test.ts`：新增 `done` 状态的用例（12 个 `withTarget` 工具的
  过去式文案 + 参数插值正确性）；确认 `plain()` 分支下 running/done 复用同一文案。
- `entrypoints/sidepanel/store.test.ts`（如不存在则新建，`entrypoints/` 目前没有测试基础设施，
  这一条视既有覆盖情况调整）或等价的手动验证：
  - `start`→`update`→`end`（成功）序列只产生一条最终 `status: 'done'` 的记录，不重复。
  - 确认拒绝直接产生一条独立的 `failed` 记录。
  - 6 秒未结束的 running 步骤 `slow` 变为 `true`；结束后定时器不再触发写入。
  - 新一轮开始/`clear()`/`openConversation()` 后 `activitySteps` 清空，且此前排队的定时器回调
    不会写回已清空的数组。
- 手动 `pnpm dev` 验收：
  - 连续多个工具调用的一轮任务：历史列表逐步累积已完成步骤（过去式+勾选），当前步骤持续高亮。
  - 一次会被拒绝的写操作确认：拒绝后历史列表里出现一条永久的失败记录，不再是"闪一下就消失"。
  - 人为制造一个耗时超过 6 秒的工具调用（如读取一个很大的页面），确认运行中文案追加"时间较长"
    后缀。
  - 两次工具调用之间人为制造间隔：确认消息气泡尾部出现 `TypingDots`，工具历史列表本身不受影响。
  - 一轮任务正常结束后，`ActivityStepList` 和思考间隙提示都不再残留。
- `pnpm compile`、`pnpm test`、`pnpm build` 收尾验证。

## 验收标准

- [ ] `lib/agent/activity-description.ts` 的 `ActivityStatus` 增加 `'done'`，12 个 `withTarget`
      工具均有对应的中英文过去式文案。
- [ ] 新增通用 `agentActivity.slowSuffix`（中英文），不为每个工具新增慢速专属文案。
- [ ] `store.ts` 的 `currentActivity` 替换为 `activitySteps: ActivityStep[]`，`upsertActivityStep`/
      `finishActivityStep` 落地，旧的单槽覆盖逻辑和 2.5 秒失败自动清空定时器移除。
- [ ] 慢速定时器按 `toolCallId` 管理，步骤结束/中止/清空时正确清理，不产生孤立回调写入。
- [ ] `Message` 组件的思考间隙提示按新条件（`busy && !pendingConfirmation && 无 running 步骤`）
      展示，覆盖等待首个 token / 工具间隙 / 组织最终回答三种场景。
- [ ] `CurrentActivityLine.tsx` 重命名/替换为 `ActivityStepList.tsx`，渲染累积的步骤历史，
      `done`/`failed` 条目永久保留在本轮内，`running` 条目在 `slow` 时追加后缀。
- [ ] 相关测试（`activity-description.test.ts` 等）新增/更新并通过。
- [ ] `pnpm compile`、`pnpm test`、`pnpm build` 通过。

## 开放问题

- 无。
