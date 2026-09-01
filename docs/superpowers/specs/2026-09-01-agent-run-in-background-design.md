# Agent 主循环迁移到 background 设计

- 日期：2026-09-01
- 来源：用户报告"面板一销毁，整轮任务就没了"；根因排查见本文 §1
- 状态：待实现

## 1. 问题

`entrypoints/sidepanel/store.ts` 里，`createBrowserAgent`（`lib/agent/agent.ts`）实例化和驱动它的 `await agent.prompt(...)`，完整跑在侧边栏文档自己的 JS 上下文里（`store.ts:1089-1239`）：流式请求、工具调用循环、activity timeline、pending confirmation/question 全部是这个 `async` 函数栈里的内存状态。持久化只在 `finally` 里做一次（`store.ts:1298` 的 `persistConversationSnapshot`），也就是 `agent.prompt()` 整体 resolve/reject 之后才写 Dexie。

而侧边栏文档本身会被 Chrome 主动销毁，不是意外情况，是本项目的既有设计选择：面板按 tab 强绑定（`entrypoints/background.ts:140-152` 的 `action.onClicked`），`tabs.onActivated` 一触发就对没打开过面板的 tab 显式下发 `enabled:false`（`background.ts:126-131`，代码注释自陈"Chrome 会把跟过来的面板关掉"）。用户在 A 标签页开着面板、agent 正在跑，只要切到 B 标签页，面板文档连同其 JS 堆一起被摘除，不会抛出任何可 catch 的异常——不是异常，是整个 realm 被销毁。用户手动点面板关闭按钮、关窗口，是同一个根因的另外两个触发路径。

后果：本轮任务的整个执行状态消失，且因为持久化只在 `finally` 兜底，**连刚发出去还没来得及落盘的用户消息**都可能一并丢失。

## 2. 目标 / 非目标

**目标：**
- agent 的主循环（`Agent` 实例、`agent.prompt()` 驱动的流式请求 + 工具循环）迁移到 `entrypoints/background.ts`（service worker），使其生命周期与"这个 tab 的任务"绑定，而不是与"这个面板文档"绑定。
- 面板销毁再重开（切标签页、手动关闭再打开、面板因崩溃重载）时，正在跑的任务不受影响，重开的面板能重建出完整的当前状态（消息、activity steps、pending confirmation/question、busy 标志）。
- 结构化检测到的表单提交确认、`ask_user` 追问，在面板缺席时无限期挂起等待，不因为面板不在场就被判失败（ref: 本次设计决策）。
- 会话消息改为逐条增量持久化，而不是整轮结束才写一次，把"面板/后台都彻底死掉"这种无法恢复的极端情况下的数据丢失范围，从"整轮"收窄到"最后一段还没落盘的流式增量"。

**非目标（v1 明确不做）：**
- 不做"浏览器完全退出 / 扩展重新加载 / 系统休眠导致 service worker 被彻底回收且没有任何存活的 alarm 把它唤醒"场景下的真正断点续跑——这种场景下挂起的 JS 调用栈本身就没了，`pi-agent-core`（即便加上本项目已打的 patch）也没有序列化/恢复调用栈的能力。v1 的应对是**检测并诚实报告失败**（见 §5 的 orphan 检测），不是静默复活。
- 不做多 tab 并发任务的可见性面板（比如"后台还有 3 个任务在跑"的全局列表）。现有模型本来就是"一个面板 tab 对应一个会话、同一时刻一个 tab 最多一个 run"，这次迁移只是换执行位置，不改变这个基数。
- 不改动 `permissions.ts`、`tool-policy.ts`、`confirm-gate.ts` 的状态机逻辑、表单层（`form-schema.ts`/`form-dom.ts`/`form-submit.ts`）、`tab-session.ts`/`tab-session-storage.ts`、`agent-overlay.ts`/`tab-overlay-state.ts`——这些模块已经不依赖 `window`/`document`，也不假设自己跑在哪个上下文，只是被调用的位置从面板换成 background，接线方式不变。

## 3. 架构总览

```
今天：
┌─────────────────────────────┐
│ 侧边栏文档（可被 Chrome 销毁）  │
│  store.ts                    │
│   └─ createBrowserAgent()    │
│       └─ agent.prompt()      │  ← 流式请求 + 工具循环 + 状态全在这里
│           └─ tools.ts        │
│               └─ sendMessage │──→ background.ts（executeInTab 等）
└─────────────────────────────┘

迁移后：
┌─────────────────────────┐        Port: 'agent-run'         ┌───────────────────────────────┐
│ 侧边栏文档（可被销毁，无妨）│ ←──────────────────────────────→ │ background.ts（service worker） │
│  仅渲染：订阅事件、        │   hello{tabId} → 状态快照/增量事件│  RunState per tabId            │
│  发送用户操作              │   respondToConfirm/Question/stop │   └─ agent.prompt()（不变）     │
└─────────────────────────┘                                   │       └─ tools.ts（直连背景函数）│
                                                                │  chrome.alarms 保活（run 期间）  │
                                                                │  storage.session 记录 run 状态   │
                                                                └───────────────────────────────┘
```

