# 任务回放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把一次成功的对话沉淀成录制型快捷指令：run 期间录下成功的写操作轨迹，用户在回复上点"保存为指令"，之后从 `/` 面板选中它、可选补一句话，agent 带着参考轨迹重跑。

**Architecture:** 录制挂在 `run-registry.ts` 已有的 `tool_execution_start/end` 订阅上，纯函数 `trajectory-recorder.ts` 把一次工具调用变成人类可读、已脱敏的 `TrajectoryStep`，随 assistant 消息存档。保存走一个新抽屉组件，结果以 `origin: 'recorded'` 存进现有快捷指令列表。回放是一次普通的 `page` 作用域 agent 运行，只是首轮 prompt 由 `shortcut-prompts.ts` 的新分支拼出参考轨迹——不开任何旁路。

**Tech Stack:** TypeScript、React 19、Zustand、Vitest（`unit` / `ui` / `dom` 三个 project）、WXT。

**Spec:** `docs/superpowers/specs/2026-09-23-task-replay-design.md`

**与设计稿的两处偏差（实现时以本计划为准，Task 11 同步回设计稿）：**

1. 设计稿说"新模块 `lib/agent/task-trajectory.ts`"。本计划拆成两个：`task-trajectory.ts`（类型、校验、人读渲染——面板和设置页也要用）与 `trajectory-recorder.ts`（从工具调用构造步骤——只在 background 用，依赖 `permissions.ts` 和脱敏）。不拆的话，`lib/shortcuts.ts` 和设置页会为了一个类型把 `permissions.ts` 整个拖进 options 页的 bundle。
2. 设计稿写"🔒 填写了一个敏感字段（未记录，需要时用 ask_user 向用户索取）"。这是错的：`fill-form-request.ts` 的 `planFormFill` 在到达页面之前就丢掉了 sensitive 字段——Runi 从来没替用户填过它们。轨迹里改为"🔒 敏感字段「X」需由用户自己填写（未记录）"，回放 prompt 也改为"执行到那里时请用户自己填写"，而不是让模型去索取一个它本来就不能写入的值。

## 执行进度（2026-09-23 更新）

按 superpowers:subagent-driven-development 逐任务执行：每个任务先由实现子代理完成，再经独立审查，必要时修一轮后复审。**Task 1–9 已完成并推送到 origin/main（`45d401e`）；换机器后从 Task 10 继续，不要重做前面的任务。**

| 任务 | 状态 | 提交范围 | 审查 |
|---|---|---|---|
| Task 1 录制器 | ✅ 完成 | `8ac59cd..13fea21` | 修 1 轮后通过 |
| Task 2 校验与渲染 | ✅ 完成 | `13fea21..36060a8` | 修 1 轮后通过 |
| Task 3 字段落库 | ✅ 完成 | `36060a8..890d7e0` | 一次通过 |
| Task 4 run-registry 录制 | ✅ 完成 | `890d7e0..4c7341d` | 一次通过 |
| Task 5 recorded origin | ✅ 完成 | `4c7341d..70fa728` | 一次通过 |
| Task 6 回放 prompt 与 store | ✅ 完成 | `70fa728..177b335` | 一次通过 |
| Task 7 保存草稿 | ✅ 完成 | `177b335..19c9db6` | 一次通过 |
| Task 8 保存抽屉与按钮 | ✅ 完成 | `19c9db6..1df6934` | 一次通过 |
| Task 9 待执行胶囊 | ✅ 完成 | `1df6934..45d401e` | 修 1 轮后通过 |
| Task 10 设置页 | ⏳ 待做 | — | — |
| Task 11 文档与全量验证 | ⏳ 待做 | — | — |
| 全分支最终审查 | ⏳ 待做 | — | — |

**已完成任务与下文计划原文的偏差（代码以实际提交为准）：**

- **Task 1**：`browser_fill_form` 里查不到句柄的字段不录值，只留 `{ target }`（原文会照录）——无法判断是否敏感时 fail-closed。
- **Task 2**：`parseTrajectory` 对 `sensitive` 条目丢掉 `value`/`checked`；`target`/`detail` 超过 `MAX_TRAJECTORY_VALUE_CHARS` 时截断而不是整条拒绝（批量点击的 target 会拼接多个标签，合法地超过标签上限）。
- **Task 4**：计划里"正常结束的 run 以 busy:false 留在 runs 里"的前提是错的——`finally` 末尾会 `runs.delete`。测试的 `settledReply` 改为等 `getRunState(tabId) === undefined` 后读落库记录；另加了 `recordingChainStarted` 标志，只在本轮真有可录调用时才 `await state.recordingChain`（无条件 await 会打乱 8 个旧测试依赖的微任务时序）。
- **Task 6 / Task 9**：仓库级守卫测试 `lib/final-review.test.ts` 把 `runShortcut(...)` / `buildShortcutExecution(...)` 的签名写成了字面串，已随签名变化重新钉住，守卫意图不变。
- **Task 8**：没有照抄 HistoryDrawer 的 Esc + Tab 焦点圈逻辑，而是抽成 `entrypoints/sidepanel/components/useModalKeyboard.ts`，SaveTaskDrawer 与 HistoryDrawer 共用。
- **Task 9**：胶囊挂起时输入框只当纯文本——`/` 命令面板与 `@` 标签页选择器都不弹出，回车一定执行挂起的任务；点工具栏胶囊会先清掉挂起的任务。

**留给最终审查分诊的遗留项：**

- 暂缓（真实但超出本功能范围）：`browser_select` 按选择器寻址、拿不到句柄，底层 `selectOptionInPage` 也没有敏感字段拦截，选中值只经过通用脱敏就进入轨迹。
- 次要：保存抽屉关闭后焦点没有回到书签按钮；`recordingChainStarted` 可改为修掉那几个旧测试后删除；缺"被停止的调用不录""录制失败 run 仍正常收尾"的测试；`validateShortcutConfigs` 里保留 id 检查重复一次；`parseTrajectory` 未限制 `url` 长度；补充说明在两处各自 `trim`；挂起任务时残留的 `mention` 状态未清理。

## Global Constraints

- 直接在 `main` 上提交，不开分支（CLAUDE.md「Git」一节）。代码注释与提交信息用中文。每个提交信息以一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 结尾。
- `MAX_TRAJECTORY_STEPS = 50`、`MAX_TRAJECTORY_VALUE_CHARS = 500`、`MAX_TRAJECTORY_LABEL_CHARS = 120`，只在 `lib/agent/task-trajectory.ts` 定义一次，其他地方 import。
- 录进轨迹的每一段页面来源文字（标签、写入值、选择器、URL、存储键）都先过 `redactText`，再截断——顺序不能反（CLAUDE.md `page-outline.ts` 一节：先截断会把敏感串切成两半，脱敏正则就匹配不上了）。
- sensitive 字段（密码/支付）的值永远不进轨迹。`browser_set_storage` 只记键名不记值；`browser_modify_dom` / `browser_set_style` 不记 HTML/CSS 内容。URL 一律只保留 `origin + pathname`。
- 回放不新增工具、权限、消息类型或执行通道；录制型指令固定 `scope: 'page'`、`customized: true`。
- 所有新增的界面文案与 prompt 文案同时写进 `lib/i18n/locales/zh.ts` 与 `en.ts`（`TranslationKey = keyof typeof zh`，en 缺键会编译失败）。
- 不升级 Dexie schema（新增的是非索引字段）。
- 单测命令：`pnpm vitest run <file>`；全量：`pnpm test`；类型检查：`pnpm compile`。

## Review Focus

1. **写操作把页面带走了**：点"下一步"导致跳转，`background.ts` 用新页面重建句柄表——轨迹里的标签必须仍是**点击前**那个按钮的名字。→ Task 4 的"标签在执行前解析"用例。
2. **敏感字段**：用户期望回放时不会冒出"帮你填了密码"之类的假象，也不期望模型去索取密码后试图写入。→ Task 1 的 sensitive 用例 + Task 2 的敏感文案用例。
3. **存储里有一条损坏的录制指令**（手动改过 storage、旧版本写入）：其余指令照常加载，只有这一条报错。→ Task 5 的"坏轨迹只影响这一条"用例。
4. **在设置页编辑录制指令的名称**：保存后轨迹和 `scope: 'page'` 都还在，不会退化成一条普通 page 指令。→ Task 10 的编辑用例。
5. **对回放出来的回复点"重新生成"**：用的仍是当时那句补充说明，也仍然不预取正文。→ Task 6 的 regenerate 用例。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `lib/agent/task-trajectory.ts`（新建） | `TrajectoryStep` 类型、三个上限常量、`parseTrajectory` 校验、`describeTrajectoryStep` / `renderTrajectoryForPrompt` 人读渲染 |
| `lib/agent/trajectory-recorder.ts`（新建） | `isRecordableTool`、`buildTrajectorySteps`（工具调用 → 步骤，含脱敏与截断）、`appendTrajectorySteps` |
| `lib/agent/run-registry.ts` | 在 `tool_execution_start/end` 里录制，`finally` 里存档 |
| `lib/chat/messages.ts` / `lib/db.ts` / `entrypoints/sidepanel/store.ts` | `trajectory` 字段的持久化与恢复 |
| `lib/shortcuts.ts` | `'recorded'` origin 与校验 |
| `lib/chat/shortcut-prompts.ts` / `lib/chat/shortcut-rerun.ts` / `store.ts` | 回放 prompt、补充说明、跳过预取 |
| `lib/chat/recorded-task.ts`（新建） | `canSaveAsTask` / `buildRecordedTaskDraft` / `toRecordedShortcut` |
| `entrypoints/sidepanel/components/SaveTaskDrawer.tsx`（新建） | 保存抽屉 |
| `entrypoints/sidepanel/App.tsx` / `icons.tsx` | 保存按钮、抽屉挂载、保存成功提示 |
| `entrypoints/sidepanel/components/WorkbenchComposer.tsx` | 待执行胶囊、面板 ▶ 标记、录制指令不进胶囊栏 |
| `components/ShortcutSettings.tsx` | 录制指令的展示、编辑与"恢复预设"文案 |

---

### Task 1: 轨迹步骤的类型与录制器

**Files:**
- Create: `lib/agent/task-trajectory.ts`
- Create: `lib/agent/trajectory-recorder.ts`
- Test: `lib/agent/trajectory-recorder.test.ts`

**Interfaces:**
- Consumes: `redactText` / `defaultRedactionSettings` / `RedactionSettings`（`lib/redaction.ts`）；`FormFieldTable` / `FormFieldHandle`（`lib/agent/tab-form-fields.ts`）；`WRITE_TOOL_NAMES`（`lib/agent/permissions.ts`）。
- Produces:
  ```ts
  // task-trajectory.ts
  export interface TrajectoryValue { target: string; value?: string; checked?: boolean; sensitive?: boolean }
  export interface TrajectoryStep { tool: string; url: string; target?: string; values?: TrajectoryValue[]; detail?: string; sensitive?: boolean }
  export const MAX_TRAJECTORY_STEPS = 50;
  export const MAX_TRAJECTORY_VALUE_CHARS = 500;
  export const MAX_TRAJECTORY_LABEL_CHARS = 120;
  // trajectory-recorder.ts
  export interface RecordInput { toolName: string; args: unknown; url: string | undefined; table: FormFieldTable | undefined; afterUrl?: string; redaction: RedactionSettings }
  export function isRecordableTool(toolName: string): boolean;
  export function buildTrajectorySteps(input: RecordInput): TrajectoryStep[];
  export function appendTrajectorySteps(existing: readonly TrajectoryStep[], added: readonly TrajectoryStep[]): TrajectoryStep[];
  export function stripUrl(raw: string | undefined): string;
  ```

- [x] **Step 1: 建类型文件**

`lib/agent/task-trajectory.ts`（本 Task 只放类型与常量，Task 2 再往里加函数）：

```ts
// 任务回放的参考轨迹：一次成功运行里改变过页面的工具调用，整理成人能读、模型能照着走的步骤
// （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §3）。
//
// 这个文件只放类型、上限和纯渲染——面板、设置页、lib/shortcuts.ts 都要 import 它，
// 所以它不能依赖 permissions.ts / 脱敏这类 background 侧的东西；那一半在 trajectory-recorder.ts。

export interface TrajectoryValue {
  /** 人读的字段名，已带书名号：「报销金额」。 */
  target: string;
  /** 文本类写入值，已脱敏、已截断。 */
  value?: string;
  /** 勾选类字段的目标状态。 */
  checked?: boolean;
  /** 密码/支付字段：值从未写入也从未记录（planFormFill 在到达页面前就丢掉了它）。 */
  sensitive?: boolean;
}

export interface TrajectoryStep {
  tool: string;
  /** 执行时目标页的 origin + pathname；query/hash 里常有订单号和 token，一律不留。 */
  url: string;
  /**
   * 人读的操作对象：按标签定位时是「下一步」，只能退回选择器时是 `button.submit`。
   * fieldId 不进来——它按元素身份分配，跨页面加载必然失效（见 field-id-allocation.ts）。
   */
  target?: string;
  values?: TrajectoryValue[];
  /** 其余关键参数的摘要：按键、跳转地址、存储键、DOM 操作类型等。 */
  detail?: string;
  /** 这一步涉及 sensitive 字段。 */
  sensitive?: boolean;
}

export const MAX_TRAJECTORY_STEPS = 50;
export const MAX_TRAJECTORY_VALUE_CHARS = 500;
export const MAX_TRAJECTORY_LABEL_CHARS = 120;
```

- [x] **Step 2: 写失败的测试**

