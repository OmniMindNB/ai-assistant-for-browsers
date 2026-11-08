# 无 form 结构的提交确认 · 实施计划

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 按 Task 顺序执行，每个 Task 先写失败测试再改实现。

**Goal:** 让「本轮已批量填写 ≥3 个可写字段之后，对按钮类元素的单目标点击 / fill_form 的 submit」逐次请求用户确认，堵住 wj.qq.com 一类无 `<form>` SPA 的提交绕过（ref: 会话导出 runi-请答题-20261108-1734）。

**Architecture:** 判定与计数是纯函数，放 `lib/agent/form-submit.ts`（提交意图判定家族）；计数所需的目标 kind 由 background 查句柄表后随 `ClickElementResult` / `BatchClickOutcome` 带回；运行态计数在 `agent.ts` 的 hooks 闭包里维护（按 tab、URL 一变清零）；探针沿用 `PROBE_CLICK_TARGET` 通道，载荷带 `landedFieldWrites`；确认卡片复用 `PendingConfirmation.kind` 新增 `'commit'` 值。

**Tech Stack:** TypeScript、WXT MV3、vitest（unit / ui project）。

**Spec:** `docs/superpowers/specs/2026-11-08-formless-commit-confirmation-design.md`

## Global Constraints

- `FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES = 3`，唯一常量，定义在 `form-submit.ts`。
- 不做文案启发式；`decideSubmitIntent`（结构判定）行为不变。
- 批量 `fieldIds` 点击、`browser_press_key` 不受新规则影响（探针载荷不带计数即天然免疫）。
- 确认语义沿用 `confirm_always`：逐次询问、绝不读写轮内缓存。
- 隐私政策（zh/en）不动：既有表述在新规则下仍然为真且方向更保守。README 的「只有检测到的表单提交会逐次请求确认」因「只有」变得不准确，需同步改写并更新 `final-review.test.ts` 的两条断言。
- 提交直接在 `main` 上，消息中文。

## Review Focus

1. **计数口径** —— pendingSelection（自动补全待选定）不算落地；批量点击里只有可写字段 kind（text/textarea/select/checkbox/radio/contenteditable）的目标计入；按钮/链接点击不计数。
2. **URL 哨兵** —— 计数带 `{ url?, count }`；地址一变即清零（挂接 afterToolCall 现成的 lastKnownUrl 更新点）；探针发数前再取一次当前地址比对，拿不到或不同则不发（防「填完 → 页面自跳 → 新页点按钮」误伤）。
3. **fill_form 自带字段计入本次探测** —— 探针在执行前发出，`fill_form(N, submit)` 的 N 取 `已跟踪数 + args.fields.length`（敏感字段此刻不可知，上界，接受）。
4. **卡片诚实性** —— `kind: 'commit'` 的标题是「请确认此次点击」而非「表单提交」；摘要说「可能提交或终结表单」。
5. **批量免疫的实现事实** —— `clickElementsByFieldIds` 内部调 `probeSubmitIntent({ submitFieldId })` 不带计数，谓词自然不触发，不需要额外分支。

---

### Task 1: form-submit.ts —— 谓词与计数（纯函数）

**Files:** `lib/agent/form-submit.ts`、`lib/agent/form-submit.test.ts`

**Interfaces:**
- `export const FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES = 3`
- `export interface FormlessCommitInfo { tag?: string; type?: string; role?: string; kind?: FormFieldKind; landedFieldWrites?: number }`
- `export function decideFormlessCommitIntent(info: FormlessCommitInfo): boolean` —— 计数达标 且 目标为按钮类（kind ∈ {submit, button}；无 kind 时 tag=button，或 input[type∈submit|button|image]，或 role=button）
- `export function countLandedFieldWrites(toolName: string, details: unknown): number` —— 按 fill_form outcomes / type / select / click(单点+批量) 的结果形状数落地写入

**Steps:**
- [x] 失败测试：阈值边界（2 否 / 3 是）、按钮类集合（submit/button 是；link/text/checkbox/radio/scrollable 否）、selector 路径（tag=button 是、input[type=text] 否、div[role=button] 是、a 否）、无计数否；countLandedFieldWrites 的六个口径用例（含 pendingSelection、批量混合 kind/status）
- [x] 实现（`import type { FormFieldKind, ClickElementResult, FillFormResult, TypeTextResult, SelectOptionResult } from '@/lib/messaging'`，仅类型，无环）

### Task 2: messaging.ts + form-dom.ts —— 协议与注入函数

**Files:** `lib/messaging.ts`、`lib/agent/form-dom.ts`

**Steps:**
- [x] `ProbeClickTargetPayload` += `landedFieldWrites?: number`（注释：运行上下文，由 agent.ts 提供；批量/按键路径不带）
- [x] `ProbeClickTargetResult` += `commitConfirm?: { landedFieldWrites: number }`、`submitLabel?: string`
- [x] `ClickElementResult` / `BatchClickOutcome` += `kind?: FormFieldKind`（句柄表可查时才有；selector 兜底路径缺省）
- [x] `ProbeClickOutput` += `role?: string`；`probeClickTarget` 返回体加 `role: element.getAttribute('role') || undefined`（序列化注入，不得引用模块作用域——保持内联）