一个 tab 同一时刻最多一个 `RunState`，键是面板绑定的 `tabId`（与现有 `TabSessionController.panelTabId`、`tab-session-storage.ts` 的键一致）。面板不再持有 `Agent` 实例，只订阅、渲染、转发用户操作。

这看起来是否合理，要不要先确认一下再往下看协议细节？

## 4. Port 协议

新增 `lib/agent/run-port-protocol.ts`，定义面板 ↔ background 的消息形状（独立于 `lib/messaging.ts` 现有的一次性 `sendMessage`/响应模型，因为那套协议没有"背景主动推事件"的通道）。

```ts
// 面板 → background
type PanelToBackground =
  | { type: 'hello'; tabId: number }
  | { type: 'respondConfirm'; toolCallId: string; approved: boolean }
  | { type: 'respondQuestion'; toolCallId: string; answer: string }
  | { type: 'stop' };

// background → 面板
type BackgroundToPanel =
  | { type: 'snapshot'; busy: boolean; messages: UIMessage[]; activitySteps: ActivityStep[];
      pendingConfirmation?: PendingConfirmation; pendingQuestion?: PendingQuestion }
  | { type: 'event'; event: AgentSubscribeEvent }   // agent.subscribe 的事件原样转发
  | { type: 'orphanResolved'; message: UIMessage };  // 见 §5，冷启动发现的孤儿 run 被判失败
```

面板挂载时用 `browser.runtime.connect({ name: 'agent-run' })` 建立 Port，第一条消息发送 `hello{tabId}`（tabId 来自面板自己已知的绑定 tab，与今天 `turn-tabid-pinning` 的做法一致，不是从 Port 里推断）。background 收到 `hello` 后：

- `Map<tabId, RunState>` 里有对应条目 → 立即回一条 `snapshot`（`busy:true` + 当前累积的 messages/activitySteps/pending*），随后把这个 Port 登记为该 `RunState` 的"当前监听者"，后续 `agent.subscribe` 事件、activity 变化都用 `event` 消息往这个 Port 推。
- 没有条目，但 `storage.session` 里有这个 tab 的"曾经在跑"标记（§5 的孤儿检测）→ 走孤儿清理流程，回 `orphanResolved`，`busy:false`。
- 都没有 → 回 `snapshot{busy:false, messages: [], ...}`（面板照常从 Dexie 加载历史，这条路径基本是空操作，只是保持协议统一）。

`onDisconnect` 只表示"暂时没人在看"，绝不触发 `RunState` 清理或 `agent.abort()`——这是本次设计要修的问题本身，不能在新协议里重犯。

同一个 tab 只保留最后一个连上的 Port 作为监听者；旧 Port（比如面板重复挂载留下的僵尸连接）静默替换，不特殊处理。

`stop` 和 `respondConfirm`/`respondQuestion` 不要求发送方是"当前监听者"那个 Port——只要能证明自己是这个 tabId 绑定的面板（`hello` 已经做过这层校验），任何时刻发这三种消息都应该生效。

## 5. 持久化与容错边界

两类状态，持久化策略不同：

**会话消息（对话历史本身）**——已经用 Dexie（`lib/db.ts`）持久化，只是时机要从"整轮结束"改成"每条消息完成时"：`agent.subscribe` 的 `message_end` 事件（不是 `text_delta`——增量 token 级别落盘太吵，且流式中间态本来就不构成一条完整消息）触发一次 `persistConversationSnapshot`。最坏情况下的丢失范围从"整轮"收窄到"最后一段还没等到 `message_end` 的流式文本"。

**运行中状态（activity steps、pending confirmation/question 描述、busy 标志）**——不是对话内容，是易失的运行态，写入 `browser.storage.session`（新增 `lib/agent/run-state-storage.ts`，键 `runi:agent-run:<tabId>`，写法镜像 `tab-session-storage.ts`/`tab-overlay-state.ts`）。每次 `RunState` 变化（`agent.subscribe` 事件、confirm/question 挂起或解决、run 开始/结束）都同步一份快照过去。

这份 `storage.session` 快照撑起两件事：

