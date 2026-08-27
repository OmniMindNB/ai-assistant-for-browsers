# Explicit Task Outcome Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model explicitly declare a task's success/partial/failure at the end of a turn that modified the page, persist that signal on the assistant message, and show it as a small badge in the side panel.

**Architecture:** A new no-op-on-the-page tool `report_task_outcome({ outcome, reason })` the model calls to close out a turn. `lib/agent/agent.ts` tracks (per `agent.prompt()` call, i.e. per turn — a fresh `Agent`/hook closure is created for every `send()`) whether a write tool ran and whether the outcome tool was called; if a write ran and the model's final message has no more tool calls without having reported an outcome, `prepareNextTurnWithContext` forces exactly one more turn restricted to `report_task_outcome` only. The reported `{ outcome, reason }` flows out through a new `onTaskOutcome` callback into `entrypoints/sidepanel/store.ts`, gets attached to the run's assistant message before it's persisted, and renders as a badge in `App.tsx`.

**Tech Stack:** TypeScript, WXT/MV3, vitest (`unit` project for `lib/agent/*.test.ts` and `lib/chat/messages.test.ts`, `ui` project for `entrypoints/sidepanel/store-context.test.tsx` and `entrypoints/sidepanel/components/workbench-components.test.tsx`), `@earendil-works/pi-agent-core`'s `Agent`/`AgentOptions` hooks (`afterToolCall`, `prepareNextTurnWithContext`, `steer`), Dexie (`lib/db.ts`).

**Spec:** `docs/superpowers/specs/2026-08-27-explicit-task-outcome-signal-design.md`

## Global Constraints

- `report_task_outcome` does not touch the page or browser state at all — it goes in `READ_ONLY_TOOL_NAMES` (`lib/agent/permissions.ts`), never in `WRITE_TOOL_NAMES`/`AUTO_APPROVE_TOOL_NAMES`, and never triggers a confirmation card.
- The outcome is only ever required for a turn where at least one tool in `WRITE_TOOL_NAMES` executed successfully this turn (`writeToolRanThisRun`). A pure Q&A turn with no write tool call never triggers the forced closing turn and never gets a badge.
- `TaskOutcome.outcome` is a three-state union: `'success' | 'partial' | 'failure'` — never a boolean.
- The forced-closing-turn branch in `prepareNextTurnWithContext` is independent of, and never taken in the same call as, the existing budget-exhaustion branch (`policy.prepareFinalResponse()`): that branch only ever engages when the model's message already contains tool calls that got blocked, so the new branch's `!hasToolCalls` condition can never be true at the same time. Existing behavior for the budget-exhaustion branch must not change by a single character.
- The forced closing turn fires **at most once** per `agent.prompt()` call (tracked via an `outcomeForceAttempted` flag) — if the model still doesn't call `report_task_outcome` on that forced turn, the run ends with no outcome recorded. Never retry a second time.
- `ChatMessage.taskOutcome` / `ChatMessageRecord.taskOutcome` are optional and **not indexed** in Dexie — no `db.version(2)` bump, following the exact precedent already documented for `kind`/`quotedText`/`attachments` in `lib/db.ts`.
- Abort (`stop()` → `agent.abort()`) and stream-level errors (`stopReason: 'error'|'aborted'`) never reach `prepareNextTurnWithContext` at all — `pi-agent-core`'s `agent-loop.js` returns before calling it in both cases. No special-case code is needed or should be written for these paths; do not add any `if (aborted) return` guards inside the new branch — they would be dead code.
- Every new user-facing string in `App.tsx` goes through `t()`/i18n (`lib/i18n/locales/zh.ts` and `en.ts` both, same key, matching wording register as neighboring `chat.*` keys). Tests that render `<App />` assert on the **English** strings (existing precedent in `workbench-components.test.tsx`, e.g. `screen.getByLabelText('Generating')`).

---

### Task 1: `report_task_outcome` tool

**Files:**
- Create: `lib/agent/task-outcome.ts`
- Modify: `lib/agent/tools.ts` (`BrowserToolsConfig`, `createBrowserTools`, new `makeReportTaskOutcomeTool`)
- Modify: `lib/agent/permissions.ts` (`READ_ONLY_TOOL_NAMES`)
- Test: `lib/agent/report-task-outcome-tool.test.ts` (new file, mirrors `lib/agent/wait-tool.test.ts`)

