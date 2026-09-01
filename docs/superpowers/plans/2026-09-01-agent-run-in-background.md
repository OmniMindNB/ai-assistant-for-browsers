# Agent 主循环迁移到 Background 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent 的执行（`Agent` 实例 + `agent.prompt()` 驱动的流式请求/工具循环）从 `entrypoints/sidepanel/store.ts` 迁移到 `entrypoints/background.ts`（service worker），使正在运行的任务不再因为侧边栏文档被 Chrome 销毁（切标签页、手动关闭面板）而丢失。

**Architecture:** `entrypoints/background.ts` 里新增 `Map<tabId, RunState>`（`lib/agent/run-registry.ts`）持有 `Agent` 实例并驱动其生命周期；面板改为通过 `browser.runtime.connect` 建立的持久 Port 连接推送/接收状态，退化成一个只订阅、只转发用户操作的薄 UI；`chrome.alarms` 在 run 进行期间保活 service worker；一份镜像到 `browser.storage.session` 的运行态快照，让面板重连时能立即重建 UI，也让 service worker 意外冷启动后能把"曾经在跑"的孤儿 run 判定为明确的 `failure`，而不是让用户永远面对一个转不动的圈。

**Tech Stack:** TypeScript, WXT (Manifest V3), `@earendil-works/pi-agent-core`（已打 patch，参见 `patches/`），Zustand，Dexie，Vitest（`unit`/`ui`/`dom` 三个 project，见 `vitest.config.ts`）。

**Spec:** `docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md`

## Global Constraints

- Port 名称固定为常量 `AGENT_RUN_PORT_NAME = 'agent-run'`（spec §4）。
- 会话消息（Dexie）改为在每个 `message_end` 事件时增量落盘，不是只在整轮结束时（spec §5）。不对 `text_delta` 逐 token 落盘。
- 运行中状态（activitySteps/pendingConfirmation/pendingQuestion/busy）镜像到 `browser.storage.session`，键前缀 `runi:agent-run:`（spec §5）。
- `chrome.alarms` 保活周期 ~20s，只在有 run 处于 in-flight 或阻塞等待确认时注册，run 结束即清除（spec §5）。这次要求新增 `"alarms"` manifest 权限（`wxt.config.ts` 当前没有）。
- 冷启动孤儿检测（spec §5.2）只解决"service worker 彻底死过一次"场景，不做真正的断点续跑——这是已披露的已知限制，不是本计划的疏漏。
- `lib/agent/agent.ts`、`lib/agent/tools.ts`、`lib/agent/permissions.ts`、`lib/agent/confirm-gate.ts`、`lib/agent/tool-policy.ts`、表单层、`tab-session.ts`/`tab-session-storage.ts`、`agent-overlay.ts`/`tab-overlay-state.ts` **不改动接口**，只改调用方（spec §6）。
- §7 提到的 `tools.ts` 直连改造（去掉自寻址 `sendMessage`）**不在本计划范围内**，留作独立后续 PR。
- 所有面向用户的文案（`t(...)`）保留 i18n 正确性：由于 `describeToolActivity`/`describeEmptyAgentRun` 等格式化函数整体迁移进 background 之后，background 自己的 `currentLocale`（`lib/i18n/index.tsx` 模块级单例，与面板的是两份独立实例）必须显式与 `chrome.storage.local` 里的用户语言偏好同步（本计划 Task 5 处理），否则这些文案会用错语言。

---

## File Structure

新增：
- `lib/agent/run-port-protocol.ts` — 面板 ↔ background 的 Port 消息类型 + Port 名称常量 + `PendingConfirmation`/`PendingQuestion` 类型（从 `store.ts` 移过来，因为现在是跨上下文契约，不该只属于面板）。
- `lib/agent/run-state-storage.ts` — 运行态快照读写 `browser.storage.session`（镜像 `tab-session-storage.ts`）。
- `lib/agent/run-registry.ts` — 核心编排：`Map<tabId, RunState>`、`startRun`/`respondConfirm`/`respondQuestion`/`stopRun`/`attachPort`/`detachPort`、alarm 保活、冷启动孤儿扫描。承接原来 `store.ts` 里"驱动 Agent 并解读其输出"的那部分逻辑（`toAgentMessages`/`extractLastAssistantText`/`findLastAssistant`/`describeEmptyAgentRun`/`isNetworkFetchError`/`compactJson`/`isToolGuardBlockResult`）。

修改：
- `wxt.config.ts` — manifest 加 `"alarms"` 权限。
- `lib/i18n/index.tsx` — `applyLocale` 加 `document` 存在性判断，使其在 service worker 里可安全调用。
- `entrypoints/background.ts` — 新增 `onConnect` 监听、启动时的孤儿扫描、启动时与 storage.onChanged 触发的 locale 同步。
- `entrypoints/sidepanel/store.ts` — 大幅精简：删除 `Agent` 实例化/`agent.subscribe`/`agent.prompt()`/`finally` 里的持久化及一整批只用于解读 Agent 输出的私有函数；新增 Port 客户端；`stop`/`respondToConfirmation`/`respondToQuestion` 改为发 Port 消息。

不改：`lib/agent/agent.ts`、`lib/agent/tools.ts`、`lib/agent/permissions.ts`、`lib/agent/confirm-gate.ts`、`lib/agent/tool-policy.ts`、`lib/agent/tab-session.ts`、`lib/agent/tab-session-storage.ts`、`lib/agent/agent-overlay.ts`、`lib/agent/tab-overlay-state.ts`、`lib/agent/activity-description.ts`、`lib/agent/confirm-summary.ts`、`lib/agent/activity-steps.ts`、`lib/db.ts`、`lib/chat/messages.ts`。

---

### Task 1: Port 协议类型 + 运行态 storage.session 持久化

**Files:**
- Create: `lib/agent/run-port-protocol.ts`
- Create: `lib/agent/run-state-storage.ts`
- Test: `lib/agent/run-state-storage.test.ts`

**Interfaces:**
- Produces: `AGENT_RUN_PORT_NAME`、`PendingConfirmation`、`PendingQuestion`、`RunSnapshot`、`PanelToBackground`（`HelloMessage | StartRunRequest | RespondConfirmMessage | RespondQuestionMessage | StopMessage`）、`BackgroundToPanel`（`SnapshotMessage | OrphanResolvedMessage`）；`loadRunStateSnapshot(tabId)`、`saveRunStateSnapshot(tabId, snapshot)`、`clearRunStateSnapshot(tabId)`、`listOrphanRunTabIds()`。

- [ ] **Step 1: 写 `lib/agent/run-port-protocol.ts`**

```ts
// 面板 <-> background 的持久连接（browser.runtime.connect）消息协议。
// 与 lib/messaging.ts 的一次性 sendMessage/响应模型是两套独立机制：那套服务请求-响应，
// 这套服务 background 主动推送的运行态更新（ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md §4）。
import type { ChatMessage } from '@/lib/chat/messages';
import type { ActivityStep } from './activity-steps';
import type { ProviderConfig } from '@/lib/settings';
import type { ImageContent } from '@earendil-works/pi-ai';

export const AGENT_RUN_PORT_NAME = 'agent-run';

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  summary: string;
  codePreview?: string;
}

export interface PendingQuestion {
  toolCallId: string;
  question: string;
}

/** 面板 -> background：挂载/重连时的握手，声明自己绑定的 tabId。 */
export interface HelloMessage {
  type: 'hello';
  tabId: number;
}

/** 面板 -> background：发起一轮新的 agent 运行。tabId 已有存活 run 时，background 先中止旧的再开始新的。 */
export interface StartRunRequest {
  type: 'startRun';
  tabId: number;
  conversationId: string;
  provider: ProviderConfig;
  systemPrompt: string;
  withoutBrowserTools?: boolean;
  /** 提交前的历史（面板已完成截断/编辑逻辑），不含本轮新增的用户消息和占位 assistant。 */
  historyMessages: ChatMessage[];
  /** 本轮用户消息的最终展示形态（含 quotedText/attachments）。 */
  displayMessage: ChatMessage;
  agentUserContent: string;
  images?: ImageContent[];
  readToolCallBudget: number;
  writeToolCallBudget: number;
}

export interface RespondConfirmMessage {
  type: 'respondConfirm';
  tabId: number;
  toolCallId: string;
  approved: boolean;
}

export interface RespondQuestionMessage {
  type: 'respondQuestion';
  tabId: number;
  toolCallId: string;
  answer: string;
}

export interface StopMessage {
  type: 'stop';
  tabId: number;
}

export type PanelToBackground =
  | HelloMessage
  | StartRunRequest
  | RespondConfirmMessage
  | RespondQuestionMessage
  | StopMessage;

/** background 侧运行态的完整快照——格式化好、可以直接渲染，面板不做任何 i18n/文案拼接。 */
export interface RunSnapshot {
  tabId: number;
  busy: boolean;
  messages: ChatMessage[];
  activitySteps: ActivityStep[];
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
}

export interface SnapshotMessage extends RunSnapshot {
  type: 'snapshot';
}

/** 冷启动发现的孤儿 run（见 run-registry.ts 的 scanForOrphans）：这条 tabId 没有存活的 run，
 * 但上次 service worker 死掉时还标着"在跑"。background 已经把 failure 消息写进 Dexie，
 * 这里只是把最终消息数组同步给面板，不需要面板自己再去读一次 Dexie。 */
export interface OrphanResolvedMessage {
  type: 'orphanResolved';
  tabId: number;
  messages: ChatMessage[];
}

export type BackgroundToPanel = SnapshotMessage | OrphanResolvedMessage;
```

- [ ] **Step 2: 写 `lib/agent/run-state-storage.ts` 和它的失败测试**