1. **面板重连时的 snapshot 回放**（§4）——不依赖 `Map<tabId, RunState>` 里那份内存态，纯读 storage 也能重建 UI，为 §5.2 的冷启动场景做准备。
2. **孤儿 run 检测**：service worker 每次冷启动（浏览器重启后首次唤醒、扩展重新加载后首次唤醒）时，扫一遍 `storage.session` 里所有 `runi:agent-run:*` 键——这些条目如果存在，说明上次那个 worker 实例死的时候还标着"在跑"或"等确认"，而这次冷启动的 `Map<tabId, RunState>` 必然是空的（内存态跨不过 worker 重建）。对每一个这样的孤儿条目：写一条 `failure` 消息到对应会话（Dexie），文案说明"任务因浏览器/扩展重启被中断"，清掉这个 storage 键。面板下次为这个 tab 连接 Port 时，走 §4 的 `orphanResolved` 分支。

**Chrome 服务工作线程保活**：只在"有 run 处于 in-flight 或阻塞等待确认"这段时间注册一个 `chrome.alarms`（短周期，如 ~20s）。alarm 触发本身就是 service worker 活动，会重置 Chrome 的空闲回收计时器，让 `agent.prompt()` 内部挂起的调用栈（包括等待 `onConfirm`/`onAskUser` 解决的那个 `await`）在浏览器进程本身存活期间不会被当成"空闲"回收掉。run 结束（成功/失败/用户中止）时清掉这个 alarm。

这个 alarm 保活机制，和 §5.2 的孤儿检测，边界画得很清楚：**alarm 保活解决"用户长时间不回来，但浏览器进程还开着"这个常见情况**（本次选定的"无限期等待"就是靠这个撑住）；**孤儿检测是浏览器进程本身也没了之后的安全网**，不是让任务复活，只是把"永远转圈"变成"明确失败"。这个边界要在实现和后续文档里保持清楚披露，不能让人以为这次改造做到了真正的断点续跑。

## 6. 现有模块的接入方式

- `agent.ts` 的 `createBrowserAgentOptions`/`createBrowserAgent` **不需要改结构**——它已经不引用 `window`/`document`，纯粹通过 `options.onConfirm`/`onAskUser`/`onOverlay`/`onSessionChange`/`onTaskOutcome`/`steer` 这些回调和外界交互。改的是**调用方**：从 `store.ts` 换成 background 里新增的 run 编排模块（建议 `lib/agent/run-registry.ts`，持有 `Map<tabId, RunState>`，导出 `startRun`/`getRunState`/`respondConfirm`/`respondQuestion`/`stopRun` 给 background.ts 的消息/Port 处理代码调用）。
- `onConfirm`/`onAskUser` 的实现从"直接 set 到 Zustand store，返回一个由 UI 事件 resolve 的 Promise"改成"往当前监听的 Port 推一条 `event`，把 resolver 存进 `RunState.pendingConfirmation`/`pendingQuestion`，等 `respondConfirm`/`respondQuestion` 消息进来时调用"——resolver 本身没法序列化，只能活在内存里；能扛过 worker 重建的只有 §5 里镜像出去的那份描述文本，这也是孤儿检测存在的原因。
- `onOverlay`（`SET_AGENT_OVERLAY` 消息）、`onSessionChange`（`saveTabSession`）不需要改实现，只是调用位置从"面板发 `sendMessage` 到 background 再转发"变成"background 内部直接调用"——本来就是 background 侧函数，少一跳而已。
- `confirm-gate.ts`、`permissions.ts`、`tool-policy.ts` 的状态机、`tab-session.ts`/`tab-session-storage.ts`、`agent-overlay.ts`/`tab-overlay-state.ts`：不改。

## 7. tools.ts 改造

`lib/agent/tools.ts` 里 `execute()` 目前普遍通过 `sendMessage(...)`（`lib/messaging.ts` 的 `browser.runtime.sendMessage`）把请求发回 `background.ts` 的 `handleMessage` 分发，因为今天 `tools.ts` 是被 `agent.ts` → `store.ts` 一路 import 进面板 bundle 的。

一旦 `Agent` 实例本身跑在 background 里，这条 `sendMessage` 路径变成**自己给自己发运行时消息**——Chrome 允许扩展页面这样做（`runtime.sendMessage` 发出后，同扩展内注册的 `onMessage` 监听器包括发送方自己都能收到），所以理论上不改也能工作，但这是不必要的序列化/异步跳转开销，也让 `background.ts` 的 `handleMessage` 承担了本不需要区分"外部消息 vs 自己内部调用"的复杂度。改造方式：把 `background.ts` 里各消息类型分支的真正逻辑（`executeInTab(...)`、`resolveTargetTab(...)`、`sendToContentScript(...)` 那些调用，例如 `fillForm`、`clickElement`、`extractActivePage` 等函数）抽成独立导出函数，`handleMessage` 的 switch 分支和 `tools.ts` 的 `execute()` 都直接调用这些导出函数，不再让后者经过 `sendMessage` 绕一圈。