`lib/agent/trajectory-recorder.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { defaultRedactionSettings } from '@/lib/redaction';
import type { FormFieldTable } from './tab-form-fields';
import {
  MAX_TRAJECTORY_LABEL_CHARS,
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  type TrajectoryStep,
} from './task-trajectory';
import { appendTrajectorySteps, buildTrajectorySteps, isRecordableTool, stripUrl } from './trajectory-recorder';

const redaction = defaultRedactionSettings();
const PAGE = 'https://example.com/expense/new?order=123#top';

function table(fields: Record<string, { label?: string; text?: string; sensitive?: boolean }>): FormFieldTable {
  return {
    url: PAGE,
    fields: Object.fromEntries(
      Object.entries(fields).map(([id, f]) => [
        id,
        { path: [], expect: { tag: 'input', label: f.label, text: f.text }, sensitive: f.sensitive ?? false, kind: 'text' as never },
      ]),
    ),
  };
}

function build(toolName: string, args: unknown, extra: Partial<Parameters<typeof buildTrajectorySteps>[0]> = {}) {
  return buildTrajectorySteps({ toolName, args, url: PAGE, table: undefined, redaction, ...extra });
}

describe('isRecordableTool', () => {
  it('records writes and tab switches, never reads or the outcome report', () => {
    expect(isRecordableTool('browser_click')).toBe(true);
    expect(isRecordableTool('browser_navigate')).toBe(true);
    expect(isRecordableTool('browser_switch_tab')).toBe(true);
    expect(isRecordableTool('browser_read_page')).toBe(false);
    expect(isRecordableTool('browser_get_form')).toBe(false);
    expect(isRecordableTool('report_task_outcome')).toBe(false);
  });
});

describe('stripUrl', () => {
  it('keeps only origin and pathname', () => {
    expect(stripUrl(PAGE)).toBe('https://example.com/expense/new');
    expect(stripUrl(undefined)).toBe('');
    expect(stripUrl('not a url')).toBe('');
  });
});

describe('buildTrajectorySteps', () => {
  it('turns a fill_form call into labelled values on a stripped url', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '280' }, { fieldId: 'f2', checked: true }] },
      { table: table({ f1: { label: '报销金额' }, f2: { label: '差旅' } }) },
    );
    expect(steps).toEqual([
      {
        tool: 'browser_fill_form',
        url: 'https://example.com/expense/new',
        values: [
          { target: '「报销金额」', value: '280' },
          { target: '「差旅」', checked: true },
        ],
      },
    ]);
  });

  it('never records a sensitive field value, only that the user must fill it in', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: 'hunter2' }] },
      { table: table({ f1: { label: '支付密码', sensitive: true } }) },
    );
    expect(steps).toEqual([
      { tool: 'browser_fill_form', url: 'https://example.com/expense/new', values: [{ target: '「支付密码」', sensitive: true }], sensitive: true },
    ]);
    expect(JSON.stringify(steps)).not.toContain('hunter2');
  });

  it('redacts written values before storing them', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '13812345678' }] },
      { table: table({ f1: { label: '手机' } }) },
    );
    expect(JSON.stringify(steps)).not.toContain('13812345678');
  });

  it('splits the submit click of a fill_form call into its own step', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '280' }], submit: { fieldId: 'f9' } },
      { table: table({ f1: { label: '报销金额' }, f9: { text: '提交' } }) },
    );
    expect(steps.map((step) => step.tool)).toEqual(['browser_fill_form', 'browser_click']);
    expect(steps[1].target).toBe('「提交」');
  });

  it('labels a click by its handle, and falls back to the selector when the handle is unknown', () => {
    const t = table({ f3: { text: '下一步' } });
    expect(build('browser_click', { fieldId: 'f3' }, { table: t })[0].target).toBe('「下一步」');
    expect(build('browser_click', { fieldId: 'f404', selector: 'button.next' }, { table: t })[0].target).toBe('`button.next`');
    expect(build('browser_click', { fieldIds: ['f3', 'f3'] }, { table: t })[0].target).toBe('「下一步」、「下一步」');
    expect(build('browser_click', { fieldId: 'f404' }, { table: t })[0].target).toBeUndefined();
  });

  it('records selector-based typing and selection as a single value', () => {
    expect(build('browser_type', { selector: '#q', text: 'runi' })[0]).toEqual({
      tool: 'browser_type', url: 'https://example.com/expense/new', target: '`#q`', values: [{ target: '`#q`', value: 'runi' }],
    });
    expect(build('browser_select', { selector: 'select.city', value: 'SH' })[0].values).toEqual([{ target: '`select.city`', value: 'SH' }]);
  });

  it('keeps navigation targets without their query strings', () => {
    expect(build('browser_navigate', { url: 'https://a.test/x?token=s3cret' })[0].detail).toBe('https://a.test/x');
    expect(build('browser_open_tab', { url: 'https://b.test/y#frag' })[0].detail).toBe('https://b.test/y');
    expect(build('browser_switch_tab', { tabId: 5 }, { afterUrl: 'https://c.test/z?q=1' })[0].detail).toBe('https://c.test/z');
  });

  it('never records storage values or injected markup', () => {
    const storage = build('browser_set_storage', { area: 'local', key: 'draft', value: 'TOKEN-abc' });
    expect(storage[0].detail).toBe('localStorage.draft');
    expect(JSON.stringify(storage)).not.toContain('TOKEN-abc');

    const dom = build('browser_modify_dom', { selector: '.ad', action: 'setHtml', value: '<b>secret</b>' });
    expect(dom[0].detail).toBe('setHtml `.ad`');
    expect(JSON.stringify(dom)).not.toContain('secret');

    const style = build('browser_set_style', { selector: 'body', styles: { color: 'red', background: 'url(x)' } });
    expect(style[0].detail).toBe('`body` { color, background }');
  });

  it('describes key presses with their modifiers', () => {
    expect(build('browser_press_key', { key: 'Enter', modifiers: { ctrl: true } })[0].detail).toBe('Ctrl+Enter');
  });

  it('clips long labels and values to their caps', () => {
    const steps = build(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: 'v'.repeat(MAX_TRAJECTORY_VALUE_CHARS * 2) }] },
      { table: table({ f1: { label: 'L'.repeat(MAX_TRAJECTORY_LABEL_CHARS * 2) } }) },
    );
    const value = steps[0].values![0];
    expect(value.value!.length).toBe(MAX_TRAJECTORY_VALUE_CHARS);
    // 书名号两个字符不计入标签上限。
    expect(value.target.length).toBe(MAX_TRAJECTORY_LABEL_CHARS + 2);
  });

  it('survives a malformed handle table instead of throwing', () => {
    const broken = { url: PAGE, fields: null } as unknown as FormFieldTable;
    expect(() => build('browser_click', { fieldId: 'f1' }, { table: broken })).not.toThrow();
  });

  it('ignores non-object args', () => {
    expect(build('browser_click', undefined)).toEqual([{ tool: 'browser_click', url: 'https://example.com/expense/new' }]);
  });
});

describe('appendTrajectorySteps', () => {
  it('keeps only the most recent steps once the cap is exceeded', () => {
    const make = (n: number): TrajectoryStep => ({ tool: 'browser_click', url: '', detail: String(n) });
    const existing = Array.from({ length: MAX_TRAJECTORY_STEPS }, (_, i) => make(i));
    const next = appendTrajectorySteps(existing, [make(999)]);
    expect(next).toHaveLength(MAX_TRAJECTORY_STEPS);
    expect(next.at(-1)?.detail).toBe('999');
    expect(next[0].detail).toBe('1');
  });
});
```

- [x] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/trajectory-recorder.test.ts`
Expected: FAIL，`Failed to resolve import "./trajectory-recorder"`。

- [x] **Step 4: 实现录制器**

`lib/agent/trajectory-recorder.ts`：