先写测试 `lib/agent/run-state-storage.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadRunStateSnapshot,
  saveRunStateSnapshot,
  clearRunStateSnapshot,
  listOrphanRunTabIds,
} from './run-state-storage';
import type { RunSnapshot } from './run-port-protocol';

const store = new Map<string, unknown>();

beforeEach(() => {
  store.clear();
  (globalThis as any).browser = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        }),
        remove: vi.fn(async (key: string) => {
          store.delete(key);
        }),
        // 冷启动扫描要枚举所有 runi:agent-run:* 键，模拟 get(null) 返回全部
        getAll: undefined,
      },
    },
  };
  // browser.storage.session.get(null) 在真实 Chrome 里返回全部条目；polyfill 下同样支持传 null。
  (globalThis as any).browser.storage.session.get = vi.fn(async (key: unknown) => {
    if (key === null) return Object.fromEntries(store.entries());
    return { [key as string]: store.get(key as string) };
  });
});

function makeSnapshot(tabId: number): RunSnapshot {
  return {
    tabId,
    busy: true,
    messages: [],
    activitySteps: [],
    pendingConfirmation: null,
    pendingQuestion: null,
  };
}

describe('run-state-storage', () => {
  it('round-trips a snapshot for a tab', async () => {
    await saveRunStateSnapshot(7, makeSnapshot(7));
    const loaded = await loadRunStateSnapshot(7);
    expect(loaded).toEqual(makeSnapshot(7));
  });

  it('returns undefined for a tab with no saved snapshot', async () => {
    expect(await loadRunStateSnapshot(999)).toBeUndefined();
  });

  it('clears a snapshot', async () => {
    await saveRunStateSnapshot(7, makeSnapshot(7));
    await clearRunStateSnapshot(7);
    expect(await loadRunStateSnapshot(7)).toBeUndefined();
  });

  it('lists tabIds with a saved snapshot for orphan scanning', async () => {
    await saveRunStateSnapshot(7, makeSnapshot(7));
    await saveRunStateSnapshot(12, makeSnapshot(12));
    expect((await listOrphanRunTabIds()).sort()).toEqual([7, 12]);
  });

  it('write failure degrades silently (quota exceeded etc.)', async () => {
    (globalThis as any).browser.storage.session.set = vi.fn(async () => {
      throw new Error('QUOTA_BYTES exceeded');
    });
    await expect(saveRunStateSnapshot(7, makeSnapshot(7))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/run-state-storage.test.ts`
Expected: FAIL，`Cannot find module './run-state-storage'`。

- [ ] **Step 4: 实现 `lib/agent/run-state-storage.ts`**

```ts
// 运行中状态（activitySteps/pendingConfirmation/pendingQuestion/busy）的跨上下文持久化。
// 写法镜像 lib/agent/tab-session-storage.ts：存 browser.storage.session（而非模块级变量），
// 因为 service worker 会被 Chrome 回收，模块级变量活不过这次回收；storage.session 是
// session 级、不落盘，能跨这次回收存活，浏览器重启后自动清空
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md §5）。
import type { RunSnapshot } from './run-port-protocol';

const KEY_PREFIX = 'runi:agent-run:';

function storageKey(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

export async function loadRunStateSnapshot(tabId: number): Promise<RunSnapshot | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as RunSnapshot | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，这一次状态就当没同步。 */
export async function saveRunStateSnapshot(tabId: number, snapshot: RunSnapshot): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: snapshot });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearRunStateSnapshot(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}

/** 冷启动孤儿扫描用：枚举所有仍留有运行态快照的 tabId。 */
export async function listOrphanRunTabIds(): Promise<number[]> {
  const all = await browser.storage.session.get(null);
  return Object.keys(all)
    .filter((key) => key.startsWith(KEY_PREFIX))
    .map((key) => Number(key.slice(KEY_PREFIX.length)))
    .filter((tabId) => Number.isFinite(tabId));
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/run-state-storage.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 6: 类型检查**

Run: `pnpm compile`
Expected: 无新增错误（`run-port-protocol.ts` 目前还没有消费方之外的引用，`ProviderConfig`/`ImageContent`/`ChatMessage`/`ActivityStep` 均已存在对应导出）。

- [ ] **Step 7: Commit**

```bash
git add lib/agent/run-port-protocol.ts lib/agent/run-state-storage.ts lib/agent/run-state-storage.test.ts
git commit -m "feat: agent run 的 Port 协议类型与运行态持久化"
```

---

### Task 2: `run-registry.ts` —— RunState 核心与 startRun happy path

**Files:**
- Create: `lib/agent/run-registry.ts`
- Test: `lib/agent/run-registry.test.ts`

**Interfaces:**
- Consumes: `AGENT_RUN_PORT_NAME`/`RunSnapshot`/`PendingConfirmation`/`PendingQuestion`/`StartRunRequest`（Task 1）；`createBrowserAgent`（`lib/agent/agent.ts`，签名不变）；`ChatMessage`/`toMessageRecords`/`conversationTitle`（`lib/chat/messages.ts`）；`replaceConversationMessages`（`lib/db.ts`）；`createTabSession`/`loadTabSession`/`saveTabSession`（`lib/agent/tab-session.ts`、`lib/agent/tab-session-storage.ts`）；`summarizeToolCallForConfirmation`（`lib/agent/confirm-summary.ts`）；`describeToolActivity`（`lib/agent/activity-description.ts`）；`upsertActivityStep`/`finishActivityStep`（`lib/agent/activity-steps.ts`）；`t`（`lib/i18n`）。
- Produces（本任务内实现，Task 3/4 继续扩展同一个模块）：`startRun(request: StartRunRequest, ports: PortRegistry): Promise<void>`（不 await 到轮次结束——内部把 `agent.prompt()` 作为不等待的异步任务发出去，函数本身在 `RunState` 建好、初始快照落盘后就返回）；导出的 `getRunState(tabId): RunState | undefined` 供 Task 3 使用。

`StartRunRequest` 里没有携带一个"端口注册表"的概念；本任务先把 `attachPort`/推送逻辑抽成一个最小接口 `PortRegistry`（Task 3 会给出真正实现，这里先用一个测试替身）：

```ts
export interface PortRegistry {
  /** 把一份快照推给这个 tabId 当前挂着的 Port；没有挂 Port 时是no-op。 */
  push(tabId: number, snapshot: RunSnapshot): void;
}
```

- [ ] **Step 1: 写失败测试（覆盖 happy path：启动 → 流式文本 → 工具调用 → 结束并落盘）**

```ts
// lib/agent/run-registry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBrowserAgent: vi.fn(),
  replaceConversationMessages: vi.fn(async () => undefined),
  loadTabSession: vi.fn(async (tabId: number) => ({ panelTabId: tabId, currentTabId: tabId, trackedTabs: [], snapshot: () => ({}) })),
  saveTabSession: vi.fn(async () => undefined),
}));

vi.mock('./agent', () => ({ createBrowserAgent: mocks.createBrowserAgent }));
vi.mock('@/lib/db', () => ({ replaceConversationMessages: mocks.replaceConversationMessages }));
vi.mock('./tab-session-storage', () => ({
  loadTabSession: mocks.loadTabSession,
  saveTabSession: mocks.saveTabSession,
}));
vi.mock('./run-state-storage', () => ({
  saveRunStateSnapshot: vi.fn(async () => undefined),
  clearRunStateSnapshot: vi.fn(async () => undefined),
  loadRunStateSnapshot: vi.fn(async () => undefined),
  listOrphanRunTabIds: vi.fn(async () => []),
}));

import { startRun, getRunState } from './run-registry';
import type { StartRunRequest } from './run-port-protocol';

function makeFakeAgent(events: unknown[]) {
  let listener: ((event: unknown) => void) | undefined;
  return {
    subscribe: vi.fn((fn: (event: unknown) => void) => {
      listener = fn;
      return () => { listener = undefined; };
    }),
    prompt: vi.fn(async () => {
      for (const event of events) listener?.(event);
    }),
    abort: vi.fn(),
    state: { messages: [] },
  };
}

function makeRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    type: 'startRun',
    tabId: 7,
    conversationId: 'conv-1',
    provider: { id: 'p1', name: 'p1', baseURL: 'https://x', apiKey: 'k', model: 'm' } as never,
    systemPrompt: 'sys',
    historyMessages: [],
    displayMessage: { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
    agentUserContent: 'hi',
    readToolCallBudget: 12,
    writeToolCallBudget: 24,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.createBrowserAgent.mockReset();
  mocks.replaceConversationMessages.mockClear();
});