**Interfaces:**
- Produces: `export type TaskOutcomeValue = 'success' | 'partial' | 'failure';`, `export interface TaskOutcome { outcome: TaskOutcomeValue; reason: string; }`, `export const REPORT_TASK_OUTCOME_TOOL_NAME = 'report_task_outcome';` (all from `lib/agent/task-outcome.ts`); `BrowserToolsConfig.onTaskOutcome?: (outcome: TaskOutcome) => void`; `createBrowserTools(session, config)` now includes a tool named `report_task_outcome` whose `execute` calls `config.onTaskOutcome` with the validated `{ outcome, reason }`.
- Consumes: nothing from other tasks — fully self-contained.

- [ ] **Step 1: Write the failing tests**

Create `lib/agent/report-task-outcome-tool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from './tools';
import { createTabSession } from './tab-session';
import { REPORT_TASK_OUTCOME_TOOL_NAME, type TaskOutcome } from './task-outcome';

function getTool(onTaskOutcome?: (outcome: TaskOutcome) => void) {
  const tool = createBrowserTools(createTabSession(1), { onTaskOutcome }).find(
    (candidate) => candidate.name === REPORT_TASK_OUTCOME_TOOL_NAME,
  );
  if (!tool) throw new Error('report_task_outcome 未注册');
  return tool;
}

describe('report_task_outcome', () => {
  it('is registered as a tool', () => {
    expect(getTool().name).toBe('report_task_outcome');
  });

  it('forwards the outcome and reason to onTaskOutcome', async () => {
    const onTaskOutcome = vi.fn();
    const output = await getTool(onTaskOutcome).execute('call-1', {
      outcome: 'success',
      reason: '已经填好并提交表单。',
    });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'success', reason: '已经填好并提交表单。' });
    expect((output.content[0] as { text: string }).text).toContain('success');
  });

  it('reports partial and failure outcomes the same way', async () => {
    const onTaskOutcome = vi.fn();
    await getTool(onTaskOutcome).execute('call-1', { outcome: 'partial', reason: '只填了 3 个字段中的 2 个。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'partial', reason: '只填了 3 个字段中的 2 个。' });
    await getTool(onTaskOutcome).execute('call-2', { outcome: 'failure', reason: '没有找到提交按钮。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'failure', reason: '没有找到提交按钮。' });
  });

  it('does not throw when onTaskOutcome is not wired up', async () => {
    await expect(getTool(undefined).execute('call-1', { outcome: 'success', reason: 'ok' })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/report-task-outcome-tool.test.ts`
Expected: FAIL — `./task-outcome` module does not exist, and no tool named `report_task_outcome` is registered.

- [ ] **Step 3: Create lib/agent/task-outcome.ts**

```ts
export type TaskOutcomeValue = 'success' | 'partial' | 'failure';

export interface TaskOutcome {
  outcome: TaskOutcomeValue;
  /** 模型给出的一句话原因；partial/failure 时应说明卡在哪里。 */
  reason: string;
}

export const REPORT_TASK_OUTCOME_TOOL_NAME = 'report_task_outcome';
```

- [ ] **Step 4: Register the tool in lib/agent/tools.ts**

Add the import (alongside the existing `./action-result-text` import near the top of the file):

```ts
import { REPORT_TASK_OUTCOME_TOOL_NAME, type TaskOutcome, type TaskOutcomeValue } from './task-outcome';
```

Extend `BrowserToolsConfig` (currently only `onAskUser`):

```ts
export interface BrowserToolsConfig {
  /** 供 ask_user 工具调用，等待用户在侧边栏里回答；未接入时该工具直接报错。 */
  onAskUser?: (toolCallId: string, question: string, signal?: AbortSignal) => Promise<string>;
  /** 供 report_task_outcome 工具调用，把模型汇报的成败信号转发给外层。 */
  onTaskOutcome?: (outcome: TaskOutcome) => void;
}
```

Add `makeReportTaskOutcomeTool(config.onTaskOutcome)` to the array returned by `createBrowserTools` (right after `makeAskUserTool(config.onAskUser)` — both are the non-`browser_`-prefixed, non-page-touching tools):

```ts
export function createBrowserTools(session: TabSessionController, config: BrowserToolsConfig = {}): BrowserAgentTool[] {
  return [
    browserGetActiveTabTool,
    makeAskUserTool(config.onAskUser),
    makeReportTaskOutcomeTool(config.onTaskOutcome),
    waitTool,
    // ...其余不变
```

Add the tool factory itself, right after `makeAskUserTool` and before `waitTool`:

```ts
// 不带 browser_ 前缀，理由同 ask_user/wait：不修改页面或浏览器状态。
function makeReportTaskOutcomeTool(onTaskOutcome?: BrowserToolsConfig['onTaskOutcome']): BrowserAgentTool {
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

- [ ] **Step 5: Register the tool as read-only in permissions.ts**

Add `'report_task_outcome'` to `READ_ONLY_TOOL_NAMES` in `lib/agent/permissions.ts`, right after the existing `'wait'` entry:

```ts
  // 同上：纯粹的计时等待，不碰页面或浏览器状态。
  'wait',
  // 不修改页面或浏览器状态——只是让模型显式声明这轮任务的成败信号。
  'report_task_outcome',
]);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/report-task-outcome-tool.test.ts`
Expected: PASS.

Run: `pnpm vitest run lib/agent/permissions.test.ts`
Expected: PASS, unaffected (adding to a `Set` doesn't change existing assertions).

- [ ] **Step 7: Commit**

```bash
git add lib/agent/task-outcome.ts lib/agent/tools.ts lib/agent/permissions.ts lib/agent/report-task-outcome-tool.test.ts
git commit -m "feat: 新增 report_task_outcome 工具——模型显式声明任务成败"
```

---

### Task 2: `agent.ts` — track write/outcome state and force one closing turn

**Files:**
- Modify: `lib/agent/agent.ts` (`BrowserAgentOptions`, `createBrowserAgentOptions` — the `tools` resolution, `afterToolCall`, `prepareNextTurnWithContext`)
- Test: `lib/agent/agent.test.ts`

**Interfaces:**
- Consumes: `REPORT_TASK_OUTCOME_TOOL_NAME`, `TaskOutcome` from Task 1's `lib/agent/task-outcome.ts`; `WRITE_TOOL_NAMES` (existing, from `./permissions`).
- Produces: `BrowserAgentOptions.onTaskOutcome?: (outcome: TaskOutcome) => void`; `createBrowserAgentOptions(...)`'s default tool construction now passes `onTaskOutcome` through to `createBrowserTools`; `prepareNextTurnWithContext` gains the new independent branch described in the spec §3.5.

- [ ] **Step 1: Write the failing tests**

Add to `lib/agent/agent.test.ts`. First, add the import (alongside the existing `PrepareNextTurnContext` import):

```ts
import type {
  AfterToolCallContext,
  AgentMessage,
  BeforeToolCallContext,
  PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core';
```

(no change needed to this import line itself — `AgentMessage` is already imported; the new tests only need a small local helper for a no-tool-call assistant message, added next to `afterContext`):

```ts
function textOnlyMessage(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolCallStillPendingMessage(name: string) {
  return { content: [{ type: 'toolCall', id: `${name}-id`, name, arguments: {} }] };
}
```

Then add a new `describe` block, after the existing `describe('createBrowserAgentOptions tool policy hooks', ...)` block:

```ts
describe('createBrowserAgentOptions task outcome forcing', () => {
  const reportTaskOutcomeTool = { name: 'report_task_outcome' } as unknown as BrowserAgentTool;

  function hooksWithTool(overrides: { onTaskOutcome?: (outcome: unknown) => void; steer?: (m: AgentMessage) => void } = {}) {
    return createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: overrides.steer ?? vi.fn(),
      onTaskOutcome: overrides.onTaskOutcome,
    });
  }

  it('does not force a closing turn when no write tool ran this run', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not force a closing turn while the model still has pending tool calls', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_click'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('forces exactly one closing turn restricted to report_task_outcome after a write with no outcome reported', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));

    const first = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(first?.context?.tools).toEqual([reportTaskOutcomeTool]);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0][0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('report_task_outcome'),
    });

    // 模型在被强制的这一轮仍然没有调用，也只补一次，不会无限重试。
    const second = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('still nothing'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(second).toBeUndefined();
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('does not force a closing turn once report_task_outcome has already been called', async () => {
    const steer = vi.fn();
    const hooks = hooksWithTool({ steer });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    await hooks.afterToolCall?.(afterContext('report_task_outcome', { outcome: 'success', reason: 'ok' }, false));

    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [reportTaskOutcomeTool] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not force a closing turn when report_task_outcome is not among the available tools', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#a' }, false));
    const next = await hooks.prepareNextTurnWithContext?.({
      message: textOnlyMessage('done'),
      context: { messages: [], tools: [] },
    } as unknown as PrepareNextTurnContext);
    expect(next).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
  });

  it('leaves the existing budget-exhaustion branch untouched when both could apply', async () => {
    const steer = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      tools: [reportTaskOutcomeTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 2,
      steer,
    });
    await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false)); // 预算耗尽
    const next = await hooks.prepareNextTurnWithContext?.({
      message: toolCallStillPendingMessage('browser_read_page'),
      context: { messages: [], tools: [{ name: 'still-present' }] },
    } as unknown as PrepareNextTurnContext);
    expect(next?.context?.tools).toEqual([]); // 既有分支的行为：清空全部工具，不是收窄成 report_task_outcome
    expect(next?.context?.messages.at(-1)).toMatchObject({ content: expect.stringContaining('工具调用预算已经用完') });
  });

  it('threads onTaskOutcome through to the default report_task_outcome tool', async () => {
    const onTaskOutcome = vi.fn();
    const hooks = createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: vi.fn(),
      onTaskOutcome,
    });
    const tool = (hooks.initialState.tools as BrowserAgentTool[]).find((t) => t.name === 'report_task_outcome');
    expect(tool).toBeDefined();
    await tool!.execute('call-1', { outcome: 'partial', reason: '只完成了一半。' });
    expect(onTaskOutcome).toHaveBeenCalledWith({ outcome: 'partial', reason: '只完成了一半。' });
  });
});
```

Add the `BrowserAgentTool` type import at the top of the test file (needed by the new block):

```ts
import type { BrowserAgentTool } from './tools';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: FAIL — `onTaskOutcome` is not a recognized option, and the new branch doesn't exist yet, so every assertion about forced turns / `steer` calls fails.

