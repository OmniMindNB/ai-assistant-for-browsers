# 会话导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可以把任一会话导出成一个 `.md` 文件，用于排查问题。文件含问答、工具步骤（脱敏参数、失败原因）、每轮模型与耗时，末尾附脱敏后的结构化 JSON。

**Architecture:** 分三块：
- 运行期补存诊断信息：`run-registry.ts` 在 `tool_execution_end` 写入 `ActivityStep.errorText`，在收尾时往 assistant 消息写入 `runDiagnostics`。纯逻辑放在新文件 `lib/agent/run-diagnostics.ts`。
- 生成导出：纯函数模块 `lib/chat/conversation-export.ts`。先脱敏成 `ConversationExport` 中间结构，再渲染成 Markdown 和附录 JSON。
- 触发下载：面板 `store.exportConversation(id)` 从 IndexedDB 读取数据，再通过 `lib/workbench/download-file.ts` 触发下载。入口在历史抽屉和顶栏。

**Tech Stack:** TypeScript、React、Zustand、Dexie、Vitest（unit/ui/dom 三个项目）、WXT。

**Spec:** `docs/superpowers/specs/2026-09-24-conversation-export-design.md`

## Global Constraints

- 不新增 manifest 权限（不申请 `downloads`），不新增工具，不新增 `lib/messaging.ts` 消息类型，不改 `run-port-protocol.ts`。
- 不改 Dexie schema 版本；新增字段都不建索引。
- 顺序必须是先 `redactText` 后截断，任何地方都不能反过来。
- `MAX_STEP_ERROR_CHARS` = 300；工具参数单个字符串截到 120 字；参数 JSON 整体截到 300 字。
- `MASKED_WRITE_ARG_KEYS = ['value', 'text']`，只对 `WRITE_TOOL_NAMES` 生效。
- 附录 JSON 顶层 `schema: 'runi-conversation-export/1'`。
- 文件名格式 `runi-<标题>-<YYYYMMDD-HHmm>.md`；标题里的非法字符替换成 `_`，截到 40 字；标题为空时用 `conversation`。
- 新增 i18n key 放在 `export.*` 下，`zh.ts` 和 `en.ts` 都要补（`lib/i18n/i18n.test.ts` 会校验两边 key 一致）。
- 不导出 `apiKey`、`baseURL` 全文、图片 `dataUrl`、文本附件 `textContent`、`rerun.selection`、`rerun.supplement`。
- 提交直接在 `main` 上进行，不开分支（见 CLAUDE.md "Git"）。

## Review Focus

