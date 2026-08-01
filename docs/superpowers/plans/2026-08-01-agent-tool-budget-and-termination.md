# Agent Tool Budget and Termination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary 50-call test ceiling with a 12-call read budget, a 24-call user-approved write budget, deterministic final-answer termination, and a two-failure duplicate-call circuit breaker.

**Architecture:** Put budget and repeated-failure state in a small `AgentToolPolicy` unit, leaving permission decisions in the existing deny-first gate. `createBrowserAgent()` composes that policy with Pi's `beforeToolCall`, `afterToolCall`, `prepareNextTurn`, and `shouldStopAfterTurn` hooks; budget exhaustion removes tools for exactly one final model turn and then stops the loop.

**Tech Stack:** TypeScript 5.9, Vitest 4, `@earendil-works/pi-agent-core` 0.79, WXT 0.20, pnpm.

## Global Constraints

- Read-only and analysis work may execute at most 12 tools per user turn.
- A confirm-level tool approved by the user raises that turn's total execution budget to 24.
- A denied confirm-level tool does not raise the budget.
- The first confirm-level call immediately after the 12th read in the same model batch may still ask for approval and expand the budget.
- Exhaustion permits exactly one subsequent model response with `context.tools = []`, then the Agent must stop.
- Two consecutive execution failures with the same tool name and canonical arguments block the third matching call without consuming execution budget.
- Do not restore natural-language keyword routing, change permission levels, add telemetry, or add a wall-clock timeout.
- Keep the activity-list display window at 12; it is independent of execution budget.

---

### Task 1: Replace the single prompt budget with explicit read/write budgets

**Files:**
- Modify: `lib/agent/system-prompt.ts:4-10,78-99,130-136`
- Modify: `lib/agent/system-prompt.test.ts:1-4,238-248`
- Modify: `entrypoints/sidepanel/store.ts:677-693`

**Interfaces:**
- Produces: `DEFAULT_READ_TOOL_CALL_BUDGET = 12` and `DEFAULT_WRITE_TOOL_CALL_BUDGET = 24`.
- Produces: `SystemPromptOptions.readToolCallBudget?: number` and `SystemPromptOptions.writeToolCallBudget?: number`.
- Temporarily preserves: `DEFAULT_MAX_TOOL_TURNS` and `SystemPromptOptions.maxToolTurns` as deprecated compatibility aliases until Task 3 migrates the runtime caller.

- [ ] **Step 1: Write failing prompt tests**

Replace the two current budget tests with assertions that require both defaults and both overrides:

```ts
import {
  buildSystemPrompt,
  DEFAULT_READ_TOOL_CALL_BUDGET,
  DEFAULT_WRITE_TOOL_CALL_BUDGET,
  SYSTEM_PROMPT,
} from './system-prompt';

it('states the default read and approved-write tool budgets', () => {
  expect(SYSTEM_PROMPT).toContain(`读取和分析最多 ${DEFAULT_READ_TOOL_CALL_BUDGET} 次`);
  expect(SYSTEM_PROMPT).toContain(`批准写入或交互后，本轮总预算最多 ${DEFAULT_WRITE_TOOL_CALL_BUDGET} 次`);
});

it('states custom read and approved-write tool budgets', () => {
  const prompt = buildSystemPrompt({ readToolCallBudget: 3, writeToolCallBudget: 7 });
  expect(prompt).toContain('读取和分析最多 3 次');
  expect(prompt).toContain('批准写入或交互后，本轮总预算最多 7 次');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test lib/agent/system-prompt.test.ts`

Expected: FAIL because the two constants and two new option fields do not exist.

- [ ] **Step 3: Implement the prompt constants and option fields**

In `system-prompt.ts`, replace the old constant and option with:

```ts
export const DEFAULT_READ_TOOL_CALL_BUDGET = 12;
export const DEFAULT_WRITE_TOOL_CALL_BUDGET = 24;
/** @deprecated Migrated and removed in Task 3. */
export const DEFAULT_MAX_TOOL_TURNS = DEFAULT_READ_TOOL_CALL_BUDGET;

export interface SystemPromptOptions {
  locale?: ResolvedLocale;
  readToolCallBudget?: number;
  writeToolCallBudget?: number;
  /** @deprecated Migrated and removed in Task 3. */
  maxToolTurns?: number;
  now?: Date;
  timeZone?: string;
  page?: RuntimePageContext;
  constraints?: string;
}
```