describe('run-registry startRun', () => {
  it('creates a RunState, persists the initial history immediately, and streams text into the last assistant message', async () => {
    const agent = makeFakeAgent([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
    ]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    const pushed: unknown[] = [];
    const ports = { push: (_tabId: number, snapshot: unknown) => pushed.push(snapshot) };

    await startRun(makeRequest(), ports);
    // startRun 不等待 agent.prompt() 跑完再返回；这里等一次微任务队列排空，
    // 让 fire-and-forget 的 prompt() 内部同步触发的事件先落地。
    await vi.waitFor(() => expect(mocks.replaceConversationMessages).toHaveBeenCalled());

    // 第一次落盘（startRun 内，agent.prompt 之前）必须已经包含用户消息，
    // 这正是本次迁移要修的 bug：用户消息不能只等到轮次结束才落盘。
    const firstCallMessages = mocks.replaceConversationMessages.mock.calls[0][1];
    expect(firstCallMessages.some((m: { role: string; content: string }) => m.role === 'user' && m.content === 'hi')).toBe(true);

    const state = getRunState(7);
    expect(state?.busy).toBe(false);
    const lastMessage = state?.messages[state.messages.length - 1];
    expect(lastMessage?.content).toBe('Hello');
  });

  it('aborts an existing run for the same tab before starting a new one', async () => {
    const firstAgent = makeFakeAgent([]);
    const secondAgent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValueOnce(firstAgent).mockReturnValueOnce(secondAgent);
    const ports = { push: () => undefined };

    await startRun(makeRequest(), ports);
    await startRun(makeRequest({ conversationId: 'conv-2', displayMessage: { id: 'u2', role: 'user', content: 'again', createdAt: 2 } }), ports);

    expect(firstAgent.abort).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: FAIL，`Cannot find module './run-registry'`。

- [ ] **Step 3: 实现 `lib/agent/run-registry.ts`（happy path 部分）**

这一步把原来 `store.ts` 里 `runAgent` 从 `createBrowserAgent(...)` 到 `agent.subscribe` 回调、到 `agent.prompt()` 结束的那部分逻辑整体搬过来，行为对齐（活动步骤、文本节流累积、任务结果、导航监听全部保留），区别只有两处：调用方从"面板发消息触发"变成"接收 `StartRunRequest`"，以及落盘从"整轮结束才存一次"改成"收到用户消息就先存一次、之后每个 `message_end` 再存一次"。

```ts
// lib/agent/run-registry.ts
// agent 运行的核心编排：一个 tabId 同一时刻最多一个 RunState，Agent 实例、活动步骤、
// pending confirmation/question 全部在这里，不再依赖侧边栏面板文档的生命周期
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md）。
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message as AgentLlmMessage } from '@earendil-works/pi-ai';
import { createBrowserAgent } from './agent';
import { createTabSession, type TabSessionController } from './tab-session';
import { loadTabSession, saveTabSession } from './tab-session-storage';
import { summarizeToolCallForConfirmation } from './confirm-summary';
import { describeToolActivity } from './activity-description';
import { upsertActivityStep, finishActivityStep, type ActivityStep } from './activity-steps';
import { replaceConversationMessages } from '@/lib/db';
import { conversationTitle, toMessageRecords, type ChatMessage } from '@/lib/chat/messages';
import { t } from '@/lib/i18n';
import type { TaskOutcome } from './task-outcome';
import type {
  PendingConfirmation,
  PendingQuestion,
  RunSnapshot,
  StartRunRequest,
} from './run-port-protocol';
import { saveRunStateSnapshot, clearRunStateSnapshot } from './run-state-storage';
import { setOverlayForTab, clearOverlayForTab } from './tab-overlay-state';
import { sendToContentScript } from './content-script-messaging';
import { newMessageId, type SetAgentOverlayPayload } from '@/lib/messaging';

export interface PortRegistry {
  push(tabId: number, snapshot: RunSnapshot): void;
}

interface RunState {
  tabId: number;
  conversationId: string;
  agent: Agent;
  session: TabSessionController;
  messages: ChatMessage[];
  activitySteps: ActivityStep[];
  busy: boolean;
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
  resolveConfirmation: ((approved: boolean) => void) | null;
  resolveQuestion: ((answer: string) => void) | null;
  pendingToolArgs: Map<string, { toolName: string; args: unknown }>;
  terminatedToolCallIds: Set<string>;
  taskOutcome: TaskOutcome | null;
}

const runs = new Map<number, RunState>();

export function getRunState(tabId: number): RunState | undefined {
  return runs.get(tabId);
}

function snapshotOf(state: RunState): RunSnapshot {
  return {
    tabId: state.tabId,
    busy: state.busy,
    messages: state.messages,
    activitySteps: state.activitySteps,
    pendingConfirmation: state.pendingConfirmation,
    pendingQuestion: state.pendingQuestion,
  };
}

function pushAndPersist(state: RunState, ports: PortRegistry): void {
  const snapshot = snapshotOf(state);
  ports.push(state.tabId, snapshot);
  void saveRunStateSnapshot(state.tabId, snapshot);
}

async function persistMessages(state: RunState): Promise<void> {
  await replaceConversationMessages(
    state.conversationId,
    toMessageRecords(state.conversationId, state.messages),
    conversationTitle(state.messages),
  ).catch((e: unknown) => console.error('[Runi] 持久化会话失败', e));
}

function toAgentMessages(messages: ChatMessage[]): AgentLlmMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content, timestamp: message.createdAt };
    }
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
      api: 'openai-completions',
      provider: 'history',
      model: 'history',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: message.createdAt,
    } satisfies AssistantMessage;
  });
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    return content
      .filter((part): part is { type: 'text'; text: string } => Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'))
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

interface LastAssistantInfo {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

function findLastAssistant(messages: unknown[]): LastAssistantInfo | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    return message as LastAssistantInfo;
  }
  return undefined;
}

function isNetworkFetchError(reason: string): boolean {
  return /failed to fetch|network ?error|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET_DISCONNECTED|NETWORK_CHANGED)/i.test(reason);
}

function describeEmptyAgentRun(last: LastAssistantInfo | undefined): string {
  if (last?.stopReason === 'error') {
    const reason = last.errorMessage || t('store.unknownError');
    if (isNetworkFetchError(reason)) return t('store.modelCallNetworkError', { reason });
    return t('store.modelCallFailed', { reason });
  }
  if (last?.stopReason === 'length') return t('store.tokenLimitReached');
  if (last?.stopReason === 'aborted') return t('store.generationAborted');
  const onlyToolCalls =
    Array.isArray(last?.content) && last.content.length > 0 &&
    last.content.every((part) => (part as { type?: unknown })?.type === 'toolCall');
  if (onlyToolCalls) return t('store.onlyToolCalls');
  return t('store.noTextResult');
}

function replaceLastAssistant(state: RunState, content: string): void {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;
  state.messages = [...state.messages.slice(0, -1), { ...last, content }];
}

const STREAM_FLUSH_INTERVAL_MS = 48;

export async function startRun(request: StartRunRequest, ports: PortRegistry): Promise<void> {
  const existing = runs.get(request.tabId);
  if (existing) {
    existing.agent.abort();
    runs.delete(request.tabId);
  }

  const session = await loadTabSession(request.tabId).catch(() => createTabSession(request.tabId));
  const placeholder: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', createdAt: Date.now() };
  const state: RunState = {
    tabId: request.tabId,
    conversationId: request.conversationId,
    agent: null as unknown as Agent, // 下面立刻赋值；先占位是因为 onConfirm/onAskUser 闭包要引用 state
    session,
    messages: [...request.historyMessages, request.displayMessage, placeholder],
    activitySteps: [],
    busy: true,
    pendingConfirmation: null,
    pendingQuestion: null,
    resolveConfirmation: null,
    resolveQuestion: null,
    pendingToolArgs: new Map(),
    terminatedToolCallIds: new Set(),
    taskOutcome: null,
  };
  runs.set(request.tabId, state);

  // 用户消息必须在这里、agent.prompt() 开始之前就落盘——这正是本次迁移要修的
  // bug：过去只在整轮结束的 finally 里持久化一次，面板中途被销毁时刚发出去的
  // 用户消息会跟着丢。
  await persistMessages(state);
  pushAndPersist(state, ports);

  const onConfirm = async (toolCallId: string, toolName: string, args: unknown): Promise<boolean> => {
    const { summary, codePreview } = summarizeToolCallForConfirmation(toolName, args, undefined);
    state.pendingToolArgs.set(toolCallId, { toolName, args });
    state.pendingConfirmation = { toolCallId, toolName, summary, codePreview };
    pushAndPersist(state, ports);
    return new Promise<boolean>((resolve) => { state.resolveConfirmation = resolve; });
  };

  const onAskUser = async (toolCallId: string, question: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) return '';
    state.pendingQuestion = { toolCallId, question };
    pushAndPersist(state, ports);
    return new Promise<string>((resolve) => { state.resolveQuestion = resolve; });
  };

  const agent = createBrowserAgent({
    provider: request.provider,
    tabId: request.tabId,
    session,
    systemPrompt: request.systemPrompt,
    tools: request.withoutBrowserTools ? [] : undefined,
    messages: toAgentMessages(request.historyMessages),
    readToolCallBudget: request.readToolCallBudget,
    writeToolCallBudget: request.writeToolCallBudget,
    onConfirm,
    onAskUser,
    onOverlay: (payload, targetTabId) => {
      void sendAgentOverlay(payload, targetTabId);
    },
    onSessionChange: (updated) => { void saveTabSession(updated).catch(() => undefined); },
    onTaskOutcome: (outcome) => { state.taskOutcome = outcome; },
  });
  state.agent = agent;

  let acc = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    replaceLastAssistant(state, acc);
    pushAndPersist(state, ports);
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      acc += event.assistantMessageEvent.delta;
      if (flushTimer === null) flushTimer = setTimeout(flush, STREAM_FLUSH_INTERVAL_MS);
    }

    if (event.type === 'tool_execution_start' && !state.terminatedToolCallIds.has(event.toolCallId)) {
      state.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
      });
      pushAndPersist(state, ports);
    }

    if (event.type === 'tool_execution_update' && !state.terminatedToolCallIds.has(event.toolCallId)) {
      state.pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      const existingStep = state.activitySteps.find((step) => step.id === event.toolCallId);
      state.activitySteps = upsertActivityStep(state.activitySteps, {
        id: event.toolCallId,
        description: describeToolActivity(event.toolName, event.args, 'running'),
        status: 'running',
        slow: existingStep?.slow,
      });
      pushAndPersist(state, ports);
    }

    if (event.type === 'tool_execution_end') {
      const info = state.pendingToolArgs.get(event.toolCallId);
      state.pendingToolArgs.delete(event.toolCallId);
      if (!state.terminatedToolCallIds.has(event.toolCallId)) {
        const finalStatus = event.isError ? 'failed' : 'done';
        state.activitySteps = finishActivityStep(
          state.activitySteps,
          event.toolCallId,
          finalStatus,
          describeToolActivity(event.toolName, info?.args, finalStatus),
        );
        pushAndPersist(state, ports);
      }
    }

    if (event.type === 'message_end') {
      void persistMessages(state);
    }
  });

  try {
    await agent.prompt(request.agentUserContent, request.images);
    if (!acc.trim()) {
      const last = findLastAssistant(agent.state.messages);
      acc = extractLastAssistantText(agent.state.messages) || describeEmptyAgentRun(last);
    }
    replaceLastAssistant(state, acc);
  } catch (e) {
    console.error('[Runi] agent.prompt 异常', e);
  } finally {
    unsubscribe();
    if (flushTimer !== null) clearTimeout(flushTimer);
    if (state.taskOutcome) {
      const last = state.messages[state.messages.length - 1];
      if (last) state.messages = [...state.messages.slice(0, -1), { ...last, taskOutcome: state.taskOutcome }];
    }
    state.busy = false;
    state.activitySteps = [];
    state.pendingConfirmation = null;
    state.pendingQuestion = null;
    await persistMessages(state);
    pushAndPersist(state, ports);
    await clearRunStateSnapshot(state.tabId).catch(() => undefined);
    if (runs.get(state.tabId) === state) runs.delete(state.tabId);
  }
}

// 遮罩的真正落地逻辑（entrypoints/background.ts 里的 setAgentOverlay）本身就只是拼装
// 两个 lib 级原语：tab-overlay-state.ts 的 setOverlayForTab/clearOverlayForTab（写
// storage.session）和 content-script-messaging.ts 的 sendToContentScript（推给内容脚本
// 渲染）。run-registry.ts 直接调用这两个原语，不必绕经 background.ts 的消息处理器——
// 那条路径本来就是给"外部消息"用的，onOverlay 回调现在就运行在 background 进程里，
// 直接调用是同一件事的更短路径，不是另起一套逻辑。
async function sendAgentOverlay(payload: SetAgentOverlayPayload, targetTabId: number): Promise<void> {
  if (payload.active) {
    await setOverlayForTab(targetTabId, payload.label ?? '');
  } else {
    await clearOverlayForTab(targetTabId);
  }
  try {
    await sendToContentScript(targetTabId, { id: newMessageId(), type: 'SET_AGENT_OVERLAY', payload });
  } catch {
    // 遮罩是纯视觉功能，下发失败（页面是 chrome:// 之类注入不进去的地址、或正在卸载）
    // 一律吞掉，不能让它的失败影响真正的写操作（同 background.ts 原 pushOverlayToTab 的约定）。
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`

- [ ] **Step 6: Commit**

```bash
git add lib/agent/run-registry.ts lib/agent/run-registry.test.ts
git commit -m "feat: run-registry 核心——background 侧驱动 agent 主循环"
```

---

### Task 3: `run-registry.ts` —— respondConfirm/respondQuestion/stopRun + Port 挂载

**Files:**
- Modify: `lib/agent/run-registry.ts`
- Modify: `lib/agent/run-registry.test.ts`

**Interfaces:**
- Produces: `respondConfirm(tabId, toolCallId, approved): void`、`respondQuestion(tabId, toolCallId, answer): void`、`stopRun(tabId): void`、`attachPort(tabId, port: PortLike): RunSnapshot | undefined`（挂载监听者，若有存活 run 立即返回当前快照供调用方发首帧；没有 run 返回 `undefined`）、`detachPort(tabId, port: PortLike): void`。

`PortLike` 是 `chrome.runtime.Port` 的最小子集，方便测试用假对象替代：

```ts
export interface PortLike {
  postMessage(message: unknown): void;
}
```

- [ ] **Step 1: 补充失败测试**

在 `lib/agent/run-registry.test.ts` 追加：

这几个新用例直接写成本任务 Step 4 会落地的最终形态——`startRun` 只接收一个参数
（`ports` 参数在本任务里被 `attachPort`/内部 `listeners` 表取代，见下方 Step 3/4）。
在 Step 4 完成之前，这几条新用例会因为多传了一个不存在的形参位置而在运行时报错
（JS 不会因为多传参数直接报错，但 Task 2 当前实现里 `pushAndPersist(state, ports)`
会在 `ports` 是 `undefined` 时抛 `Cannot read properties of undefined`）——这正是
Step 2 要确认的"失败"，Step 3/4 落地后自然转为通过，不需要额外过渡代码：

```ts
import { respondConfirm, respondQuestion, stopRun, attachPort, detachPort } from './run-registry';

describe('run-registry confirm/question/stop/port', () => {
  it('resolves a pending confirmation and clears it from the snapshot', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 20 }));
    const state = getRunState(20)!;
    let resolved: boolean | undefined;
    // 真实场景下这个字段是 agent.ts 内部调用 onConfirm 时设置的；makeFakeAgent 的
    // prompt() 不模拟 beforeToolCall/onConfirm 那条路径（agent.ts 本身已经有测试覆盖
    // onConfirm 何时被调用），这里直接摆好"正在等待确认"这个前置状态来测 respondConfirm
    // 自己的行为。
    state.pendingConfirmation = { toolCallId: 'call-1', toolName: 'browser_click', summary: 'x' };
    state.resolveConfirmation = (approved) => { resolved = approved; };

    respondConfirm(20, 'call-1', true);

    expect(resolved).toBe(true);
    expect(getRunState(20)?.pendingConfirmation).toBeNull();
  });

  it('resolves a pending question', async () => {
    await startRun(makeRequest({ tabId: 21 }));
    const state = getRunState(21)!;
    let answered: string | undefined;
    state.pendingQuestion = { toolCallId: 'ask-1', question: 'which one?' };
    state.resolveQuestion = (answer) => { answered = answer; };

    respondQuestion(21, 'ask-1', 'the first one');

    expect(answered).toBe('the first one');
    expect(getRunState(21)?.pendingQuestion).toBeNull();
  });

  it('stop aborts the agent and clears pending confirmation/question', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 22 }));
    const state = getRunState(22)!;
    state.pendingConfirmation = { toolCallId: 'call-2', toolName: 'browser_click', summary: 'x' };

    stopRun(22);

    expect(agent.abort).toHaveBeenCalledOnce();
    expect(getRunState(22)?.pendingConfirmation).toBeNull();
  });

  it('attachPort replies with the current snapshot for a live run, and detachPort never cancels the run', async () => {
    const agent = makeFakeAgent([]);
    mocks.createBrowserAgent.mockReturnValue(agent);
    await startRun(makeRequest({ tabId: 23 }));

    const snapshot = attachPort(23, { postMessage: () => undefined });
    expect(snapshot?.tabId).toBe(23);

    detachPort(23, { postMessage: () => undefined });
    expect(agent.abort).not.toHaveBeenCalled();
    expect(getRunState(23)).toBeDefined();
  });

  it('attachPort returns undefined when there is no live run for the tab', () => {
    expect(attachPort(999, { postMessage: () => undefined })).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: FAIL，`respondConfirm is not a function` 等。

- [ ] **Step 3: 在 `run-registry.ts` 里实现这几个函数**

在文件末尾追加（`PortRegistry`/`push` 的实现细节在 Task 5 才落地到真实 `chrome.runtime.Port`；这里先把"某个 tabId 当前挂着哪个 Port"这件事收进 `run-registry.ts` 自己管，`PortRegistry.push` 因此可以变成模块内部逻辑，Task 2 里传进 `startRun` 的外部 `ports` 参数改成用这里新增的模块级监听者表）：

```ts
export interface PortLike {
  postMessage(message: unknown): void;
}

const listeners = new Map<number, PortLike>();

function broadcast(tabId: number, snapshot: RunSnapshot): void {
  listeners.get(tabId)?.postMessage({ type: 'snapshot', ...snapshot });
}

/** Task 2 里 startRun 签名的第二个参数改为不再需要——统一用 broadcast()。
 * 见下方"Step 4: 调整 startRun 签名"。*/

export function attachPort(tabId: number, port: PortLike): RunSnapshot | undefined {
  listeners.set(tabId, port);
  const state = runs.get(tabId);
  return state ? snapshotOf(state) : undefined;
}

/** Port 断开只表示"暂时没人在看"，绝不能连带清理 RunState 或调用 agent.abort()——
 * 这正是本次迁移要修的 bug 本身，不能在这里重犯（ref: 设计文档 §4）。*/
export function detachPort(tabId: number, port: PortLike): void {
  if (listeners.get(tabId) === port) listeners.delete(tabId);
}

export function respondConfirm(tabId: number, toolCallId: string, approved: boolean): void {
  const state = runs.get(tabId);
  if (!state || state.pendingConfirmation?.toolCallId !== toolCallId) return;
  const resolve = state.resolveConfirmation;
  state.resolveConfirmation = null;
  if (!approved) {
    state.terminatedToolCallIds.add(toolCallId);
    const info = state.pendingToolArgs.get(toolCallId);
    state.activitySteps = upsertActivityStep(state.activitySteps, {
      id: toolCallId,
      description: describeToolActivity(state.pendingConfirmation.toolName, info?.args, 'failed'),
      status: 'failed',
    });
  }
  state.pendingConfirmation = null;
  broadcast(tabId, snapshotOf(state));
  void saveRunStateSnapshot(tabId, snapshotOf(state));
  resolve?.(approved);
}

export function respondQuestion(tabId: number, toolCallId: string, answer: string): void {
  const state = runs.get(tabId);
  if (!state || state.pendingQuestion?.toolCallId !== toolCallId) return;
  const resolve = state.resolveQuestion;
  state.resolveQuestion = null;
  state.pendingQuestion = null;
  broadcast(tabId, snapshotOf(state));
  void saveRunStateSnapshot(tabId, snapshotOf(state));
  resolve?.(answer);
}

export function stopRun(tabId: number): void {
  const state = runs.get(tabId);
  if (!state) return;
  state.resolveConfirmation?.(false);
  state.resolveConfirmation = null;
  state.resolveQuestion?.('');
  state.resolveQuestion = null;
  state.agent.abort();
  for (const step of state.activitySteps) state.terminatedToolCallIds.add(step.id);
  const pendingId = state.pendingConfirmation?.toolCallId ?? state.pendingQuestion?.toolCallId;
  if (pendingId) state.terminatedToolCallIds.add(pendingId);
  state.pendingConfirmation = null;
  state.pendingQuestion = null;
  state.activitySteps = [];
  broadcast(tabId, snapshotOf(state));
  void saveRunStateSnapshot(tabId, snapshotOf(state));
}
```

- [ ] **Step 4: 调整 `startRun`，把 `PortRegistry` 参数换成内部 `broadcast`**

把 Task 2 里 `pushAndPersist(state, ports)` 的 `ports: PortRegistry` 参数去掉，改成直接调用本任务新增的 `broadcast`；`startRun` 的签名从 `startRun(request, ports)` 简化为 `startRun(request: StartRunRequest): Promise<void>`。同步修改：
- 删除 Task 2 里定义的 `export interface PortRegistry { push(...): void }`——本任务的 `listeners`/`broadcast`/`PortLike` 取代了它，不再需要这个中间抽象。
- `pushAndPersist(state: RunState)` 内部改为 `broadcast(state.tabId, snapshotOf(state)); void saveRunStateSnapshot(...)`，删掉 `ports` 形参。
- 所有调用点（`onConfirm`/`onAskUser`/`agent.subscribe` 回调/`finally`）里 `pushAndPersist(state, ports)` 改成 `pushAndPersist(state)`。
- `startRun` 函数体去掉 `ports` 形参，函数签名改为 `export async function startRun(request: StartRunRequest): Promise<void>`。

同步更新 `run-registry.test.ts` 里 Task 2 写的两个 `startRun(makeRequest(), ports)` 调用和 `makeRequest` 辅助——去掉 `ports` 参数传递，改为 `startRun(makeRequest())`；`ports.push` 相关断言（"pushed 数组"那条）改为改用 `attachPort` 挂一个假 `PortLike` 再断言它收到的 `postMessage` 调用：

```ts
it('creates a RunState, persists the initial history immediately, and streams text into the last assistant message', async () => {
  const agent = makeFakeAgent([
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
  ]);
  mocks.createBrowserAgent.mockReturnValue(agent);
  const posted: unknown[] = [];
  attachPort(7, { postMessage: (m) => posted.push(m) });

  await startRun(makeRequest());
  await vi.waitFor(() => expect(mocks.replaceConversationMessages).toHaveBeenCalled());

  const firstCallMessages = mocks.replaceConversationMessages.mock.calls[0][1];
  expect(firstCallMessages.some((m: { role: string; content: string }) => m.role === 'user' && m.content === 'hi')).toBe(true);

  const state = getRunState(7);
  expect(state?.busy).toBe(false);
  expect(state?.messages[state.messages.length - 1]?.content).toBe('Hello');
  expect(posted.length).toBeGreaterThan(0);
});
```

其余测试同样去掉 `ports` 局部变量、改用 `startRun(makeRequest({ tabId: N }))`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 6: 类型检查**

Run: `pnpm compile`

- [ ] **Step 7: Commit**

```bash
git add lib/agent/run-registry.ts lib/agent/run-registry.test.ts
git commit -m "feat: run-registry 支持 confirm/question 应答、stop 与 Port 挂载"
```

---

### Task 4: `run-registry.ts` —— alarm 保活 + 冷启动孤儿检测

**Files:**
- Modify: `lib/agent/run-registry.ts`
- Modify: `lib/agent/run-registry.test.ts`
- Modify: `wxt.config.ts`

**Interfaces:**
- Produces: `scanForOrphans(): Promise<OrphanResolvedMessage[]>`（冷启动时调用一次；返回值供 Task 5 里挨个尝试推给对应 Port，此时大概率还没有 Port 连上，返回值主要是方便测试断言，实际推送发生在 Task 5 的 `attachPort` 里——见下方 Step 3 对 `attachPort` 的调整）。
- Alarm 相关不对外导出新符号，`startRun`/`stopRun`/`finally` 内部调用。

- [ ] **Step 1: manifest 加 `alarms` 权限**

Modify `wxt.config.ts:37`：

```ts
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'alarms'],
```

- [ ] **Step 2: 补充失败测试**

追加到 `lib/agent/run-registry.test.ts`：

```ts
describe('run-registry keepalive alarm', () => {
  beforeEach(() => {
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      alarms: {
        create: vi.fn(),
        clear: vi.fn(async () => true),
        onAlarm: { addListener: vi.fn() },
      },
    };
  });

  it('registers a keepalive alarm while a run is in-flight and clears it when the run settles', async () => {
    const agent = makeFakeAgent([]);
    let resolvePrompt!: () => void;
    agent.prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    mocks.createBrowserAgent.mockReturnValue(agent);

    const runPromise = startRun(makeRequest({ tabId: 30 }));
    await vi.waitFor(() => expect((globalThis as any).browser.alarms.create).toHaveBeenCalled());
    expect((globalThis as any).browser.alarms.create.mock.calls[0][0]).toBe('runi:agent-keepalive:30');

    resolvePrompt();
    await runPromise;
    expect((globalThis as any).browser.alarms.clear).toHaveBeenCalledWith('runi:agent-keepalive:30');
  });
});

describe('run-registry orphan scan', () => {
  it('marks a stale storage.session run-state entry as failure and clears it, without touching live runs', async () => {
    const { listOrphanRunTabIds, loadRunStateSnapshot } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([99]);
    vi.mocked(loadRunStateSnapshot).mockResolvedValueOnce({
      tabId: 99,
      busy: true,
      messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }],
      activitySteps: [],
      pendingConfirmation: null,
      pendingQuestion: null,
    });
    // 冷启动场景：内存里的 runs Map 对 tabId 99 必然是空的（这正是 orphan 的定义）。
    expect(getRunState(99)).toBeUndefined();

    const { scanForOrphans } = await import('./run-registry');
    const resolved = await scanForOrphans();

    expect(resolved).toHaveLength(1);
    expect(resolved[0].tabId).toBe(99);
    expect(resolved[0].messages.at(-1)?.role).toBe('assistant');
    expect(mocks.replaceConversationMessages).toHaveBeenCalled();
  });

  it('does nothing when there is no stale storage.session entry', async () => {
    const { listOrphanRunTabIds } = await import('./run-state-storage');
    vi.mocked(listOrphanRunTabIds).mockResolvedValueOnce([]);
    const { scanForOrphans } = await import('./run-registry');
    expect(await scanForOrphans()).toEqual([]);
  });
});
```

需要把 `run-state-storage` 的 mock 从 `vi.mock('./run-state-storage', () => ({ ... }))` 改成用 `vi.fn()` 具名导出，方便这里用 `vi.mocked(...).mockResolvedValueOnce(...)` 覆写单次返回值——把文件顶部的 mock 块改成：

```ts
vi.mock('./run-state-storage', () => ({
  saveRunStateSnapshot: vi.fn(async () => undefined),
  clearRunStateSnapshot: vi.fn(async () => undefined),
  loadRunStateSnapshot: vi.fn(async () => undefined),
  listOrphanRunTabIds: vi.fn(async () => []),
}));
```

（这一步实际上是把已有 mock 原样保留——上面 Task 1/2 写的时候已经是这个形状，这里只是确认，不需要额外改动。）

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: FAIL（`scanForOrphans` 不存在、alarm 相关断言拿不到调用）。

- [ ] **Step 4: 实现 alarm 保活**

在 `run-registry.ts` 里新增：

```ts
function keepaliveAlarmName(tabId: number): string {
  return `runi:agent-keepalive:${tabId}`;
}

const KEEPALIVE_PERIOD_MINUTES = 20 / 60; // chrome.alarms 的周期单位是分钟；20 秒 ≈ 1/3 分钟

function startKeepalive(tabId: number): void {
  browser.alarms?.create?.(keepaliveAlarmName(tabId), { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
}

function stopKeepalive(tabId: number): void {
  void browser.alarms?.clear?.(keepaliveAlarmName(tabId));
}
```

在 `startRun` 里，`runs.set(request.tabId, state)` 之后加 `startKeepalive(request.tabId)`；在 `finally` 块里，`await clearRunStateSnapshot(...)` 之后加 `stopKeepalive(state.tabId)`。

alarm 触发本身除了"让 service worker 保持存活"之外不需要做任何业务逻辑——`chrome.alarms.onAlarm` 的监听器统一挂在 Task 5 的 `entrypoints/background.ts` 里（那才是 background 的唯一入口点，`run-registry.ts` 只负责创建/清除 alarm，不监听）。

- [ ] **Step 5: 实现 `scanForOrphans`**

```ts
export async function scanForOrphans(): Promise<import('./run-port-protocol').OrphanResolvedMessage[]> {
  const tabIds = await listOrphanRunTabIds();
  const resolved: import('./run-port-protocol').OrphanResolvedMessage[] = [];
  for (const tabId of tabIds) {
    if (runs.has(tabId)) continue; // 这个 tab 已经有存活的 run，说明这条快照是它自己刚写的，不是孤儿
    const snapshot = await loadRunStateSnapshot(tabId);
    if (!snapshot) continue;
    const last = snapshot.messages[snapshot.messages.length - 1];
    const messages: ChatMessage[] = last && last.role === 'assistant' && !last.content
      ? [...snapshot.messages.slice(0, -1), { ...last, content: t('store.interruptedByRestart') }]
      : [...snapshot.messages, { id: `orphan-${tabId}-${Date.now()}`, role: 'assistant' as const, content: t('store.interruptedByRestart'), createdAt: Date.now() }];
    // conversationId 没有存在 RunSnapshot 里（它不是渲染需要的字段），孤儿快照因此推不出
    // 该写回哪个会话——這正是 scanForOrphans 只依赖 storage.session 做检测、但恢复动作
    // 必须落到 Dexie 时暴露的缺口，下一步（Step 6）补上。
    resolved.push({ type: 'orphanResolved', tabId, messages });
    await clearRunStateSnapshot(tabId);
  }
  return resolved;
}
```

- [ ] **Step 6: 补 `conversationId` 到 `RunSnapshot`，让孤儿恢复能写回正确的会话**

回到 `lib/agent/run-port-protocol.ts`，给 `RunSnapshot` 加一个字段：

```ts
export interface RunSnapshot {
  tabId: number;
  conversationId: string;
  busy: boolean;
  messages: ChatMessage[];
  activitySteps: ActivityStep[];
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
}
```

回到 `run-registry.ts`：
- `snapshotOf(state)` 加一行 `conversationId: state.conversationId,`。
- `scanForOrphans` 里，`resolved.push(...)` 之前加：

```ts
    await replaceConversationMessages(
      snapshot.conversationId,
      toMessageRecords(snapshot.conversationId, messages),
      conversationTitle(messages),
    ).catch((e: unknown) => console.error('[Runi] 孤儿 run 恢复失败', e));
```

- 更新 Step 2 里手写的测试 mock 快照对象，加上 `conversationId: 'conv-1'`；`scanForOrphans` 测试里追加一条断言 `expect(mocks.replaceConversationMessages).toHaveBeenCalledWith('conv-1', expect.any(Array), expect.any(String))`。

- [ ] **Step 7: `i18n` 补文案键**

新增翻译键 `store.interruptedByRestart`，中英各一份。

Modify `lib/i18n/locales/zh.ts`（在 `store.generationAborted` 附近插入一行）：

```ts
  'store.interruptedByRestart': '任务因浏览器或扩展重启被中断，请重新发起。',
```

Modify `lib/i18n/locales/en.ts`：

```ts
  'store.interruptedByRestart': 'The task was interrupted by a browser or extension restart. Please try again.',
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 9: 类型检查**

Run: `pnpm compile`

- [ ] **Step 10: Commit**

```bash
git add lib/agent/run-registry.ts lib/agent/run-registry.test.ts lib/agent/run-port-protocol.ts wxt.config.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat: run-registry 加 alarm 保活与冷启动孤儿检测"
```

---

### Task 5: `background.ts` 接线 —— Port 监听、启动时孤儿扫描、locale 同步

**Files:**
- Modify: `entrypoints/background.ts`
- Modify: `lib/i18n/index.tsx`

**Interfaces:**
- Consumes: `AGENT_RUN_PORT_NAME`/`PanelToBackground`（Task 1）；`startRun`/`respondConfirm`/`respondQuestion`/`stopRun`/`attachPort`/`detachPort`/`scanForOrphans`（Task 2-4）。
- 没有新增可测试的纯函数（`entrypoints/background.ts` 目前没有对应 vitest project——`fill-form-request.ts` 早先已经是"逻辑下沉以便测试、background.ts 只做 I/O 编排"的先例，这次同样遵循，见 `docs/superpowers/specs/2026-08-31-page-redaction-pipeline-design.md` §7 对同一约定的说明）。本任务只用 `pnpm compile` + Task 8 的手工验证兜底。

- [ ] **Step 1: `lib/i18n/index.tsx` 让 `applyLocale` 在 service worker 里安全可调**

Modify `lib/i18n/index.tsx:35-40`：

旧：
```ts
export function applyLocale(mode: LocaleMode): ResolvedLocale {
  const resolved = resolveLocale(mode);
  currentLocale = resolved;
  document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
  return resolved;
}
```

新：
```ts
export function applyLocale(mode: LocaleMode): ResolvedLocale {
  const resolved = resolveLocale(mode);
  currentLocale = resolved;
  // service worker 没有 document；background 侧调用这个函数只是为了让 t()/getCurrentLocale()
  // 读到正确的语言（describeToolActivity 等格式化函数现在跑在 background 里，见
  // docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md 的 Global Constraints）。
  if (typeof document !== 'undefined') {
    document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
  }
  return resolved;
}
```

- [ ] **Step 2: `background.ts` 顶部导入**

在 `entrypoints/background.ts` 现有 import 区块（`resolveTargetTab`/`sendToContentScript` 那一批，约第 55-70 行）里加：

```ts
import { AGENT_RUN_PORT_NAME, type PanelToBackground } from '@/lib/agent/run-port-protocol';
import { startRun, respondConfirm, respondQuestion, stopRun, attachPort, detachPort, scanForOrphans } from '@/lib/agent/run-registry';
import { loadLocale, applyLocale, LOCALE_KEY } from '@/lib/i18n';
```

- [ ] **Step 3: `defineBackground` 里注册 Port 监听 + 启动时的孤儿扫描 + locale 初始化**

Modify `entrypoints/background.ts:119-124`（`defineBackground(() => { ... })` 开头）：

旧：
```ts
export default defineBackground(() => {
  // 每次 Service Worker 启动都重新确立"面板按 tab 绑定"这条约束（见 lib/tab-panel-scope.ts）。
  // 不能只挂在 runtime.onInstalled 上：那只在安装/更新时触发一次，浏览器重启、扩展重新启用
  // 都不会再触发，而 manifest 的 side_panel.default_path 会让全局默认悄悄恢复成"所有 tab 都开"，
  // 于是在 A 标签页打开的面板会跟着切换显示到 B 标签页上。
  syncSidePanelScope().catch((err: unknown) => console.error('[Runi] sidePanel scope sync:', err));
```

新：
```ts
export default defineBackground(() => {
  // 每次 Service Worker 启动都重新确立"面板按 tab 绑定"这条约束（见 lib/tab-panel-scope.ts）。
  // 不能只挂在 runtime.onInstalled 上：那只在安装/更新时触发一次，浏览器重启、扩展重新启用
  // 都不会再触发，而 manifest 的 side_panel.default_path 会让全局默认悄悄恢复成"所有 tab 都开"，
  // 于是在 A 标签页打开的面板会跟着切换显示到 B 标签页上。
  syncSidePanelScope().catch((err: unknown) => console.error('[Runi] sidePanel scope sync:', err));

  // background 和面板是两份独立的 lib/i18n 模块实例，各自的 currentLocale 单例互不相通。
  // describeToolActivity/describeEmptyAgentRun 等格式化函数现在跑在 background 里（见
  // lib/agent/run-registry.ts），必须显式把 background 自己这份 currentLocale 与用户在
  // chrome.storage.local 里的语言偏好同步，否则永远停在 service worker 冷启动那一刻的默认值。
  loadLocale().then(applyLocale).catch((err: unknown) => console.error('[Runi] locale sync on startup:', err));
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[LOCALE_KEY]) return;
    loadLocale().then(applyLocale).catch((err: unknown) => console.error('[Runi] locale sync on change:', err));
  });

  // 冷启动孤儿扫描：见 lib/agent/run-registry.ts 的 scanForOrphans 文档注释。这里只是触发，
  // 不需要处理返回值——它已经把 failure 消息写进了 Dexie；面板重连时会走 attachPort 返回
  // undefined -> 面板照常从 Dexie 读历史，自然看到这条 failure 消息，不需要额外的 orphanResolved
  // 推送路径（Task 6 的面板实现相应地不需要特殊处理 orphanResolved 消息类型）。
  scanForOrphans().catch((err: unknown) => console.error('[Runi] scanForOrphans:', err));

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_RUN_PORT_NAME) return;
    let boundTabId: number | undefined;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as PanelToBackground;
      switch (message.type) {
        case 'hello': {
          boundTabId = message.tabId;
          const snapshot = attachPort(message.tabId, port);
          if (snapshot) port.postMessage({ type: 'snapshot', ...snapshot });
          break;
        }
        case 'startRun':
          void startRun(message);
          break;
        case 'respondConfirm':
          respondConfirm(message.tabId, message.toolCallId, message.approved);
          break;
        case 'respondQuestion':
          respondQuestion(message.tabId, message.toolCallId, message.answer);
          break;
        case 'stop':
          stopRun(message.tabId);
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      if (typeof boundTabId === 'number') detachPort(boundTabId, port);
    });
  });
```

> `scanForOrphans()` 的结果目前不推给任何面板——设计上没问题：孤儿恢复已经把 `failure` 消息写进了 Dexie，面板不论是这次冷启动之后第一次挂载、还是之后随便哪次挂载，`attachPort` 都会因为没有存活的 `RunState` 而返回 `undefined`，面板走"没有 run，照常读 Dexie 历史"的默认路径（Task 6），自然会看到这条已经落库的 failure 消息。`OrphanResolvedMessage` 类型和 Task 1 里的 Port 协议保留，是为了覆盖"孤儿扫描发生时面板恰好已经连着 Port"这个边界情况——但由于 `scanForOrphans()` 只在 `defineBackground` 顶层跑一次、发生在任何 `onConnect` 之前，面板不可能在那一刻已经连上，所以这条推送路径在 v1 里实际不会被触发，先不接线，避免为一个当前排除不到的时序去猜测处理逻辑（YAGNI）。如果未来 `scanForOrphans` 改成也能在运行期被触发（比如响应某个新增的重试入口），到时候再把推送接上。

- [ ] **Step 4: 类型检查**

Run: `pnpm compile`
Expected: 通过。注意 `browser.runtime.onConnect`/`port.onMessage`/`port.onDisconnect` 的类型来自 WXT 的 `browser` polyfill，和现有 `browser.runtime.onMessage.addListener` 用法（`background.ts:154`）是同一套类型来源，不需要额外声明。

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts lib/i18n/index.tsx
git commit -m "feat: background 接入 agent-run Port、启动时孤儿扫描与 locale 同步"
```

---

### Task 6: `store.ts` —— Port 客户端 + `runAgent` 改为发起 `startRun`

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: `AGENT_RUN_PORT_NAME`/`PendingConfirmation`/`PendingQuestion`/`SnapshotMessage`/`OrphanResolvedMessage`（Task 1，替换 store.ts 里原来自己声明的 `PendingConfirmation`/`PendingQuestion`）。

这一步是最大的一次删除：`store.ts` 里从 `const onConfirm = ...`（原 1065 行）到 `finally` 块结束（原 1300 行）之间，以及文件末尾的 `toAgentMessages`/`extractLastAssistantText`/`LastAssistantInfo`/`findLastAssistant`/`isNetworkFetchError`/`describeEmptyAgentRun`/`compactJson`/`isToolGuardBlockResult`/`getMissingAgentMessageTypes`（原 1319-1436 行）全部删除——这些逻辑已经在 Task 2 里原样搬进了 `run-registry.ts`。`persistConversationSnapshot`（原 1443-1459 行）也删除：落盘现在完全是 background 的职责。

- [ ] **Step 1: 把 `PendingConfirmation`/`PendingQuestion` 的定义换成从 Task 1 的模块导入**

Modify `entrypoints/sidepanel/store.ts:99-109`：

旧：
```ts
export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  summary: string;
  codePreview?: string;
}

export interface PendingQuestion {
  toolCallId: string;
  question: string;
}
```

新：
```ts
export type { PendingConfirmation, PendingQuestion } from '@/lib/agent/run-port-protocol';
```

（`export type { ... } from ...` 保留了原有 `import { PendingConfirmation } from '@/entrypoints/sidepanel/store'` 这类外部消费方的路径不变——先搜一遍确认有没有别的文件这样引用；如果 `components/` 下有组件是 `import type { PendingConfirmation } from '../store'` 这样引用的，这个 re-export 让它们不用跟着改。)

- [ ] **Step 2: 简化 `ActiveRun`**

Modify `entrypoints/sidepanel/store.ts:174-183`：

旧：
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

新：
```ts
// 真正的运行状态（Agent 实例、pending confirmation/question 的 resolver、活动步骤）现在都
// 在 background 的 run-registry.ts 里；面板这份 ActiveRun 只剩下"用来过滤过期事件"的身份信息
// （ref: docs/superpowers/specs/2026-09-01-agent-run-in-background-design.md）。
interface ActiveRun {
  id: number;
  origin: ConversationOrigin;
  tabId: number;
}
```

`Agent` 类型的 import（原文件顶部 `import type { Agent } from '@earendil-works/pi-agent-core';`）和 `TaskOutcome` 的 import 如果只被 `ActiveRun` 用到，这一步之后要看是否还有别处引用——`ChatMessage.taskOutcome` 字段（`lib/chat/messages.ts`）本身就是 `TaskOutcome` 类型，`store.ts` 大概率还需要这个 import 做别的类型标注，先不删，等 Step 6 全部改完后跑一次 `pnpm compile`/lint 由未使用导入的报错驱动清理。

- [ ] **Step 3: `settleRun`/`invalidateActiveRun` 精简**

Modify `entrypoints/sidepanel/store.ts:335-341`：

旧：
```ts
function settleRun(run: ActiveRun): void {
  if (activeRun?.id !== run.id) return;
  run.resolveConfirmation = null;
  run.resolveQuestion = null;
  run.agent = null;
  activeRun = null;
}
```

新：
```ts
function settleRun(run: ActiveRun): void {
  if (activeRun?.id !== run.id) return;
  activeRun = null;
}
```

Modify `entrypoints/sidepanel/store.ts:343-360`（`invalidateActiveRun`）：

旧：
```ts
function invalidateActiveRun(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  persist = true,
): void {
  const run = activeRun;
  if (!run) return;
  const messages = isCurrentOrigin(run.origin, get) ? get().messages : [];
  activeRun = null;
  run.resolveConfirmation?.(false);
  run.resolveConfirmation = null;
  run.resolveQuestion?.('');
  run.resolveQuestion = null;
  run.agent?.abort();
  if (isCurrentOrigin(run.origin, get)) {
    clearAllSlowActivityTimers();
    set({ busy: false, pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
```

新（`persist` 参数、`messages` 变量等原本用于"整轮结束时要不要把当前内容存进 Dexie"的逻辑一并删除——落盘现在完全在 background，面板不再需要在中止路径里操心持久化）：

```ts
function invalidateActiveRun(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
): void {
  const run = activeRun;
  if (!run) return;
  activeRun = null;
  postToRunPort({ type: 'stop', tabId: run.tabId });
  if (isCurrentOrigin(run.origin, get)) {
    clearAllSlowActivityTimers();
    set({ busy: false, pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
```

（保留这个函数原本 360 行往后、闭合大括号之前是否还有更多内容——本步骤只替换到这里列出的这段，其余原样保留；实现时先完整读一遍 `invalidateActiveRun` 全函数体再改，不要凭这段摘录臆测结尾。)

调用方 `invalidateActiveRun(set, get, false)`（`removeConversation` 里两处）要去掉第三个参数，改成 `invalidateActiveRun(set, get)`。

- [ ] **Step 4: Port 客户端——建立连接、处理 `snapshot`**

在文件里新增一段模块级状态和函数（放在 `let activeRun: ActiveRun | null = null;` 附近，即原 184 行一带）：

```ts
let runPort: ReturnType<typeof browser.runtime.connect> | null = null;

function postToRunPort(message: PanelToBackground): void {
  runPort?.postMessage(message);
}

/** panelTabId 解析出来之后调用一次（见 restoreTabConversation），建立与 background 的
 * 持久连接。面板文档被销毁时这个 Port 自然断开，不需要显式清理——不影响 background 里
 * 的 run 继续跑，见 lib/agent/run-registry.ts 的 detachPort 文档注释。*/
function connectRunPort(tabId: number, set: StoreSet, get: StoreGet): void {
  runPort = browser.runtime.connect({ name: AGENT_RUN_PORT_NAME });
  runPort.onMessage.addListener((raw: unknown) => {
    const message = raw as BackgroundToPanel;
    if (message.type === 'snapshot') applySnapshot(message, set, get);
    // orphanResolved 目前不会被触发（见 background.ts Step 3 的注释），面板不处理这个分支——
    // 孤儿恢复写回 Dexie 后，下次这个 tab 的会话被打开时会照常从历史里读到那条 failure 消息。
  });
  postToRunPort({ type: 'hello', tabId });
}

function applySnapshot(snapshot: SnapshotMessage, set: StoreSet, get: StoreGet): void {
  const run = activeRun;
  if (!run || run.tabId !== snapshot.tabId || !isCurrentOrigin(run.origin, get)) return;
  set({
    messages: snapshot.messages,
    activitySteps: snapshot.activitySteps,
    pendingConfirmation: snapshot.pendingConfirmation,
    pendingQuestion: snapshot.pendingQuestion,
    busy: snapshot.busy,
  });
  if (!snapshot.busy) settleRun(run);
}
```

加对应 import：

```ts
import { AGENT_RUN_PORT_NAME, type PanelToBackground, type BackgroundToPanel, type SnapshotMessage } from '@/lib/agent/run-port-protocol';
```

- [ ] **Step 5: `restoreTabConversation` 里调用 `connectRunPort`**

Modify `entrypoints/sidepanel/store.ts:836-840`：

旧：
```ts
  restoreTabConversation: async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') return;
    panelTabId = tabId;
```

新：
```ts
  restoreTabConversation: async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== 'number') return;
    panelTabId = tabId;
    connectRunPort(tabId, set, get);
```

（这里 `restoreTabConversation` 是 `create<ChatState>((set, get) => ({ ... }))` 里的一个方法，`set`/`get` 在闭包里已经可用，不需要额外传参——上面 `connectRunPort` 签名里的 `set`/`get` 形参对应的就是这两个闭包变量本身，写法与文件里其它方法一致。)

- [ ] **Step 6: 重写 `runAgent` 的尾部——从"驱动 Agent"改成"发起 startRun"**

Modify `entrypoints/sidepanel/store.ts`，把原 1065-1300 行（从 `const onConfirm = ...` 到 `finally` 块结束、`return true;` 之前）整体替换为：

```ts
  activeRun = { id: run.id, origin: run.origin, tabId };
  postToRunPort({
    type: 'startRun',
    tabId,
    conversationId: run.origin.conversationId,
    provider: agentProvider,
    systemPrompt: buildSystemPrompt({
      locale: getCurrentLocale(),
      readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
      writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
      now: new Date(),
      page: options.withoutBrowserTools ? undefined : { tabId, title: tab.title, url: tab.url },
      constraints: options.systemPromptSuffix,
    }),
    withoutBrowserTools: options.withoutBrowserTools,
    // history 是提交前的历史，不含本轮新增的用户消息——run-registry.ts 的 startRun 会自己
    // 拼接 [...historyMessages, displayMessage, 占位 assistant]。这里传 history 而不是
    // 上面 set({messages:[...history, committedDisplay, ...]}) 用过的那个拼接结果，否则
    // committedDisplay 会在 run-registry.ts 那边被重复拼接一次。
    historyMessages: history,
    displayMessage: committedDisplay,
    agentUserContent: committedAgentUserContent,
    images: committedImages,
    readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
    writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
  });
  return true;
}
```

注意这里删掉了 Step 0（原 1052-1062 行，`set({ messages: [...history, committedDisplay, makeMessage('assistant', '')], ... busy: true, ... })`）吗？**不删**——那一段仍然要保留在 `runAgent` 更靠前的位置（原来就在 `onConfirm` 定义之前），因为它负责的是"立刻把用户刚发的消息乐观地画到 UI 上、清空输入框、亮起 busy 状态"，这是纯本地 UI 响应，不依赖 Port 是否连上、background 是否已经处理。本步骤只替换 `const onConfirm = ...` 往后的部分；`set({...busy:true...})` 那一段和它之前的所有前置校验（Provider/tab 解析/历史截断/附件提交）原样保留不动。

同时删除文件末尾（原 1306-1467 行左右）不再被引用的函数：`replaceLastAssistant`（不再被 store.ts 使用——它现在只在 `run-registry.ts` 里；但 `applySnapshot` 不需要它，因为 `snapshot.messages` 已经是完整数组，直接 `set({messages: snapshot.messages})` 即可）、`toAgentMessages`、`extractLastAssistantText`、`LastAssistantInfo`、`findLastAssistant`、`isNetworkFetchError`、`describeEmptyAgentRun`、`compactJson`、`isToolGuardBlockResult`、`getMissingAgentMessageTypes`、`persistConversationSnapshot`。保留：`errMsg`（`send`/`runShortcut`/`editMessage` 等别处仍在用）。

`getMissingAgentMessageTypes`（原本在 `runAgent` 里于 `agent.prompt()` 之前调用，检查 background 是否支持全部所需消息类型）整个删除，不迁移——它存在的意义是"面板和 background 分别打包，版本可能不同步"；现在 `Agent` 实例本身就在 background 里跑，`tools.ts` 调用的 `sendMessage` 目标就是本进程自己的 `handleMessage`，不存在"背景协议过旧"这种版本错配场景了。相应地，Step 0 那段 `set({...})` 之后原本紧跟的 `if (!isCurrentRun(run, get)) return false; const missingTypes = await getMissingAgentMessageTypes(); ...` 整段判断也一并删除，直接从 Step 0 的 `set(...)` 跳到本步骤新写的 Port 发送逻辑。

- [ ] **Step 7: 编译期核对残留引用**

Run: `pnpm compile`
Expected: 报出所有因为本任务删除函数/字段而失效的引用（未使用的 import、`Agent`/`TaskOutcome` 类型是否还需要、`makeMessage('assistant', '')` 是否还有其它调用方等）。逐个修：
- 未使用的 `import type { Agent } from '@earendil-works/pi-agent-core';` 直接删除这行 import（`ActiveRun`/`agent.subscribe` 都不在 store.ts 了）。
- `createBrowserAgent`（`@/lib/agent/agent`）、`buildSystemPrompt`（若这次改动后只在这一处用到，保留其 import；`DEFAULT_READ_TOOL_CALL_BUDGET`/`DEFAULT_WRITE_TOOL_CALL_BUDGET` 同理保留，因为 Step 6 仍然引用它们构造 `systemPrompt`）——`createBrowserAgent` 的 import 要删除，`store.ts` 不再直接调用它。
- `summarizeToolCallForConfirmation`/`describeToolActivity`（如果 store.ts 里除了已删除的 `onConfirm`/`subscribe` 回调之外没有别的引用）一并删除 import。

- [ ] **Step 8: 迁移 `store-context.test.tsx` 里依赖 `createBrowserAgent` 的用例**

`store-context.test.tsx` 顶部的 mock（原第 4/41-43 行）：

旧：
```ts
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createBrowserAgent: vi.fn(),
  ...
}));
...
vi.mock('@/lib/agent/agent', () => ({
  createBrowserAgent: mocks.createBrowserAgent,
}));
```

新：
```ts
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  runPortPostMessage: vi.fn(),
  ...
}));
...
// store.ts 现在不再直接调用 createBrowserAgent；它改为通过 browser.runtime.connect(...)
// 建立的 Port 发 startRun 消息。这里 mock 一个最小的假 Port：onMessage 监听器存起来，
// 测试里可以手动调用它模拟 background 推回来的 snapshot。
let runPortListener: ((message: unknown) => void) | undefined;
(globalThis as any).browser = {
  ...(globalThis as any).browser,
  runtime: {
    ...(globalThis as any).browser?.runtime,
    connect: vi.fn(() => ({
      postMessage: mocks.runPortPostMessage,
      onMessage: { addListener: (fn: (message: unknown) => void) => { runPortListener = fn; } },
      onDisconnect: { addListener: () => undefined },
    })),
  },
};
```

（具体怎么把 `browser` 挂到 jsdom 全局，要先看 `entrypoints/sidepanel/store-context.test.tsx` 现有文件顶部是怎么 mock `browser.tabs`/`browser.storage` 的——跟着现有约定写，不要另起一套风格。这里给出的是逻辑形状，落地时对照文件里已有的 `browser` mock 写法调整。）

原本形如：

```ts
mocks.createBrowserAgent.mockReturnValue(agent);
mocks.sendMessage.mockImplementation((type: string) => { ... });
...
await vi.waitFor(() => expect(mocks.createBrowserAgent).toHaveBeenCalledOnce());
```

的用例，改写模式（以 `store-context.test.tsx:300` 附近那条为例，具体断言按各用例原本在验证什么调整）：

```ts
mocks.sendMessage.mockImplementation((type: string) => { ... }); // 不变：GET_ACTIVE_TAB 等仍走 sendMessage
...
await vi.waitFor(() => expect(mocks.runPortPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'startRun' })));
const startRunCall = mocks.runPortPostMessage.mock.calls.find((c) => c[0].type === 'startRun')!;
```

原来断言 `mocks.createBrowserAgent.mock.calls[0][0].systemPrompt` / `.tools` 的用例（`store-context.test.tsx:682-684`、`:711`），改成断言 `startRunCall[0].systemPrompt` / `.withoutBrowserTools`：

```ts
expect(startRunCall[0]).toEqual(expect.objectContaining({ withoutBrowserTools: true }));
const { systemPrompt } = startRunCall[0];
```

原来通过 `agent.subscribe` 的假实现（`makeAgent()` 辅助函数，模拟 `text_delta`/`tool_execution_start` 等事件）来驱动断言"消息内容渲染成功"的用例，现在改为：调用 `runPortPostMessage` 之后，手动触发 `runPortListener?.({ type: 'snapshot', tabId, busy: false, messages: [...], activitySteps: [], pendingConfirmation: null, pendingQuestion: null, conversationId: '...' })`，再断言 `useChat.getState().messages` 反映了这份 snapshot。`makeAgent()` 这个测试辅助函数如果只服务于这批用例，本任务里一并删除；如果还被别的（本任务未涉及）用例使用，保留但检查是否需要调整。

这一步的产出标准不是"每一条现有用例逐字保留原断言"，而是"覆盖的行为不丢"：原来测的是"store.ts 构造了正确的 systemPrompt/tools/messages 传给 Agent"，现在测的是"store.ts 构造了正确的 startRun 请求"；原来测的是"agent 事件驱动 UI 更新"，现在测的是"收到的 snapshot 驱动 UI 更新"（后者已经在 Task 2/3 的 `run-registry.test.ts` 里从 background 侧覆盖了"snapshot 内容是否正确"，`store-context.test.tsx` 这边只需要覆盖"面板收到 snapshot 之后 UI 状态对不对"，不需要重复造一遍完整的 Agent 事件序列）。

- [ ] **Step 9: 运行测试确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS。这一步大概率需要几轮"跑测试 → 看哪条失败 → 对照失败原因判断是断言过时还是真的改错了 → 修"的迭代，不是一次到位——`store-context.test.tsx` 有 40+ 条用例，本步骤没有在 Step 8 里逐条列出每一条的新写法，实现者需要通读现有文件、按 Step 8 给出的两种改写模式（`sendMessage`-无关用例不动；涉及 `createBrowserAgent`/agent 事件的用例按模式改写）逐条过一遍。

- [ ] **Step 10: 全量测试 + 类型检查**

Run: `pnpm compile && pnpm test`
Expected: 全部通过（`unit`/`ui`/`dom` 三个 project）。

- [ ] **Step 11: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "refactor: store.ts 改为通过 Port 发起 startRun，不再直接持有 Agent 实例"
```