1. **非 http 的会话 URL 或畸形 URL**（`chrome://newtab`、空串、`about:blank`）：导出不能抛错。无法解析的 URL 整段省略，其余正常导出。测试加在 Task 3。
2. **模型回复里有未闭合的 ``` 代码围栏**：后面的章节和附录 JSON 不能被吞进代码块。测试加在 Task 4。
3. **调用签名不是合法 JSON**（旧记录、被截断的签名）：不能把原始签名串原样导出，因为可能含写入值。只导出工具名，不带参数。测试加在 Task 3。
4. **标题只有非法字符或空白**（如 `???`、`   `）：文件名仍然合法，不能出现 `runi--2026….md`。测试加在 Task 4。
5. **失败工具返回的报错里带手机号，且长度超过 300 字**：落库的 `errorText` 已脱敏；截断发生在脱敏之后，不会切断手机号导致脱敏失效。测试加在 Task 2。

---

### Task 1: `ActivityStep.errorText` 字段

**Files:**
- Modify: `lib/agent/activity-steps.ts`（`ActivityStep` 接口；`finishActivityStep`）
- Test: `lib/agent/activity-steps.test.ts`

**Interfaces:**
- Produces: `ActivityStep.errorText?: string`；`finishActivityStep(steps, id, status, description, errorText?: string): ActivityStep[]`

- [ ] **Step 1: 写失败测试**

在 `lib/agent/activity-steps.test.ts` 末尾追加：

```ts
// 会话导出靠 errorText 回答"它为什么失败"（ref: 2026-09-24-conversation-export-design.md §3.1）。
describe('finishActivityStep errorText', () => {
  it('records the error text on a failed step', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running', signature: 's' }];
    const next = finishActivityStep(steps, 'a', 'failed', 'A failed', '字段 f3 写入后读回不一致');
    expect(next[0]).toEqual({ id: 'a', description: 'A failed', status: 'failed', signature: 's', errorText: '字段 f3 写入后读回不一致' });
  });

  it('does not add an errorText key when none is given', () => {
    const next = finishActivityStep([{ id: 'a', description: 'A', status: 'running' }], 'a', 'done', 'A done');
    expect(next[0]).not.toHaveProperty('errorText');
  });

  it('keeps only the last attempt\'s error text across a merged retry', () => {
    let steps: ActivityStep[] = [{ id: 'c1', description: 'x', status: 'running', signature: 'sig' }];
    steps = finishActivityStep(steps, 'c1', 'failed', 'x', '第一次失败');
    steps = upsertActivityStep(steps, { id: 'c2', description: 'x', status: 'running', signature: 'sig' });
    expect(steps).toHaveLength(1);
    expect(steps[0]).not.toHaveProperty('errorText');
    steps = finishActivityStep(steps, 'c2', 'failed', 'x', '第二次失败');
    expect(steps[0]).toMatchObject({ attempt: 2, errorText: '第二次失败' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/activity-steps.test.ts`
Expected: 前两个新用例中至少 `records the error text` 失败（`errorText` 缺失）；TypeScript 层面第 5 个参数不存在。

- [ ] **Step 3: 实现**

`lib/agent/activity-steps.ts`：在 `ActivityStep` 接口的 `attempt` 字段后加：

```ts
  /**
   * 失败时工具返回的报错原文（已 redactText、已截断，见 run-diagnostics.ts 的 extractToolErrorText）。
   * 只在 tool_execution_end 且 isError 时写入；面板暂不渲染，供会话导出排查问题
   * （ref: 2026-09-24-conversation-export-design.md §3.1）。
   */
  errorText?: string;
```

把 `finishActivityStep` 改成：

```ts
export function finishActivityStep(
  steps: ActivityStep[],
  id: string,
  status: 'done' | 'failed',
  description: string,
  errorText?: string,
): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1) return steps;
  const next = steps.slice();
  next[index] = { ...next[index], status, description, ...(errorText !== undefined ? { errorText } : {}) };
  return next;
}
```

（重试合并时，新的 running 步骤对象本身不带 `errorText`，`upsertActivityStep` 的 `{ ...step, attempt }` 会自然丢掉上一次的报错，不需要额外改动。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/activity-steps.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/agent/activity-steps.ts lib/agent/activity-steps.test.ts
git commit -m "feat(agent): 活动步骤记录失败原因字段 errorText"
```

---

### Task 2: 运行期补存诊断信息（`run-diagnostics.ts` + run-registry 接线 + 持久化字段）

**Files:**
- Create: `lib/agent/run-diagnostics.ts`
- Create: `lib/agent/run-diagnostics.test.ts`
- Modify: `lib/agent/run-registry.ts`（import 区；`startRun` 内 `recordRedaction` 之后、`agent.subscribe` 回调、`finally` 收尾合并最后一条消息处）
- Modify: `lib/agent/run-registry.test.ts`
- Modify: `lib/chat/messages.ts`（`ChatMessage` 接口 + `toMessageRecords`）
- Modify: `lib/chat/messages.test.ts`
- Modify: `lib/db.ts`（`ChatMessageRecord`）
- Modify: `entrypoints/sidepanel/store.ts:945-960`（记录 → 消息映射）

**Interfaces:**
- Consumes: Task 1 的 `finishActivityStep(..., errorText?)`
- Produces:
  - `export const MAX_STEP_ERROR_CHARS = 300`
  - `export interface RunDiagnostics { providerName: string; api: string; baseUrlHost: string; modelId: string; vision: boolean; withoutBrowserTools: boolean; readToolCallBudget: number; writeToolCallBudget: number; startedAt: number; durationMs: number; llmTurns: number; toolCalls: number }`
  - `export function extractToolErrorText(result: unknown, redaction: RedactionSettings): string | undefined`
  - `export function baseUrlHost(baseURL: string): string`
  - `export function buildRunDiagnostics(input: RunDiagnosticsInput): RunDiagnostics`
  - `ChatMessage.runDiagnostics?: RunDiagnostics`，`ChatMessageRecord.runDiagnostics?: RunDiagnostics`

- [ ] **Step 1: 写纯函数的失败测试**

Create `lib/agent/run-diagnostics.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import { baseUrlHost, buildRunDiagnostics, extractToolErrorText, MAX_STEP_ERROR_CHARS } from './run-diagnostics';

const redaction = defaultRedactionSettings();

describe('extractToolErrorText', () => {
  it('joins the text parts of a pi-agent-core error result', () => {
    const result = { content: [{ type: 'text', text: '找不到元素' }, { type: 'image', data: 'x' }, { type: 'text', text: '#submit' }], details: {} };
    expect(extractToolErrorText(result, redaction)).toBe('找不到元素\n#submit');
  });

  it('returns undefined when there is no text', () => {
    expect(extractToolErrorText(undefined, redaction)).toBeUndefined();
    expect(extractToolErrorText({ content: [] }, redaction)).toBeUndefined();
    expect(extractToolErrorText({ content: [{ type: 'text', text: '   ' }] }, redaction)).toBeUndefined();
  });

  // Review Focus #5：先脱敏再截断——手机号跨过截断点时也不能漏出前半截。
  it('redacts before clipping so a phone number straddling the cut never leaks', () => {
    const phone = '13812345678';
    const text = `${'a'.repeat(MAX_STEP_ERROR_CHARS - 5)}${phone}${'b'.repeat(50)}`;
    const out = extractToolErrorText({ content: [{ type: 'text', text }] }, redaction)!;
    expect(out).not.toContain('13812');
    expect(out.length).toBeLessThanOrEqual(MAX_STEP_ERROR_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('baseUrlHost', () => {
  it('keeps only host (with port)', () => {
    expect(baseUrlHost('https://api.deepseek.com/v1/chat')).toBe('api.deepseek.com');
    expect(baseUrlHost('http://localhost:11434/v1')).toBe('localhost:11434');
  });
  it('returns empty string for garbage', () => {
    expect(baseUrlHost('not a url')).toBe('');
  });
});

describe('buildRunDiagnostics', () => {
  it('never carries the api key or the full baseURL', () => {
    const d = buildRunDiagnostics({
      provider: { id: 'p', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1?token=abc', apiKey: 'sk-secret', model: 'deepseek-v4-pro' } as never,
      withoutBrowserTools: false,
      readToolCallBudget: 20,
      writeToolCallBudget: 40,
      startedAt: 1000,
      endedAt: 39200,
      llmTurns: 5,
      toolCalls: 9,
    });
    expect(d).toEqual({
      providerName: 'DeepSeek',
      api: 'openai-completions',
      baseUrlHost: 'api.deepseek.com',
      modelId: 'deepseek-v4-pro',
      vision: false,
      withoutBrowserTools: false,
      readToolCallBudget: 20,
      writeToolCallBudget: 40,
      startedAt: 1000,
      durationMs: 38200,
      llmTurns: 5,
      toolCalls: 9,
    });
    expect(JSON.stringify(d)).not.toContain('sk-secret');
    expect(JSON.stringify(d)).not.toContain('token=abc');
  });

  it('clamps a negative duration to 0', () => {
    const d = buildRunDiagnostics({
      provider: { id: 'p', name: 'x', baseURL: '', apiKey: '', model: 'm' } as never,
      withoutBrowserTools: true, readToolCallBudget: 1, writeToolCallBudget: 1,
      startedAt: 10, endedAt: 5, llmTurns: 0, toolCalls: 0,
    });
    expect(d.durationMs).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/run-diagnostics.test.ts`
Expected: FAIL，报 `Cannot find module './run-diagnostics'`

- [ ] **Step 3: 实现 `lib/agent/run-diagnostics.ts`**

```ts
// 会话导出用的运行期诊断信息（ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §3）。
// 纯函数：run-registry.ts 只负责在事件里调用它们，本文件不碰 browser/storage。
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { resolveProviderApi, type ProviderConfig } from '@/lib/settings';
import { supportsVision } from './vision';

export const MAX_STEP_ERROR_CHARS = 300;

export interface RunDiagnostics {
  /** ProviderConfig.name；不含 apiKey。 */
  providerName: string;
  /** resolveProviderApi 的结果。 */
  api: string;
  /** baseURL 只保留 host（含端口）；解析失败记 ''。 */
  baseUrlHost: string;
  modelId: string;
  /** 决定了这一轮有没有 browser_screenshot。 */
  vision: boolean;
  withoutBrowserTools: boolean;
  readToolCallBudget: number;
  writeToolCallBudget: number;
  startedAt: number;
  durationMs: number;
  /** turn_start 事件计数。 */
  llmTurns: number;
  /** tool_execution_start 事件计数。 */
  toolCalls: number;
}

export interface RunDiagnosticsInput {
  provider: ProviderConfig;
  withoutBrowserTools: boolean;
  readToolCallBudget: number;
  writeToolCallBudget: number;
  startedAt: number;
  endedAt: number;
  llmTurns: number;
  toolCalls: number;
}

/**
 * 从 pi-agent-core 的错误结果（createErrorToolResult → { content: [{ type: 'text', text }] }）里取报错原文。
 * 先 redactText 再截断：先截断可能把敏感串切成两半，脱敏正则的 lookaround 就再也匹配不上。
 */
export function extractToolErrorText(result: unknown, redaction: RedactionSettings): string | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) return undefined;
  const redacted = redactText(text, redaction);
  return redacted.length > MAX_STEP_ERROR_CHARS ? `${redacted.slice(0, MAX_STEP_ERROR_CHARS)}…` : redacted;
}

export function baseUrlHost(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return '';
  }
}

export function buildRunDiagnostics(input: RunDiagnosticsInput): RunDiagnostics {
  return {
    providerName: input.provider.name,
    api: resolveProviderApi(input.provider),
    baseUrlHost: baseUrlHost(input.provider.baseURL),
    modelId: input.provider.model,
    vision: supportsVision(input.provider, input.provider.model),
    withoutBrowserTools: input.withoutBrowserTools,
    readToolCallBudget: input.readToolCallBudget,
    writeToolCallBudget: input.writeToolCallBudget,
    startedAt: input.startedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    llmTurns: input.llmTurns,
    toolCalls: input.toolCalls,
  };
}
```

注意：截断后的结果最多是 300 字再加一个 `…`，所以测试断言写的是 `≤ MAX_STEP_ERROR_CHARS + 1`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/run-diagnostics.test.ts`
Expected: PASS。如果 `resolveProviderApi` 对没有 `api` 字段的 provider 返回的不是 `'openai-completions'`，先读 `lib/settings.ts:185` 核对，再改测试期望值；不要改实现去迎合测试。

- [ ] **Step 5: 持久化字段**

`lib/chat/messages.ts`：
- 顶部 import 区加 `import type { RunDiagnostics } from '@/lib/agent/run-diagnostics';`
- `ChatMessage` 接口 `trajectory` 字段之后加：

```ts
  /**
   * 这一轮的运行诊断（模型、协议、耗时、调用次数）；仅 assistant 消息、且由 run-registry 正常收尾时才有值。
   * 供会话导出排查问题（ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §3.2）。
   */
  runDiagnostics?: RunDiagnostics;
```

- `toMessageRecords` 的映射对象 `trajectory: message.trajectory,` 之后加 `runDiagnostics: message.runDiagnostics,`

`lib/db.ts`：
- import 区加 `import type { RunDiagnostics } from './agent/run-diagnostics';`
- `ChatMessageRecord` 的 `trajectory` 字段之后加：

```ts
  /**
   * 这一轮的运行诊断，供会话导出排查问题。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为没有诊断信息。
   */
  runDiagnostics?: RunDiagnostics;
```

`entrypoints/sidepanel/store.ts`，`openConversation` 里 `.map((r) => ({ ... trajectory: r.trajectory, }))` 的 `trajectory: r.trajectory,` 之后加 `runDiagnostics: r.runDiagnostics,`

`lib/chat/messages.test.ts` 的 `describe('toMessageRecords')` 里追加：

```ts
  it('保留 assistant 消息的运行诊断', () => {
    const runDiagnostics = {
      providerName: 'DeepSeek', api: 'openai-completions', baseUrlHost: 'api.deepseek.com', modelId: 'm',
      vision: false, withoutBrowserTools: false, readToolCallBudget: 20, writeToolCallBudget: 40,
      startedAt: 1, durationMs: 2, llmTurns: 1, toolCalls: 0,
    };
    const records = toMessageRecords('c-1', [msg('a', 'user', '问'), { ...msg('b', 'assistant', '答'), runDiagnostics }]);
    expect(records[1].runDiagnostics).toEqual(runDiagnostics);
  });
```

- [ ] **Step 6: 写 run-registry 的失败测试**

在 `lib/agent/run-registry.test.ts` 里 `it('describes a finished step from the tool result, ...')` 之后追加：

```ts
  it('stores a redacted errorText on a failed step, and none on a successful one', async () => {
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'turn_start' },
        { type: 'tool_execution_start', toolCallId: 'ok-1', toolName: 'browser_get_form', args: {} },
        { type: 'tool_execution_end', toolCallId: 'ok-1', toolName: 'browser_get_form', isError: false, result: { content: [{ type: 'text', text: '表单' }], details: {} } },
        { type: 'tool_execution_start', toolCallId: 'bad-1', toolName: 'browser_click', args: { selector: '#go' } },
        { type: 'tool_execution_end', toolCallId: 'bad-1', toolName: 'browser_click', isError: true, result: { content: [{ type: 'text', text: '联系 13812345678 失败' }], details: {} } },
      ]),
    );

    await startRun(makeRequest({ tabId: 90 }));
    await vi.waitFor(() => expect(getRunState(90)).toBeUndefined());

    const lastRecord = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1].at(-1);
    const ok = lastRecord?.activitySteps?.find((step) => step.id === 'ok-1');
    const bad = lastRecord?.activitySteps?.find((step) => step.id === 'bad-1');
    expect(ok).not.toHaveProperty('errorText');
    expect(bad?.errorText).toBeDefined();
    expect(bad?.errorText).not.toContain('13812345678');
  });

  it('attaches runDiagnostics to the final assistant message without the api key', async () => {
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'turn_start' },
        { type: 'tool_execution_start', toolCallId: 'c-1', toolName: 'browser_get_form', args: {} },
        { type: 'tool_execution_end', toolCallId: 'c-1', toolName: 'browser_get_form', isError: false, result: { content: [], details: {} } },
        { type: 'turn_start' },
      ]),
    );

    await startRun(makeRequest({
      tabId: 91,
      provider: { id: 'p1', name: 'Local', baseURL: 'http://localhost:11434/v1', apiKey: 'sk-secret', model: 'qwen' } as never,
    }));
    await vi.waitFor(() => expect(getRunState(91)).toBeUndefined());

    const lastRecord = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1].at(-1);
    expect(lastRecord?.role).toBe('assistant');
    expect(lastRecord?.runDiagnostics).toMatchObject({
      providerName: 'Local',
      baseUrlHost: 'localhost:11434',
      modelId: 'qwen',
      llmTurns: 2,
      toolCalls: 1,
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      withoutBrowserTools: false,
    });
    expect(JSON.stringify(lastRecord?.runDiagnostics)).not.toContain('sk-secret');
  });

  it('attaches runDiagnostics even when the user stopped the run', async () => {
    const agent = makeFakeAgent([]);
    let rejectPrompt!: (e: unknown) => void;
    agent.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 92 }));
    stopRun(92);
    rejectPrompt(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await vi.waitFor(() => expect(getRunState(92)).toBeUndefined());

    const lastRecord = mocks.replaceConversationMessages.mock.calls.at(-1)?.[1].at(-1);
    expect(lastRecord?.stopped).toBe(true);
    expect(lastRecord?.runDiagnostics?.providerName).toBe('p1');
  });
