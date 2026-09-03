# browser_wait_for Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `browser_wait_for` 工具，让 agent 能等待页面达成具体条件（元素出现/消失、文本出现、DOM 静止），取代目前只能 `wait(N)` 盲等的做法。

**Architecture:** 遵循本项目既有的工具三段式：纯逻辑（条件解析、结果文案）放 `lib/agent/wait-condition.ts`，注入页面的观察函数放 `lib/agent/wait-dom.ts`，`background.ts` 只做 I/O 编排。注入函数内部用 `MutationObserver` 加轮询兜底与超时竞速，`scripting.executeScript` 会 await 它返回的 promise，因此 background 侧不轮询。

**Tech Stack:** TypeScript、WXT（MV3）、vitest（`unit` 与 `dom` 两个 project）、`@earendil-works/pi-agent-core` 的 `AgentTool`、TypeBox（`Type.*`）描述工具参数。

**Spec:** `docs/superpowers/specs/2026-09-03-agent-tool-expansion-design.md`（本计划实现其 §5，以及 §6/§7 中与 wait_for 相关的条目）

## Global Constraints

- 不新增任何 manifest 权限。`wxt.config.ts` 的 `permissions` 数组保持不变。
- `browser_wait_for` 进 `READ_ONLY_TOOL_NAMES`，**不进** `AUTO_APPROVE_TOOL_NAMES`。它不修改任何状态。
- 超时不是错误：返回 `met: false` 与已等时长，不抛异常。
- `timeoutMs` 默认 5000，上限 15000，下限 500。
- `idleMs` 默认 500，范围 [100, 5000]。
- 注入页面的函数（`wait-dom.ts` 内的 `waitForConditionInPage`）**不得引用任何模块作用域的绑定**——它会被 `browser.scripting.executeScript` 序列化后在页面里执行，模块作用域的函数、常量、import 的值在那里一律是 `undefined`。`import type` 会被编译期擦除，不受此限制。
- 代码注释与提交信息用中文，与本仓库既有风格一致。
- 每个 vitest 命令都用 `pnpm vitest run <file>` 形式（`pnpm test` 是全量单跑）。

---

### Task 1: 条件解析与结果文案（纯函数）

**Files:**
- Create: `lib/agent/wait-condition.ts`
- Test: `lib/agent/wait-condition.test.ts`

**Interfaces:**
- Consumes: 无（本计划的第一个任务）
- Produces:
  - `type WaitConditionKind = 'appear' | 'disappear' | 'textContains' | 'domIdle'`
  - `interface WaitCondition { kind: WaitConditionKind; selector?: string; text?: string; idleMs: number; timeoutMs: number }`
  - `interface WaitOutcome { met: boolean; elapsedMs: number; matched?: number; error?: string }`
  - `function parseWaitCondition(params: unknown): { ok: true; condition: WaitCondition } | { ok: false; error: string }`
  - `function describeWaitResult(condition: WaitCondition, outcome: WaitOutcome): string`
  - `const DEFAULT_WAIT_TIMEOUT_MS = 5000`、`MAX_WAIT_TIMEOUT_MS = 15000`、`MIN_WAIT_TIMEOUT_MS = 500`、`DEFAULT_DOM_IDLE_MS = 500`

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/wait-condition.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOM_IDLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  describeWaitResult,
  parseWaitCondition,
  type WaitCondition,
} from './wait-condition';