Resolve the values once in `buildSystemPrompt()` and pass them into the task-execution text:

```ts
const readToolCallBudget = options.readToolCallBudget ?? options.maxToolTurns ?? DEFAULT_READ_TOOL_CALL_BUDGET;
const writeToolCallBudget = Math.max(
  readToolCallBudget,
  options.writeToolCallBudget ?? DEFAULT_WRITE_TOOL_CALL_BUDGET,
);
```

Use this exact behavioral instruction in `<task_execution>`:

```ts
`工具预算：读取和分析最多 ${readToolCallBudget} 次；用户批准写入或交互后，本轮总预算最多 ${writeToolCallBudget} 次。这些是上限而不是目标，够用就停。预算耗尽或工具被拒绝时，立即基于已有证据回答，并标出仍不确定的部分。`
```

Update `store.ts` to pass both constants to `buildSystemPrompt()`. Do not change the `createBrowserAgent()` call yet; Task 3 changes that interface after its failing tests exist.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm test lib/agent/system-prompt.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/agent/system-prompt.ts lib/agent/system-prompt.test.ts entrypoints/sidepanel/store.ts
git commit -m "refactor(agent): define read and write tool budgets"
```

---

### Task 2: Add a unit-tested tool execution policy

**Files:**
- Create: `lib/agent/tool-policy.ts`
- Create: `lib/agent/tool-policy.test.ts`

**Interfaces:**
- Consumes: `CONFIRM_TOOL_NAMES` from `lib/agent/permissions.ts` only in the caller; the policy itself accepts `isConfirmTool` so permission classification stays outside it.
- Produces: `createAgentToolPolicy(options: AgentToolPolicyOptions): AgentToolPolicy`.
- Produces: `AgentToolPolicy.preflight(toolName, args, isConfirmTool)`, `approveWrite()`, `recordExecution(toolName, args, isError)`, `prepareFinalResponse()`, and `shouldStopAfterTurn()`.

- [ ] **Step 1: Write failing budget-state tests**

Create `tool-policy.test.ts` with small budgets so boundaries are explicit:

```ts
import { describe, expect, it } from 'vitest';
import { createAgentToolPolicy } from './tool-policy';

describe('AgentToolPolicy budgets', () => {
  it('blocks reads after the read budget', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.preflight('browser_get_html', {}, false)).toMatchObject({ block: true, reason: expect.stringContaining('2') });
  });

  it('allows a first confirm tool at the read boundary and expands only after approval', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.preflight('browser_click', { selector: '#save' }, true)).toBeUndefined();
    policy.approveWrite();
    expect(policy.preflight('browser_click', { selector: '#save' }, true)).toBeUndefined();
    expect(policy.currentBudget).toBe(4);
  });

  it('does not expand unless approveWrite is called', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 2, writeToolCallBudget: 4 });
    policy.recordExecution('browser_read_page', {}, false);
    policy.recordExecution('browser_query_dom', {}, false);
    expect(policy.currentBudget).toBe(2);
    expect(policy.preflight('browser_get_html', {}, false)?.block).toBe(true);
  });
});
```

- [ ] **Step 2: Run the policy tests and verify RED**

Run: `pnpm test lib/agent/tool-policy.test.ts`

Expected: FAIL because `tool-policy.ts` does not exist.

- [ ] **Step 3: Implement minimal budget state**

Create these public types and the minimal closure-backed implementation:

```ts
export interface AgentToolPolicyOptions {
  readToolCallBudget: number;
  writeToolCallBudget: number;
}

export interface ToolPreflightBlock {
  block: true;
  reason: string;
}

export interface AgentToolPolicy {
  readonly completedToolCalls: number;
  readonly currentBudget: number;
  readonly exhausted: boolean;
  preflight(toolName: string, args: unknown, isConfirmTool: boolean): ToolPreflightBlock | undefined;
  approveWrite(): void;
  recordExecution(toolName: string, args: unknown, isError: boolean): void;
  prepareFinalResponse(): boolean;
  shouldStopAfterTurn(): boolean;
}
```

Normalize the write budget with `Math.max(readToolCallBudget, writeToolCallBudget)`. In `preflight()`, allow an unapproved confirm tool through at the read boundary; block all other calls when `completedToolCalls >= currentBudget`.

- [ ] **Step 4: Run the policy tests and verify GREEN**

Run: `pnpm test lib/agent/tool-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing duplicate-failure tests**