```

（tabId 90–92 目前在该文件里没被占用；执行前 `grep -n "tabId: 9[0-2]" lib/agent/run-registry.test.ts` 确认一下，被占用就换一个没用过的号。）

- [ ] **Step 7: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: 新增的 3 个用例 FAIL（`errorText` 为 undefined，`runDiagnostics` 为 undefined）

- [ ] **Step 8: 在 run-registry.ts 接线**

1. import 区（`import { toolSignature } from './tool-policy';` 之后）加：

```ts
import { buildRunDiagnostics, extractToolErrorText } from './run-diagnostics';
```

2. 把

```ts
  // 录制用的脱敏配置一轮只读一次；读不到就用内置规则，绝不因此让录制（更不能让 run）失败。
  const recordRedaction = loadRedactionSettings().catch(() => defaultRedactionSettings());
```

改为：

```ts
  // 录制用的脱敏配置一轮只读一次；读不到就用内置规则，绝不因此让录制（更不能让 run）失败。
  const recordRedaction = loadRedactionSettings().catch(() => defaultRedactionSettings());
  // 失败步骤的 errorText 要在同步的 tool_execution_end 回调里当场脱敏，所以这里先把配置取出来；
  // 上面那个 promise 仍留给录制链使用（ref: 2026-09-24-conversation-export-design.md §3.1）。
  const errorRedaction = await recordRedaction;
  // 会话导出的运行诊断（§3.2）：只数事件，不依赖默认关闭的 perf-trace.ts。
  const runStartedAt = Date.now();
  let llmTurns = 0;
  let toolCallCount = 0;