这一步在实现阶段需要逐个 `execute()` 过一遍——`tools.ts` 现有的 `sendMessage` 调用点不是每个都对应到需要改的同一批背景函数（部分工具，比如涉及标签页追踪状态清理的调用，已经在直接用 `browser.storage.*` 相关的封装函数，那些本来就不受上下文限制，不用动）。这一步是可选的性能/整洁性清理，不是让迁移本身工作起来的必要条件；可以放在核心迁移（§3-§6）验证通过之后再做，作为单独一次改动更容易评审。

## 8. 面板侧改动

`store.ts` 的改动量最大，但性质是**删除**而不是重写：删掉 `createBrowserAgent` 实例化、`agent.subscribe` 事件处理、`agent.prompt()` 调用、`persistConversationSnapshot` 在 `finally` 里的调用（这些职责整体搬到 background）。面板新增：

- 挂载时建立 Port，发送 `hello`，处理 `snapshot`/`event`/`orphanResolved` 三种回包，把它们映射到今天已有的同一套 Zustand state 更新逻辑（`replaceLastAssistant`、`upsertActivityStep`、`set({ pendingQuestion, ... })` 等大部分函数可以原样保留，只是触发源从"本地 `agent.subscribe` 回调"换成"收到的 `event` 消息"）。
- 用户发消息 / 点确认卡片 / 回答 ask_user / 点"停止"，从"本地函数调用"改成"往 Port 发一条 `PanelToBackground` 消息"。
- `isCurrentRun` 这类"用户切换/清空会话时丢弃迟到回调"的判断逻辑不变，只是判断的输入源从本地闭包变量换成 Port 收到的消息里携带的 run 标识。

## 9. 测试计划

- 新增 `lib/agent/run-registry.test.ts`（`unit` vitest project，node 环境）：`startRun`/`respondConfirm`/`respondQuestion`/`stopRun` 的状态流转，孤儿检测逻辑（mock `browser.storage.session` 里预置一条"曾经在跑"记录，验证冷启动扫描后写入 Dexie 的 failure 消息和 storage 键被清理）。
- `lib/agent/run-state-storage.test.ts`：镜像 `tab-session-storage.test.ts`（如果存在）的写法，覆盖读写往返、写入失败静默降级。
- `agent.ts` 现有测试（`agent-runtime.test.ts`、`pi-agent-hook-forwarding.test.ts`）不需要大改——它测的是 `createBrowserAgentOptions` 的行为，调用方从哪个上下文触发不影响这些用例。
- 面板侧：`entrypoints/sidepanel/store-context.test.tsx`（`ui` vitest project，jsdom）需要新增一个 Port mock（今天 mock 的是 `sendMessage`），覆盖"面板挂载即收到 in-flight 快照并正确渲染"、"面板断开重连后 activity steps 不丢"这两个新场景——这两个正是本次要修的 bug 的直接回归测试。
- `chrome.alarms` 保活和真实的 service worker 30 秒空闲回收，vitest 环境模拟不了 Chrome 的实际调度器；这部分只能靠手工验证（`pnpm dev` 加载扩展，开一个长任务，在 `chrome://serviceworker-internals` 或 DevTools 里观察 worker 存活，切标签页/关面板验证任务不中断）。

## 10. 已知取舍 / 后续可能的跟进

- §2 已声明的非目标：浏览器完全退出/扩展重载/系统休眠导致 worker 彻底死亡时，正在进行的任务无法真正续跑，只能被判失败——这是 `pi-agent-core` 没有可序列化调用栈这一前提下的硬限制，不是这次实现偷懒。如果未来需要真正的断点续跑，需要把 agent 循环整体改造成"每步显式落盘的状态机"，那是比这次改造大得多的工程量，届时应该另开一份设计文档评估是否值得。
- `chrome.alarms` 的最小周期在部分 Chrome 版本/策略下可能被限制得比预期长（企业策略、省电模式），保活效果因环境而异；v1 按标准行为设计，不针对这类边缘限制做特殊探测或降级提示。
- Port 协议（`lib/agent/run-port-protocol.ts`）和 `lib/messaging.ts` 现有的一次性 `sendMessage` 协议是两套独立机制，服务不同的通信模式（推送 vs 请求-响应）；不强行统一到一套类型系统里，避免为了"一致"而让请求-响应类消息也套上不必要的 Port 生命周期管理。
- §7 的 `tools.ts` 直连改造是可选的后续清理项，不阻塞核心迁移合入；如果评审认为范围已经够大，可以拆成独立的第二个 PR。