- [ ] **Step 3: Implement in agent.ts**

Add the import (alongside the existing `./permissions` import):

```ts
import { REPORT_TASK_OUTCOME_TOOL_NAME, type TaskOutcome } from './task-outcome';
```

Add `onTaskOutcome` to `BrowserAgentOptions` (right after `onAskUser`):

```ts
  onAskUser?: (toolCallId: string, question: string, signal?: AbortSignal) => Promise<string>;
  /** report_task_outcome 工具被调用时转发给外层，用于把成败信号落到对应的 assistant 消息上。 */
  onTaskOutcome?: (outcome: TaskOutcome) => void;
```

In `createBrowserAgentOptions`, two separate edits near the top of the function body:

Replace this existing line (thread `onTaskOutcome` through to the default tool set, and capture the resolved tool reference right after it):

```ts
  const tools = options.tools ?? createBrowserTools(session, { onAskUser: options.onAskUser });
```

with:

```ts
  const tools = options.tools ?? createBrowserTools(session, { onAskUser: options.onAskUser, onTaskOutcome: options.onTaskOutcome });
  const reportTaskOutcomeTool = tools.find((tool) => tool.name === REPORT_TASK_OUTCOME_TOOL_NAME);
```

Then add three new closure flags right after the existing `let postDossierFollowUps = 0;` line (leave every other existing `let`/`const` in that block — `toolCallCounts`, `confirmGateState`, `overlayTabId`, `TAB_SESSION_MUTATING_TOOLS`, `recordPreExecutionBlock` — untouched):

```ts
  let implementationDossierCollected = false;
  let postDossierFollowUps = 0;
  let writeToolRanThisRun = false;
  let outcomeReported = false;
  let outcomeForceAttempted = false;
```

In `afterToolCall`, add the tracking right after the existing `toolCallCounts.set(...)` line:

```ts
      const toolName = context.toolCall.name;
      policy.recordExecution(toolName, context.args, context.isError);
      toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);

      if (!context.isError && WRITE_TOOL_NAMES.has(toolName)) writeToolRanThisRun = true;
      if (!context.isError && toolName === REPORT_TASK_OUTCOME_TOOL_NAME) outcomeReported = true;
```

Replace the body of `prepareNextTurnWithContext` — the existing early-return shape (`if (!policy.prepareFinalResponse()) return undefined; ...`) becomes an if/else so the new branch is reachable when the budget-exhaustion branch doesn't apply:

```ts
    prepareNextTurnWithContext: async (context) => {
      const budgetExhausted = policy.exhausted;
      if (policy.prepareFinalResponse()) {
        const finalInstruction: AgentMessage = {
          role: 'user',
          content: budgetExhausted
            ? '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。'
            : '工具调用连续被阻止，工具调用阶段已经结束。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。',
          timestamp: Date.now(),
        };
        return {
          context: {
            ...context.context,
            messages: [...context.context.messages, finalInstruction],
            tools: [],
          },
        };
      }

      // 写工具跑过、这轮消息没有（新的）工具调用（模型认为自己已经收尾）、还没汇报过、
      // 还没强制补调过一次、且 report_task_outcome 确实在可用工具里——五个条件同时成立才补一轮。
      const hasToolCalls = context.message?.content?.some((part) => part.type === 'toolCall') ?? false;
      if (writeToolRanThisRun && !outcomeReported && !outcomeForceAttempted && !hasToolCalls && reportTaskOutcomeTool) {
        outcomeForceAttempted = true; // 保证最多补调一次，绝不循环
        options.steer({
          role: 'user',
          content:
            '任务已结束但还没有汇报结果。请立即调用 report_task_outcome，说明这次操作是 success/partial/failure，并给出一句话原因，然后停止。',
          timestamp: Date.now(),
        });
        return { context: { ...context.context, tools: [reportTaskOutcomeTool] } };
      }
      return undefined;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: PASS, including every pre-existing test in the file (the budget-exhaustion branch's own tests at lines 99-121, 142-187 must still pass unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/agent.ts lib/agent/agent.test.ts
git commit -m "feat: agent.ts 跟踪写工具/成败汇报状态，收尾时强制补调一次 report_task_outcome"
```