---

### Task 7: `store.ts` —— `stop`/`respondToConfirmation`/`respondToQuestion` 改走 Port

**Files:**
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: `postToRunPort`（Task 6 新增的模块级函数）、`activeRun.tabId`（Task 6 简化后的 `ActiveRun`）。

- [ ] **Step 1: 改写 `stop`**

Modify `entrypoints/sidepanel/store.ts:734-747`：

旧：
```ts
  stop: () => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(false);
    run.resolveConfirmation = null;
    run.resolveQuestion?.('');
    run.resolveQuestion = null;
    run.agent?.abort();
    for (const step of get().activitySteps) run.terminatedToolCallIds.add(step.id);
    const pendingId = get().pendingConfirmation?.toolCallId ?? get().pendingQuestion?.toolCallId;
    if (pendingId) run.terminatedToolCallIds.add(pendingId);
    clearAllSlowActivityTimers();
    set({ pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
  },
```

新（`terminatedToolCallIds` 记账现在完全是 background 的职责——`run-registry.ts` 的 `stopRun` 已经做了同样的事，面板这边只需要乐观地清一下本地 UI，权威状态由随后推回来的 `snapshot` 覆盖）：

```ts
  stop: () => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    postToRunPort({ type: 'stop', tabId: run.tabId });
    clearAllSlowActivityTimers();
    set({ pendingConfirmation: null, pendingQuestion: null, activitySteps: [] });
  },
```