describe('parseWaitCondition', () => {
  it('拒绝未知的条件类型', () => {
    const parsed = parseWaitCondition({ kind: 'networkIdle', selector: '.x' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('networkIdle');
  });

  it('appear 缺少 selector 时报错', () => {
    const parsed = parseWaitCondition({ kind: 'appear' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('selector');
  });

  it('disappear 缺少 selector 时报错', () => {
    const parsed = parseWaitCondition({ kind: 'disappear', selector: '   ' });
    expect(parsed.ok).toBe(false);
  });

  it('textContains 缺少 text 时报错', () => {
    const parsed = parseWaitCondition({ kind: 'textContains', selector: 'main' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('text');
  });

  it('appear 带 selector 时补齐默认超时', () => {
    const parsed = parseWaitCondition({ kind: 'appear', selector: '.result' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.condition).toEqual({
        kind: 'appear',
        selector: '.result',
        idleMs: DEFAULT_DOM_IDLE_MS,
        timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
      });
    }
  });

  it('domIdle 不需要 selector', () => {
    const parsed = parseWaitCondition({ kind: 'domIdle' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.condition.idleMs).toBe(DEFAULT_DOM_IDLE_MS);
  });

  it('timeoutMs 超过上限时夹到上限', () => {
    const parsed = parseWaitCondition({ kind: 'domIdle', timeoutMs: 60000 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.condition.timeoutMs).toBe(MAX_WAIT_TIMEOUT_MS);
  });

  it('timeoutMs 低于下限或非数字时回到合法范围', () => {
    const tooSmall = parseWaitCondition({ kind: 'domIdle', timeoutMs: 1 });
    expect(tooSmall.ok).toBe(true);
    if (tooSmall.ok) expect(tooSmall.condition.timeoutMs).toBe(500);

    const notANumber = parseWaitCondition({ kind: 'domIdle', timeoutMs: 'soon' });
    expect(notANumber.ok).toBe(true);
    if (notANumber.ok) expect(notANumber.condition.timeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  it('idleMs 夹到 [100, 5000]', () => {
    const parsed = parseWaitCondition({ kind: 'domIdle', idleMs: 99999 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.condition.idleMs).toBe(5000);
  });
});

describe('describeWaitResult', () => {
  const appear: WaitCondition = { kind: 'appear', selector: '.result', idleMs: 500, timeoutMs: 5000 };

  it('appear 命中时报告匹配数量和耗时', () => {
    const text = describeWaitResult(appear, { met: true, elapsedMs: 320, matched: 3 });
    expect(text).toContain('.result');
    expect(text).toContain('3');
    expect(text).toContain('320');
  });

  it('disappear 命中时不提匹配数量', () => {
    const condition: WaitCondition = { kind: 'disappear', selector: '.spinner', idleMs: 500, timeoutMs: 5000 };
    const text = describeWaitResult(condition, { met: true, elapsedMs: 120, matched: 0 });
    expect(text).toContain('.spinner');
    expect(text).toContain('消失');
  });

  it('domIdle 命中时报告静止时长', () => {
    const condition: WaitCondition = { kind: 'domIdle', idleMs: 800, timeoutMs: 5000 };
    const text = describeWaitResult(condition, { met: true, elapsedMs: 1500 });
    expect(text).toContain('800');
  });

  // 超时不是错误，但必须明确劝阻原样重试——否则模型会反复等同一个条件，
  // 每次都是一整轮 LLM 往返。
  it('超时的文案明确劝阻原样重试', () => {
    const text = describeWaitResult(appear, { met: false, elapsedMs: 5000 });
    expect(text).toContain('超时');
    expect(text).toContain('不要原样重试');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/wait-condition.test.ts`
Expected: FAIL，报错为无法解析模块 `./wait-condition`（文件尚未创建）。

- [ ] **Step 3: 写最小实现**

创建 `lib/agent/wait-condition.ts`：

```ts
// browser_wait_for 的参数解析与结果文案。纯函数，不碰 DOM、不发消息，
// 这样等待条件的边界与措辞可以脱离浏览器环境测试。

export type WaitConditionKind = 'appear' | 'disappear' | 'textContains' | 'domIdle';

export interface WaitCondition {
  kind: WaitConditionKind;
  selector?: string;
  text?: string;
  idleMs: number;
  timeoutMs: number;
}

export interface WaitOutcome {
  met: boolean;
  elapsedMs: number;
  /** appear/disappear 命中时匹配到的元素数。 */
  matched?: number;
  /** 页面内错误（例如非法选择器）；有值时工具抛出，让模型修正参数。 */
  error?: string;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 5000;
export const MIN_WAIT_TIMEOUT_MS = 500;
/** 硬上限：一次盲等不应吃掉整轮时间。 */
export const MAX_WAIT_TIMEOUT_MS = 15000;
export const DEFAULT_DOM_IDLE_MS = 500;
const MIN_DOM_IDLE_MS = 100;
const MAX_DOM_IDLE_MS = 5000;

const KINDS: WaitConditionKind[] = ['appear', 'disappear', 'textContains', 'domIdle'];

export function parseWaitCondition(
  params: unknown,
): { ok: true; condition: WaitCondition } | { ok: false; error: string } {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const kind = record.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as WaitConditionKind)) {
    return { ok: false, error: `未知的等待条件 "${String(kind)}"，只支持：${KINDS.join('、')}。` };
  }

  const selector = typeof record.selector === 'string' ? record.selector.trim() : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';

  if ((kind === 'appear' || kind === 'disappear') && !selector) {
    return { ok: false, error: `${kind} 条件必须提供 selector。` };
  }
  if (kind === 'textContains' && !text) {
    return { ok: false, error: 'textContains 条件必须提供 text。' };
  }

  return {
    ok: true,
    condition: {
      kind: kind as WaitConditionKind,
      ...(selector ? { selector } : {}),
      ...(kind === 'textContains' ? { text } : {}),
      idleMs: clamp(record.idleMs, DEFAULT_DOM_IDLE_MS, MIN_DOM_IDLE_MS, MAX_DOM_IDLE_MS),
      timeoutMs: clamp(record.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
    },
  };
}

export function describeWaitResult(condition: WaitCondition, outcome: WaitOutcome): string {
  if (!outcome.met) {
    return [
      `等待超时：${condition.timeoutMs}ms 内未满足条件（${describeCondition(condition)}），实际等待 ${outcome.elapsedMs}ms。`,
      '页面可能仍在加载，也可能是条件本身写错了。不要原样重试——先用 browser_get_form 或 browser_read_page 确认页面当前状态。',
    ].join('\n');
  }

  switch (condition.kind) {
    case 'appear':
      return `等待成功：选择器 "${condition.selector}" 已出现（匹配 ${outcome.matched ?? 0} 个元素），耗时 ${outcome.elapsedMs}ms。`;
    case 'disappear':
      return `等待成功：选择器 "${condition.selector}" 已消失，耗时 ${outcome.elapsedMs}ms。`;
    case 'textContains':
      return `等待成功：${condition.selector ? `"${condition.selector}" 内` : '页面上'}已出现文本 "${condition.text}"，耗时 ${outcome.elapsedMs}ms。`;
    case 'domIdle':
      return `等待成功：页面 DOM 已连续 ${condition.idleMs}ms 无变动，耗时 ${outcome.elapsedMs}ms。`;
  }
}

function describeCondition(condition: WaitCondition): string {
  switch (condition.kind) {
    case 'appear':
      return `等待 "${condition.selector}" 出现`;
    case 'disappear':
      return `等待 "${condition.selector}" 消失`;
    case 'textContains':
      return `等待文本 "${condition.text}" 出现`;
    case 'domIdle':
      return `等待 DOM 连续 ${condition.idleMs}ms 无变动`;
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/wait-condition.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 无输出、退出码 0。

- [ ] **Step 6: 提交**

```bash
git add lib/agent/wait-condition.ts lib/agent/wait-condition.test.ts
git commit -m "$(cat <<'EOF'
feat: browser_wait_for 的条件解析与结果文案

纯函数层：四种条件的参数校验与夹取（timeoutMs 上限 15s，防止一次盲等
吃掉整轮时间），以及给模型的结果文案。超时走 met:false 而不是抛异常，
文案里明确劝阻原样重试——否则模型会反复等同一个条件，每次一整轮往返。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 2: 注入页面的等待观察函数

**Files:**
- Create: `lib/agent/wait-dom.ts`
- Test: `lib/agent/wait-dom.dom.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WaitConditionKind`（仅 `import type`，编译期擦除，不违反注入约束）
- Produces:
  - `interface WaitForInput { kind: WaitConditionKind; selector?: string; text?: string; idleMs: number; timeoutMs: number }`
  - `interface WaitForOutput { met: boolean; elapsedMs: number; matched?: number; error?: string }`
  - `async function waitForConditionInPage(input: WaitForInput): Promise<WaitForOutput>`

**注意：** 测试文件名必须以 `.dom.test.ts` 结尾，否则会被 `unit` project（node 环境，无 DOM）捡走而不是 `dom` project。

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/wait-dom.dom.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForConditionInPage } from './wait-dom';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('waitForConditionInPage', () => {
  it('条件一开始就满足时立即返回，不等待', async () => {
    document.body.innerHTML = '<div class="result">ok</div>';
    const output = await waitForConditionInPage({
      kind: 'appear', selector: '.result', idleMs: 500, timeoutMs: 5000,
    });
    expect(output.met).toBe(true);
    expect(output.matched).toBe(1);
  });

  it('元素稍后出现时命中 appear', async () => {
    const promise = waitForConditionInPage({
      kind: 'appear', selector: '.late', idleMs: 500, timeoutMs: 3000,
    });
    setTimeout(() => {
      const node = document.createElement('div');
      node.className = 'late';
      document.body.append(node);
    }, 30);
    const output = await promise;
    expect(output.met).toBe(true);
    expect(output.matched).toBe(1);
  });

  it('元素被移除时命中 disappear', async () => {
    document.body.innerHTML = '<div class="spinner"></div>';
    const promise = waitForConditionInPage({
      kind: 'disappear', selector: '.spinner', idleMs: 500, timeoutMs: 3000,
    });
    setTimeout(() => document.querySelector('.spinner')?.remove(), 30);
    const output = await promise;
    expect(output.met).toBe(true);
    expect(output.matched).toBe(0);
  });

  it('文本出现时命中 textContains', async () => {
    document.body.innerHTML = '<main></main>';
    const promise = waitForConditionInPage({
      kind: 'textContains', selector: 'main', text: '已完成', idleMs: 500, timeoutMs: 3000,
    });
    setTimeout(() => {
      document.querySelector('main')!.textContent = '任务已完成';
    }, 30);
    const output = await promise;
    expect(output.met).toBe(true);
  });

  it('textContains 不给 selector 时在整个 body 里找', async () => {
    document.body.innerHTML = '<section>结果已就绪</section>';
    const output = await waitForConditionInPage({
      kind: 'textContains', text: '已就绪', idleMs: 500, timeoutMs: 3000,
    });
    expect(output.met).toBe(true);
  });

  it('DOM 停止变动后命中 domIdle', async () => {
    const promise = waitForConditionInPage({ kind: 'domIdle', idleMs: 120, timeoutMs: 5000 });
    // 先制造几次变动，再停下来：命中时间必须晚于最后一次变动
    for (const delay of [20, 60, 100]) {
      setTimeout(() => document.body.append(document.createElement('span')), delay);
    }
    const output = await promise;
    expect(output.met).toBe(true);
    expect(output.elapsedMs).toBeGreaterThanOrEqual(120);
  });

  it('条件始终不满足时超时返回 met:false，不抛异常', async () => {
    const output = await waitForConditionInPage({
      kind: 'appear', selector: '.never', idleMs: 500, timeoutMs: 200,
    });
    expect(output.met).toBe(false);
    expect(output.elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it('非法选择器返回 error 而不是抛异常', async () => {
    const output = await waitForConditionInPage({
      kind: 'appear', selector: ':::bad', idleMs: 500, timeoutMs: 200,
    });
    expect(output.met).toBe(false);
    expect(output.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/wait-dom.dom.test.ts`
Expected: FAIL，无法解析模块 `./wait-dom`。

- [ ] **Step 3: 写最小实现**

创建 `lib/agent/wait-dom.ts`：

```ts
// 注入页面执行的等待观察函数。
//
// ⚠️ 与 form-dom.ts 同一约束：这个函数会被 browser.scripting.executeScript
// 序列化后送进页面执行，函数体内不得引用任何模块作用域的绑定（本文件的其它
// 函数、常量、import 的值），否则在页面里一律是 undefined。所有配置通过
// input 参数传入。类型导入（import type）会被编译期擦除，不受此限制。
import type { WaitConditionKind } from './wait-condition';

export interface WaitForInput {
  kind: WaitConditionKind;
  selector?: string;
  text?: string;
  idleMs: number;
  timeoutMs: number;
}

export interface WaitForOutput {
  met: boolean;
  elapsedMs: number;
  matched?: number;
  error?: string;
}

export async function waitForConditionInPage(input: WaitForInput): Promise<WaitForOutput> {
  const startedAt = Date.now();
  // MutationObserver 只在有变动时唤醒；轮询是兜底——有些命中条件（例如
  // domIdle 的"够久没动"）本质上不由变动触发，而是由"没有变动"触发。
  const POLL_MS = 50;
  let lastMutationAt = Date.now();

  const check = (): { met: boolean; matched?: number; error?: string } => {
    try {
      if (input.kind === 'appear' || input.kind === 'disappear') {
        const matched = document.querySelectorAll(input.selector as string).length;
        return { met: input.kind === 'appear' ? matched > 0 : matched === 0, matched };
      }
      if (input.kind === 'textContains') {
        const scope = input.selector ? document.querySelector(input.selector) : document.body;
        if (!scope) return { met: false };
        // innerText 在注入的真实页面里更贴近"用户看得见的文本"；jsdom 没有实现
        // 它，会落到 textContent。两者对"文本是否出现"这个判断都够用。
        const text = (scope as HTMLElement).innerText ?? scope.textContent ?? '';
        return { met: text.includes(input.text as string) };
      }
      return { met: Date.now() - lastMutationAt >= input.idleMs };
    } catch (error) {
      return { met: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const immediate = check();
  if (immediate.error) return { met: false, elapsedMs: Date.now() - startedAt, error: immediate.error };
  // domIdle 不走快速路径：刚进来时 lastMutationAt 就是此刻，必然还没静止够久。
  if (immediate.met && input.kind !== 'domIdle') {
    return { met: true, elapsedMs: Date.now() - startedAt, matched: immediate.matched };
  }

  return new Promise<WaitForOutput>((resolve) => {
    let settled = false;
    const observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });

    const finish = (output: WaitForOutput) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(output);
    };

    const poll = setInterval(() => {
      const current = check();
      if (current.error) {
        finish({ met: false, elapsedMs: Date.now() - startedAt, error: current.error });
        return;
      }
      if (current.met) {
        finish({ met: true, elapsedMs: Date.now() - startedAt, matched: current.matched });
      }
    }, POLL_MS);

    const timer = setTimeout(() => {
      finish({ met: false, elapsedMs: Date.now() - startedAt });
    }, input.timeoutMs);
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/wait-dom.dom.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 无输出、退出码 0。

- [ ] **Step 6: 提交**

```bash
git add lib/agent/wait-dom.ts lib/agent/wait-dom.dom.test.ts
git commit -m "$(cat <<'EOF'
feat: 注入页面的等待观察函数

MutationObserver 负责在有变动时唤醒，50ms 轮询兜底——domIdle 这类条件
本质上由"没有变动"触发，观察器不会为它发通知。已经满足的条件走快速路径
立即返回（domIdle 除外：刚进来必然还没静止够久）。非法选择器返回 error
而不是抛异常，让上层能把它转成模型可修正的提示。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 3: 接线（消息类型 + background handler + 工具注册 + 权限分级）

**Files:**
- Modify: `lib/messaging.ts`（`MessageType` 联合类型，以及文件末尾的 payload/result 接口区）
- Modify: `entrypoints/background.ts`（`handleMessage` 的 switch，以及 handler 函数区）
- Modify: `lib/agent/tools.ts`（`createBrowserTools` 的工具数组 + 新增 `makeWaitForTool`）
- Modify: `lib/agent/permissions.ts:16-36`（`READ_ONLY_TOOL_NAMES`）
- Test: `lib/agent/wait-for-tool.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseWaitCondition` / `describeWaitResult` / `WaitCondition` / `WaitOutcome`；Task 2 的 `waitForConditionInPage` / `WaitForInput` / `WaitForOutput`
- Produces:
  - `lib/messaging.ts`：`'WAIT_FOR'` 加入 `MessageType`；`interface WaitForPayload extends WaitForInput`（结构相同，独立命名以免 messaging 反向依赖 agent 层）；`interface WaitForResult { met: boolean; elapsedMs: number; matched?: number; error?: string }`
  - `lib/agent/tools.ts`：工具 `browser_wait_for` 出现在 `createBrowserTools()` 返回的数组里

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/wait-for-tool.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');
const { READ_ONLY_TOOL_NAMES, AUTO_APPROVE_TOOL_NAMES, decideToolPermission } = await import('./permissions');

function getWaitForTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_wait_for');
  if (!tool) throw new Error('browser_wait_for 未注册');
  return tool;
}

beforeEach(() => {
  sendMessage.mockReset();
});

describe('browser_wait_for 工具', () => {
  it('已注册', () => {
    expect(getWaitForTool().name).toBe('browser_wait_for');
  });

  it('把解析后的条件发给当前操作 tab', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: true, elapsedMs: 300, matched: 2 } });
    await getWaitForTool().execute('call-1', { kind: 'appear', selector: '.result' });

    expect(sendMessage).toHaveBeenCalledWith(
      'WAIT_FOR',
      { kind: 'appear', selector: '.result', idleMs: 500, timeoutMs: 5000 },
      1,
    );
  });

  it('命中时回报匹配数量与耗时', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: true, elapsedMs: 300, matched: 2 } });
    const output = await getWaitForTool().execute('call-1', { kind: 'appear', selector: '.result' });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('.result');
    expect(text).toContain('2');
  });

  // 超时是一个正常结果，不是异常：模型需要知道"等过了、没等到"才能改变策略。
  it('超时不抛异常，而是返回劝阻重试的文案', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: false, elapsedMs: 5000 } });
    const output = await getWaitForTool().execute('call-1', { kind: 'appear', selector: '.never' });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('超时');
    expect(text).toContain('不要原样重试');
  });

  it('参数非法时在发消息之前就抛出', async () => {
    await expect(getWaitForTool().execute('call-1', { kind: 'appear' })).rejects.toThrow('selector');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('页面报告非法选择器时抛出，让模型修正', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { met: false, elapsedMs: 5, error: '选择器非法' } });
    await expect(
      getWaitForTool().execute('call-1', { kind: 'appear', selector: ':::bad' }),
    ).rejects.toThrow('选择器非法');
  });
});

describe('browser_wait_for 的权限分级', () => {
  it('属于只读工具，不属于写工具', () => {
    expect(READ_ONLY_TOOL_NAMES.has('browser_wait_for')).toBe(true);
    expect(AUTO_APPROVE_TOOL_NAMES.has('browser_wait_for')).toBe(false);
  });

  it('按只读工具直接放行', () => {
    expect(decideToolPermission('browser_wait_for', { kind: 'domIdle' })).toEqual({ level: 'always_allow' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/wait-for-tool.test.ts`
Expected: FAIL，`browser_wait_for 未注册`。

- [ ] **Step 3: 加消息类型**

在 `lib/messaging.ts` 的 `MessageType` 联合里，`'SCROLL_PAGE'` 之后加一行：

```ts
  | 'SCROLL_PAGE'
  | 'WAIT_FOR'
```

在 `ScrollPageResult` 接口之后加：

```ts
/**
 * browser_wait_for 的载荷。字段与 lib/agent/wait-dom.ts 的 WaitForInput 同构，
 * 但独立声明——messaging 是被 agent 层依赖的下层，不反向 import agent 模块。
 */
export interface WaitForPayload {
  kind: 'appear' | 'disappear' | 'textContains' | 'domIdle';
  selector?: string;
  text?: string;
  idleMs: number;
  timeoutMs: number;
}

export interface WaitForResult {
  met: boolean;
  elapsedMs: number;
  /** appear/disappear 命中时匹配到的元素数。 */
  matched?: number;
  /** 页面内错误（例如非法选择器）。 */
  error?: string;
}
```

- [ ] **Step 4: 加 background handler**

在 `entrypoints/background.ts` 顶部的 import 区，把 `WaitForPayload` / `WaitForResult` 加进从 `@/lib/messaging` 的 type 导入，并新增：

```ts
import { waitForConditionInPage } from '@/lib/agent/wait-dom';
```

在 `handleMessage` 的 switch 里，`case 'SCROLL_PAGE'` 之后加：

```ts
    case 'WAIT_FOR':
      return waitForCondition(message.payload as WaitForPayload, requireTabId(message));
```

在 `scrollPage` 函数附近新增 handler：

```ts
/**
 * 注入函数自己带超时，正常路径不会挂住；这里再加一层略长的兜底，是防注入上下文
 * 因导航被销毁而使 executeScript 的 promise 永远不结算。executeScript 本身的
 * 失败（页面已关闭、被 CSP 拒绝等）同样收敛成"没等到"，而不是让整轮任务报错——
 * 等待失败不该比等待超时更严重。
 */
async function waitForCondition(payload: WaitForPayload, tabId: number): Promise<WaitForResult> {
  const guardMs = payload.timeoutMs + 2000;
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<WaitForResult>((resolve) => {
    guardTimer = setTimeout(() => resolve({ met: false, elapsedMs: payload.timeoutMs }), guardMs);
  });

  try {
    return await Promise.race([
      executeInTab(tabId, payload, waitForConditionInPage).catch(
        (error): WaitForResult => ({
          met: false,
          elapsedMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      guard,
    ]);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}
```

同时把 `'WAIT_FOR'` 加进 `background.ts:120` 附近那个需要 tabId 的消息类型常量数组（与 `'SCROLL_PAGE'` 同列）。

- [ ] **Step 5: 注册工具**

在 `lib/agent/tools.ts` 顶部加导入：

```ts
import { describeWaitResult, parseWaitCondition } from './wait-condition';
```

并把 `WaitForPayload` / `WaitForResult` 加进从 `@/lib/messaging` 的 type 导入列表。

在 `createBrowserTools` 的 `tools` 数组里，`makeScrollTool(session),` 之后加一行：

```ts
    makeWaitForTool(session),
```

在 `makeScrollTool` 之后新增：

```ts
function makeWaitForTool(session: TabSessionController): BrowserAgentTool {
  return {
    name: 'browser_wait_for',
    label: 'Wait For',
    description:
      'Wait until the page satisfies a specific condition, then continue. Prefer this over the generic `wait` tool: blind fixed-duration waiting either stops too early (costing another full round-trip) or wastes wall-clock time. Conditions: appear/disappear (a CSS selector matches / stops matching), textContains (text shows up, optionally scoped to a selector), domIdle (no DOM mutation for idleMs — use this when you do not know which selector to watch for). A timeout is a normal result, not an error: it reports how long it waited so you can change strategy instead of retrying the same wait.',
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal('appear'),
        Type.Literal('disappear'),
        Type.Literal('textContains'),
        Type.Literal('domIdle'),
      ]),
      selector: Type.Optional(
        Type.String({ description: 'CSS selector. Required for appear and disappear; optional scope for textContains.' }),
      ),
      text: Type.Optional(Type.String({ description: 'Text to wait for. Required for textContains.' })),
      idleMs: Type.Optional(Type.Number({ description: 'For domIdle: how long the DOM must stay unchanged. 100-5000, defaults to 500.' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'Give up after this long. 500-15000, defaults to 5000.' })),
    }),
    execute: async (_toolCallId, params) => {
      const parsed = parseWaitCondition(params);
      if (!parsed.ok) throw new Error(parsed.error);

      const response = (await sendMessage<WaitForPayload, WaitForResult>(
        'WAIT_FOR',
        parsed.condition as WaitForPayload,
        session.currentTabId,
      )) as MessageResponse<WaitForResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '等待失败');
      // 非法选择器是模型可以修正的参数错误，值得抛出；超时不是。
      if (response.data.error) throw new Error(response.data.error);

      return textResult(
        describeWaitResult(parsed.condition, response.data),
        response.data as unknown as Record<string, unknown>,
      );
    },
  };
}
```

- [ ] **Step 6: 加权限分级**

在 `lib/agent/permissions.ts` 的 `READ_ONLY_TOOL_NAMES` 里，`'browser_get_form',` 之后加：

```ts
  // 只等待、不修改任何状态；因此不触发执行遮罩、不进写预算，但仍计入读预算。
  'browser_wait_for',
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/wait-for-tool.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 8: 跑全量测试与类型检查，确认没打破既有用例**

Run: `pnpm test && pnpm compile`
Expected: 全部 PASS，`pnpm compile` 无输出。

注意 `lib/final-review.test.ts` 会对工具名单做断言——若它以精确列表匹配而失败，把 `browser_wait_for` 补进去；若只是断言"不含 `browser_inject_script`"则不受影响。

- [ ] **Step 9: 提交**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts lib/agent/permissions.ts lib/agent/wait-for-tool.test.ts
git commit -m "$(cat <<'EOF'
feat: 注册 browser_wait_for 工具

WAIT_FOR 消息 + background handler + 工具注册 + 只读分级。handler 在注入
函数自带的超时之外再加一层兜底，防注入上下文因导航被销毁而永不结算；
executeScript 本身的失败也收敛成"没等到"，等待失败不该比等待超时更严重。

非法选择器抛出（模型能修正），超时不抛（模型需要据此改变策略）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 4: 提示词引导与活动步骤文案

**Files:**
- Modify: `lib/agent/system-prompt.ts:173-196`（`buildToolStrategy`）
- Modify: `lib/agent/activity-description.ts`（`wait` case 附近）
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `lib/agent/system-prompt.test.ts`（若不存在则创建）

**Interfaces:**
- Consumes: Task 3 注册好的 `browser_wait_for`
- Produces: 无新导出；只改文案与提示词内容

**为什么这个任务不能省：** 工具存在但模型不知道该优先用它，等于没加。现有 `buildToolStrategy` 没有任何关于等待的引导，模型会继续走 `wait(N)` 的老路。

- [ ] **Step 1: 写失败的测试**

`lib/agent/system-prompt.test.ts` 已存在，追加下面的 describe 块（`buildSystemPrompt` 的 import 按需补上）：

```ts
describe('等待策略引导', () => {
  it('提示词让模型优先用 browser_wait_for 而不是盲等', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('browser_wait_for');
    expect(prompt).toContain('wait');
  });
});
```

同时在 `lib/i18n/i18n.test.ts` 的既有用例之外确认中英词典键一致（该文件通常已有此类校验；若有，新增的键会被它自动覆盖，无需另写用例）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/system-prompt.test.ts`
Expected: FAIL，提示词中不含 `browser_wait_for`。

- [ ] **Step 3: 改提示词**

在 `lib/agent/system-prompt.ts` 的 `buildToolStrategy` 里，`'- 需要确认某个元素实际生效的样式：用 browser_get_computed_style。'` 之后加一行：

```ts
    '- 点击、提交或跳转之后内容还没加载出来：用 browser_wait_for 等具体条件（等元素出现用 appear、等 loading 消失用 disappear、等文本出现用 textContains、不知道等什么就用 domIdle）。不要用 wait 盲等固定秒数——等少了要多花一整轮重试，等多了纯属浪费。',
```

- [ ] **Step 4: 加活动步骤文案**

在 `lib/agent/activity-description.ts` 的 `case 'wait': { ... }` 之后加：

```ts
    case 'browser_wait_for': {
      const kind = str('kind');
      const target = str('selector') || str('text') || kind;
      return withTarget(
        status,
        'agentActivity.now.waitFor',
        'agentActivity.done.waitFor',
        'agentActivity.failed.waitFor',
        target,
      );
    }
```

在 `lib/i18n/locales/zh.ts` 的 `'agentActivity.now.scrollTo'` 附近加：

```ts
  'agentActivity.now.waitFor': '正在等待 "{target}"',
  'agentActivity.done.waitFor': '已等待 "{target}"',
  'agentActivity.failed.waitFor': '等待 "{target}" 失败',
```

在 `lib/i18n/locales/en.ts` 对应位置加：

```ts
  'agentActivity.now.waitFor': 'Waiting for "{target}"',
  'agentActivity.done.waitFor': 'Waited for "{target}"',
  'agentActivity.failed.waitFor': 'Failed waiting for "{target}"',
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/system-prompt.test.ts lib/i18n/i18n.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量验证**

Run: `pnpm test && pnpm compile`
Expected: 全部 PASS，`pnpm compile` 无输出。

- [ ] **Step 7: 真机验证**

Run: `pnpm build`

然后从 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序，选 `.output/chrome-mv3`。打开一个内容异步加载的页面（例如任意搜索结果页），在侧边栏让 agent 做一次"点击搜索后等结果出现再总结"的任务，确认活动步骤里出现"正在等待 …"且没有退化成 `wait(N)`。

- [ ] **Step 8: 提交**

```bash
git add lib/agent/system-prompt.ts lib/agent/activity-description.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts lib/agent/system-prompt.test.ts
git commit -m "$(cat <<'EOF'
feat: browser_wait_for 的提示词引导与活动步骤文案

工具存在但模型不知道该优先用它，等于没加：buildToolStrategy 里明确写出
四种条件各自的适用场景，并点名劝阻 wait 盲等。补上面板活动步骤的中英文案。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

## 完成标准

- `pnpm test` 全绿，`pnpm compile` 无输出。
- `createBrowserTools()` 返回的数组包含 `browser_wait_for`。
- `decideToolPermission('browser_wait_for', ...)` 返回 `always_allow`。
- 系统提示词包含优先使用 `browser_wait_for` 的引导。
- 真机上一次异步加载任务能走通，活动步骤显示等待条件。