### Task 3: background.ts —— 探针与点击结果接线

**Files:** `entrypoints/background.ts`

**Steps:**
- [x] `probeSubmitIntent`：结构判定为否且探针 found 时，`decideFormlessCommitIntent({ tag, type, role, kind: submitHandle?.kind, landedFieldWrites })` 命中则返回 `commitConfirm`；`submitLabel` 取句柄 expect.label/text，兜底 probe.textContent
- [x] `clickElementByFieldId` 成功返回带 `kind: handle?.kind`；`retryClickAfterRelocation` 带 `kind: refreshed.fields[fieldId]?.kind`
- [x] `clickElementsByFieldIds` 的 outcomes push 带 `kind: handle?.kind`

### Task 4: permissions.ts + confirm-gate.ts —— 闸门

**Files:** `lib/agent/permissions.ts`、`lib/agent/confirm-gate.ts`、对应 test

**Steps:**
- [x] `ToolWriteIntent` += `commitConfirm?: { landedFieldWrites: number }`、`submitLabel?: string`
- [x] 闸门：`intent.isSubmit`（reason 不变）或 `intent.commitConfirm`（reason：`该操作可能提交或终结表单（本轮已批量填写字段），需要单独确认。`）→ `always = true`；confirmArgs 注入 `commitConfirm: true` +（click）`landedFieldWrites` /（fill_form）`submitLabel`
- [x] `ConfirmFn` 与 `resolveConfirmGate` 加 `kind: 'submit' | 'commit'` 透传；commit 的拒绝 block reason：`用户拒绝了这次点击。`
- [x] 失败测试先行：commit 走 always 且 onConfirm 收到 kind='commit'；拒绝文案；结构提交不受影响

### Task 5: agent.ts —— 运行态计数

**Files:** `lib/agent/agent.ts`、`lib/agent/agent.test.ts`

**Steps:**
- [x] hooks 闭包：`landedFieldWrites = new Map<number, { url?: string; count: number }>()`
- [x] afterToolCall：`!isError` 时 `countLandedFieldWrites` 累加（在地址判定之后，导航清零先发生）；NAVIGATION_WATCH_TOOLS 分支 URL 变化处 `delete`；navigate/open_tab/go_back 分支同样 `delete`；观测到地址时刷新 `entry.url` 基线
- [x] `buildSubmitIntentProbePayload(toolName, args, runContext?)`：click 两个分支带 `runContext?.landedFieldWrites`，fill_form 带 `已跟踪数 + args.fields.length`，press_key 不带
- [x] resolveSubmitIntent 闭包：click/fill_form 且该 tab 有计数时取当前地址（fetchTabUrl），url 未观测则采纳为基线，不同或取不到则不发
- [x] 失败测试先行：fill_form outcomes 计数 → 下一次 click 的探针载荷带 landedFieldWrites；URL 变化后清零；地址不符不发

### Task 6: confirm-summary.ts —— 卡片摘要

**Files:** `lib/agent/confirm-summary.ts`、`lib/agent/confirm-summary.test.ts`

**Steps:**
- [x] browser_click：`commitConfirm === true && typeof landedFieldWrites === 'number'` → `AI 已在本页填写 N 个字段，现在想要点击「X」——这一步可能会提交或终结表单。`（fieldId 与 selector 两条路径都要）
- [x] browser_fill_form：`commitConfirm` 时尾部 `，随后点击「submitLabel」——这一步可能会提交或终结表单`（label 缺省用「提交按钮」），替代「并提交表单到 …」

### Task 7: 快照协议 + 面板卡片

**Files:** `lib/agent/run-port-protocol.ts`、`lib/agent/run-registry.ts`、`entrypoints/sidepanel/App.tsx`、`lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`

**Steps:**
- [x] `PendingConfirmation.kind` 加 `'commit'`（注释同步：三种共用应答通道）
- [x] `run-registry.ts` `onConfirm` 加 kind 参数，`kind === 'commit'` 时写入快照
- [x] `ConfirmationCard` 三处文案按 kind 分支（标题 / 批准按钮 / 提示行；拒绝按钮共用）
- [x] i18n：`confirm.commitTitle` / `confirm.commitApprove` / `confirm.commitHint`（zh + en）

### Task 8: 提示词与 README 文案同步

**Files:** `lib/agent/system-prompt.ts`、`lib/agent/system-prompt.test.ts`、`README.md`、`README.zh.md`、`lib/final-review.test.ts`

**Steps:**
- [x] system-prompt 151 行：「只有检测到的表单提交会触发用户确认」→「检测到的表单提交，以及批量填写字段后的提交性点击，会触发用户确认」；同步 system-prompt.test.ts:71 断言
- [x] README.zh.md「只有检测到的表单提交会逐次请求确认」→「表单提交——结构检测到的，或批量填写后的提交性点击——会逐次请求确认」；README.md 英文对应句同步
- [x] final-review.test.ts 两条断言（en 'detected form submissions ask for confirmation each time' / zh '只有检测到的表单提交会逐次请求确认'）改为新文案

### Task 9: 全量验证

- [x] `pnpm compile`
- [x] `pnpm test`
- [x] 检查 `git diff` 无意外文件；提交