- [ ] **Step 2: 改写 `respondToConfirmation`/`respondToQuestion`**

Modify `entrypoints/sidepanel/store.ts:749-776`：

旧：
```ts
  respondToConfirmation: (approved) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveConfirmation?.(approved);
    run.resolveConfirmation = null;
    const pending = get().pendingConfirmation;
    set({ pendingConfirmation: null });
    if (!approved && pending) {
      run.terminatedToolCallIds.add(pending.toolCallId);
      const info = run.pendingToolArgs.get(pending.toolCallId);
      const description = describeToolActivity(pending.toolName, info?.args, 'failed');
      set((s) => ({
        activitySteps: upsertActivityStep(s.activitySteps, {
          id: pending.toolCallId,
          description,
          status: 'failed',
        }),
      }));
    }
  },

  respondToQuestion: (answer) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    run.resolveQuestion?.(answer);
    run.resolveQuestion = null;
    set({ pendingQuestion: null });
  },
```

新（拒绝时把对应活动步骤标成 failed 这件事，`run-registry.ts` 的 `respondConfirm` 已经做了，面板这边不用再自己算 `describeToolActivity`——`upsertActivityStep`/`describeToolActivity` 的 import 如果 store.ts 里没有其它用途，Task 6 Step 7 的编译检查会顺带发现并清掉）：