```

3. `agent.subscribe((event: AgentEvent) => {` 回调的第一行加：

```ts
    if (event.type === 'turn_start') llmTurns += 1;
```

4. `tool_execution_start` 分支里，`state.pendingToolArgs.set(...)` 之前加 `toolCallCount += 1;`

5. `tool_execution_end` 分支里的 `finishActivityStep(...)` 调用改为：

```ts
        const finalStatus = event.isError ? 'failed' : 'done';
        state.activitySteps = finishActivityStep(
          state.activitySteps,
          event.toolCallId,
          finalStatus,
          // 结果一并交给文案：调用参数只说"打算做什么"，重定向后的落地地址、
          // 部分失败的实际落地字段数只有结果里有（见 activity-description.ts）。
          describeToolActivity(event.toolName, info?.args, finalStatus, event.result),
          event.isError ? extractToolErrorText(event.result, errorRedaction) : undefined,
        );
```

6. `finally` 里合并最后一条消息的对象，在 `...(state.trajectory.length > 0 ? { trajectory: state.trajectory } : {}),` 之后加：

```ts
              ...(last.role === 'assistant'
                ? {
                    runDiagnostics: buildRunDiagnostics({
                      provider: request.provider,
                      withoutBrowserTools: request.withoutBrowserTools === true,
                      readToolCallBudget: request.readToolCallBudget,
                      writeToolCallBudget: request.writeToolCallBudget,
                      startedAt: runStartedAt,
                      endedAt: Date.now(),
                      llmTurns,
                      toolCalls: toolCallCount,
                    }),
                  }
                : {}),
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/run-registry.test.ts lib/agent/run-diagnostics.test.ts lib/chat/messages.test.ts lib/agent/activity-steps.test.ts`
Expected: PASS。如果已有用例对失败步骤用了 `toEqual` 精确比对、而它的 `result` 带文本，现在会多出 `errorText`。这种情况要把期望值补上 `errorText`，那才是新的正确行为；不要为了让旧用例通过而删掉这个字段。

- [ ] **Step 10: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误

```bash
git add lib/agent/run-diagnostics.ts lib/agent/run-diagnostics.test.ts lib/agent/run-registry.ts lib/agent/run-registry.test.ts lib/chat/messages.ts lib/chat/messages.test.ts lib/db.ts entrypoints/sidepanel/store.ts
git commit -m "feat(agent): 持久化失败步骤原因与每轮运行诊断，供会话导出"
```

---

### Task 3: 导出中间结构与脱敏（`buildConversationExport`）

**Files:**
- Create: `lib/chat/conversation-export.ts`（本任务只写类型、常量、`stripUrl`、`sanitizeToolArgs`、`buildConversationExport`）
- Create: `lib/chat/conversation-export.test.ts`
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`（在文件末尾字典对象里加本任务及 Task 4、Task 5 用到的全部 `export.*` key，一次加齐）

**Interfaces:**
- Consumes: Task 2 的 `RunDiagnostics`；`ChatMessageRecord`、`ConversationRecord`（`lib/db.ts`）；`redactText`、`RedactionSettings`（`lib/redaction.ts`）；`WRITE_TOOL_NAMES`（`lib/agent/permissions.ts`）；`Translate`、`ResolvedLocale`（`lib/i18n`，仅 type import）
- Produces:
  - `export const EXPORT_SCHEMA = 'runi-conversation-export/1'`
  - `export const MASKED_WRITE_ARG_KEYS: ReadonlySet<string>`，`export const KEPT_WRITE_ARG_KEYS: ReadonlySet<string>`
  - `export function stripUrl(url: string): string | undefined`
  - `export function sanitizeToolArgs(toolName: string, args: unknown, redaction: RedactionSettings, t: Translate): unknown`
  - `export interface ConversationExport` / `ExportedMessage` / `ExportedStep` / `ExportedAttachment`
  - `export function buildConversationExport(input: ConversationExportInput): ConversationExport`

- [ ] **Step 1: 加 i18n key**

`lib/i18n/locales/zh.ts` 字典对象末尾加：

```ts
  'export.title': 'Runi 会话导出：{title}',
  'export.exportedAt': '导出时间：{time}',
  'export.version': '扩展版本：{version} · 界面语言：{locale}',
  'export.pageUrl': '会话页面：{url}',
  'export.privacyNote': '说明：已按脱敏规则处理；表单填写值、图片、附件正文、API Key 未导出',
  'export.round': '第 {n} 轮',
  'export.roleUser': '用户',
  'export.roleAssistant': 'Runi',
  'export.stopped': '已停止',
  'export.contextTruncated': '上下文已重切',
  'export.quote': '引用：',
  'export.attachments': '附件：{list}',
  'export.tabReferences': '引用标签页：{list}',
  'export.shortcut': '快捷指令：{name}',
  'export.runInfo': '**运行信息**：{provider} · {model}（{api} @ {host}）· 视觉 {vision} · 耗时 {duration} · LLM {turns} 轮 · 工具 {tools} 次 · 预算 读 {read} / 写 {write}',
  'export.withoutBrowserTools': ' · 无浏览器工具',
  'export.yes': '是',
  'export.no': '否',
  'export.taskOutcome': '**任务结果**：{outcome} —— {reason}',
  'export.stepsTableHeader': '| # | 状态 | 步骤 | 调用 | 失败原因 |',
  'export.appendix': '附录：结构化数据',
  'export.maskedValue': '‹已省略 {count} 字›',
  'export.exportConversationAriaLabel': '导出会话 {title}',
  'export.exportCurrent': '导出当前会话',
  'export.notFound': '会话不存在或已被删除',
  'export.failed': '导出失败：{error}',
```

`lib/i18n/locales/en.ts` 对应位置加：

```ts
  'export.title': 'Runi conversation export: {title}',
  'export.exportedAt': 'Exported at: {time}',
  'export.version': 'Extension version: {version} · UI language: {locale}',
  'export.pageUrl': 'Page: {url}',
  'export.privacyNote': 'Note: redaction rules applied; form values, images, attachment contents and API keys are not exported',
  'export.round': 'Round {n}',
  'export.roleUser': 'User',
  'export.roleAssistant': 'Runi',
  'export.stopped': 'Stopped',
  'export.contextTruncated': 'Context truncated',
  'export.quote': 'Quote: ',
  'export.attachments': 'Attachments: {list}',
  'export.tabReferences': 'Referenced tabs: {list}',
  'export.shortcut': 'Shortcut: {name}',
  'export.runInfo': '**Run info**: {provider} · {model} ({api} @ {host}) · vision {vision} · {duration} · {turns} LLM turns · {tools} tool calls · budget read {read} / write {write}',
  'export.withoutBrowserTools': ' · no browser tools',
  'export.yes': 'yes',
  'export.no': 'no',
  'export.taskOutcome': '**Task outcome**: {outcome} — {reason}',
  'export.stepsTableHeader': '| # | Status | Step | Call | Failure |',
  'export.appendix': 'Appendix: structured data',
  'export.maskedValue': '‹{count} chars omitted›',
  'export.exportConversationAriaLabel': 'Export conversation {title}',
  'export.exportCurrent': 'Export current conversation',
  'export.notFound': 'Conversation not found or already deleted',
  'export.failed': 'Export failed: {error}',
```

Run: `pnpm vitest run lib/i18n/i18n.test.ts`
Expected: PASS（两边 key 一致）

- [ ] **Step 2: 写失败测试**

Create `lib/chat/conversation-export.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import { interpolate } from '@/lib/i18n/core';
import { zh } from '@/lib/i18n/locales/zh';
import type { Translate } from '@/lib/i18n';
import type { ChatMessageRecord, ConversationRecord } from '@/lib/db';
import { createBrowserTools } from '@/lib/agent/tools';
import { createTabSession } from '@/lib/agent/tab-session';
import { WRITE_TOOL_NAMES } from '@/lib/agent/permissions';
import {
  buildConversationExport,
  EXPORT_SCHEMA,
  KEPT_WRITE_ARG_KEYS,
  MASKED_WRITE_ARG_KEYS,
  sanitizeToolArgs,
  stripUrl,
} from './conversation-export';

const t = ((key: keyof typeof zh, vars?: Record<string, string | number>) => interpolate(zh[key], vars)) as Translate;
const redaction = defaultRedactionSettings();

const conversation: ConversationRecord = {
  id: 'c1',
  title: '帮我填 13812345678 的表单',
  url: 'https://shop.example.com/checkout?order=998877&token=abc#step2',
  createdAt: 1,
  updatedAt: 2,
};

function record(partial: Partial<ChatMessageRecord>): ChatMessageRecord {
  return { conversationId: 'c1', role: 'user', content: '', createdAt: 1, ...partial };
}

function build(records: ChatMessageRecord[], conv: ConversationRecord = conversation) {
  return buildConversationExport({ conversation: conv, records, redaction, extensionVersion: '1.4.0', locale: 'zh', exportedAt: 100, t });
}

describe('stripUrl', () => {
  it('drops query and hash', () => {
    expect(stripUrl('https://a.com/x/y?token=1#h')).toBe('https://a.com/x/y');
  });
  // Review Focus #1
  it('returns undefined for unparseable input instead of throwing', () => {
    expect(stripUrl('')).toBeUndefined();
    expect(stripUrl('not a url')).toBeUndefined();
  });
  it('keeps non-http schemes without their query', () => {
    expect(stripUrl('chrome://newtab/?x=1')).toBe('chrome://newtab/');
    expect(stripUrl('about:blank')).toBe('about:blank');
  });
});

describe('sanitizeToolArgs', () => {
  it('masks value/text of write tools and keeps locators', () => {
    const out = sanitizeToolArgs('browser_fill_form', { fields: [{ fieldId: 'f3', value: 'P@ssw0rd!!' }], submit: { fieldId: 'f9' } }, redaction, t);
    expect(out).toEqual({ fields: [{ fieldId: 'f3', value: '‹已省略 10 字›' }], submit: { fieldId: 'f9' } });
    expect(sanitizeToolArgs('browser_type', { selector: '#pwd', text: 'secret' }, redaction, t)).toEqual({ selector: '#pwd', text: '‹已省略 6 字›' });
  });

  it('does not mask read tools\' search text, but still redacts it', () => {
    expect(sanitizeToolArgs('browser_find_text', { text: '下一步' }, redaction, t)).toEqual({ text: '下一步' });
    expect(sanitizeToolArgs('browser_find_text', { text: '13812345678' }, redaction, t)).not.toEqual({ text: '13812345678' });
  });

  it('strips url query and clips long strings', () => {
    const out = sanitizeToolArgs('browser_navigate', { url: 'https://a.com/p?sid=1' }, redaction, t);
    expect(out).toEqual({ url: 'https://a.com/p' });
    const long = sanitizeToolArgs('browser_click', { selector: 'x'.repeat(500) }, redaction, t) as { selector: string };
    expect(long.selector.length).toBeLessThanOrEqual(121);
  });

  it('leaves non-string values alone', () => {
    expect(sanitizeToolArgs('browser_set_storage', { area: 'local', key: 'k', value: null }, redaction, t)).toEqual({ area: 'local', key: 'k', value: null });
  });
});

// 守护测试（spec §7）：写工具新增了字符串参数，就必须明确它该屏蔽还是保留。
describe('write tool argument keys guard', () => {
  function collectStringKeys(schema: any, key: string | undefined, out: Set<string>): void {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'string' && key) out.add(key);
    if (schema.properties) for (const [k, v] of Object.entries(schema.properties)) collectStringKeys(v, k, out);
    if (schema.items) collectStringKeys(schema.items, key, out);
    if (schema.patternProperties) for (const v of Object.values(schema.patternProperties)) collectStringKeys(v, key, out);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') collectStringKeys(schema.additionalProperties, key, out);
    for (const c of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) collectStringKeys(c, key, out);
  }

  it('classifies every string parameter of every write tool', () => {
    const unclassified: string[] = [];
    for (const tool of createBrowserTools(createTabSession(1))) {
      if (!WRITE_TOOL_NAMES.has(tool.name)) continue;
      const keys = new Set<string>();
      collectStringKeys(tool.parameters, undefined, keys);
      for (const key of keys) {
        if (!MASKED_WRITE_ARG_KEYS.has(key) && !KEPT_WRITE_ARG_KEYS.has(key)) unclassified.push(`${tool.name}.${key}`);
      }
    }
    expect(unclassified).toEqual([]);
  });
});

describe('buildConversationExport', () => {
  it('redacts the title and strips the page url', () => {
    const doc = build([]);
    expect(doc.schema).toBe(EXPORT_SCHEMA);
    expect(doc.conversation.title).not.toContain('13812345678');
    expect(doc.conversation.url).toBe('https://shop.example.com/checkout');
    expect(doc.extensionVersion).toBe('1.4.0');
  });

  // Review Focus #1
  it('omits an unparseable conversation url instead of throwing', () => {
    const doc = build([], { ...conversation, url: 'garbage' });
    expect(doc.conversation).not.toHaveProperty('url');
  });

  it('redacts user content and quoted text; drops system records', () => {
    const doc = build([
      record({ role: 'system', content: 'sys' }),
      record({ content: '我的邮箱 a@b.com', quotedText: '电话 13812345678' }),
    ]);
    expect(doc.messages).toHaveLength(1);
    expect(doc.messages[0].content).not.toContain('a@b.com');
    expect(doc.messages[0].quotedText).not.toContain('13812345678');
  });

  it('exports attachment metadata only', () => {
    const doc = build([
      record({
        attachments: [
          { id: 'i', kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 2048, dataUrl: 'data:image/png;base64,AAAA' },
          { id: 't', kind: 'text', name: 'a.txt', mimeType: 'text/plain', size: 5, textContent: 'SECRET', truncated: false },
          { id: 'p', kind: 'pdf', name: 'b.pdf', mimeType: 'application/pdf', size: 9, pageCount: 3, extractedChars: 100, truncated: false },
        ],
      }),
    ]);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('base64');
    expect(json).not.toContain('SECRET');
    expect(doc.messages[0].attachments).toEqual([
      { kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 2048 },
      { kind: 'text', name: 'a.txt', mimeType: 'text/plain', size: 5 },
      { kind: 'pdf', name: 'b.pdf', mimeType: 'application/pdf', size: 9, pageCount: 3 },
    ]);
  });

  it('splits step signatures into tool name + sanitized args', () => {
    const doc = build([
      record({ role: 'assistant', content: '好', activitySteps: [
        { id: 's1', description: '填写 1 个字段', status: 'failed', attempt: 2, signature: 'browser_fill_form:{"fields":[{"fieldId":"f3","value":"110101199001011234"}]}', errorText: '读回不一致' },
      ] }),
    ]);
    const step = doc.messages[0].steps![0];
    expect(step).toMatchObject({ status: 'failed', attempt: 2, toolName: 'browser_fill_form', errorText: '读回不一致' });
    expect(step.args).toContain('f3');
    expect(step.args).not.toContain('110101199001011234');
  });

  // Review Focus #3
  it('never exports a raw signature that is not valid JSON', () => {
    const doc = build([
      record({ role: 'assistant', content: '', activitySteps: [
        { id: 's1', description: 'x', status: 'done', signature: 'browser_type:{"selector":"#p","text":"hunter2' },
      ] }),
    ]);
    const step = doc.messages[0].steps![0];
    expect(step.toolName).toBe('browser_type');
    expect(step).not.toHaveProperty('args');
    expect(JSON.stringify(doc)).not.toContain('hunter2');
  });

  it('keeps only id/name/scope of a shortcut rerun', () => {
    const doc = build([
      record({ kind: 'action', content: '润色', rerun: {
        shortcut: { id: 'polish', origin: 'builtin', scope: 'selection', customized: false, name: '润色选中文字', prompt: 'p' },
        selection: '选中的原文', supplement: '补充',
      } as never }),
    ]);
    expect(doc.messages[0].shortcut).toEqual({ id: 'polish', name: '润色选中文字', scope: 'selection' });
    expect(JSON.stringify(doc)).not.toContain('选中的原文');
  });

  it('passes through runDiagnostics, taskOutcome and flags', () => {
    const runDiagnostics = {
      providerName: 'DeepSeek', api: 'openai-completions', baseUrlHost: 'api.deepseek.com', modelId: 'm',
      vision: false, withoutBrowserTools: false, readToolCallBudget: 20, writeToolCallBudget: 40,
      startedAt: 1, durationMs: 38200, llmTurns: 5, toolCalls: 9,
    };
    const doc = build([
      record({ role: 'assistant', content: 'x', stopped: true, contextTruncated: true, runDiagnostics, taskOutcome: { outcome: 'partial', reason: '卡在第二步' } }),
    ]);
    expect(doc.messages[0]).toMatchObject({ stopped: true, contextTruncated: true, runDiagnostics, taskOutcome: { outcome: 'partial', reason: '卡在第二步' } });
  });

  it('strips tab reference urls and redacts titles', () => {
    const doc = build([
      record({ tabReferences: [{ id: 3, title: '订单 13812345678', url: 'https://a.com/o?id=1' }] }),
    ]);
    expect(doc.messages[0].tabReferences).toEqual([{ title: expect.not.stringContaining('13812345678'), url: 'https://a.com/o' }]);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm vitest run lib/chat/conversation-export.test.ts`
Expected: FAIL，报 `Cannot find module './conversation-export'`

- [ ] **Step 4: 实现（本任务部分）**

Create `lib/chat/conversation-export.ts`：

```ts
// 会话导出：把一个会话变成可用于排查问题的诊断记录
// （ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md）。
// 脱敏只在 buildConversationExport 里做一次；Markdown 和附录 JSON 都从它产出的
// ConversationExport 渲染，不存在第二条未脱敏的输出路径。
import type { ChatMessageRecord, ConversationRecord } from '@/lib/db';
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { WRITE_TOOL_NAMES } from '@/lib/agent/permissions';
import type { ActivityStep } from '@/lib/agent/activity-steps';
import type { RunDiagnostics } from '@/lib/agent/run-diagnostics';
import type { TaskOutcome } from '@/lib/agent/task-outcome';
import type { TrajectoryStep } from '@/lib/agent/task-trajectory';
import type { ResolvedLocale, Translate } from '@/lib/i18n';

export const EXPORT_SCHEMA = 'runi-conversation-export/1';
const MAX_ARG_STRING_CHARS = 120;
const MAX_ARGS_JSON_CHARS = 300;

/** 写工具里承载"写进页面的值"的参数键：只导出长度（spec §4.2）。 */
export const MASKED_WRITE_ARG_KEYS: ReadonlySet<string> = new Set(['value', 'text']);
/** 写工具里的定位/枚举参数：排查"点错了元素"要靠它们，只脱敏不屏蔽。守护测试要求每个写工具字符串参数必居其一。 */
export const KEPT_WRITE_ARG_KEYS: ReadonlySet<string> = new Set([
  'selector', 'styles', 'action', 'attribute', 'fieldId', 'fieldIds', 'key', 'behavior', 'url', 'area',
]);

export interface ExportedAttachment {
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount?: number;
}

export interface ExportedStep {
  status: ActivityStep['status'];
  description: string;
  tabLabel?: string;
  attempt?: number;
  toolName?: string;
  /** 已屏蔽写入值、已脱敏、已截断的参数 JSON。 */
  args?: string;
  errorText?: string;
}

export interface ExportedMessage {
  role: 'user' | 'assistant';
  createdAt: number;
  kind?: 'input' | 'action';
  content: string;
  quotedText?: string;
  attachments?: ExportedAttachment[];
  tabReferences?: { title: string; url?: string }[];
  shortcut?: { id: string; name: string; scope: string };
  taskOutcome?: TaskOutcome;
  stopped?: boolean;
  contextTruncated?: boolean;
  steps?: ExportedStep[];
  trajectory?: TrajectoryStep[];
  runDiagnostics?: RunDiagnostics;
}

export interface ConversationExport {
  schema: typeof EXPORT_SCHEMA;
  exportedAt: number;
  extensionVersion: string;
  locale: ResolvedLocale;
  conversation: { title: string; url?: string; createdAt: number; updatedAt: number };
  messages: ExportedMessage[];
}

export interface ConversationExportInput {
  conversation: ConversationRecord;
  records: ChatMessageRecord[];
  redaction: RedactionSettings;
  extensionVersion: string;
  locale: ResolvedLocale;
  exportedAt: number;
  t: Translate;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 只留 scheme + host + pathname：query/hash 里常带 token、订单号。无法解析时返回 undefined，由调用方整段省略。 */
export function stripUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : `${parsed.protocol}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

export function sanitizeToolArgs(toolName: string, args: unknown, redaction: RedactionSettings, t: Translate): unknown {
  const maskWrites = WRITE_TOOL_NAMES.has(toolName);
  const visit = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') {
      if (maskWrites && key !== undefined && MASKED_WRITE_ARG_KEYS.has(key)) return t('export.maskedValue', { count: value.length });
      if (key === 'url') return stripUrl(value) ?? '';
      return clip(redactText(value, redaction), MAX_ARG_STRING_CHARS);
    }
    // 数组元素继承父键：fieldIds: ['f1'] 仍按 fieldIds 归类。
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    }
    return value;
  };
  return visit(args, undefined);
}