```ts
// 把一次成功的工具调用整理成 TrajectoryStep（ref: 设计稿 §3）。只在 background 的
// run-registry.ts 里用；类型与渲染在 task-trajectory.ts，那边不能依赖这里的 permissions/脱敏。
//
// 顺序铁律：先 redactText 再截断。反过来会把手机号之类切成两半，脱敏正则就认不出来了
// （同 page-outline.ts 的约定）。
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { WRITE_TOOL_NAMES } from './permissions';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';
import {
  MAX_TRAJECTORY_LABEL_CHARS,
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  type TrajectoryStep,
  type TrajectoryValue,
} from './task-trajectory';

export interface RecordInput {
  toolName: string;
  args: unknown;
  /** 执行前目标页的完整 URL；这里负责去掉 query/hash。 */
  url: string | undefined;
  /** 执行前目标页的句柄表——必须是执行前的那一份，见 run-registry.ts 的录制注释。 */
  table: FormFieldTable | undefined;
  /** 只有 browser_switch_tab 用得上：切换之后新目标页的 URL。 */
  afterUrl?: string;
  redaction: RedactionSettings;
}

/**
 * 录哪些调用：所有写工具，外加 browser_switch_tab——它本身只读，但决定了后面的操作落在哪个
 * 页面，丢了它多标签页任务的轨迹就断了。读工具一律不录：回放时模型反正要重读，录进去只会
 * 让它照抄多余的读取轮次。
 */
export function isRecordableTool(toolName: string): boolean {
  return WRITE_TOOL_NAMES.has(toolName) || toolName === 'browser_switch_tab';
}

export function stripUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

export function appendTrajectorySteps(
  existing: readonly TrajectoryStep[],
  added: readonly TrajectoryStep[],
): TrajectoryStep[] {
  // 保留最后 N 步：越靠后越接近"最终走通的那条路"。
  return [...existing, ...added].slice(-MAX_TRAJECTORY_STEPS);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function buildTrajectorySteps(input: RecordInput): TrajectoryStep[] {
  const redact = (text: string) => redactText(text, input.redaction);
  const args = asRecord(input.args);
  const url = redact(stripUrl(input.url));
  const base: TrajectoryStep = { tool: input.toolName, url };

  // getFormFieldsForTab 只做类型断言不校验形状，旧版/畸形的表不能让录制抛出。
  const fields = input.table && input.table.fields && typeof input.table.fields === 'object'
    ? input.table.fields
    : undefined;
  const handleOf = (fieldId: unknown): FormFieldHandle | undefined => {
    if (typeof fieldId !== 'string' || !fields) return undefined;
    const handle = fields[fieldId];
    return handle && typeof handle === 'object' && handle.expect ? handle : undefined;
  };
  const labelTarget = (handle: FormFieldHandle | undefined): string | undefined => {
    const raw = (handle?.expect.label || handle?.expect.text || handle?.expect.name || '').trim();
    return raw ? `「${clip(redact(raw), MAX_TRAJECTORY_LABEL_CHARS)}」` : undefined;
  };
  const selectorTarget = (selector: unknown): string | undefined => {
    const raw = str(selector);
    return raw ? `\`${clip(redact(raw), MAX_TRAJECTORY_LABEL_CHARS)}\`` : undefined;
  };
  const value = (raw: string) => clip(redact(raw), MAX_TRAJECTORY_VALUE_CHARS);

  switch (input.toolName) {
    case 'browser_fill_form': {
      const entries = Array.isArray(args.fields) ? args.fields : [];
      const values: TrajectoryValue[] = entries.map((entry) => {
        const field = asRecord(entry);
        const handle = handleOf(field.fieldId);
        const target = labelTarget(handle) ?? `「${typeof field.fieldId === 'string' ? field.fieldId : '?'}」`;
        // planFormFill 在到达页面之前就丢掉了 sensitive 字段：这里既不录值，也不能暗示"已填"。
        if (handle?.sensitive) return { target, sensitive: true };
        return {
          target,
          ...(typeof field.value === 'string' ? { value: value(field.value) } : {}),
          ...(typeof field.checked === 'boolean' ? { checked: field.checked } : {}),
        };
      });
      const steps: TrajectoryStep[] = [
        { ...base, values, ...(values.some((item) => item.sensitive) ? { sensitive: true } : {}) },
      ];
      const submit = asRecord(args.submit);
      if (submit.fieldId !== undefined) {
        const target = labelTarget(handleOf(submit.fieldId));
        steps.push({ tool: 'browser_click', url, ...(target ? { target } : {}) });
      }
      return steps;
    }
    case 'browser_click': {
      const ids = Array.isArray(args.fieldIds) ? args.fieldIds : args.fieldId !== undefined ? [args.fieldId] : [];
      const labels = ids.map((id) => labelTarget(handleOf(id))).filter((label): label is string => Boolean(label));
      const target = labels.length > 0 ? labels.join('、') : selectorTarget(args.selector);
      return [{ ...base, ...(target ? { target } : {}) }];
    }
    case 'browser_type':
    case 'browser_select': {
      const target = selectorTarget(args.selector) ?? '「?」';
      const raw = input.toolName === 'browser_type' ? args.text : args.value;
      return [{ ...base, target, values: [{ target, ...(typeof raw === 'string' ? { value: value(raw) } : {}) }] }];
    }
    case 'browser_press_key': {
      const modifiers = asRecord(args.modifiers);
      const keys = [
        ...(modifiers.ctrl ? ['Ctrl'] : []),
        ...(modifiers.alt ? ['Alt'] : []),
        ...(modifiers.shift ? ['Shift'] : []),
        ...(modifiers.meta ? ['Meta'] : []),
        ...(str(args.key) ? [String(args.key)] : []),
      ];
      return [{ ...base, ...(keys.length > 0 ? { detail: keys.join('+') } : {}) }];
    }
    case 'browser_scroll': {
      const target = labelTarget(handleOf(args.fieldId)) ?? selectorTarget(args.selector);
      return [{ ...base, ...(target ? { target } : {}) }];
    }
    case 'browser_navigate':
    case 'browser_open_tab': {
      const detail = redact(stripUrl(str(args.url)));
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    case 'browser_switch_tab': {
      const detail = redact(stripUrl(input.afterUrl));
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    case 'browser_set_storage': {
      // 只记键名：storage 的值常常就是 token。
      const area = args.area === 'session' ? 'sessionStorage' : 'localStorage';
      const key = str(args.key);
      return [{ ...base, ...(key ? { detail: `${area}.${clip(redact(key), MAX_TRAJECTORY_LABEL_CHARS)}` } : {}) }];
    }
    case 'browser_modify_dom': {
      const selector = selectorTarget(args.selector);
      const action = str(args.action);
      const detail = [action, selector].filter(Boolean).join(' ');
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    case 'browser_set_style': {
      const selector = selectorTarget(args.selector);
      const properties = Object.keys(asRecord(args.styles));
      const detail = selector
        ? `${selector}${properties.length > 0 ? ` { ${properties.map((p) => clip(redact(p), 40)).join(', ')} }` : ''}`
        : undefined;
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    default:
      return [base];
  }
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/trajectory-recorder.test.ts`
Expected: PASS（全部用例）。

- [x] **Step 6: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [x] **Step 7: 提交**

```bash
git add lib/agent/task-trajectory.ts lib/agent/trajectory-recorder.ts lib/agent/trajectory-recorder.test.ts
git commit -m "feat(agent): 新增任务轨迹录制器——成功的写操作整理成脱敏后的人读步骤" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 轨迹的校验与人读渲染

**Files:**
- Modify: `lib/agent/task-trajectory.ts`
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `lib/agent/task-trajectory.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TrajectoryStep` / `TrajectoryValue` / 三个常量；`Translate`（`@/lib/i18n`，仅类型）。
- Produces:
  ```ts
  export function parseTrajectory(value: unknown): TrajectoryStep[] | null;
  export function describeTrajectoryStep(step: TrajectoryStep, translate: Translate): string;
  export function renderTrajectoryForPrompt(steps: readonly TrajectoryStep[], translate: Translate): string;
  ```
  以及 i18n 键 `trajectory.*`（见 Step 3）。

- [x] **Step 1: 写失败的测试**

`lib/agent/task-trajectory.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import type { Translate, TranslationKey } from '@/lib/i18n';
import {
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  describeTrajectoryStep,
  parseTrajectory,
  renderTrajectoryForPrompt,
  type TrajectoryStep,
} from './task-trajectory';

function translator(dict: Record<TranslationKey, string>): Translate {
  return ((key: TranslationKey, vars?: Record<string, string | number>) =>
    dict[key].replace(/\{(\w+)\}/g, (match, name: string) =>
      vars && name in vars ? String(vars[name]) : match,
    )) as Translate;
}
const t = translator(en);
const zhT = translator(zh);

const URL_A = 'https://example.com/expense/new';

describe('parseTrajectory', () => {
  const valid: TrajectoryStep[] = [
    { tool: 'browser_fill_form', url: URL_A, values: [{ target: '「金额」', value: '280' }, { target: '「密码」', sensitive: true }], sensitive: true },
    { tool: 'browser_click', url: URL_A, target: '「下一步」' },
  ];

  it('accepts a well-formed trajectory and returns a clean copy', () => {
    const withJunk = [{ ...valid[0], extra: 'drop me' }, valid[1]];
    const parsed = parseTrajectory(withJunk);
    expect(parsed).toEqual(valid);
    expect(parsed?.[0]).not.toHaveProperty('extra');
  });

  it('rejects anything that is not a non-empty, capped array of steps', () => {
    expect(parseTrajectory(undefined)).toBeNull();
    expect(parseTrajectory([])).toBeNull();
    expect(parseTrajectory(Array.from({ length: MAX_TRAJECTORY_STEPS + 1 }, () => valid[1]))).toBeNull();
    expect(parseTrajectory([{ tool: '', url: URL_A }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: 3 }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: URL_A, values: 'x' }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: URL_A, values: [{ target: '「a」', value: 'v'.repeat(MAX_TRAJECTORY_VALUE_CHARS + 1) }] }])).toBeNull();
    expect(parseTrajectory([{ tool: 'browser_click', url: URL_A, values: [{ target: '「a」', checked: 'yes' }] }])).toBeNull();
  });
});

describe('describeTrajectoryStep', () => {
  it('describes a single-value fill without a list prefix', () => {
    expect(describeTrajectoryStep({ tool: 'browser_fill_form', url: URL_A, values: [{ target: '「Amount」', value: '280' }] }, t))
      .toBe('Set 「Amount」 to "280"');
  });

  it('lists several values of one fill call', () => {
    const step: TrajectoryStep = {
      tool: 'browser_fill_form',
      url: URL_A,
      values: [{ target: '「Amount」', value: '280' }, { target: '「Travel」', checked: true }, { target: '「Memo」', checked: false }],
    };
    expect(describeTrajectoryStep(step, t)).toBe('Fill in the form: Set 「Amount」 to "280"; Check 「Travel」; Uncheck 「Memo」');
  });

  it('tells the user to fill sensitive fields themselves instead of claiming they were filled', () => {
    const step: TrajectoryStep = { tool: 'browser_fill_form', url: URL_A, values: [{ target: '「支付密码」', sensitive: true }], sensitive: true };
    expect(describeTrajectoryStep(step, zhT)).toBe('🔒 敏感字段「支付密码」需由用户自己填写（未记录）');
  });

  it('describes clicks, with a fallback when the target is unknown', () => {
    expect(describeTrajectoryStep({ tool: 'browser_click', url: URL_A, target: '「下一步」' }, zhT)).toBe('点击「下一步」');
    expect(describeTrajectoryStep({ tool: 'browser_click', url: URL_A }, zhT)).toBe('点击页面上的一个元素');
  });

  it('describes navigation and key presses from their detail', () => {
    expect(describeTrajectoryStep({ tool: 'browser_navigate', url: URL_A, detail: 'https://a.test/x' }, t)).toBe('Go to https://a.test/x');
    expect(describeTrajectoryStep({ tool: 'browser_press_key', url: URL_A, detail: 'Enter' }, t)).toBe('Press Enter');
  });

  it('falls back to the raw tool name for tools it has no wording for', () => {
    expect(describeTrajectoryStep({ tool: 'browser_future_tool', url: URL_A, detail: 'x' }, t)).toBe('browser_future_tool: x');
  });
});

describe('renderTrajectoryForPrompt', () => {
  it('numbers steps and collapses repeated pages', () => {
    const steps: TrajectoryStep[] = [
      { tool: 'browser_fill_form', url: URL_A, values: [{ target: '「报销金额」', value: '280' }] },
      { tool: 'browser_click', url: URL_A, target: '「下一步」' },
      { tool: 'browser_click', url: 'https://example.com/expense/confirm', target: '「确认」' },
      { tool: 'browser_close_tab', url: '' },
    ];
    expect(renderTrajectoryForPrompt(steps, zhT)).toBe([
      `1. [${URL_A}] 「报销金额」填入 "280"`,
      '2. [同上] 点击「下一步」',
      '3. [https://example.com/expense/confirm] 点击「确认」',
      '4. 关闭当前标签页',
    ].join('\n'));
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/task-trajectory.test.ts`
Expected: FAIL，`parseTrajectory is not a function`（或导入报错）。

- [x] **Step 3: 加 i18n 键**

在 `lib/i18n/locales/zh.ts` 的对象里（放在 `store.*` 一组之后）追加：

```ts
  'trajectory.click': '点击{target}',
  'trajectory.clickUnknown': '点击页面上的一个元素',
  'trajectory.someField': '某个字段',
  'trajectory.fillValue': '{target}填入 {value}',
  'trajectory.fillChecked': '勾选{target}',
  'trajectory.fillUnchecked': '取消勾选{target}',
  'trajectory.fillSensitive': '🔒 敏感字段{target}需由用户自己填写（未记录）',
  'trajectory.fillList': '填写表单：{items}',
  'trajectory.listSeparator': '；',
  'trajectory.type': '在{target}输入 {value}',
  'trajectory.select': '在{target}选择 {value}',
  'trajectory.pressKey': '按下 {detail}',
  'trajectory.scroll': '滚动页面',
  'trajectory.scrollTo': '滚动到{target}',
  'trajectory.navigate': '打开 {detail}',
  'trajectory.openTab': '在新标签页打开 {detail}',
  'trajectory.switchTab': '切换到标签页 {detail}',
  'trajectory.closeTab': '关闭当前标签页',
  'trajectory.goBack': '返回上一页',
  'trajectory.setStorage': '写入存储项 {detail}',
  'trajectory.modifyDom': '修改页面元素：{detail}',
  'trajectory.setStyle': '修改样式：{detail}',
  'trajectory.generic': '{tool}：{detail}',
  'trajectory.sameUrl': '同上',
```

在 `lib/i18n/locales/en.ts` 的对应位置追加：

```ts
  'trajectory.click': 'Click {target}',
  'trajectory.clickUnknown': 'Click an element on the page',
  'trajectory.someField': 'a field',
  'trajectory.fillValue': 'Set {target} to {value}',
  'trajectory.fillChecked': 'Check {target}',
  'trajectory.fillUnchecked': 'Uncheck {target}',
  'trajectory.fillSensitive': '🔒 Sensitive field {target} must be filled in by the user (not recorded)',
  'trajectory.fillList': 'Fill in the form: {items}',
  'trajectory.listSeparator': '; ',
  'trajectory.type': 'Type {value} into {target}',
  'trajectory.select': 'Select {value} in {target}',
  'trajectory.pressKey': 'Press {detail}',
  'trajectory.scroll': 'Scroll the page',
  'trajectory.scrollTo': 'Scroll to {target}',
  'trajectory.navigate': 'Go to {detail}',
  'trajectory.openTab': 'Open {detail} in a new tab',
  'trajectory.switchTab': 'Switch to the tab at {detail}',
  'trajectory.closeTab': 'Close the current tab',
  'trajectory.goBack': 'Go back',
  'trajectory.setStorage': 'Write storage key {detail}',
  'trajectory.modifyDom': 'Modify page elements: {detail}',
  'trajectory.setStyle': 'Change styles: {detail}',
  'trajectory.generic': '{tool}: {detail}',
  'trajectory.sameUrl': 'same page',
```

- [x] **Step 4: 实现校验与渲染**

在 `lib/agent/task-trajectory.ts` 顶部加 `import type { Translate } from '@/lib/i18n';`，文件末尾追加：

```ts
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function parseValue(raw: unknown): TrajectoryValue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.target !== 'string' || !item.target) return null;
  if (!isOptionalString(item.value) || (item.value?.length ?? 0) > MAX_TRAJECTORY_VALUE_CHARS) return null;
  if (item.checked !== undefined && typeof item.checked !== 'boolean') return null;
  if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') return null;
  return {
    target: item.target,
    ...(item.value !== undefined ? { value: item.value } : {}),
    ...(item.checked !== undefined ? { checked: item.checked as boolean } : {}),
    ...(item.sensitive ? { sensitive: true } : {}),
  };
}

/**
 * 存储里读回来的轨迹一律当不可信数据：用户可能手改过 storage，也可能是别的版本写的。
 * 返回只含已知字段的干净副本；任何一处不合法就整体返回 null，由调用方决定怎么报错。
 */
export function parseTrajectory(value: unknown): TrajectoryStep[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRAJECTORY_STEPS) return null;
  const steps: TrajectoryStep[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.tool !== 'string' || !item.tool) return null;
    if (typeof item.url !== 'string') return null;
    if (!isOptionalString(item.target) || !isOptionalString(item.detail)) return null;
    if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') return null;
    let values: TrajectoryValue[] | undefined;
    if (item.values !== undefined) {
      if (!Array.isArray(item.values)) return null;
      values = [];
      for (const rawValue of item.values) {
        const parsed = parseValue(rawValue);
        if (!parsed) return null;
        values.push(parsed);
      }
    }
    steps.push({
      tool: item.tool,
      url: item.url,
      ...(item.target !== undefined ? { target: item.target } : {}),
      ...(values ? { values } : {}),
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
      ...(item.sensitive ? { sensitive: true } : {}),
    });
  }
  return steps;
}

function describeValue(value: TrajectoryValue, translate: Translate): string {
  if (value.sensitive) return translate('trajectory.fillSensitive', { target: value.target });
  if (value.checked === true) return translate('trajectory.fillChecked', { target: value.target });
  if (value.checked === false) return translate('trajectory.fillUnchecked', { target: value.target });
  return translate('trajectory.fillValue', { target: value.target, value: JSON.stringify(value.value ?? '') });
}

/**
 * 一步的人读描述。保存抽屉和回放 prompt 共用这一个函数：用户在抽屉里看到的，
 * 就是模型将收到的，两边不能各写一份。写入值用 JSON.stringify 包起来，边界一眼可见。
 */
export function describeTrajectoryStep(step: TrajectoryStep, translate: Translate): string {
  const target = step.target ?? translate('trajectory.someField');
  const detail = step.detail ?? '';
  switch (step.tool) {
    case 'browser_fill_form': {
      const values = step.values ?? [];
      if (values.length === 1) return describeValue(values[0], translate);
      return translate('trajectory.fillList', {
        items: values.map((value) => describeValue(value, translate)).join(translate('trajectory.listSeparator')),
      });
    }
    case 'browser_click':
      return step.target ? translate('trajectory.click', { target: step.target }) : translate('trajectory.clickUnknown');
    case 'browser_type':
      return translate('trajectory.type', { target, value: JSON.stringify(step.values?.[0]?.value ?? '') });
    case 'browser_select':
      return translate('trajectory.select', { target, value: JSON.stringify(step.values?.[0]?.value ?? '') });
    case 'browser_press_key':
      return translate('trajectory.pressKey', { detail });
    case 'browser_scroll':
      return step.target ? translate('trajectory.scrollTo', { target: step.target }) : translate('trajectory.scroll');
    case 'browser_navigate':
      return translate('trajectory.navigate', { detail });
    case 'browser_open_tab':
      return translate('trajectory.openTab', { detail });
    case 'browser_switch_tab':
      return translate('trajectory.switchTab', { detail });
    case 'browser_close_tab':
      return translate('trajectory.closeTab');
    case 'browser_go_back':
      return translate('trajectory.goBack');
    case 'browser_set_storage':
      return translate('trajectory.setStorage', { detail });
    case 'browser_modify_dom':
      return translate('trajectory.modifyDom', { detail });
    case 'browser_set_style':
      return translate('trajectory.setStyle', { detail });
    default:
      return translate('trajectory.generic', { tool: step.tool, detail });
  }
}

/** 回放 prompt 里的步骤清单：编号 + 所在页面；连续同页写成「同上」，省 token 也更好读。 */
export function renderTrajectoryForPrompt(steps: readonly TrajectoryStep[], translate: Translate): string {
  let previousUrl: string | undefined;
  return steps
    .map((step, index) => {
      const where = !step.url ? '' : step.url === previousUrl ? `[${translate('trajectory.sameUrl')}] ` : `[${step.url}] `;
      if (step.url) previousUrl = step.url;
      return `${index + 1}. ${where}${describeTrajectoryStep(step, translate)}`;
    })
    .join('\n');
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/task-trajectory.test.ts lib/agent/trajectory-recorder.test.ts`
Expected: PASS。

- [x] **Step 6: 类型检查**

Run: `pnpm compile`
Expected: 无错误（en 与 zh 键一致）。

- [x] **Step 7: 提交**

```bash
git add lib/agent/task-trajectory.ts lib/agent/task-trajectory.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(agent): 轨迹校验与人读渲染——抽屉和回放 prompt 共用一份描述" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 消息上的 `trajectory` 字段落库与恢复

**Files:**
- Modify: `lib/chat/messages.ts`（`ChatMessage` 接口、`toMessageRecords`）
- Modify: `lib/db.ts`（`ChatMessageRecord`）
- Modify: `entrypoints/sidepanel/store.ts:942-958`（`openConversation` 里 records → messages 的映射）
- Test: `lib/chat/messages.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TrajectoryStep`。
- Produces: `ChatMessage.trajectory?: TrajectoryStep[]`、`ChatMessageRecord.trajectory?: TrajectoryStep[]`。

- [x] **Step 1: 写失败的测试**

在 `lib/chat/messages.test.ts` 末尾追加（若文件顶部还没有 `toMessageRecords` 的 import，把它加进现有的 `./messages` import 里）：

```ts
describe('toMessageRecords trajectory', () => {
  it('persists the recorded trajectory of an assistant reply', () => {
    const trajectory = [{ tool: 'browser_click', url: 'https://example.com/a', target: '「下一步」' }];
    const records = toMessageRecords('conv-1', [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'done', createdAt: 2, trajectory },
    ]);
    expect(records[1].trajectory).toEqual(trajectory);
    expect(records[0].trajectory).toBeUndefined();
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/chat/messages.test.ts`
Expected: FAIL（类型检查不参与 vitest，因此表现为 `expected undefined to deeply equal [...]`）。

- [x] **Step 3: 加字段并接通映射**

`lib/chat/messages.ts`：顶部加 `import type { TrajectoryStep } from '@/lib/agent/task-trajectory';`，在 `ChatMessage` 的 `rerun?` 之后加：

```ts
  /**
   * 本轮成功执行过的写操作参考轨迹（已脱敏）；仅 assistant 消息、且这一轮真的动过页面时才有值。
   * 供「保存为指令」取用（ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §3.5）。
   */
  trajectory?: TrajectoryStep[];
```

`toMessageRecords` 的映射对象里 `rerun: message.rerun,` 之后加一行 `trajectory: message.trajectory,`。

`lib/db.ts`：顶部加 `import type { TrajectoryStep } from './agent/task-trajectory';`，在 `ChatMessageRecord` 的 `rerun?` 之后加：

```ts
  /**
   * 本轮成功执行过的写操作参考轨迹（已脱敏），供「保存为指令」取用。
   * 不建索引，同上无需 Dexie 版本迁移；存量记录无此字段即视为这一轮没有可保存的轨迹。
   */
  trajectory?: TrajectoryStep[];
```

`entrypoints/sidepanel/store.ts` 里 `openConversation` 把 records 映射成 messages 的对象（`rerun: r.rerun,` 那一行）之后加 `trajectory: r.trajectory,`。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/chat/messages.test.ts`
Expected: PASS。

- [x] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 无错误。

- [x] **Step 6: 提交**

```bash
git add lib/chat/messages.ts lib/chat/messages.test.ts lib/db.ts entrypoints/sidepanel/store.ts
git commit -m "feat(chat): assistant 消息带上参考轨迹并随历史落库" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: run-registry 录制与存档

**Files:**
- Modify: `lib/agent/run-registry.ts`（`RunState`、`startRun` 的状态初始化、事件订阅、`finally` 存档）
- Test: `lib/agent/run-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isRecordableTool` / `buildTrajectorySteps` / `appendTrajectorySteps` / `TrajectoryStep`；已有的 `getFormFieldsForTab`、`fetchTargetUrl`、`loadRedactionSettings`、`defaultRedactionSettings`。
- Produces: 每轮结束时最后一条 assistant 消息上的 `trajectory`（Task 3 定义的字段）。

- [x] **Step 1: 写失败的测试**

在 `lib/agent/run-registry.test.ts` 末尾追加一个 describe（复用文件里已有的 `mocks`、`makeFakeAgent`、`makeRequest`、`installTabsStub`、`installAlarmsStub`）：

```ts
describe('run-registry trajectory recording', () => {
  beforeEach(() => {
    installAlarmsStub();
  });

  // 正常结束的 run 不会从 runs 里删掉，而是以 busy: false 留着（见 'creates a RunState...' 用例），
  // 所以等的是 busy 翻成 false；finally 里先改 state.messages、后置 busy=false，此时存档已就位。
  async function settledReply(tabId: number): Promise<any> {
    await vi.waitFor(() => expect(getRunState(tabId)?.busy).toBe(false));
    return getRunState(tabId)!.messages.at(-1);
  }

  function lastPersistedMessage(): any {
    return mocks.replaceConversationMessages.mock.calls.at(-1)?.[1]?.at(-1);
  }

  // toMessageRecords 会丢掉末尾内容为空的 assistant 占位，所以要落库的用例得先流一段文字进去。
  const replyText = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];

  it('records a successful write with its label and archives it on the reply', async () => {
    installTabsStub('https://example.com/form?token=abc');
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_fill_form', args: { fields: [{ fieldId: 'f1', value: 'hello' }] } },
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_fill_form', isError: false, result: {} },
        ...replyText,
      ]),
    );

    await startRun(makeRequest({ tabId: 61 }));
    const expected = [
      { tool: 'browser_fill_form', url: 'https://example.com/form', values: [{ target: '「邮箱」', value: 'hello' }] },
    ];
    expect((await settledReply(61)).trajectory).toEqual(expected);
    await vi.waitFor(() => expect(lastPersistedMessage()?.trajectory).toEqual(expected));
  });

  it('does not record failed calls or read-only tools', async () => {
    installTabsStub();
    mocks.createBrowserAgent.mockReturnValue(
      makeFakeAgent([
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_click', args: { fieldId: 'f1' } },
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_click', isError: true, result: {} },
        { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'browser_read_page', args: {} },
        { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'browser_read_page', isError: false, result: {} },
      ]),
    );

    await startRun(makeRequest({ tabId: 62 }));

    expect(await settledReply(62)).not.toHaveProperty('trajectory');
  });

  it('resolves the label from the handle table as it was before the tool ran', async () => {
    installTabsStub();
    const original = mocks.getFormFieldsForTab.getMockImplementation()!;
    let replaced = false;
    mocks.getFormFieldsForTab.mockImplementation(async () => ({
      url: 'https://example.com/form',
      fields: { f1: { path: [], expect: { tag: 'button', text: replaced ? '返回首页' : '下一步' }, sensitive: false, kind: 'button' } },
    }) as never);
    try {
      const agent = makeFakeAgent([]);
      agent.prompt = vi.fn(async () => {
        const listener = agent.subscribe.mock.calls[0][0] as (event: unknown) => void;
        listener({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_click', args: { fieldId: 'f1' } });
        // 点击把页面带走了：background 用新页面重建了句柄表，同一个 f1 现在指向别的东西。
        replaced = true;
        listener({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_click', isError: false, result: {} });
      });
      mocks.createBrowserAgent.mockReturnValue(agent);

      await startRun(makeRequest({ tabId: 63 }));

      expect((await settledReply(63)).trajectory?.[0]?.target).toBe('「下一步」');
    } finally {
      mocks.getFormFieldsForTab.mockImplementation(original);
    }
  });

  it('records the destination of a tab switch after it happened', async () => {
    (globalThis as any).browser = {
      ...(globalThis as any).browser,
      tabs: { get: vi.fn(async (id: number) => ({ id, url: id === 99 ? 'https://other.test/p?x=1' : 'https://example.com/form' })) },
    };
    const agent = makeFakeAgent([]);
    agent.prompt = vi.fn(async () => {
      const listener = agent.subscribe.mock.calls[0][0] as (event: unknown) => void;
      listener({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'browser_switch_tab', args: { tabId: 99 } });
      getRunState(64)!.session.currentTabId = 99;
      listener({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'browser_switch_tab', isError: false, result: {} });
    });
    mocks.createBrowserAgent.mockReturnValue(agent);

    await startRun(makeRequest({ tabId: 64 }));

    expect((await settledReply(64)).trajectory?.[0]).toEqual({
      tool: 'browser_switch_tab',
      url: 'https://example.com/form',
      detail: 'https://other.test/p',
    });
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/run-registry.test.ts -t "trajectory recording"`
Expected: FAIL——第 1、3、4 个用例拿到的 `trajectory` 是 `undefined`。

- [x] **Step 3: 扩展 RunState 与初始化**

`lib/agent/run-registry.ts` 顶部加：

```ts
import { appendTrajectorySteps, buildTrajectorySteps, isRecordableTool } from './trajectory-recorder';
import type { TrajectoryStep } from './task-trajectory';
import type { FormFieldTable } from './tab-form-fields';
```

`RunState` 接口末尾加：

```ts
  /** 本轮成功执行过的写操作参考轨迹（ref: 设计稿 §3）；finally 里挂到最后一条 assistant 消息上。 */
  trajectory: TrajectoryStep[];
  /**
   * toolCallId → 执行前抓到的目标页 URL 和句柄表。必须在 tool_execution_start 当场发起：
   * 点完"下一步"页面就跳走了，background 会用新页面重建句柄表，等到 end 再查，查到的是
   * 另一个页面上的同名 fieldId。
   */
  recordingStarts: Map<string, Promise<RecordingContext>>;
  /** 录制是异步的（要等上面的查询），串成一条链：finally 存档前 await 它，保证不丢最后一步。 */
  recordingChain: Promise<void>;
```

在 `RunState` 接口上方加：

```ts
interface RecordingContext {
  url: string | undefined;
  table: FormFieldTable | undefined;
}

async function captureRecordingContext(tabId: number): Promise<RecordingContext> {
  const [url, table] = await Promise.all([
    fetchTargetUrl(tabId),
    getFormFieldsForTab(tabId).catch(() => undefined),
  ]);
  return { url, table };
}
```

`startRun` 里 `const state: RunState = { ... }` 的字面量末尾（`stopRequested: false,` 之后）加：

```ts
    trajectory: [],
    recordingStarts: new Map(),
    recordingChain: Promise.resolve(),
```

在 `const unsubscribe = agent.subscribe(...)` 之前加：

```ts
  // 录制用的脱敏配置一轮只读一次；读不到就用内置规则，绝不因此让录制（更不能让 run）失败。
  const recordRedaction = loadRedactionSettings().catch(() => defaultRedactionSettings());
```

- [x] **Step 4: 在事件订阅里录制**

在 `tool_execution_start` 分支里（`state.pendingToolArgs.set(...)` 之后）加：

```ts
      if (isRecordableTool(event.toolName) && !state.recordingStarts.has(event.toolCallId)) {
        state.recordingStarts.set(event.toolCallId, captureRecordingContext(state.session.currentTabId));
      }
```

在 `tool_execution_end` 分支里，紧跟 `state.pendingToolArgs.delete(event.toolCallId);` 之后加：

```ts
      const recordingStart = state.recordingStarts.get(event.toolCallId);
      state.recordingStarts.delete(event.toolCallId);
      // 只录成功的调用：失败和重试不进轨迹，这正是"照着成功的那条路走"的意思。
      if (recordingStart && !event.isError && !state.terminatedToolCallIds.has(event.toolCallId)) {
        const toolName = event.toolName;
        const args = info?.args;
        state.recordingChain = state.recordingChain
          .then(async () => {
            const [context, redaction] = await Promise.all([recordingStart, recordRedaction]);
            const afterUrl = toolName === 'browser_switch_tab'
              ? await fetchTargetUrl(state.session.currentTabId)
              : undefined;
            state.trajectory = appendTrajectorySteps(
              state.trajectory,
              buildTrajectorySteps({ toolName, args, url: context.url, table: context.table, afterUrl, redaction }),
            );
          })
          // 录制是锦上添花：任何失败都只是少录一步，绝不能让 run 的收尾卡住。
          .catch(() => undefined);
      }
```

注意 `browser_switch_tab` 的 `afterUrl` 读的是 `end` 那一刻的 `state.session.currentTabId`——`tool_execution_end` 是同步事件，而 `then` 回调在它之后才执行，此时 session 已经切过去了；Step 1 的第 4 个用例覆盖这一点。

- [x] **Step 5: finally 里存档**

在 `finally` 块里，`if (runs.get(state.tabId) === state) {` 这一行**之前**加：

```ts
      // 最后一步的录制可能还在等句柄表查询；先让它落地再存档，否则最后一步（往往就是"提交"）会丢。
      await state.recordingChain;
```

在存档对象里 `...(state.contextTruncated ? { contextTruncated: true } : {}),` 之后加：

```ts
              ...(state.trajectory.length > 0 ? { trajectory: state.trajectory } : {}),
```

- [x] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/run-registry.test.ts`
Expected: PASS（新用例与全部既有用例）。

- [x] **Step 7: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。

```bash
git add lib/agent/run-registry.ts lib/agent/run-registry.test.ts
git commit -m "feat(agent): run 期间录制成功的写操作，轮次结束时存档到回复上" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 快捷指令支持 `recorded` origin

**Files:**
- Modify: `lib/shortcuts.ts`（`ShortcutOrigin`、`ShortcutConfig`、`ResolvedShortcut`、`validateShortcutConfigs`）
- Test: `lib/shortcuts.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `parseTrajectory`、`TrajectoryStep`。
- Produces: `ShortcutOrigin = 'builtin' | 'custom' | 'recorded'`；`ShortcutConfig.trajectory?` / `ResolvedShortcut.trajectory?`；`resolveShortcut` 对 recorded 原样带出 `trajectory`。

- [x] **Step 1: 写失败的测试**

在 `lib/shortcuts.test.ts` 末尾追加：

```ts
describe('recorded shortcuts', () => {
  const recorded = {
    id: 'shortcut-rec-1',
    origin: 'recorded',
    scope: 'page',
    customized: true,
    name: '差旅报销单',
    prompt: '帮我填一张差旅报销单',
    trajectory: [{ tool: 'browser_click', url: 'https://example.com/a', target: '「下一步」' }],
  };

  it('accepts a well-formed recorded shortcut and keeps its trajectory', () => {
    const result = validateShortcutConfigs([recorded]);
    expect(result.errors).toEqual([]);
    expect(result.shortcuts).toEqual([recorded]);
  });

  it('resolves a recorded shortcut with its own name, prompt and trajectory', () => {
    const resolved = resolveShortcut(recorded as ShortcutConfig, translator(en));
    expect(resolved.name).toBe('差旅报销单');
    expect(resolved.trajectory).toEqual(recorded.trajectory);
  });

  it('rejects recorded shortcuts that are not page-scoped, not customized, or lack a valid trajectory', () => {
    expect(validateShortcutConfigs([{ ...recorded, scope: 'none' }]).errors).toHaveLength(1);
    expect(validateShortcutConfigs([{ ...recorded, customized: false }]).errors).toHaveLength(1);
    expect(validateShortcutConfigs([{ ...recorded, trajectory: [] }]).errors).toHaveLength(1);
    expect(validateShortcutConfigs([{ ...recorded, trajectory: undefined }]).errors).toHaveLength(1);
    expect(validateShortcutConfigs([{ ...recorded, id: BUILTIN_SUMMARIZE_ID }]).errors).toHaveLength(1);
  });

  it('rejects a trajectory on a shortcut that is not recorded', () => {
    const custom = { id: 'c1', origin: 'custom', scope: 'page', customized: true, name: 'n', prompt: 'p', trajectory: recorded.trajectory };
    expect(validateShortcutConfigs([custom]).errors).toHaveLength(1);
  });

  it('flags only the corrupted recorded entry and keeps the rest', () => {
    const result = validateShortcutConfigs([
      recorded,
      { ...recorded, id: 'shortcut-rec-2', trajectory: [{ tool: 'browser_click' }] },
    ]);
    expect(result.shortcuts.map((item) => item.id)).toEqual(['shortcut-rec-1']);
    expect(result.errors).toEqual(['Shortcut at index 1 has an invalid trajectory.']);
  });
});
```

（`translator` 与 `en` 已在文件顶部定义/导入。）

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/shortcuts.test.ts -t "recorded shortcuts"`
Expected: FAIL，`has an invalid origin.`。

- [x] **Step 3: 实现**

`lib/shortcuts.ts`：

1. 顶部加 `import { parseTrajectory, type TrajectoryStep } from './agent/task-trajectory';`。
2. `export type ShortcutOrigin = 'builtin' | 'custom' | 'recorded';`，并在其上方加注释：

```ts
/**
 * recorded：从一次成功的对话保存下来的任务指令（ref: docs/superpowers/specs/2026-09-23-task-replay-design.md）。
 * 固定 page 作用域、customized: true，带一份参考轨迹；不参与 BUILTINS_REVISION 的演进。
 */
```

3. `ShortcutConfig` 与 `ResolvedShortcut` 各加一行 `trajectory?: TrajectoryStep[];`。
4. `validateShortcutConfigs`：
   - origin 检查改为 `if (item.origin !== 'builtin' && item.origin !== 'custom' && item.origin !== 'recorded') {`。
   - 紧跟现有的 `if (item.origin === 'custom' && !item.customized) { ... }` 之后加：

```ts
    if (item.origin === 'recorded') {
      if (BUILTIN_IDS.has(id)) {
        errors.push(`${label} cannot use a reserved built-in id: ${id}.`);
        return;
      }
      if (item.scope !== 'page') {
        errors.push(`${label} must use page scope for a recorded shortcut.`);
        return;
      }
      if (item.customized !== true) {
        errors.push(`${label} must mark a recorded shortcut as customized.`);
        return;
      }
    }
    const trajectory = item.origin === 'recorded' ? parseTrajectory(item.trajectory) : undefined;
    if (item.origin === 'recorded' && !trajectory) {
      errors.push(`${label} has an invalid trajectory.`);
      return;
    }
    if (item.origin !== 'recorded' && item.trajectory !== undefined) {
      errors.push(`${label} cannot carry a trajectory.`);
      return;
    }
```

   - `const requiresText = item.origin === 'custom' || item.customized;` 改为 `const requiresText = item.origin !== 'builtin' || item.customized;`。
   - `shortcuts.push({...})` 里 `...(prompt !== undefined ? { prompt } : {}),` 之后加 `...(trajectory ? { trajectory } : {}),`。

`resolveShortcut` 不用改：recorded 的 `customized` 恒为 `true`，走 `config.customized || ...` 分支原样展开 `config`，`trajectory` 随之带出。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/shortcuts.test.ts`
Expected: PASS。

- [x] **Step 5: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。若 `components/ShortcutSettings.tsx` 等处对 `ShortcutOrigin` 做了穷举 switch 导致报错，在该处给 `'recorded'` 补与 `'custom'` 相同的分支（Task 10 会再细化）。

```bash
git add lib/shortcuts.ts lib/shortcuts.test.ts
git commit -m "feat(shortcuts): 新增 recorded 类型的快捷指令，校验其参考轨迹" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 回放 prompt、补充说明与重新生成

**Files:**
- Modify: `lib/chat/shortcut-prompts.ts`
- Modify: `lib/chat/shortcut-rerun.ts`
- Modify: `entrypoints/sidepanel/store.ts`（`ChatState.runShortcut` 签名、`runShortcut`、`regenerate`、`RunShortcutOptions`、`runResolvedShortcut`）
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `lib/chat/shortcut-prompts.test.ts`、`entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `renderTrajectoryForPrompt`；Task 5 的 `ResolvedShortcut.trajectory`。
- Produces:
  ```ts
  buildShortcutExecution(shortcut, translate, selection?, pagePrefetch?, supplement?: string): ShortcutExecution
  ShortcutRerun.supplement?: string
  ChatState.runShortcut: (shortcut: ShortcutConfig, options?: { supplement?: string }) => Promise<void>
  ```

- [x] **Step 1: 写失败的 prompt 测试**

在 `lib/chat/shortcut-prompts.test.ts` 末尾追加：

```ts
describe('buildShortcutExecution for recorded shortcuts', () => {
  const recorded: ResolvedShortcut = {
    id: 'shortcut-rec-1',
    origin: 'recorded',
    scope: 'page',
    customized: true,
    name: '差旅报销单',
    prompt: '帮我填一张差旅报销单',
    trajectory: [
      { tool: 'browser_fill_form', url: 'https://example.com/expense/new', values: [{ target: '「报销金额」', value: '280' }] },
      { tool: 'browser_click', url: 'https://example.com/expense/new', target: '「下一步」' },
    ],
  };

  it('sends the goal and the reference steps, keeps browser tools, and never prefetches', () => {
    const execution = buildShortcutExecution(recorded, zhT);
    expect(execution.browserTools).toBe('all');
    expect(execution.systemPromptSuffix).toBe('');
    expect(execution.display).toBe('▶ 差旅报销单');
    expect(execution.agentUserContent).toContain('帮我填一张差旅报销单');
    expect(execution.agentUserContent).toContain('1. [https://example.com/expense/new] 「报销金额」填入 "280"');
    expect(execution.agentUserContent).toContain('2. [同上] 点击「下一步」');
    expect(execution.agentUserContent).not.toContain('本次补充说明');
  });

  it('adds the supplement to both the prompt and the displayed label', () => {
    const execution = buildShortcutExecution(recorded, zhT, undefined, undefined, '  金额改成 300 ');
    expect(execution.display).toBe('▶ 差旅报销单 · 金额改成 300');
    expect(execution.agentUserContent).toContain('本次补充说明：金额改成 300');
  });

  it('ignores a page prefetch plan even if one is passed', () => {
    const plan = planPagePrefetch({ title: 'T', url: 'https://example.com/', text: 'x'.repeat(5000) });
    const execution = buildShortcutExecution(recorded, t, undefined, plan);
    expect(execution.agentUserContent).not.toContain('x'.repeat(100));
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/chat/shortcut-prompts.test.ts -t "recorded"`
Expected: FAIL（走进了普通 page 分支，`display` 是 `'差旅报销单'`）。

- [x] **Step 3: 加 i18n 键**

`zh.ts`（放在 `store.shortcutPagePrompt` 附近）：

```ts
  'store.recordedTaskDisplay': '▶ {name}',
  'store.recordedTaskDisplayWithNote': '▶ {name} · {note}',
  'store.recordedTaskPrompt':
    '[已保存的任务]\n目标：{goal}\n\n上次成功完成时的参考步骤（按顺序；定位靠可见标签，旧的 fieldId 已失效，需要先 browser_get_form / browser_find_text 重新取句柄）：\n{steps}\n\n执行规则：页面与参考不一致时以页面实际为准，自行调整；当前页不是第 1 步所在页面时，先跳转过去；标注为敏感字段的步骤 Runi 不会代填，执行到那里时请用户自己填写。',
  'store.recordedTaskPromptWithNote':
    '[已保存的任务]\n目标：{goal}\n\n上次成功完成时的参考步骤（按顺序；定位靠可见标签，旧的 fieldId 已失效，需要先 browser_get_form / browser_find_text 重新取句柄）：\n{steps}\n\n本次补充说明：{note}\n\n执行规则：补充说明优先于参考步骤里的值；页面与参考不一致时以页面实际为准，自行调整；当前页不是第 1 步所在页面时，先跳转过去；标注为敏感字段的步骤 Runi 不会代填，执行到那里时请用户自己填写。',
```

`en.ts`：

```ts
  'store.recordedTaskDisplay': '▶ {name}',
  'store.recordedTaskDisplayWithNote': '▶ {name} · {note}',
  'store.recordedTaskPrompt':
    '[Saved task]\nGoal: {goal}\n\nReference steps from the last successful run (in order; elements are identified by their visible labels, the old fieldIds are no longer valid, so call browser_get_form / browser_find_text first to get fresh handles):\n{steps}\n\nRules: where the page differs from the reference, follow the page and adapt; if the current page is not where step 1 happened, navigate there first; Runi never fills steps marked as sensitive fields, so ask the user to fill those in themselves when you reach them.',
  'store.recordedTaskPromptWithNote':
    '[Saved task]\nGoal: {goal}\n\nReference steps from the last successful run (in order; elements are identified by their visible labels, the old fieldIds are no longer valid, so call browser_get_form / browser_find_text first to get fresh handles):\n{steps}\n\nNote for this run: {note}\n\nRules: the note for this run overrides values in the reference steps; where the page differs from the reference, follow the page and adapt; if the current page is not where step 1 happened, navigate there first; Runi never fills steps marked as sensitive fields, so ask the user to fill those in themselves when you reach them.',
```

- [x] **Step 4: 实现 prompt 分支与 rerun 字段**

`lib/chat/shortcut-prompts.ts`：顶部加 `import { renderTrajectoryForPrompt } from '@/lib/agent/task-trajectory';`，函数签名加第 5 个参数 `supplement?: string`，在函数体最开头（`if (shortcut.scope === 'page')` 之前）加：

```ts
  // 录制型指令：不做正文预取——回放要的是表单和按钮，不是正文，起始页也可能根本不是当前页
  // （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §6.3）。
  if (shortcut.origin === 'recorded') {
    const note = supplement?.trim() ?? '';
    const vars = {
      name: shortcut.name,
      goal: shortcut.prompt,
      steps: renderTrajectoryForPrompt(shortcut.trajectory ?? [], translate),
      note,
    };
    return {
      display: translate(note ? 'store.recordedTaskDisplayWithNote' : 'store.recordedTaskDisplay', vars),
      agentUserContent: translate(note ? 'store.recordedTaskPromptWithNote' : 'store.recordedTaskPrompt', vars),
      browserTools: 'all',
      systemPromptSuffix: '',
    };
  }
```

`lib/chat/shortcut-rerun.ts` 的 `ShortcutRerun` 里加：

```ts
  /** 录制型指令执行时用户补的那句"这次的不同之处"；重新生成时原样再用一次。 */
  supplement?: string;
```

- [x] **Step 5: 运行 prompt 测试确认通过**

Run: `pnpm vitest run lib/chat/shortcut-prompts.test.ts`
Expected: PASS。

- [x] **Step 6: 写失败的 store 测试**

在 `entrypoints/sidepanel/store-context.test.tsx` 里，紧挨着 `'regenerates a shortcut reply by replaying its rerun recipe...'` 用例之后追加：

```ts
  const recordedShortcut = {
    id: 'shortcut-rec-1',
    origin: 'recorded' as const,
    scope: 'page' as const,
    customized: true,
    name: '差旅报销单',
    prompt: '帮我填一张差旅报销单',
    trajectory: [{ tool: 'browser_click', url: 'https://example.com/expense/new', target: '「报销金额」' }],
  };

  it('runs a recorded shortcut without prefetching the page and forwards the supplement', async () => {
    await connectPort();
    mocks.sendMessage.mockImplementation(async (type: string) => {
      if (type === 'GET_ACTIVE_TAB') return { ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } };
      return { ok: true, data: {} };
    });

    await useChat.getState().runShortcut(recordedShortcut, { supplement: '金额改成 300' });

    expect(mocks.sendMessage.mock.calls.some(([type]) => type === 'EXTRACT_PAGE')).toBe(false);
    const sent = lastStartRunCall().agentUserContent;
    expect(sent).toContain('金额改成 300');
    expect(sent).toContain('「报销金额」');
    const userMessage = useChat.getState().messages.find((message) => message.role === 'user');
    expect(userMessage?.content).toBe('▶ 差旅报销单 · 金额改成 300');
    expect(userMessage?.rerun?.supplement).toBe('金额改成 300');
  });

  it('regenerates a recorded reply with the same supplement and still without prefetching', async () => {
    await connectPort();
    mocks.sendMessage.mockImplementation(async (type: string) => {
      if (type === 'GET_ACTIVE_TAB') return { ok: true, data: { id: 7, title: 'Example', url: 'https://example.com/' } };
      return { ok: true, data: {} };
    });
    useChat.setState({
      messages: [
        { id: 'u1', role: 'user', content: '▶ 差旅报销单 · 金额改成 300', createdAt: 1, kind: 'action', rerun: { shortcut: recordedShortcut, supplement: '金额改成 300' } },
        { id: 'a1', role: 'assistant', content: 'done', createdAt: 2 },
      ],
    });

    await expect(useChat.getState().regenerate('a1')).resolves.toBe(true);

    expect(mocks.sendMessage.mock.calls.some(([type]) => type === 'EXTRACT_PAGE')).toBe(false);
    expect(lastStartRunCall().agentUserContent).toContain('金额改成 300');
  });
```

- [x] **Step 7: 运行 store 测试确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx -t "recorded"`
Expected: FAIL（调用了 `EXTRACT_PAGE`，且 `rerun.supplement` 为 `undefined`）。

- [x] **Step 8: 接通 store**

`entrypoints/sidepanel/store.ts`：

1. `ChatState` 里：`runShortcut: (shortcut: ShortcutConfig, options?: { supplement?: string }) => Promise<void>;`
2. `RunShortcutOptions` 里加：
   ```ts
   /** 录制型指令的补充说明（见 shortcut-rerun.ts）。 */
   supplement?: string;
   ```
3. `runShortcut` 实现改为：
   ```ts
   runShortcut: async (shortcut, options) => {
     await runResolvedShortcut(set, get, resolveShortcut({ ...shortcut }, t), {
       supplement: options?.supplement,
       retry: () => { void get().runShortcut(shortcut, options); },
     });
   },
   ```
4. `regenerate` 里调用 `runResolvedShortcut` 的 options 加 `supplement: rerun.supplement,`。
5. `runResolvedShortcut` 的 `else if (resolved.scope === 'page')` 分支：保持 `resolveActiveTab` 与其失败处理不变，把随后调用 `EXTRACT_PAGE` 的整个 `try { ... } catch { ... }` 块包进：
   ```ts
    // 录制型指令不预取正文：回放要的是表单和按钮，起始页也可能不是当前页（见 shortcut-prompts.ts）。
    if (resolved.origin !== 'recorded') {
      // ……原 try/catch 原样放在这里……
    }
   ```
6. `execution = buildShortcutExecution(resolved, t, selectionText, pagePrefetch);` 改为 `execution = buildShortcutExecution(resolved, t, selectionText, pagePrefetch, options.supplement);`。
7. `display` 的 `rerun` 对象里 `selection: ...` 之后加：
   ```ts
      ...(options.supplement?.trim() ? { supplement: options.supplement.trim() } : {}),
   ```

- [x] **Step 9: 运行测试确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx lib/chat/shortcut-prompts.test.ts`
Expected: PASS。

- [x] **Step 10: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。`App.tsx` 的 `executeShortcut` 此时仍只传一个参数，合法。

```bash
git add lib/chat/shortcut-prompts.ts lib/chat/shortcut-prompts.test.ts lib/chat/shortcut-rerun.ts entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(chat): 录制型指令的回放 prompt——带参考轨迹与补充说明，不预取正文" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 从会话生成保存草稿

**Files:**
- Create: `lib/chat/recorded-task.ts`
- Test: `lib/chat/recorded-task.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` / `conversationTitle`（`lib/chat/messages.ts`）；`MAX_TRAJECTORY_STEPS` / `TrajectoryStep`（Task 1）；`newShortcutId` / `ShortcutConfig`（Task 5）。
- Produces:
  ```ts
  export interface RecordedTaskDraft { name: string; goal: string; steps: TrajectoryStep[]; truncated: boolean; incompleteOutcome: boolean }
  export function canSaveAsTask(messages: readonly ChatMessage[], messageId: string): boolean;
  export function buildRecordedTaskDraft(messages: readonly ChatMessage[], messageId: string): RecordedTaskDraft | null;
  export function toRecordedShortcut(input: { name: string; goal: string; steps: TrajectoryStep[] }): ShortcutConfig;
  ```

- [x] **Step 1: 写失败的测试**

`lib/chat/recorded-task.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { MAX_TRAJECTORY_STEPS, type TrajectoryStep } from '@/lib/agent/task-trajectory';
import { validateShortcutConfigs } from '@/lib/shortcuts';
import type { ChatMessage } from './messages';
import { buildRecordedTaskDraft, canSaveAsTask, toRecordedShortcut } from './recorded-task';

const step = (n: number): TrajectoryStep => ({ tool: 'browser_click', url: 'https://example.com/a', target: `「按钮${n}」` });

const conversation: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '帮我填一张差旅报销单', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: '填了一半，金额是多少？', createdAt: 2, trajectory: [step(1)] },
  { id: 'u2', role: 'user', content: '金额写 280', createdAt: 3 },
  { id: 'a2', role: 'assistant', content: '已提交', createdAt: 4, trajectory: [step(2)] },
  { id: 'u3', role: 'user', content: '谢谢', createdAt: 5 },
  { id: 'a3', role: 'assistant', content: '不客气', createdAt: 6 },
];

describe('canSaveAsTask', () => {
  it('offers saving on any assistant reply that has a recorded step at or before it', () => {
    expect(canSaveAsTask(conversation, 'a1')).toBe(true);
    expect(canSaveAsTask(conversation, 'a3')).toBe(true);
  });

  it('does not offer saving for pure Q&A, user messages or unknown ids', () => {
    const qa: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', createdAt: 2 },
    ];
    expect(canSaveAsTask(qa, 'a1')).toBe(false);
    expect(canSaveAsTask(conversation, 'u1')).toBe(false);
    expect(canSaveAsTask(conversation, 'missing')).toBe(false);
  });
});

describe('buildRecordedTaskDraft', () => {
  it('joins every step and every user message up to the chosen reply', () => {
    const draft = buildRecordedTaskDraft(conversation, 'a2')!;
    expect(draft.name).toBe('帮我填一张差旅报销单');
    expect(draft.goal).toBe('帮我填一张差旅报销单\n金额写 280');
    expect(draft.steps).toEqual([step(1), step(2)]);
    expect(draft.truncated).toBe(false);
    expect(draft.incompleteOutcome).toBe(false);
  });

  it('keeps the last steps when the session recorded more than the cap', () => {
    const many: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'x', createdAt: 2, trajectory: Array.from({ length: 40 }, (_, i) => step(i)) },
      { id: 'a2', role: 'assistant', content: 'y', createdAt: 3, trajectory: Array.from({ length: 40 }, (_, i) => step(100 + i)) },
    ];
    const draft = buildRecordedTaskDraft(many, 'a2')!;
    expect(draft.steps).toHaveLength(MAX_TRAJECTORY_STEPS);
    expect(draft.steps.at(-1)).toEqual(step(139));
    expect(draft.truncated).toBe(true);
  });

  it('warns when a reply in range reported the task as not completed', () => {
    const partial = conversation.map((message) =>
      message.id === 'a2' ? { ...message, taskOutcome: { outcome: 'partial' as const, reason: 'x' } } : message,
    );
    expect(buildRecordedTaskDraft(partial, 'a2')!.incompleteOutcome).toBe(true);
  });

  it('returns copies, so editing the draft cannot mutate chat history', () => {
    const withValue: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'x', createdAt: 2, trajectory: [{ tool: 'browser_fill_form', url: '', values: [{ target: '「a」', value: '1' }] }] },
    ];
    const draft = buildRecordedTaskDraft(withValue, 'a1')!;
    draft.steps[0].values![0].value = '2';
    expect(withValue[1].trajectory![0].values![0].value).toBe('1');
  });

  it('returns null when nothing can be saved', () => {
    expect(buildRecordedTaskDraft(conversation, 'u1')).toBeNull();
  });
});

describe('toRecordedShortcut', () => {
  it('produces a config that passes storage validation', () => {
    const config = toRecordedShortcut({ name: ' 报销单 ', goal: ' 填报销单 ', steps: [step(1)] });
    expect(config).toMatchObject({ origin: 'recorded', scope: 'page', customized: true, name: '报销单', prompt: '填报销单' });
    expect(validateShortcutConfigs([config]).errors).toEqual([]);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/chat/recorded-task.test.ts`
Expected: FAIL，`Failed to resolve import "./recorded-task"`。

- [x] **Step 3: 实现**

`lib/chat/recorded-task.ts`：

```ts
// 「保存为指令」的纯逻辑：从会话里取出草稿、判断按钮该不该出现、生成要落盘的配置
// （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §4）。
// 放在 lib/ 而不是组件里，理由同 messages.ts：面板的可测逻辑集中在这里。
import { MAX_TRAJECTORY_STEPS, type TrajectoryStep } from '@/lib/agent/task-trajectory';
import { newShortcutId, type ShortcutConfig } from '@/lib/shortcuts';
import { conversationTitle, type ChatMessage } from './messages';

export interface RecordedTaskDraft {
  name: string;
  goal: string;
  steps: TrajectoryStep[];
  /** 会话里录到的步骤超过上限，只保留了最后 MAX_TRAJECTORY_STEPS 步。 */
  truncated: boolean;
  /** 区间内有回复报告了 partial/failure——提示，不阻止保存。 */
  incompleteOutcome: boolean;
}

function rangeUpTo(messages: readonly ChatMessage[], messageId: string): ChatMessage[] | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0 || messages[index].role !== 'assistant') return null;
  return messages.slice(0, index + 1);
}

export function canSaveAsTask(messages: readonly ChatMessage[], messageId: string): boolean {
  const range = rangeUpTo(messages, messageId);
  return Boolean(range?.some((message) => message.role === 'assistant' && (message.trajectory?.length ?? 0) > 0));
}

function cloneStep(step: TrajectoryStep): TrajectoryStep {
  return { ...step, ...(step.values ? { values: step.values.map((value) => ({ ...value })) } : {}) };
}

/**
 * 取数范围是"会话开头到被点的那条回复"：一次成功的对话常常跨多轮——第一轮填了一半，
 * 用户补了信息，第二轮才提交。
 */
export function buildRecordedTaskDraft(messages: readonly ChatMessage[], messageId: string): RecordedTaskDraft | null {
  if (!canSaveAsTask(messages, messageId)) return null;
  const range = rangeUpTo(messages, messageId)!;
  const all = range.flatMap((message) => (message.role === 'assistant' ? message.trajectory ?? [] : []));
  return {
    name: conversationTitle(range),
    goal: range
      .filter((message) => message.role === 'user')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n'),
    // 超出上限保留最后 N 步：越靠后越接近最终走通的那条路。
    steps: all.slice(-MAX_TRAJECTORY_STEPS).map(cloneStep),
    truncated: all.length > MAX_TRAJECTORY_STEPS,
    incompleteOutcome: range.some((message) => message.taskOutcome !== undefined && message.taskOutcome.outcome !== 'success'),
  };
}

export function toRecordedShortcut(input: { name: string; goal: string; steps: TrajectoryStep[] }): ShortcutConfig {
  return {
    id: newShortcutId(),
    origin: 'recorded',
    scope: 'page',
    customized: true,
    name: input.name.trim(),
    prompt: input.goal.trim(),
    trajectory: input.steps.map(cloneStep),
  };
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/chat/recorded-task.test.ts`
Expected: PASS。

- [x] **Step 5: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。

```bash
git add lib/chat/recorded-task.ts lib/chat/recorded-task.test.ts
git commit -m "feat(chat): 从会话生成录制指令的保存草稿" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 保存抽屉与回复上的"保存为指令"按钮

**Files:**
- Create: `entrypoints/sidepanel/components/SaveTaskDrawer.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`（`Message` 的 props 与操作行、抽屉挂载、保存提示）
- Modify: `entrypoints/sidepanel/icons.tsx`（新增 `IconBookmark`、`IconPlay`）
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `canSaveAsTask` / `buildRecordedTaskDraft` / `toRecordedShortcut` / `RecordedTaskDraft`；Task 2 的 `describeTrajectoryStep`、`MAX_TRAJECTORY_VALUE_CHARS`；`updateShortcutConfigs`（`lib/shortcuts.ts`）；store 的 `refreshShortcuts`。
- Produces:
  ```ts
  export interface SaveTaskDrawerProps { open: boolean; messages: ChatMessage[]; messageId: string | null; onClose(): void; onSaved(name: string): void }
  export function SaveTaskDrawer(props: SaveTaskDrawerProps): JSX.Element | null;
  export function IconBookmark(props: IconProps): JSX.Element;
  export function IconPlay(props: IconProps): JSX.Element;  // Task 9 使用
  ```

- [x] **Step 1: 加图标**

`entrypoints/sidepanel/icons.tsx` 末尾追加（与现有图标同一个 `Svg` 包装）：

```tsx
export function IconBookmark({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </Svg>
  );
}

export function IconPlay({ className }: IconProps) {
  return (
    <Svg className={className}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  );
}
```

- [x] **Step 2: 加 i18n 键**

`zh.ts`：

```ts
  'chat.saveAsTaskAriaLabel': '保存为指令',
  'recordedTask.title': '保存为指令',
  'recordedTask.nameLabel': '名称',
  'recordedTask.goalLabel': '目标',
  'recordedTask.stepsLabel': '参考步骤',
  'recordedTask.privacyNote': '这些内容只保存在本机；执行时会作为参考发送给你配置的模型。',
  'recordedTask.incompleteWarning': '上次这轮报告为未完成，确认要保存吗？',
  'recordedTask.truncatedNotice': '步骤较多，只保留了最后 {count} 步。',
  'recordedTask.valueAria': '{target} 的写入值',
  'recordedTask.deleteStepAria': '删除第 {index} 步',
  'recordedTask.save': '保存',
  'recordedTask.savedNotice': '已保存「{name}」，输入 / 即可调用',
```

`en.ts`：

```ts
  'chat.saveAsTaskAriaLabel': 'Save as task',
  'recordedTask.title': 'Save as task',
  'recordedTask.nameLabel': 'Name',
  'recordedTask.goalLabel': 'Goal',
  'recordedTask.stepsLabel': 'Reference steps',
  'recordedTask.privacyNote': 'This stays on this device; when you run it, it is sent to your configured model as a reference.',
  'recordedTask.incompleteWarning': 'This run reported the task as not completed. Save it anyway?',
  'recordedTask.truncatedNotice': 'There were many steps; only the last {count} were kept.',
  'recordedTask.valueAria': 'Value for {target}',
  'recordedTask.deleteStepAria': 'Delete step {index}',
  'recordedTask.save': 'Save',
  'recordedTask.savedNotice': 'Saved "{name}". Type / to run it.',
```

- [x] **Step 3: 写失败的 UI 测试**

在 `workbench-components.test.tsx` 末尾追加（`chatStore`、`LocaleProvider`、`App`、`render`、`screen`、`userEvent`、`waitFor`、`within`、`vi` 均已在文件内可用；测试 locale 为 en）：

```tsx
describe('save as task', () => {
  const recordedConversation = [
    { id: 'u1', role: 'user', content: 'File an expense report', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Submitted.',
      createdAt: 2,
      trajectory: [
        { tool: 'browser_fill_form', url: 'https://example.com/expense', values: [{ target: '「Amount」', value: '280' }] },
        { tool: 'browser_click', url: 'https://example.com/expense', target: '「Next」' },
      ],
    },
  ];

  function renderApp() {
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );
  }

  it('offers saving only on replies that changed the page', () => {
    (chatStore as any).messages = [
      ...recordedConversation,
      { id: 'u2', role: 'user', content: 'thanks', createdAt: 3 },
    ];
    renderApp();
    expect(screen.getByRole('button', { name: 'Save as task' })).toBeInTheDocument();

    cleanup();
    (chatStore as any).messages = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', createdAt: 2 },
    ];
    renderApp();
    expect(screen.queryByRole('button', { name: 'Save as task' })).toBeNull();
  });

  it('hides the button while a run is in flight', () => {
    (chatStore as any).messages = recordedConversation;
    (chatStore as any).busy = true;
    renderApp();
    expect(screen.queryByRole('button', { name: 'Save as task' })).toBeNull();
  });

  it('prefills the drawer, lets the user edit and delete steps, and saves a recorded shortcut', async () => {
    const user = userEvent.setup();
    const set = vi.spyOn((globalThis as any).browser.storage.local, 'set');
    (chatStore as any).messages = recordedConversation;
    renderApp();

    await user.click(screen.getByRole('button', { name: 'Save as task' }));
    const dialog = screen.getByRole('dialog', { name: 'Save as task' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('File an expense report');
    expect(within(dialog).getByLabelText('Goal')).toHaveValue('File an expense report');
    expect(within(dialog).getByText('Set 「Amount」 to "280"')).toBeInTheDocument();

    const amount = within(dialog).getByLabelText('Value for 「Amount」');
    await user.clear(amount);
    await user.type(amount, '300');
    await user.click(within(dialog).getByRole('button', { name: 'Delete step 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(chatStore.refreshShortcuts).toHaveBeenCalled());
    const saved = set.mock.calls.at(-1)?.[0]?.['runi:shortcuts'] as any[];
    expect(saved.at(-1)).toMatchObject({
      origin: 'recorded',
      scope: 'page',
      name: 'File an expense report',
      trajectory: [{ tool: 'browser_fill_form', values: [{ target: '「Amount」', value: '300' }] }],
    });
    expect(screen.queryByRole('dialog', { name: 'Save as task' })).toBeNull();
    // 不用 getByRole('status')：header 的运行状态行也是 status，按文字找才不会有歧义。
    expect(screen.getByText('Saved "File an expense report". Type / to run it.')).toBeInTheDocument();
  });

  it('disables saving when the name is empty or every step was deleted', async () => {
    const user = userEvent.setup();
    (chatStore as any).messages = recordedConversation;
    renderApp();

    await user.click(screen.getByRole('button', { name: 'Save as task' }));
    const dialog = screen.getByRole('dialog', { name: 'Save as task' });
    await user.clear(within(dialog).getByLabelText('Name'));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Name'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Delete step 1' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete step 1' }));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('warns when the saved range reported the task as not completed', async () => {
    const user = userEvent.setup();
    (chatStore as any).messages = recordedConversation.map((message) =>
      message.id === 'a1' ? { ...message, taskOutcome: { outcome: 'failure', reason: 'x' } } : message,
    );
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Save as task' }));
    expect(screen.getByText('This run reported the task as not completed. Save it anyway?')).toBeInTheDocument();
  });
});
```

在文件顶部的 `@testing-library/react` import 里补上 `cleanup`。

- [x] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx -t "save as task"`
Expected: FAIL，找不到 `Save as task` 按钮。

- [x] **Step 5: 实现抽屉组件**

`entrypoints/sidepanel/components/SaveTaskDrawer.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { describeTrajectoryStep, MAX_TRAJECTORY_STEPS, MAX_TRAJECTORY_VALUE_CHARS } from '@/lib/agent/task-trajectory';
import type { ChatMessage } from '@/lib/chat/messages';
import { buildRecordedTaskDraft, toRecordedShortcut, type RecordedTaskDraft } from '@/lib/chat/recorded-task';
import { updateShortcutConfigs } from '@/lib/shortcuts';
import { IconAlertTriangle, IconClose, IconTrash } from '../icons';

export interface SaveTaskDrawerProps {
  open: boolean;
  messages: ChatMessage[];
  /** 用户点了"保存为指令"的那条 assistant 回复；null 即关闭。 */
  messageId: string | null;
  onClose(): void;
  onSaved(name: string): void;
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// 保存录制指令的抽屉（ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §4.3）。
// 形态与 HistoryDrawer 一致：遮罩 + 侧滑面板 + Esc 关闭 + Tab 焦点圈在面板里。
// 保存时不调用模型：默认拼出来的用户原话已经足够准确，多一次调用就多一条失败路径。
export function SaveTaskDrawer({ open, messages, messageId, onClose, onSaved }: SaveTaskDrawerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RecordedTaskDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 只在打开（或换了一条回复）时取一次草稿：之后用户的编辑不能被流式推来的新 messages 覆盖掉。
  useEffect(() => {
    if (!open || !messageId) {
      setDraft(null);
      setError(null);
      return;
    }
    setDraft(buildRecordedTaskDraft(messages, messageId));
    setError(null);
    requestAnimationFrame(() => nameRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open || !draft) return null;

  const canSave = !saving && draft.name.trim().length > 0 && draft.goal.trim().length > 0 && draft.steps.length > 0;

  function updateValue(stepIndex: number, valueIndex: number, value: string) {
    setDraft((current) => {
      if (!current) return current;
      const steps = current.steps.map((step, i) =>
        i !== stepIndex || !step.values
          ? step
          : { ...step, values: step.values.map((item, j) => (j === valueIndex ? { ...item, value } : item)) },
      );
      return { ...current, steps };
    });
  }

  function removeStep(stepIndex: number) {
    setDraft((current) => (current ? { ...current, steps: current.steps.filter((_, i) => i !== stepIndex) } : current));
  }

  async function save() {
    if (!draft || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateShortcutConfigs((current) => [...current, toRecordedShortcut(draft)]);
      onSaved(draft.name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('recordedTask.title')}
        onMouseDown={(event) => event.stopPropagation()}
        className="relative ml-auto flex h-full w-[min(26rem,calc(100vw-2rem))] flex-col bg-white text-neutral-700 shadow-xl dark:bg-neutral-900 dark:text-neutral-300"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{t('recordedTask.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-3 text-sm">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('recordedTask.privacyNote')}</p>
          {draft.incompleteOutcome && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('recordedTask.incompleteWarning')}</span>
            </p>
          )}

          <label className="block text-xs text-neutral-600 dark:text-neutral-300">
            <span className="mb-1 block">{t('recordedTask.nameLabel')}</span>
            <input
              ref={nameRef}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className={inputClass}
            />
          </label>

          <label className="block text-xs text-neutral-600 dark:text-neutral-300">
            <span className="mb-1 block">{t('recordedTask.goalLabel')}</span>
            <textarea
              value={draft.goal}
              rows={4}
              onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
              className={inputClass}
            />
          </label>

          <div>
            <p className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">{t('recordedTask.stepsLabel')}</p>
            {draft.truncated && (
              <p className="mb-2 text-xs text-neutral-500">{t('recordedTask.truncatedNotice', { count: MAX_TRAJECTORY_STEPS })}</p>
            )}
            <ol aria-label={t('recordedTask.stepsLabel')} className="space-y-2">
              {draft.steps.map((step, stepIndex) => (
                <li key={stepIndex} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-xs tabular-nums text-neutral-400">{stepIndex + 1}.</span>
                    <span className="min-w-0 flex-1 break-words text-xs">{describeTrajectoryStep(step, t)}</span>
                    <button
                      type="button"
                      onClick={() => removeStep(stepIndex)}
                      aria-label={t('recordedTask.deleteStepAria', { index: stepIndex + 1 })}
                      className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-neutral-800"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {step.values?.map((value, valueIndex) =>
                    value.sensitive || value.value === undefined ? null : (
                      <input
                        key={valueIndex}
                        value={value.value}
                        maxLength={MAX_TRAJECTORY_VALUE_CHARS}
                        aria-label={t('recordedTask.valueAria', { target: value.target })}
                        onChange={(event) => updateValue(stepIndex, valueIndex, event.target.value)}
                        className={`mt-1.5 ${inputClass} py-1 text-xs`}
                      />
                    ),
                  )}
                </li>
              ))}
            </ol>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('recordedTask.save')}
          </button>
        </div>
      </aside>
    </div>
  );
}
```

- [x] **Step 6: 接进 App**

`entrypoints/sidepanel/App.tsx`：

1. import：`canSaveAsTask` 加进现有的 `@/lib/chat/messages` import 旁边——它来自 `@/lib/chat/recorded-task`，单独一行 `import { canSaveAsTask } from '@/lib/chat/recorded-task';`；`import { SaveTaskDrawer } from './components/SaveTaskDrawer';`；图标 import 里加 `IconBookmark`。
2. 组件状态（`historyOpen` 附近）：
   ```tsx
   const [saveTaskFor, setSaveTaskFor] = useState<string | null>(null);
   const [notice, setNotice] = useState<string | null>(null);
   ```
   并加一个自动消失的 effect：
   ```tsx
   useEffect(() => {
     if (!notice) return;
     const timer = window.setTimeout(() => setNotice(null), 4000);
     return () => window.clearTimeout(timer);
   }, [notice]);
   ```
3. 回调（`handleRegenerate` 之后）：
   ```tsx
   const handleSaveTask = useCallback(
     (id: string) => {
       if (requestBlocked) return;
       setSaveTaskFor(id);
     },
     [requestBlocked],
   );
   ```
4. `<HistoryDrawer ... />` 之后挂抽屉：
   ```tsx
      <SaveTaskDrawer
        open={saveTaskFor !== null}
        messages={messages}
        messageId={saveTaskFor}
        onClose={() => setSaveTaskFor(null)}
        onSaved={(name) => {
          setSaveTaskFor(null);
          void refreshShortcuts();
          setNotice(t('recordedTask.savedNotice', { name }));
        }}
      />
   ```
5. `settingsError` 那个 alert 块之后加：
   ```tsx
          {notice && (
            <div
              role="status"
              className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              {notice}
            </div>
          )}
   ```
6. `messages.map` 里给 `<Message>` 加两个 prop：
   ```tsx
                      canSaveTask={m.role === 'assistant' && canSaveAsTask(messages, m.id)}
                      onSaveTask={handleSaveTask}
   ```
7. `Message` 组件的解构参数与 props 类型里加 `canSaveTask: boolean;`、`onSaveTask: (id: string) => void;`，在操作行里重新生成按钮之后加：
   ```tsx
            {!requestBlocked && canSaveTask && (
              <button
                type="button"
                onClick={() => onSaveTask(message.id)}
                aria-label={t('chat.saveAsTaskAriaLabel')}
                title={t('chat.saveAsTaskAriaLabel')}
                className="inline-flex items-center gap-1 rounded-md p-1.5 text-neutral-400 transition-colors hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-neutral-200"
              >
                <IconBookmark className="h-3.5 w-3.5" />
              </button>
            )}
   ```

- [x] **Step 7: 运行测试确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS（新用例与全部既有用例）。既有用例里的 `getByRole('status')` 不会因新增的 notice 变得有歧义：notice 只在保存成功后出现。

- [x] **Step 8: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。

```bash
git add entrypoints/sidepanel/components/SaveTaskDrawer.tsx entrypoints/sidepanel/App.tsx entrypoints/sidepanel/icons.tsx entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(sidepanel): 回复上新增「保存为指令」，抽屉里可改名称、目标与步骤" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 输入框的待执行胶囊与 `/` 面板标记

**Files:**
- Modify: `entrypoints/sidepanel/components/WorkbenchComposer.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`（`executeShortcut` 透传 options）
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `entrypoints/sidepanel/components/workbench-components.test.tsx`

**Interfaces:**
- Consumes: Task 8 的 `IconPlay`；Task 6 的 `runShortcut(shortcut, options?)`。
- Produces: `WorkbenchComposerProps.onRunShortcut(shortcut: ShortcutConfig, options?: { supplement?: string }): void`。

- [x] **Step 1: 加 i18n 键**

`zh.ts`：

```ts
  'workbench.pendingTaskPlaceholder': '补充这次的不同之处（可留空），回车执行',
  'workbench.cancelPendingTask': '取消执行「{name}」',
```

`en.ts`：

```ts
  'workbench.pendingTaskPlaceholder': 'Anything different this time? (optional) Press Enter to run',
  'workbench.cancelPendingTask': 'Cancel running "{name}"',
```

- [x] **Step 2: 写失败的测试**

在 `workbench-components.test.tsx` 的 `describe('workbench composer', ...)` 块内末尾追加：

```tsx
  const recordedCommand: ResolvedShortcutCommand = {
    config: {
      id: 'shortcut-rec',
      origin: 'recorded',
      scope: 'page',
      customized: true,
      name: 'Expense report',
      prompt: 'File an expense report',
      trajectory: [{ tool: 'browser_click', url: 'https://example.com/x', target: '「Next」' }],
    },
    resolved: {
      id: 'shortcut-rec',
      origin: 'recorded',
      scope: 'page',
      customized: true,
      name: 'Expense report',
      prompt: 'File an expense report',
      trajectory: [{ tool: 'browser_click', url: 'https://example.com/x', target: '「Next」' }],
    },
  };

  it('stages a recorded task instead of running it, then runs it with the typed note', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness shortcuts={[readingShortcut, recordedCommand]} onRunShortcut={onRunShortcut} />);

    await user.type(screen.getByRole('textbox'), '/Expense');
    await user.keyboard('{Enter}');
    expect(onRunShortcut).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-pending-task')).toHaveTextContent('Expense report');
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Anything different this time? (optional) Press Enter to run');

    await user.type(screen.getByRole('textbox'), 'amount 300{Enter}');
    expect(onRunShortcut).toHaveBeenCalledWith(recordedCommand.config, { supplement: 'amount 300' });
    expect(screen.queryByTestId('composer-pending-task')).toBeNull();
  });

  it('runs a staged recorded task with no note when Enter is pressed on an empty input', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    render(<ComposerHarness shortcuts={[recordedCommand]} onRunShortcut={onRunShortcut} />);

    await user.type(screen.getByRole('textbox'), '/Expense');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(onRunShortcut).toHaveBeenCalledWith(recordedCommand.config, undefined);
  });

  it('cancels a staged recorded task with Escape or its close button', async () => {
    const user = userEvent.setup();
    const onRunShortcut = vi.fn();
    const onSend = vi.fn();
    render(<ComposerHarness shortcuts={[recordedCommand]} onRunShortcut={onRunShortcut} onSend={onSend} />);

    await user.type(screen.getByRole('textbox'), '/Expense');
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('composer-pending-task')).toBeNull();
    await user.keyboard('{Enter}');
    expect(onRunShortcut).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), '/Expense');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Cancel running "Expense report"' }));
    expect(screen.queryByTestId('composer-pending-task')).toBeNull();
  });

  it('keeps recorded tasks out of the quick shortcut chips', () => {
    render(<ComposerHarness shortcuts={[readingShortcut, recordedCommand]} />);
    const chips = screen.getByTestId('composer-shortcuts');
    expect(within(chips).getByRole('button', { name: '阅读页面' })).toBeInTheDocument();
    expect(within(chips).queryByRole('button', { name: 'Expense report' })).toBeNull();
  });
```

- [x] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx -t "recorded task"`
Expected: FAIL（选中即执行，`onRunShortcut` 被立刻调用）。

- [x] **Step 4: 实现**

`WorkbenchComposer.tsx`：

1. import 里加 `IconPlay`；`WorkbenchComposerProps.onRunShortcut` 改为 `onRunShortcut(shortcut: ShortcutConfig, options?: { supplement?: string }): void;`。
2. 状态：
   ```tsx
   // 录制型指令选中后不立即执行：先挂成一个待执行胶囊，让用户补一句"这次的不同之处"
   // （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §6.2）。
   const [pendingTask, setPendingTask] = useState<{ config: ShortcutConfig; resolved: ResolvedShortcut } | null>(null);
   ```
3. `canSend` 改为：
   ```tsx
   const canSend = !requestBlocked
     && (pendingTask !== null || input.trim().length > 0 || hasReadyAttachment);
   ```
4. `quickShortcuts` 改为：
   ```tsx
   // 录制型指令只进 / 面板：存上十几条，胶囊栏就被挤满了。
   const quickShortcuts = shortcuts.filter((command) => isUsableShortcutCommand(command) && command.config.origin !== 'recorded');
   ```
5. `handleSend` 里 `if (!canSend) return;` 之后加：
   ```tsx
    if (pendingTask) {
      const supplement = input.trim();
      onRunShortcut(pendingTask.config, supplement ? { supplement } : undefined);
      setPendingTask(null);
      setInput('');
      return;
    }
   ```
6. `runCommand` 里 `if (!command || requestBlocked) return;` 之后加：
   ```tsx
    if (command.config.origin === 'recorded') {
      setPendingTask(command);
      setOpenPopover(null);
      setInput('');
      textareaRef.current?.focus();
      return;
    }
   ```
7. 键盘处理里，现有的 `if (event.key === 'Escape' && openPopover) { ... }` 之后加（先关弹层，再按一次 Esc 才取消胶囊）：
   ```tsx
    if (event.key === 'Escape' && pendingTask) {
      event.preventDefault();
      setPendingTask(null);
      return;
    }
   ```
8. 在 `pageContextNotice` 块之后、`composer-toolbar` 之前渲染胶囊：
   ```tsx
        {pendingTask && (
          <div data-testid="composer-pending-task" className="mb-2 flex items-center gap-1">
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
              <IconPlay className="h-3 w-3 shrink-0" />
              <span className="truncate">{pendingTask.resolved.name}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setPendingTask(null);
                textareaRef.current?.focus();
              }}
              aria-label={t('workbench.cancelPendingTask', { name: pendingTask.resolved.name })}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
   ```
9. textarea 的 placeholder 改为：
   ```tsx
            placeholder={
              fileDragActive
                ? t('workbench.dropPdfPrompt')
                : pendingTask
                  ? t('workbench.pendingTaskPlaceholder')
                  : t('workbench.composerPlaceholder')
            }
   ```
10. `/` 面板的菜单项文字 `{resolved.name}` 改为：
    ```tsx
                  {config.origin === 'recorded' && <IconPlay className="mr-1.5 inline h-3 w-3 align-[-1px] text-indigo-500" />}
                  {resolved.name}
    ```
    （`aria-label` 保持 `resolved.name` 不变。）

`App.tsx` 的 `executeShortcut` 改为透传：

```tsx
  function executeShortcut(shortcut: ShortcutConfig, options?: { supplement?: string }) {
    if (requestBlocked) return;
    resetToFollowing();
    runShortcut(shortcut, options);
  }
```

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run entrypoints/sidepanel/components/workbench-components.test.tsx`
Expected: PASS（新用例与既有的 slash 命令用例：`'opens slash commands, filters, and runs the selected command'` 断言 `onRunShortcut` 以单参数被调用——`toHaveBeenCalledWith(readingShortcut.config)` 与现实现一致，因为普通指令仍走 `onRunShortcut(command.config)`）。

- [x] **Step 6: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。

```bash
git add entrypoints/sidepanel/components/WorkbenchComposer.tsx entrypoints/sidepanel/App.tsx entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(sidepanel): 录制指令选中后先挂成待执行胶囊，补一句话再回车执行" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 设置页展示与编辑录制指令

**Files:**
- Modify: `components/ShortcutSettings.tsx`
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `components/settings-components.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `describeTrajectoryStep`；Task 5 的 recorded 配置。
- Produces: 无新导出。

- [ ] **Step 1: 改 i18n**

`zh.ts`：
- 把 `'shortcut.confirmRestore'` 改为 `'会清空你自建的快捷方式和保存的任务指令，并把改过的内建文案还原为默认。此操作无法撤销。'`
- 新增：
  ```ts
  'shortcut.recordedBadge': '录制的任务',
  'shortcut.recordedStepsToggle': '参考步骤（{count}）',
  ```

`en.ts`：
- `'shortcut.confirmRestore'` 改为 `'This removes your custom shortcuts and saved tasks, and reverts edited built-in text to the defaults. It cannot be undone.'`
- 新增：
  ```ts
  'shortcut.recordedBadge': 'Recorded task',
  'shortcut.recordedStepsToggle': 'Reference steps ({count})',
  ```

先 `grep -rn "removes your custom shortcuts" components lib entrypoints` 确认没有测试写死旧英文文案；有的话一并改成新文案。

- [ ] **Step 2: 写失败的测试**

在 `components/settings-components.test.tsx` 的 `describe('grouped options settings', ...)` 块内追加：

```tsx
  const recordedEntry = {
    id: 'shortcut-rec-1',
    origin: 'recorded',
    scope: 'page',
    customized: true,
    name: 'Expense report',
    prompt: 'File an expense report',
    trajectory: [{ tool: 'browser_click', url: 'https://example.com/x', target: '「Next」' }],
  };

  it('labels recorded tasks and shows their steps read-only', async () => {
    const user = userEvent.setup();
    (storageData['runi:shortcuts'] as unknown[]).push(recordedEntry);
    renderWithLocale(<ShortcutSettings />);

    expect(await screen.findByText('Expense report')).toBeVisible();
    expect(screen.getByText('Recorded task')).toBeVisible();
    await user.click(screen.getByText('Reference steps (1)'));
    expect(screen.getByText('Click 「Next」')).toBeVisible();
  });

  it('keeps the trajectory and page scope when a recorded task is renamed', async () => {
    const user = userEvent.setup();
    (storageData['runi:shortcuts'] as unknown[]).push(recordedEntry);
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ShortcutSettings />);

    await user.click(await screen.findByRole('button', { name: 'Edit Expense report' }));
    // 录制指令的作用域固定为 page，编辑表单里不给改。
    expect(screen.queryByRole('combobox')).toBeNull();
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Travel expenses');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(set).toHaveBeenCalled());
    const saved = (set.mock.calls.at(-1)?.[0]?.['runi:shortcuts'] as any[]).find((item) => item.id === 'shortcut-rec-1');
    expect(saved).toMatchObject({ origin: 'recorded', scope: 'page', name: 'Travel expenses', trajectory: recordedEntry.trajectory });
  });
```

注意：编辑表单里名称输入框的可访问名以现有 `shortcut.name` 键的英文值为准；若不是 `'Name'`，改用 `en['shortcut.name']`（文件顶部已可 import `en`）。`Save` 按钮同理对应 `en['shortcut.save']`。`storageData` 是本 describe 的 `beforeEach` 里赋值的那个对象；若它不是在外层 `let` 声明、测试体内不可见，就改为在测试开头 `(globalThis as any).browser.storage.local.get.mockResolvedValueOnce({...})` 覆盖一次读取。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run components/settings-components.test.tsx -t "recorded"`
Expected: FAIL（找不到 `Recorded task`）。

- [ ] **Step 4: 实现**

`components/ShortcutSettings.tsx`：

1. import `describeTrajectoryStep`（`@/lib/agent/task-trajectory`）。
2. 列表每一项里，把
   ```tsx
                      <span>{scopeLabel(resolved.scope)}</span>
   ```
   改为
   ```tsx
                      <span>{item.origin === 'recorded' ? t('shortcut.recordedBadge') : scopeLabel(resolved.scope)}</span>
   ```
   并在这个 `<p>` 之后加：
   ```tsx
                    {item.origin === 'recorded' && item.trajectory && (
                      <details className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                        <summary className="cursor-pointer select-none">
                          {t('shortcut.recordedStepsToggle', { count: item.trajectory.length })}
                        </summary>
                        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                          {item.trajectory.map((step, stepIndex) => (
                            <li key={stepIndex} className="break-words">{describeTrajectoryStep(step, t)}</li>
                          ))}
                        </ol>
                      </details>
                    )}
   ```
3. 编辑表单：在组件体内（`beginEdit` 附近）算出
   ```tsx
   // 录制指令的作用域固定为 page（它的参考轨迹全是页面操作），轨迹在这里只读——要改就删掉重录。
   const editingRecorded = items.find((item) => item.id === editingId)?.origin === 'recorded';
   ```
   把作用域那个 `<label>…<select>…</select></label>` 整块包进 `{!editingRecorded && ( … )}`。
4. `saveDraft` 编辑分支里的合并改为：
   ```tsx
          current[index] = {
            ...current[index],
            ...nextDraft,
            ...(current[index].origin === 'recorded' ? { scope: 'page' as const } : {}),
            customized: true,
          };
   ```
   （`...current[index]` 已经带着 `trajectory`，这里只需防止作用域被改。）

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: PASS。

- [ ] **Step 6: 类型检查并提交**

Run: `pnpm compile`
Expected: 无错误。

```bash
git add components/ShortcutSettings.tsx components/settings-components.test.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(settings): 设置页展示录制的任务指令，编辑时保住轨迹与作用域" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 文档同步与全量验证

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`、`README.en.md`
- Modify: `docs/superpowers/specs/2026-09-23-task-replay-design.md`

- [ ] **Step 1: 更新 CLAUDE.md**

1. 「Agent loop」模块列表里（`task-outcome.ts` 条目之后）加一条：

```markdown
- **`task-trajectory.ts`** / **`trajectory-recorder.ts`** — task replay (ref: `docs/superpowers/specs/2026-09-23-task-replay-design.md`). `run-registry.ts` records every *successful* write tool call (plus `browser_switch_tab`, which is read-only but decides where later writes land) as a `TrajectoryStep` and archives the list on the turn's last assistant message as `ChatMessage.trajectory`. Labels are resolved from the handle table at `tool_execution_start`, not at `end` — a click on "下一步" navigates, `background.ts` rebuilds the table for the new page, and the same `fieldId` then names a different element. Every page-derived string goes through `redactText` *before* clipping; sensitive-field values are never recorded (`planFormFill` never writes them either, so the step says the user must fill it in, not that it was filled); `browser_set_storage` keeps only the key. The split is deliberate: `task-trajectory.ts` (types, `parseTrajectory`, `describeTrajectoryStep` shared by the save drawer and the replay prompt) is imported by the panel, the options page and `lib/shortcuts.ts`, so it must not depend on `permissions.ts` or redaction — that half lives in `trajectory-recorder.ts`, which only the background uses.
```

2. `lib/shortcuts.ts` 那一段里，把 "five built-ins ... plus custom entries" 之后补一句：

```markdown
A third origin, `recorded`, holds tasks saved from a conversation via the reply's "保存为指令" button (`lib/chat/recorded-task.ts`, `SaveTaskDrawer.tsx`): always `scope: 'page'` and `customized: true`, carrying a `trajectory` that `validateShortcutConfigs` checks with `parseTrajectory`. Recorded shortcuts appear only in the `/` palette, never as toolbar chips; picking one stages it in the composer so the user can add a one-line note (`supplement`) before Enter. Replay is an ordinary page-scope run whose first turn is built by `shortcut-prompts.ts`'s recorded branch — no page prefetch, no new tool or bypass — and `ShortcutRerun.supplement` makes "regenerate" replay the same note. "恢复预设" deletes recorded tasks along with custom ones.
```

3. 同一段里"the panel renders every usable shortcut as a chip"改为"the panel renders every usable shortcut except recorded tasks as a chip"。

- [ ] **Step 2: 更新 README**

`README.md` 的「⚡ 快捷指令」条目末尾追加一句：

```markdown
动过页面的回复可以一键「保存为指令」：Runi 记下这次成功走通的步骤（已脱敏，敏感字段不记录），之后在 `/` 面板里选中它、补一句"这次的不同之处"，就能让 agent 照着这条路再做一遍，页面有变化时它会自行调整
```

`README.en.md` 的对应条目追加：

```markdown
Any reply that changed the page can be saved as a task: Runi keeps the steps that worked (redacted, sensitive fields never recorded), and later you pick it from the `/` palette, optionally add a note about what's different this time, and the agent follows the same path, adapting where the page has changed
```

- [ ] **Step 3: 同步设计稿**

`docs/superpowers/specs/2026-09-23-task-replay-design.md`：
- 头部「状态」改为 `已实现（<Task 1 的提交>..HEAD）`，实现完成后填入实际的起始提交号。
- §3.2 代码块上方加一句："实现时拆成 `task-trajectory.ts`（类型/校验/渲染）与 `trajectory-recorder.ts`（录制），理由见实现计划开头。"
- §4.3 第 3 点与 §6.3 prompt 示例里的敏感字段文案改为"🔒 敏感字段「X」需由用户自己填写（未记录）"，并补一句："`planFormFill` 在到达页面之前就丢掉了 sensitive 字段，Runi 从未替用户填过它们，所以不能写成'已填写'，也不该让模型去索取一个它无法写入的值。"
- §10 影响面清单的"新增"里补上 `lib/agent/trajectory-recorder.ts` 与 `lib/chat/recorded-task.ts`。

- [ ] **Step 4: 全量验证**

Run: `pnpm compile`
Expected: 无错误。

Run: `pnpm test`
Expected: 全部通过，包括六个仓库级守卫测试（`brand-namespace.test.ts` 要求所有 storage 键在 `runi:` 下——本功能复用 `runi:shortcuts`，没有新键）。

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md README.md README.en.md docs/superpowers/specs/2026-09-23-task-replay-design.md
git commit -m "docs: 任务回放写进 CLAUDE.md 与 README，设计稿标记为已实现" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: 手动验收（真实浏览器）**

`pnpm build` 后从 `.output/chrome-mv3` 加载扩展，在 `lib/dev-config.ts` 填好 dev key（不提交），用 `demo/trust-demo.html` 或任一带表单的页面：
1. 让 agent 填一次表单并点下一步 → 回复下出现书签按钮 → 保存，抽屉里的步骤标签是"下一步"而不是跳转后的页面元素。
2. 刷新页面，在输入框输入 `/` 选中刚存的指令 → 出现胶囊 → 输入"金额改成 300"回车 → agent 不先读正文、直接 `browser_get_form` 并按参考步骤操作。
3. 设置页 → 快捷指令，看到"录制的任务"标签与只读步骤；改名后再从侧边栏运行一次，仍然带着轨迹。

在完成报告里如实写明这三项里哪些做过、结果如何。