```ts
  respondToConfirmation: (approved) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    const pending = get().pendingConfirmation;
    if (!pending) return;
    postToRunPort({ type: 'respondConfirm', tabId: run.tabId, toolCallId: pending.toolCallId, approved });
    set({ pendingConfirmation: null });
  },

  respondToQuestion: (answer) => {
    const run = activeRun;
    if (!run || !isCurrentRun(run, get)) return;
    const pending = get().pendingQuestion;
    if (!pending) return;
    postToRunPort({ type: 'respondQuestion', tabId: run.tabId, toolCallId: pending.toolCallId, answer });
    set({ pendingQuestion: null });
  },
```

- [ ] **Step 3: 迁移对应测试用例**

`store-context.test.tsx` 里覆盖 `stop`/`respondToConfirmation`/`respondToQuestion` 的用例（搜索 `useChat.getState().stop(`/`.respondToConfirmation(`/`.respondToQuestion(`），把原本断言 `agent.abort` 被调用 / `resolveConfirmation` 被调用的部分，改成断言 `mocks.runPortPostMessage` 收到了对应形状的消息：

```ts
useChat.getState().stop();
expect(mocks.runPortPostMessage).toHaveBeenCalledWith({ type: 'stop', tabId: expect.any(Number) });

useChat.getState().respondToConfirmation(true);
expect(mocks.runPortPostMessage).toHaveBeenCalledWith(
  expect.objectContaining({ type: 'respondConfirm', approved: true }),
);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx`
Expected: PASS。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `pnpm compile && pnpm test`
Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx
git commit -m "refactor: stop/respondToConfirmation/respondToQuestion 改为通过 Port 通知 background"
```

---

### Task 8: 手工验证——实际复现并确认修复本次报告的 bug

**Files:** 无代码改动。

- [ ] **Step 1: 构建并加载扩展**

Run: `pnpm build`
然后按 `CLAUDE.md` 的说明从 `.output/chrome-mv3` 加载未打包扩展（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序）。若已经加载过，用"重新加载"更新。

- [ ] **Step 2: 场景一——切标签页中止任务是否还会丢**

1. 在标签页 A 打开侧边栏，配置好一个 provider（或用 `lib/dev-config.ts` 的 `DEV_PROVIDER`），发一条会触发至少一次工具调用、耗时几秒以上的请求（比如"总结这个页面并列出三个要点"）。
2. 请求还在流式/工具调用进行中时，切换到标签页 B。
3. 等 5-10 秒（覆盖至少一次 20s 保活 alarm 周期不是必须的，但可以顺带在 `chrome://extensions` 的 service worker 检查器里确认 worker 没有被回收），切回标签页 A，重新打开侧边栏（如果它被 Chrome 关掉了）。