/** signature = `${toolName}:${JSON}`（tool-policy.ts 的 toolSignature）。JSON 坏了就只给工具名——原串可能含写入值。 */
function exportStep(step: ActivityStep, redaction: RedactionSettings, t: Translate): ExportedStep {
  const out: ExportedStep = { status: step.status, description: redactText(step.description, redaction) };
  if (step.tabLabel) out.tabLabel = redactText(step.tabLabel, redaction);
  if (step.attempt !== undefined) out.attempt = step.attempt;
  if (step.signature) {
    const colon = step.signature.indexOf(':');
    const toolName = colon === -1 ? step.signature : step.signature.slice(0, colon);
    out.toolName = toolName;
    if (colon !== -1) {
      try {
        const args = JSON.parse(step.signature.slice(colon + 1)) as unknown;
        out.args = clip(JSON.stringify(sanitizeToolArgs(toolName, args, redaction, t)), MAX_ARGS_JSON_CHARS);
      } catch {
        // 保持无 args。
      }
    }
  }
  if (step.errorText) out.errorText = step.errorText;
  return out;
}

function exportMessage(record: ChatMessageRecord & { role: 'user' | 'assistant' }, redaction: RedactionSettings, t: Translate): ExportedMessage {
  const out: ExportedMessage = {
    role: record.role,
    createdAt: record.createdAt,
    content: redactText(record.content, redaction),
  };
  if (record.kind) out.kind = record.kind;
  if (record.quotedText) out.quotedText = redactText(record.quotedText, redaction);
  if (record.attachments?.length) {
    out.attachments = record.attachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      ...(a.kind === 'pdf' ? { pageCount: a.pageCount } : {}),
    }));
  }
  if (record.tabReferences?.length) {
    out.tabReferences = record.tabReferences.map((ref) => {
      const url = stripUrl(ref.url);
      return { title: redactText(ref.title, redaction), ...(url ? { url } : {}) };
    });
  }
  if (record.rerun) {
    const { id, name, scope } = record.rerun.shortcut;
    out.shortcut = { id, name: redactText(name, redaction), scope };
  }
  if (record.taskOutcome) out.taskOutcome = record.taskOutcome;
  if (record.stopped) out.stopped = true;
  if (record.contextTruncated) out.contextTruncated = true;
  if (record.activitySteps?.length) out.steps = record.activitySteps.map((step) => exportStep(step, redaction, t));
  if (record.trajectory?.length) out.trajectory = record.trajectory;
  if (record.runDiagnostics) out.runDiagnostics = record.runDiagnostics;
  return out;
}