Add these cases:

```ts
describe('AgentToolPolicy repeated failures', () => {
  it('blocks the third consecutive failure with the same canonical signature', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    policy.recordExecution('browser_query_dom', { limit: 2, selector: '.x' }, true);
    policy.recordExecution('browser_query_dom', { selector: '.x', limit: 2 }, true);
    expect(policy.preflight('browser_query_dom', { limit: 2, selector: '.x' }, false)).toMatchObject({
      block: true,
      reason: expect.stringContaining('连续失败两次'),
    });
  });

  it('resets the failure streak after a success or signature change', () => {
    const policy = createAgentToolPolicy({ readToolCallBudget: 12, writeToolCallBudget: 24 });
    policy.recordExecution('browser_query_dom', { selector: '.x' }, true);
    policy.recordExecution('browser_query_dom', { selector: '.y' }, true);
    expect(policy.preflight('browser_query_dom', { selector: '.x' }, false)).toBeUndefined();
    policy.recordExecution('browser_query_dom', { selector: '.x' }, false);
    expect(policy.preflight('browser_query_dom', { selector: '.x' }, false)).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the duplicate tests and verify RED**

Run: `pnpm test lib/agent/tool-policy.test.ts`

Expected: FAIL because `recordExecution()` does not yet track canonical signatures or failure streaks.

- [ ] **Step 7: Implement stable signatures and the circuit breaker**

Add a private recursive canonicalizer that sorts object keys and preserves array order:

```ts
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function toolSignature(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(canonicalize(args))}`;
}
```

Track only the immediately consecutive failing signature. A success clears it; a different failing signature replaces it with count 1. `preflight()` checks the two-failure breaker before its budget check. A breaker block does not call `recordExecution()` and therefore does not consume budget.

- [ ] **Step 8: Write and implement final-response phase tests**

First add and run this test; verify it fails before adding the phase state:

```ts
it('prepares exactly one final response turn and stops after it', () => {
  const policy = createAgentToolPolicy({ readToolCallBudget: 1, writeToolCallBudget: 2 });
  policy.recordExecution('browser_read_page', {}, false);
  expect(policy.prepareFinalResponse()).toBe(true);
  expect(policy.prepareFinalResponse()).toBe(false);
  expect(policy.shouldStopAfterTurn()).toBe(false);
  expect(policy.shouldStopAfterTurn()).toBe(true);
});
```

Run RED: `pnpm test lib/agent/tool-policy.test.ts`

Implement a three-state phase (`active`, `final_response_prepared`, `final_response_running`). `prepareFinalResponse()` transitions `active → final_response_prepared` only when exhausted and returns true for that transition. The first `shouldStopAfterTurn()` in the prepared phase transitions to running and returns false; the next returns true.

Run GREEN: `pnpm test lib/agent/tool-policy.test.ts`

- [ ] **Step 9: Commit Task 2**

```bash
git add lib/agent/tool-policy.ts lib/agent/tool-policy.test.ts
git commit -m "feat(agent): add bounded tool execution policy"
```

---

### Task 3: Wire the policy into the Pi Agent hooks

**Files:**
- Modify: `lib/agent/agent.ts:1-113`
- Modify: `lib/agent/agent.test.ts:1-55`
- Modify: `lib/agent/system-prompt.ts:4-10,78-99`
- Modify: `lib/agent/system-prompt.test.ts:1-4,238-248`
- Modify: `entrypoints/sidepanel/store.ts:677-693`

**Interfaces:**
- Consumes: `createAgentToolPolicy()` from Task 2.
- Changes: `BrowserAgentOptions.maxToolTurns?: number` becomes `readToolCallBudget?: number` and `writeToolCallBudget?: number`.
- Produces: a `createBrowserAgent()` whose Pi hooks guarantee one tool-free final response after exhaustion.

- [ ] **Step 1: Add a test seam and failing hook integration tests**

Export a focused builder signature from `agent.ts` so tests can invoke the actual hooks without mocking the Pi package:

```ts
export interface BrowserAgentRuntimeOptions extends BrowserAgentOptions {
  steer: (message: AgentMessage) => void;
}

export function createBrowserAgentOptions(options: BrowserAgentRuntimeOptions): AgentOptions;
```