Expected: 面板重新打开后，看到的是任务继续/已经完成后的完整回复，而不是"输入框清空、消息列表停在用户那句话、没有任何回复"。这正是本次要修的 bug 的直接复现场景。

- [ ] **Step 3: 场景二——手动关闭面板**

1. 发起一个会触发结构化表单提交确认的操作（比如在一个有登录表单的页面上让 agent 尝试提交），在确认卡片弹出、任务处于"等待用户确认"状态时，点击关闭侧边栏。
2. 等几秒后重新打开侧边栏。

Expected: 确认卡片重新出现（如果 Port 重连时机足够快、run 还没被判定为异常）或者——如果关闭期间恰好触发了 service worker 被回收且没有 alarm 及时保活——至少能看到一条清晰的"任务被中断"消息，而不是无提示地卡住或消息消失。

- [ ] **Step 4: 场景三——回归验证正常路径未被破坏**

1. 不切标签页、不关面板，正常发送几条消息，包括至少一次会触发确认卡片的操作、一次 `ask_user` 追问、一次点击"停止"。

Expected: 行为与迁移前一致——流式文字逐步出现、活动步骤列表正确更新、确认/追问 UI 正常弹出与响应、停止按钮生效。

- [ ] **Step 5: 记录结果**

如果三个场景都符合预期，本计划视为完成。如果场景二里"任务被中断"文案没有出现（比如 Port 重连时机导致既没有活的 run 也没有 `orphanResolved` 推送，而 `attachPort` 返回 `undefined` 后面板从 Dexie 读到的历史里也没有那条 failure 消息），回到 Task 5 的 `scanForOrphans()` 调用时机和 Task 4 的落盘时机复核，不要在这里绕过去用别的手段掩盖。