export function buildConversationExport(input: ConversationExportInput): ConversationExport {
  const { conversation, redaction, t } = input;
  const url = conversation.url ? stripUrl(conversation.url) : undefined;
  return {
    schema: EXPORT_SCHEMA,
    exportedAt: input.exportedAt,
    extensionVersion: input.extensionVersion,
    locale: input.locale,
    conversation: {
      title: redactText(conversation.title, redaction),
      ...(url ? { url } : {}),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messages: input.records
      .filter((r): r is ChatMessageRecord & { role: 'user' | 'assistant' } => r.role !== 'system')
      .map((r) => exportMessage(r, redaction, t)),
  };
}
```

说明：`about:blank` 的 `host` 为空，按 `protocol + pathname` 输出为 `about:blank`；`chrome://newtab/?x=1` 输出 `chrome://newtab/`。如果 Node 的 `URL` 对 `chrome:` 这类特殊 scheme 解析出的 host 与测试期望不同，以实际行为为准调整测试期望值，但必须保证不含 query。

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run lib/chat/conversation-export.test.ts`
Expected: PASS。守护测试如果报出未归类的键，说明 `tools.ts` 在本计划写完后加了新参数：判断它是不是写入值，加到对应集合里，并在提交信息里说明。

- [ ] **Step 6: 提交**

```bash
git add lib/chat/conversation-export.ts lib/chat/conversation-export.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(chat): 会话导出的脱敏中间结构与写工具参数屏蔽"
```

---

### Task 4: Markdown 渲染与文件名

**Files:**
- Modify: `lib/chat/conversation-export.ts`（追加 `renderConversationExportMarkdown`、`exportFileName`）
- Modify: `lib/chat/conversation-export.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ConversationExport`、`ExportedMessage`、`ExportedStep`
- Produces:
  - `export function renderConversationExportMarkdown(doc: ConversationExport, t: Translate): string`
  - `export function exportFileName(title: string, exportedAt: number): string`

- [ ] **Step 1: 写失败测试**

在 `lib/chat/conversation-export.test.ts` 顶部 import 里加上 `renderConversationExportMarkdown, exportFileName`，文件末尾追加：

```ts
describe('renderConversationExportMarkdown', () => {
  const runDiagnostics = {
    providerName: 'DeepSeek', api: 'openai-completions', baseUrlHost: 'api.deepseek.com', modelId: 'deepseek-v4-pro',
    vision: false, withoutBrowserTools: false, readToolCallBudget: 20, writeToolCallBudget: 40,
    startedAt: 1, durationMs: 38200, llmTurns: 5, toolCalls: 9,
  };

  function render(records: ChatMessageRecord[]) {
    return renderConversationExportMarkdown(build(records), t);
  }

  it('renders header, rounds, run info, steps table and a parseable JSON appendix', () => {
    const md = render([
      record({ content: '帮我填表' }),
      record({ role: 'assistant', content: '已完成', runDiagnostics, taskOutcome: { outcome: 'partial', reason: '卡在第二步' }, activitySteps: [
        { id: 's1', description: '读取页面表单', status: 'done', signature: 'browser_get_form:{}' },
        { id: 's2', description: '填写 | 3 个字段', status: 'failed', attempt: 2, signature: 'browser_fill_form:{"fields":[{"fieldId":"f3","value":"abc"}]}', errorText: '第一行\n第二行' },
      ] }),
      record({ content: '再来一次' }),
    ]);
    expect(md).toContain('# Runi 会话导出：');
    expect(md).toContain('- 扩展版本：1.4.0 · 界面语言：zh');
    expect(md).toContain('## 第 1 轮');
    expect(md).toContain('## 第 2 轮');
    expect(md).toContain('DeepSeek · deepseek-v4-pro（openai-completions @ api.deepseek.com）');
    expect(md).toContain('耗时 38.2s');
    expect(md).toContain('**任务结果**：partial —— 卡在第二步');
    expect(md).toContain('| # | 状态 | 步骤 | 调用 | 失败原因 |');
    expect(md).toContain('填写 \\| 3 个字段');
    expect(md).toContain('第一行<br>第二行');
    expect(md).toContain('✗ ×2');
    expect(md).not.toContain('"value":"abc"');

    const fence = md.match(/\n(`{3,})json\n/)![1];
    const json = md.slice(md.lastIndexOf(`${fence}json\n`) + fence.length + 5, md.lastIndexOf(`\n${fence}`));
    expect(JSON.parse(json).schema).toBe(EXPORT_SCHEMA);
  });

  it('omits the run info line for legacy messages without diagnostics', () => {
    const md = render([record({ content: '问' }), record({ role: 'assistant', content: '答' })]);
    expect(md).not.toContain('**运行信息**');
  });

  it('puts a leading assistant message into round 1', () => {
    const md = render([record({ role: 'assistant', content: '欢迎' }), record({ content: '问' })]);
    expect(md.indexOf('## 第 1 轮')).toBeLessThan(md.indexOf('欢迎'));
    expect(md).toContain('## 第 2 轮');
  });

  // Review Focus #2
  it('closes an unbalanced code fence so later sections are not swallowed', () => {
    const md = render([record({ role: 'assistant', content: '看这段：\n```js\nconst a = 1;' }), record({ content: '下一轮' })]);
    const beforeRound2 = md.slice(0, md.indexOf('## 第 2 轮'));
    const fenceLines = beforeRound2.split('\n').filter((line) => /^\s*(`{3,}|~{3,})/.test(line));
    expect(fenceLines.length % 2).toBe(0);
  });

  it('uses a JSON fence longer than any backtick run inside the JSON', () => {
    const md = render([record({ content: '````四个反引号````' })]);
    expect(md).toMatch(/\n`{5,}json\n/);
  });
});

describe('exportFileName', () => {
  const at = new Date(2026, 8, 24, 14, 3).getTime();
  it('formats title and local timestamp', () => {
    expect(exportFileName('帮我填表', at)).toBe('runi-帮我填表-20260924-1403.md');
  });
  // Review Focus #4
  it('replaces illegal characters and falls back when nothing usable is left', () => {
    expect(exportFileName('a/b:c*?', at)).toBe('runi-a_b_c__-20260924-1403.md');
    expect(exportFileName('   ', at)).toBe('runi-conversation-20260924-1403.md');
    expect(exportFileName('...', at)).toBe('runi-conversation-20260924-1403.md');
  });
  it('clips long titles to 40 chars', () => {
    const name = exportFileName('字'.repeat(100), at);
    expect(name).toBe(`runi-${'字'.repeat(40)}-20260924-1403.md`);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/chat/conversation-export.test.ts`
Expected: FAIL，`renderConversationExportMarkdown` / `exportFileName` 未导出

- [ ] **Step 3: 实现**

在 `lib/chat/conversation-export.ts` 末尾追加：

```ts
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** 模型回复里未闭合的代码围栏会把后面的章节全吞进代码块；奇数个围栏行就补一个闭合。 */
function closeOpenFences(text: string): string {
  const fences = text.split('\n').filter((line) => /^\s*(`{3,}|~{3,})/.test(line));
  if (fences.length % 2 === 0) return text;
  const opener = fences[fences.length - 1].trim().match(/^(`{3,}|~{3,})/)![1];
  return `${text}\n${opener}`;
}

const STEP_STATUS_ICON: Record<ExportedStep['status'], string> = { done: '✓', failed: '✗', running: '…', notice: 'ℹ' };

function formatBytes(size: number): string {
  return size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`;
}

function renderMessage(m: ExportedMessage, t: Translate): string[] {
  const lines: string[] = [];
  const flags = [
    ...(m.stopped ? [t('export.stopped')] : []),
    ...(m.contextTruncated ? [t('export.contextTruncated')] : []),
  ];
  const role = m.role === 'user' ? t('export.roleUser') : t('export.roleAssistant');
  lines.push(`### ${[role, formatDateTime(m.createdAt), ...flags].join(' · ')}`, '');
  if (m.shortcut) lines.push(t('export.shortcut', { name: m.shortcut.name }), '');
  if (m.quotedText) {
    lines.push(...m.quotedText.split('\n').map((line, i) => `> ${i === 0 ? t('export.quote') : ''}${line}`), '');
  }
  if (m.content) lines.push(closeOpenFences(m.content), '');
  if (m.attachments?.length) {
    const list = m.attachments.map((a) => `${a.name}（${a.mimeType}，${formatBytes(a.size)}${a.pageCount !== undefined ? `，${a.pageCount}p` : ''}）`).join('、');
    lines.push(t('export.attachments', { list }), '');
  }
  if (m.tabReferences?.length) {
    const list = m.tabReferences.map((ref) => (ref.url ? `${ref.title} <${ref.url}>` : ref.title)).join('、');
    lines.push(t('export.tabReferences', { list }), '');
  }
  if (m.runDiagnostics) {
    const d = m.runDiagnostics;
    lines.push(
      t('export.runInfo', {
        provider: d.providerName,
        model: d.modelId,
        api: d.api,
        host: d.baseUrlHost || '-',
        vision: d.vision ? t('export.yes') : t('export.no'),
        duration: `${(d.durationMs / 1000).toFixed(1)}s`,
        turns: d.llmTurns,
        tools: d.toolCalls,
        read: d.readToolCallBudget,
        write: d.writeToolCallBudget,
      }) + (d.withoutBrowserTools ? t('export.withoutBrowserTools') : ''),
      '',
    );
  }
  if (m.taskOutcome) lines.push(t('export.taskOutcome', { outcome: m.taskOutcome.outcome, reason: m.taskOutcome.reason }), '');
  if (m.steps?.length) {
    lines.push(t('export.stepsTableHeader'), '|---|---|---|---|---|');
    m.steps.forEach((step, i) => {
      const status = `${STEP_STATUS_ICON[step.status]}${step.attempt ? ` ×${step.attempt}` : ''}`;
      const description = step.tabLabel ? `${step.description}（${step.tabLabel}）` : step.description;
      const call = step.toolName ? `${step.toolName}${step.args ? ` ${step.args}` : ''}` : '';
      lines.push(`| ${i + 1} | ${status} | ${escapeCell(description)} | ${escapeCell(call)} | ${escapeCell(step.errorText ?? '')} |`);
    });
    lines.push('');
  }
  return lines;
}

export function renderConversationExportMarkdown(doc: ConversationExport, t: Translate): string {
  const lines: string[] = [
    `# ${t('export.title', { title: doc.conversation.title })}`,
    '',
    `- ${t('export.exportedAt', { time: formatDateTime(doc.exportedAt) })}`,
    `- ${t('export.version', { version: doc.extensionVersion, locale: doc.locale })}`,
    ...(doc.conversation.url ? [`- ${t('export.pageUrl', { url: doc.conversation.url })}`] : []),
    `- ${t('export.privacyNote')}`,
    '',
  ];

  // 一轮 = 一条用户消息加上它后面的 assistant 消息；开头就是 assistant 的也单独成一轮。
  const rounds: ExportedMessage[][] = [];
  for (const m of doc.messages) {
    if (m.role === 'user' || rounds.length === 0) rounds.push([]);
    rounds[rounds.length - 1].push(m);
  }
  rounds.forEach((round, i) => {
    lines.push(`## ${t('export.round', { n: i + 1 })}`, '');
    for (const m of round) lines.push(...renderMessage(m, t));
  });

  const json = JSON.stringify(doc, null, 2);
  const longestRun = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  lines.push('---', '', `## ${t('export.appendix')}`, '', `${fence}json`, json, fence, '');
  return lines.join('\n');
}

export function exportFileName(title: string, exportedAt: number): string {
  const d = new Date(exportedAt);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const safe = Array.from(
    title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, ''),
  ).slice(0, 40).join('');
  return `runi-${safe || 'conversation'}-${stamp}.md`;
}
```

（用 `Array.from(...).slice(0, 40)` 按码点截断，避免把 emoji 等代理对切成两半。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/chat/conversation-export.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/chat/conversation-export.ts lib/chat/conversation-export.test.ts
git commit -m "feat(chat): 会话导出渲染为 Markdown 并附结构化 JSON"
```

---

### Task 5: 面板入口与下载

**Files:**
- Create: `lib/workbench/download-file.ts`
- Create: `lib/workbench/download-file.dom.test.ts`
- Modify: `entrypoints/sidepanel/icons.tsx`（加 `IconDownload`）
- Modify: `entrypoints/sidepanel/components/HistoryDrawer.tsx`（props 加 `onExport?`；每行删除按钮前加导出按钮）
- Modify: `entrypoints/sidepanel/components/WorkbenchHeader.tsx`（props 加 `onExport?`、`exportDisabled?`；新对话按钮前加导出按钮）
- Modify: `entrypoints/sidepanel/store.ts`（`ChatState` 接口 + 实现 `exportConversation`）
- Modify: `entrypoints/sidepanel/App.tsx`（解构 `exportConversation`；给两个组件接线）
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`（`chatStore` mock 加 `exportConversation: vi.fn()`；新增 UI 用例）

**Interfaces:**
- Consumes: Task 3/4 的 `buildConversationExport`、`renderConversationExportMarkdown`、`exportFileName`；i18n key `export.exportConversationAriaLabel`、`export.exportCurrent`、`export.notFound`、`export.failed`
- Produces: `downloadTextFile(fileName: string, text: string, mimeType?: string): void`；`ChatState.exportConversation(id: string): Promise<void>`；`HistoryDrawerProps.onExport?(id: string): void`；`WorkbenchHeaderProps.onExport?(): void`、`exportDisabled?: boolean`

- [ ] **Step 1: 写下载工具的失败测试**

Create `lib/workbench/download-file.dom.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from './download-file';

describe('downloadTextFile', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('clicks a temporary download anchor and revokes the object url afterwards', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });

    downloadTextFile('runi-a.md', '# hi');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('runi-a.md');
    expect(clicked[0].href).toBe('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/workbench/download-file.dom.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/workbench/download-file.ts`**

```ts
// 在扩展页面里直接触发文件下载：<a download> + Blob URL，不需要 downloads 权限
// （ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §5）。
export function downloadTextFile(fileName: string, text: string, mimeType = 'text/markdown;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 同步 revoke 在部分浏览器里会让下载拿不到数据；留一点余量再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

Run: `pnpm vitest run lib/workbench/download-file.dom.test.ts`
Expected: PASS

- [ ] **Step 4: 写 UI 失败测试**

`entrypoints/sidepanel/components/workbench-components.test.tsx`：
- 在 `chatStore` 对象里 `restoreTabConversation: vi.fn(),` 之后加 `exportConversation: vi.fn(),`
- 把 `renderDrawer` 改成接收可选的 `onExport`：

```ts
function renderDrawer(onRemove = vi.fn(), onClearAll = vi.fn(), conversations = records, onExport?: (id: string) => void) {
  return render(
    <LocaleProvider>
      <HistoryDrawer
        open
        conversations={conversations}
        activeConversationId="google"
        now={now}
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        onPick={vi.fn()}
        onRemove={onRemove}
        onClearAll={onClearAll}
        onExport={onExport}
      />
    </LocaleProvider>,
  );
}
```

- 文件末尾追加：

```ts
describe('会话导出入口', () => {
  it('历史抽屉的导出按钮带着会话 id 回调', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    renderDrawer(vi.fn(), vi.fn(), records, onExport);
    await user.click(screen.getByRole('button', { name: 'Export conversation Shopping comparison' }));
    expect(onExport).toHaveBeenCalledWith('shopping');
  });

  it('没传 onExport 时历史抽屉不渲染导出按钮', () => {
    renderDrawer();
    expect(screen.queryByRole('button', { name: /Export conversation/ })).not.toBeInTheDocument();
  });

  it('顶栏导出按钮可点击，exportDisabled 时禁用', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    const { rerender } = render(
      <LocaleProvider>
        <WorkbenchHeader historyOpen={false} onToggleHistory={vi.fn()} onNewChat={vi.fn()} onOpenSettings={vi.fn()} onExport={onExport} />
      </LocaleProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Export current conversation' }));
    expect(onExport).toHaveBeenCalledOnce();

    rerender(
      <LocaleProvider>
        <WorkbenchHeader historyOpen={false} onToggleHistory={vi.fn()} onNewChat={vi.fn()} onOpenSettings={vi.fn()} onExport={onExport} exportDisabled />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Export current conversation' })).toBeDisabled();
  });
});
```

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: 新用例 FAIL（找不到按钮）

- [ ] **Step 5: 图标与组件**

`entrypoints/sidepanel/icons.tsx`，在 `IconTrash` 之后加：

```tsx
export function IconDownload({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  );
}
```

`HistoryDrawer.tsx`：
- icons import 改为 `import { IconClose, IconDownload, IconPlus, IconTrash } from '../icons';`
- `HistoryDrawerProps` 在 `onClearAll(): void;` 后加 `onExport?(id: string): void;`
- 函数参数解构里加 `onExport,`（按现有解构的写法放在 `onClearAll,` 之后）
- 在每行删除 `<button ...>`（`onClick={() => confirmingId === conversation.id ? ...`）之前插入：

```tsx
                        {onExport && (
                          <button
                            type="button"
                            onClick={() => onExport(conversation.id)}
                            aria-label={t('export.exportConversationAriaLabel', { title: conversation.title || '' })}
                            title={t('export.exportConversationAriaLabel', { title: conversation.title || '' })}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                          >
                            <IconDownload className="h-4 w-4 shrink-0" />
                          </button>
                        )}
```

`WorkbenchHeader.tsx`：
- icons import 改为 `import { IconDownload, IconGear, IconMenu, IconPlus, IconStop } from '../icons';`
- `WorkbenchHeaderProps` 在 `onOpenSettings(): void;` 后加：

```ts
  /** 导出当前会话；不传则不显示按钮。 */
  onExport?(): void;
  /** 当前会话为空或正在运行时为 true——运行中导出只会拿到半截记录。 */
  exportDisabled?: boolean;
```

- 函数参数解构加 `onExport, exportDisabled,`
- 在 `onClick={onNewChat}` 那个按钮之前插入：

```tsx
        {onExport && (
          <button
            type="button"
            onClick={onExport}
            disabled={exportDisabled}
            aria-label={t('export.exportCurrent')}
            title={t('export.exportCurrent')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconDownload className="h-5 w-5" />
          </button>
        )}
```

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS

- [ ] **Step 6: store 动作**

`entrypoints/sidepanel/store.ts`：
- import 区加：

```ts
import { buildConversationExport, exportFileName, renderConversationExportMarkdown } from '@/lib/chat/conversation-export';
import { downloadTextFile } from '@/lib/workbench/download-file';
```

  `loadRedactionSettings` 如果还没有从 `@/lib/redaction` 导入，就补上（先 `grep -n "lib/redaction" entrypoints/sidepanel/store.ts` 查一下）。
- `ChatState` 接口 `clearAllConversations: () => Promise<void>;` 后加：

```ts
  /** 把一个会话导出成排查问题用的 .md（ref: 2026-09-24-conversation-export-design.md §5）。统一读 IndexedDB，不读面板内存。 */
  exportConversation: (id: string) => Promise<void>;
```

- 在实现对象里 `clearAllConversations` 的实现之后加：

```ts
  exportConversation: async (id) => {
    try {
      const [conversations, records, redaction] = await Promise.all([
        listConversations(),
        getConversationMessages(id),
        loadRedactionSettings(),
      ]);
      const conversation = conversations.find((c) => c.id === id);
      if (!conversation) throw new Error(t('export.notFound'));
      const doc = buildConversationExport({
        conversation,
        records,
        redaction,
        extensionVersion: browser.runtime.getManifest().version,
        locale: getCurrentLocale(),
        exportedAt: Date.now(),
        t,
      });
      downloadTextFile(exportFileName(doc.conversation.title, doc.exportedAt), renderConversationExportMarkdown(doc, t));
    } catch (error) {
      set({ error: t('export.failed', { error: errMsg(error) }) });
    }
  },
```

`entrypoints/sidepanel/App.tsx`：
- `useChat()` 的解构里 `restoreTabConversation,` 后加 `exportConversation,`
- `<HistoryDrawer ...>` 加 `onExport={(id) => void exportConversation(id)}`
- `<WorkbenchHeader ...>` 加：

```tsx
            onExport={() => void exportConversation(conversationId)}
            exportDisabled={busy || messages.length === 0}
```

（先确认 App 的 `useChat()` 解构里有 `messages`；没有就加上。）

- [ ] **Step 7: 全量验证**

Run: `pnpm compile && pnpm test`
Expected: 类型检查无错误，全部测试 PASS

- [ ] **Step 8: 提交**

```bash
git add lib/workbench/download-file.ts lib/workbench/download-file.dom.test.ts entrypoints/sidepanel/icons.tsx entrypoints/sidepanel/components/HistoryDrawer.tsx entrypoints/sidepanel/components/WorkbenchHeader.tsx entrypoints/sidepanel/store.ts entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
git commit -m "feat(sidepanel): 历史抽屉与顶栏支持导出会话"
```

---

### Task 6: 构建、手动验证与文档收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-conversation-export-design.md`（状态行）
- Modify: `CLAUDE.md`（Architecture 里补两处模块说明）

- [ ] **Step 1: 构建**

Run: `pnpm build && pnpm verify:pdfjs-assets`
Expected: 构建成功，资源校验通过

- [ ] **Step 2: 手动验证**（需要人在 Chrome 里操作）

1. `chrome://extensions` → 重新加载 `.output/chrome-mv3`。
2. 在任一表单页让 agent 执行一个带写操作的任务，并故意让一步失败（例如让它点击一个不存在的选择器）。
3. 顶栏点导出按钮。检查下载的 `.md`：
   - 有运行信息行。
   - 步骤表里失败那行有失败原因。
   - 填表的值显示为"已省略 N 字"。
   - 附录 JSON 能被解析。
4. 历史抽屉里对另一个会话点导出，确认文件名和内容对应的是那个会话。
5. 运行中确认顶栏的导出按钮是禁用状态。

- [ ] **Step 3: 更新 spec 状态和 CLAUDE.md**

spec 第 4 行 `- 状态：设计待审` 改为 `- 状态：已实现`。

`CLAUDE.md`：
- 在 `### Attachments (\`lib/chat/\`)` 小节末尾加：

```markdown
- `conversation-export.ts` — the side panel's per-conversation "export" (history drawer row / header button; ref: `docs/superpowers/specs/2026-09-24-conversation-export-design.md`), meant for bug reports. `buildConversationExport` is the one place redaction happens — the Markdown body and the JSON appendix are both rendered from its output, so there is no second, unredacted path. Write-tool arguments keyed `value`/`text` are replaced by their length; a guard test fails whenever a write tool grows a string parameter that is in neither `MASKED_WRITE_ARG_KEYS` nor `KEPT_WRITE_ARG_KEYS`, forcing a decision about whether it carries user data. Downloads go through `lib/workbench/download-file.ts` (`<a download>` + Blob URL), so no `downloads` permission.
```

- 在 `### Agent loop (\`lib/agent/\`)` 的 `perf-trace.ts` 条目之后加：

```markdown
- **`run-diagnostics.ts`** — what a finished run leaves behind for conversation export: `ActivityStep.errorText` (a failed tool's error text, `redactText`-ed *before* clipping to `MAX_STEP_ERROR_CHARS`) and `ChatMessage.runDiagnostics` (provider name, protocol, baseURL host only, model, vision, budgets, duration, LLM turn and tool call counts — never the API key). Counted from `run-registry.ts`'s own event subscription rather than `perf-trace.ts`, which is off by default and module-global.
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-09-24-conversation-export-design.md CLAUDE.md
git commit -m "docs: 会话导出实现完成，更新 spec 状态与 CLAUDE.md 架构说明"
```