---

### Task 3: system prompt instructs the model to call `report_task_outcome`

**Files:**
- Modify: `lib/agent/system-prompt.ts` (`task_execution` section)
- Test: `lib/agent/system-prompt.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (a system-prompt string does not reference the tool programmatically).

- [ ] **Step 1: Write the failing test**

Add to `lib/agent/system-prompt.test.ts`, inside the existing `describe('buildSystemPrompt task execution', ...)` block:

```ts
  it('tells the model to report success/partial/failure after modifying the page', () => {
    expect(SYSTEM_PROMPT).toContain('report_task_outcome');
    expect(SYSTEM_PROMPT).toContain('success/partial/failure');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/agent/system-prompt.test.ts`
Expected: FAIL — `SYSTEM_PROMPT` doesn't mention `report_task_outcome` yet.

- [ ] **Step 3: Add the instruction to the task_execution section**

In `lib/agent/system-prompt.ts`, add one more line to the array passed to `section('task_execution', [...].join('\n'))` (after the existing "同一个工具用同样的参数连续失败两次..." line):

```ts
    section(
      'task_execution',
      [
        `多步任务要一次做完，不要做到一半就把剩下的步骤交回给用户。工具预算：读取和分析最多 ${readToolCallBudget} 次；开始写入或交互后，本轮总预算最多 ${writeToolCallBudget} 次。这些是上限而不是目标，够用就停。预算耗尽或工具被拒绝时，立即基于已有证据回答，并标出仍不确定的部分。`,
        '需要连续做多个写操作时，先用一两句话说明打算改哪几处再开始调用工具。执行过程中保持简短，全部完成后再给一次完整说明。',
        '同一个工具用同样的参数连续失败两次，就换思路：换选择器、换工具，或先读一次 DOM 结构再试，不要第三次重复同样的调用。选择器匹配到 0 个元素时，先用 browser_query_dom 确认真实结构，不要连续盲猜。如果连续几次调用都没带来新信息，停下来向用户说明卡在哪里，而不是继续消耗预算。',
        '如果本轮修改或操作了当前页面，收尾前必须调用一次 report_task_outcome，明确声明这次任务是 success/partial/failure 并给出一句话原因；纯问答、没有实际操作页面的轮次不需要调用它。',
      ].join('\n'),
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/agent/system-prompt.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/system-prompt.ts lib/agent/system-prompt.test.ts
git commit -m "feat: 系统提示词要求写操作收尾前调用 report_task_outcome"
```

---

### Task 4: `ChatMessage`/`ChatMessageRecord` gain a `taskOutcome` field

**Files:**
- Modify: `lib/chat/messages.ts` (`ChatMessage`, `toMessageRecords`)
- Modify: `lib/db.ts` (`ChatMessageRecord`)
- Test: `lib/chat/messages.test.ts`

**Interfaces:**
- Consumes: `TaskOutcome` from Task 1's `lib/agent/task-outcome.ts`.
- Produces: `ChatMessage.taskOutcome?: TaskOutcome`; `ChatMessageRecord.taskOutcome?: TaskOutcome`; `toMessageRecords(...)` now copies `taskOutcome` onto each produced record.

- [ ] **Step 1: Write the failing tests**

Add to `lib/chat/messages.test.ts`, inside the existing `describe('toMessageRecords', ...)` block (after the "没有附件时 attachments 为 undefined" test):

```ts
  it('保留 taskOutcome', () => {
    const records = toMessageRecords('c-1', [
      { id: 'a', role: 'assistant', content: '已完成', createdAt: 1000, taskOutcome: { outcome: 'success', reason: '已提交表单。' } },
    ]);
    expect(records[0].taskOutcome).toEqual({ outcome: 'success', reason: '已提交表单。' });
  });

  it('没有 taskOutcome 时字段为 undefined', () => {
    const records = toMessageRecords('c-1', [msg('a', 'user', '问')]);
    expect(records[0].taskOutcome).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/chat/messages.test.ts`
Expected: FAIL — TypeScript rejects the `taskOutcome` property on the object literal (not yet part of `ChatMessage`), and `toMessageRecords` doesn't copy it.

- [ ] **Step 3: Add taskOutcome to ChatMessage and thread it through toMessageRecords**

In `lib/chat/messages.ts`, add the import and the field:

```ts
import type { ChatMessageRecord } from '@/lib/db';
import type { MessageAttachment } from './attachments';
import type { TaskOutcome } from '@/lib/agent/task-outcome';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  kind?: 'input' | 'action';
  quotedText?: string;
  attachments?: MessageAttachment[];
  /** 本轮任务成败信号；仅当模型在一个动过页面的回合里调用了 report_task_outcome 才会有值。 */
  taskOutcome?: TaskOutcome;
}
```

Update `toMessageRecords`'s mapping:

```ts
  return messages.slice(0, end).map((message) => ({
    conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    kind: message.kind,
    quotedText: message.quotedText,
    attachments: message.attachments,
    taskOutcome: message.taskOutcome,
  }));
```

- [ ] **Step 4: Add taskOutcome to ChatMessageRecord in lib/db.ts**

```ts
import Dexie, { type Table } from 'dexie';
import type { MessageAttachment } from './chat/attachments';
import type { TaskOutcome } from './agent/task-outcome';

export interface ChatMessageRecord {
  // ...现有字段不变，在 attachments 之后追加：
  /**
   * 本轮任务成败信号，仅当模型调用过 report_task_outcome 才有值。
   * 不建索引，同 kind/quotedText/attachments 一样无需 Dexie 版本迁移；存量记录无此字段即视为没有信号。
   */
  taskOutcome?: TaskOutcome;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run lib/chat/messages.test.ts`
Expected: PASS, including every pre-existing test in the file (the earlier exact `toEqual({...})` assertions at lines 96-102 stay green because `toEqual` treats an `undefined`-valued extra key as absent).

Run: `pnpm compile`
Expected: no type errors (confirms `lib/db.ts`'s new import resolves and the Dexie schema itself needs no version bump).

- [ ] **Step 6: Commit**

```bash
git add lib/chat/messages.ts lib/db.ts lib/chat/messages.test.ts
git commit -m "feat: ChatMessage/ChatMessageRecord 新增 taskOutcome 字段"
```

---

### Task 5: `store.ts` wiring — capture the outcome and attach it before persisting

**Files:**
- Modify: `entrypoints/sidepanel/store.ts` (`ActiveRun`, `runAgent`'s `createBrowserAgent(...)` call and `finally` block, `openConversation`)
- Test: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: `BrowserAgentOptions.onTaskOutcome` from Task 2; `ChatMessage.taskOutcome` from Task 4.
- Produces: `ActiveRun.taskOutcome: TaskOutcome | null`; `runAgent(...)` now attaches `run.taskOutcome` to the last assistant message before `persistConversationSnapshot`; `openConversation(...)`'s record mapping now includes `taskOutcome`.

- [ ] **Step 1: Write the failing tests**

Add to `entrypoints/sidepanel/store-context.test.tsx`, in a new `describe` block after the existing confirmation/ask_user tests (same file, same `describe('chat store page context', ...)` outer suite or a sibling top-level `describe` — follow whichever the surrounding tests use; place it right after the `'projects an ask_user question...'` test):

```ts
  it('attaches a reported task outcome to the assistant message before persisting', async () => {
    let resolvePrompt!: () => void;
    const agent = makeAgent();
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);
    mocks.sendMessage.mockImplementation((type: string) => {
      if (type === 'PING') return Promise.resolve({ ok: true, data: { supportedTypes: [
        'GET_PAGE_META', 'GET_SCRIPTS', 'GET_STYLESHEETS', 'QUERY_DOM', 'GET_HTML', 'GET_COMPUTED_STYLE',
        'CAPTURE_SCREENSHOT', 'SET_STYLE', 'MODIFY_DOM', 'CLICK_ELEMENT', 'TYPE_TEXT', 'SELECT_OPTION',
        'SCROLL_PAGE', 'NAVIGATE_TAB', 'SET_STORAGE',
      ] } });
      return Promise.resolve({ ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } });
    });

    const send = useChat.getState().send('fill the form');
    await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalled());
    const onTaskOutcome = mocks.createBrowserAgent.mock.calls[0][0].onTaskOutcome as (outcome: unknown) => void;
    onTaskOutcome({ outcome: 'success', reason: '已提交表单。' });
    resolvePrompt();
    await send;

    const last = useChat.getState().messages.at(-1);
    expect(last?.taskOutcome).toEqual({ outcome: 'success', reason: '已提交表单。' });
  });

  it('does not attach a task outcome when report_task_outcome was never called', async () => {
    const agent = makeAgent();
    mocks.createBrowserAgent.mockReturnValue(agent);
    await useChat.getState().send('what does this page say');

    const last = useChat.getState().messages.at(-1);
    expect(last?.taskOutcome).toBeUndefined();
  });

  it('restores a persisted task outcome when reopening a conversation', async () => {
    mocks.getConversationMessages.mockResolvedValueOnce([
      { role: 'assistant', content: '已完成', createdAt: 1, taskOutcome: { outcome: 'partial', reason: '只填了一半。' } },
    ]);
    await useChat.getState().openConversation('with-outcome');

    const restored = useChat.getState().messages.at(-1);
    expect(restored?.taskOutcome).toEqual({ outcome: 'partial', reason: '只填了一半。' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: FAIL — `onTaskOutcome` is `undefined` on the captured call args, and reopened/attached messages never carry `taskOutcome`.

- [ ] **Step 3: Implement in entrypoints/sidepanel/store.ts**

Add `taskOutcome` to `ActiveRun` and its initializer:

```ts
interface ActiveRun {
  id: number;
  origin: ConversationOrigin;
  agent: Agent | null;
  resolveConfirmation: ((approved: boolean) => void) | null;
  resolveQuestion: ((answer: string) => void) | null;
  pendingToolArgs: Map<string, { toolName: string; args: unknown }>;
  terminatedToolCallIds: Set<string>;
  taskOutcome: TaskOutcome | null;
}
```

At the `run` construction site (where `pendingToolArgs: new Map()` / `terminatedToolCallIds: new Set()` are initialized, around `store.ts:954-955`), add:

```ts
    pendingToolArgs: new Map(),
    terminatedToolCallIds: new Set(),
    taskOutcome: null,
```

Add the import for `TaskOutcome` (alongside the other `@/lib/agent/...` type imports near the top of the file):

```ts
import type { TaskOutcome } from '@/lib/agent/task-outcome';
```

In the `createBrowserAgent({...})` call inside `runAgent`, add the callback (right after `onSessionChange`):

```ts
    onSessionChange: (session) => { void saveTabSession(session).catch(() => undefined); },
    onTaskOutcome: (outcome) => {
      if (!isCurrentRun(run, get)) return;
      run.taskOutcome = outcome;
    },
```

In the `finally` block, attach the outcome to the last assistant message before persisting (right after the `if (isCurrentRun(run, get)) {` line and before `const messages = get().messages;` is used for persistence — attach first so `messages` picks up the change):

```ts
    finally {
      unsubscribe();
      if (isCurrentRun(run, get)) {
        if (run.taskOutcome) {
          const outcome = run.taskOutcome;
          set((state) => {
            const messages = state.messages.slice();
            const last = messages[messages.length - 1];
            if (!last) return {};
            messages[messages.length - 1] = { ...last, taskOutcome: outcome };
            return { messages };
          });
        }
        const messages = get().messages;
        // ...其余不变
```

Finally, add `taskOutcome: r.taskOutcome` to `openConversation`'s record→UIMessage mapping:

```ts
    const messages: UIMessage[] = records
      .filter((r) => r.role !== 'system')
      .map((r) => ({
        id: genMessageId(),
        role: r.role as 'user' | 'assistant',
        content: r.content,
        createdAt: r.createdAt,
        kind: r.kind,
        quotedText: r.quotedText,
        attachments: r.attachments,
        taskOutcome: r.taskOutcome,
      }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS, including every pre-existing test in the file (this is a large shared test file — check the full run, not just the three new tests, since the `finally` block edit runs on every single test in the suite).

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "feat: store.ts 接住 onTaskOutcome 并落到对应 assistant 消息"
```

---

### Task 6: badge rendering in the side panel

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx` (`Message` component, icon imports)
- Modify: `lib/i18n/locales/zh.ts`, `lib/i18n/locales/en.ts`
- Test: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: `UIMessage.taskOutcome` (already available via `export type UIMessage = ChatMessage` in `store.ts`, once Task 4 lands).
- Produces: no new exports — this is leaf-level UI rendering.

- [ ] **Step 1: Write the failing tests**

Add to `entrypoints/sidepanel/components/workbench-components.test.tsx`, after the existing `'does not show the trailing thinking indicator while a tool step is running'` test:

```ts
  it('renders a success badge with the reported reason as a tooltip', () => {
    (chatStore as any).messages = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Done',
        createdAt: 1,
        taskOutcome: { outcome: 'success', reason: 'Filled and submitted the form.' },
      },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('Task completed')).toBeVisible();
    expect(screen.getByTitle('Filled and submitted the form.')).toBeVisible();
  });

  it('renders partial and failure badges with distinct labels', () => {
    (chatStore as any).messages = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Partly done',
        createdAt: 1,
        taskOutcome: { outcome: 'partial', reason: 'Filled 2 of 3 fields.' },
      },
      {
        id: 'm2',
        role: 'user',
        content: 'try again',
        createdAt: 2,
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'Could not finish',
        createdAt: 3,
        taskOutcome: { outcome: 'failure', reason: 'Submit button was never found.' },
      },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByText('Partially completed')).toBeVisible();
    expect(screen.getByText('Task not completed')).toBeVisible();
  });

  it('does not render a badge when the message has no taskOutcome', () => {
    (chatStore as any).messages = [
      { id: 'm1', role: 'user', content: 'Do something', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it', createdAt: 2 },
    ];
    (chatStore as any).busy = false;
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.queryByText('Task completed')).toBeNull();
    expect(screen.queryByText('Partially completed')).toBeNull();
    expect(screen.queryByText('Task not completed')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: FAIL — no badge text is rendered anywhere yet, so `getByText('Task completed')` etc. throw "Unable to find an element".

- [ ] **Step 3: Add the i18n strings**

In `lib/i18n/locales/zh.ts`, add right after the existing `'chat.toolCallsRunningSuffix'` line:

```ts
  'chat.toolCallsRunningSuffix': '（{count} 运行中）',
  'chat.taskOutcome.success': '已完成',
  'chat.taskOutcome.partial': '部分完成',
  'chat.taskOutcome.failure': '未完成',
```

In `lib/i18n/locales/en.ts`, add right after the existing `'chat.toolCallsRunningSuffix'` line:

```ts
  'chat.toolCallsRunningSuffix': ' ({count} running)',
  'chat.taskOutcome.success': 'Task completed',
  'chat.taskOutcome.partial': 'Partially completed',
  'chat.taskOutcome.failure': 'Task not completed',
```

- [ ] **Step 4: Render the badge in App.tsx**

Add `IconAlertTriangle`, `IconCheck`, `IconClose` to the existing icon import:

```ts
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconPencil,
} from './icons';
```

In the `Message` component, insert the badge right after the `{content && showThinkingIndicator && (...)}` block and before the closing `</div></div>` of the assistant bubble:

```tsx
        {content && showThinkingIndicator && (
          <div className="mt-1">
            <TypingDots />
          </div>
        )}
        {message.taskOutcome && (
          <div
            className={`mt-2 inline-flex items-center gap-1.5 text-xs font-medium ${
              message.taskOutcome.outcome === 'success'
                ? 'text-emerald-700 dark:text-emerald-400'
                : message.taskOutcome.outcome === 'partial'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-red-700 dark:text-red-400'
            }`}
            title={message.taskOutcome.reason}
          >
            {message.taskOutcome.outcome === 'success' ? (
              <IconCheck className="h-3.5 w-3.5" />
            ) : message.taskOutcome.outcome === 'partial' ? (
              <IconAlertTriangle className="h-3.5 w-3.5" />
            ) : (
              <IconClose className="h-3.5 w-3.5" />
            )}
            <span>{t(`chat.taskOutcome.${message.taskOutcome.outcome}`)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Full verification**

Run: `pnpm compile` — expect no type errors.
Run: `pnpm test` — expect the full suite passes.
Run: `pnpm build` — expect a clean production build.

- [ ] **Step 7: Commit**

```bash
git add entrypoints/sidepanel/App.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat: 侧边栏渲染任务成败徽标"
```

---

## Manual verification (not automatable — do after all tasks land)

1. Load the unpacked extension (`pnpm build`, then `chrome://extensions` → load `.output/chrome-mv3`), give the model a real multi-step write task (e.g. "fill out this form and submit it"), and confirm it calls `report_task_outcome` on its own and the badge renders with the right color/label/tooltip.
2. Construct a case where the model finishes a write task without calling the tool on its own (harder to force deliberately — try a weaker/cheaper model), and confirm the forced follow-up turn fires exactly once and still produces a badge, without looping.
3. Click "stop" mid-task on a write-heavy turn; confirm no stray `report_task_outcome` call happens and nothing hangs.
4. Close and reopen a conversation that has a `taskOutcome`-bearing message; confirm the badge still renders correctly after the reload.