Move the existing `AgentOptions` construction into this builder; `createBrowserAgent()` supplies a closure that delegates to `agent.steer()`. Before implementing the move, add tests that expect the new export and invoke `beforeToolCall`/`afterToolCall` with minimal typed contexts cast through `unknown`.

Add these helpers to `agent.test.ts`:

```ts
import type { AfterToolCallContext, BeforeToolCallContext, PrepareNextTurnContext } from '@earendil-works/pi-agent-core';
import { vi } from 'vitest';
import { createBrowserAgentOptions } from './agent';

function beforeContext(name: string, args: unknown): BeforeToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
  } as unknown as BeforeToolCallContext;
}

function afterContext(name: string, args: unknown, isError: boolean): AfterToolCallContext {
  return {
    toolCall: { id: `${name}-id`, name, arguments: args },
    args,
    assistantMessage: {},
    context: {},
    result: { content: [{ type: 'text', text: isError ? 'failed' : 'ok' }], details: {} },
    isError,
  } as unknown as AfterToolCallContext;
}

function runtimeOptions(overrides: { onConfirm?: () => Promise<boolean> } = {}) {
  return createBrowserAgentOptions({
    provider: baseProvider,
    tabId: 1,
    tools: [],
    readToolCallBudget: 1,
    writeToolCallBudget: 2,
    steer: vi.fn(),
    ...overrides,
  });
}
```

Then add these concrete tests:

```ts
it('expands to the write budget only after confirmation succeeds', async () => {
  const hooks = runtimeOptions({ onConfirm: async () => true });
  await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
  expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#save' }))).toBeUndefined();
  await hooks.afterToolCall?.(afterContext('browser_click', { selector: '#save' }, false));
  expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
    block: true,
    reason: expect.stringContaining('2'),
  });
});

it('keeps the read budget when confirmation is denied', async () => {
  const hooks = runtimeOptions({ onConfirm: async () => false });
  await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
  expect(await hooks.beforeToolCall?.(beforeContext('browser_click', { selector: '#save' }))).toMatchObject({ block: true });
  expect(await hooks.beforeToolCall?.(beforeContext('browser_read_page', {}))).toMatchObject({
    block: true,
    reason: expect.stringContaining('1'),
  });
});

it('removes tools for one final turn and then stops', async () => {
  const steer = vi.fn();
  const hooks = createBrowserAgentOptions({
    provider: baseProvider,
    tabId: 1,
    tools: [],
    readToolCallBudget: 1,
    writeToolCallBudget: 2,
    steer,
  });
  await hooks.afterToolCall?.(afterContext('browser_read_page', {}, false));
  const next = await hooks.prepareNextTurn?.({ context: { tools: [{ name: 'still-present' }] } } as unknown as PrepareNextTurnContext);
  expect(next?.context?.tools).toEqual([]);
  expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(false);
  expect(await hooks.shouldStopAfterTurn?.({} as never)).toBe(true);
  expect(steer).toHaveBeenCalledOnce();
});

it('blocks a third identical failed execution before permission or execution', async () => {
  const hooks = createBrowserAgentOptions({
    provider: baseProvider,
    tabId: 1,
    tools: [],
    readToolCallBudget: 12,
    writeToolCallBudget: 24,
    steer: vi.fn(),
  });
  await hooks.afterToolCall?.(afterContext('browser_query_dom', { selector: '.x', limit: 2 }, true));
  await hooks.afterToolCall?.(afterContext('browser_query_dom', { limit: 2, selector: '.x' }, true));
  expect(await hooks.beforeToolCall?.(beforeContext('browser_query_dom', { selector: '.x', limit: 2 }))).toMatchObject({
    block: true,
    reason: expect.stringContaining('连续失败两次'),
  });
});
```

- [ ] **Step 2: Run agent tests and verify RED**

Run: `pnpm test lib/agent/agent.test.ts`

Expected: FAIL because `createBrowserAgentOptions` and the new budget fields do not exist.

- [ ] **Step 3: Build and wire the runtime options**

In `agent.ts`:

1. Resolve `readToolCallBudget` and `writeToolCallBudget` from the new defaults.
2. Construct one policy per `createBrowserAgentOptions()` call.
3. Run dossier limits, then `policy.preflight()`, then `beforeToolCallPermissionGate()`.
4. If a confirm tool returns no block and `confirmGateState.decision === 'approved'`, call `policy.approveWrite()` and run `policy.preflight()` once more.
5. In `afterToolCall`, call `policy.recordExecution(toolName, context.args, context.isError)` before the existing dossier bookkeeping.
6. In `prepareNextTurn`, when `policy.prepareFinalResponse()` returns true, call `options.steer()` once with the budget-exhausted final-answer instruction and return `{ context: { ...context.context, tools: [] } }`.
7. In `shouldStopAfterTurn`, return `policy.shouldStopAfterTurn()`.

Create the public Agent without exposing an uninitialized variable to the builder:

```ts
export function createBrowserAgent(options: BrowserAgentOptions): Agent {
  let agent: Agent;
  const agentOptions = createBrowserAgentOptions({
    ...options,
    steer: (message) => agent.steer(message),
  });
  agent = new Agent(agentOptions);
  return agent;
}
```

Use `CONFIRM_TOOL_NAMES.has(context.toolCall.name)` for the `isConfirmTool` argument. Preserve sequential tool execution, permission cancellation, dossier caps, context compaction, and provider selection unchanged.

- [ ] **Step 4: Update the side-panel caller**

Pass the same two constants to both prompt construction and runtime enforcement:

```ts
readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
```

Delete the temporary `DEFAULT_MAX_TOOL_TURNS` compatibility export and `SystemPromptOptions.maxToolTurns` fallback introduced in Task 1, then delete all remaining imports and uses of `DEFAULT_MAX_TOOL_TURNS` and `maxToolTurns` in executable code and tests.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm test lib/agent/tool-policy.test.ts lib/agent/agent.test.ts lib/agent/system-prompt.test.ts entrypoints/sidepanel/store-context.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add lib/agent/agent.ts lib/agent/agent.test.ts lib/agent/system-prompt.ts lib/agent/system-prompt.test.ts entrypoints/sidepanel/store.ts
git commit -m "feat(agent): enforce dynamic tool budgets"
```

---

### Task 4: Align maintenance documentation and verify the repository

**Files:**
- Modify: `docs/PROGRESS.md:124-134`
- Modify: `docs/agent-plan.md:219-224`

**Interfaces:**
- Consumes: the implemented 12/24 behavior and exact termination semantics from Tasks 1-3.
- Produces: maintenance docs that distinguish historical limits from current behavior.

- [ ] **Step 1: Update current-state documentation**

Add a 2026-08-01 entry to `PROGRESS.md` stating that the temporary 50-call testing ceiling was replaced by a 12-call read budget and 24-call approved-write budget, with one tool-free final response and duplicate-failure circuit breaking.

Change the current architecture statement in `agent-plan.md` to:

```md
3. **调用预算 + 强制收敛**：单次任务默认最多执行 12 次读取/分析工具；用户批准写入或交互后，本轮总预算提升到 24 次。预算耗尽后移除工具，只允许模型再生成一次最终回答，然后强制结束；同签名调用连续失败两次后阻断第三次。
```

Do not rewrite the dated `PROGRESS.md` entry that records the historical 8→12 change.

- [ ] **Step 2: Check repository-wide terminology**

Run:

```bash
rg -n "DEFAULT_MAX_TOOL_TURNS|maxToolTurns|默认 8|默认 50|最多 50 次" . --glob '!node_modules' --glob '!.git'
```

Expected: no executable-code references to the removed API. Historical design/plan text may remain only where it is clearly dated or marked superseded.

- [ ] **Step 3: Run the complete verification suite**

Run these commands separately and require exit code 0 from each:

```bash
pnpm test
pnpm compile
pnpm build
git diff --check
```

- [ ] **Step 4: Review the final diff against the design acceptance criteria**

Confirm from code and test output that:

- read execution stops at 12;
- approved write execution stops at 24;
- denial does not expand the budget;
- exhaustion supplies an empty tool list for exactly one final model turn;
- the third identical consecutive failed call is blocked without incrementing the execution count;
- prompt values and runtime values share constants;
- the activity list remains capped at 12 displayed items.

- [ ] **Step 5: Commit Task 4**

```bash
git add docs/PROGRESS.md docs/agent-plan.md
git commit -m "docs: document bounded agent tool execution"
```
