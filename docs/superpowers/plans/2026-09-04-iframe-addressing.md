# iframe 寻址 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让基于 `executeScript` 的页面工具能寻址跨源 iframe 内的元素——写操作经句柄定向到单帧，只读的裸选择器工具广播到所有帧并按帧分组。

**Architecture:** `executeInTab` 增加可选 `frameId` / `allFrames`；`browser_get_form` 改为一次 `allFrames: true` 注入，主框架全量采集、子帧只采可写字段与提交按钮，结果由新的纯函数模块 `frame-merge.ts` 合并编号；句柄表每条记录带上 `frameId` + `frameOrigin`，写入前由注入函数比对 `location.origin` 识别 frameId 复用。安全关键路径是提交探测必须跟着句柄的 frameId 走，这一步抽成 `planProbeTarget` 纯函数以便被测试钉死。

**Tech Stack:** TypeScript / WXT (Manifest V3) / `chrome.scripting` / Vitest（三个 project：`unit`、`ui`、`dom`）

**Spec:** `docs/superpowers/specs/2026-09-04-iframe-addressing-design.md`

## Global Constraints

- **注入函数不得引用模块作用域。** `form-dom.ts` 里被 `executeScript` 序列化的函数（`collectFormFields`、`applyFormFill`、`probeClickTarget`、`probeKeyTarget` 等）不能引用任何 import 或模块级常量，所有纯逻辑必须留在 `form-schema.ts` / `frame-merge.ts` 里。
- **不新增 manifest 权限。** 现有 `permissions: ['sidePanel','storage','scripting','activeTab','tabs','alarms']` 与 `host_permissions: ['<all_urls>']` 不变。
- **不新增权限分级档位。** `permissions.ts` 的 `READ_ONLY_TOOL_NAMES` / `AUTO_APPROVE_TOOL_NAMES` / `DENY_TOOL_NAMES` 三张表本次一条都不加、不改。
- **没有 vitest project 匹配 `entrypoints/**/*.test.ts`。** 任何需要测试的逻辑必须先从 `entrypoints/background.ts` 抽进 `lib/`。
- **测试注释约定：** 每个用例上方写一行「会让这个用例失败的 production 改动：……」，与 `lib/agent/fill-form-request.test.ts` 现有风格一致。
- **命令：** 单文件测试 `pnpm vitest run lib/agent/<file>.test.ts`；全量 `pnpm test`；类型检查 `pnpm compile`。
- **代码注释与提交信息用中文。**

---

### Task 1: `frame-merge.ts` — 多帧结果合并、编号与双上限

**Files:**
- Create: `lib/agent/frame-merge.ts`
- Create: `lib/agent/frame-merge.test.ts`

**Interfaces:**
- Consumes: `CollectFormOutput` / `RawFormField`（`lib/agent/form-dom.ts`、`lib/agent/form-schema.ts`，已存在）
- Produces:
  - `MAX_COLLECTED_FRAMES = 16`、`MAX_FIELDS_PER_CHILD_FRAME = 30`
  - `interface FrameCollection { frameId: number; origin: string; isMain: boolean; output: CollectFormOutput }`
  - `interface MergedCollection { url: string; raws: (RawFormField & { frameId: number; frameOrigin: string })[]; forms: CollectedFormInfo[]; unreachable: { iframes: number; closedShadowRoots: number }; truncated: boolean; trailingText?: string; scrollables?: RawScrollableContainer[]; droppedFrames: number; droppedChildFields: number; frameOrigins: { frameId: number; origin: string }[] }`
  - `mergeFrameCollections(collections: FrameCollection[]): MergedCollection`

- [ ] **Step 1: 写失败测试——主框架优先、子帧按序，编号全局唯一**

在 `lib/agent/frame-merge.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { CollectFormOutput } from './form-dom';
import type { RawFormField } from './form-schema';
import {
  MAX_COLLECTED_FRAMES,
  MAX_FIELDS_PER_CHILD_FRAME,
  mergeFrameCollections,
  type FrameCollection,
} from './frame-merge';

function raw(name: string, tag = 'input'): RawFormField {
  return {
    path: [{ kind: 'selector', selector: tag, index: 0 }],
    tag,
    type: 'text',
    name,
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
  } as RawFormField;
}

function output(names: string[], url: string): CollectFormOutput {
  return {
    url,
    raws: names.map((name) => raw(name)),
    forms: [],
    unreachable: { iframes: 0, closedShadowRoots: 0 },
    truncated: false,
  };
}

function frame(frameId: number, origin: string, names: string[], isMain = false): FrameCollection {
  return { frameId, origin, isMain, output: output(names, `${origin}/page`) };
}

describe('mergeFrameCollections', () => {
  // 会让这个用例失败的 production 改动：改成按 frameId 排序而不是主框架优先，
  // 或者忘了把 frameId/frameOrigin 挂到每条 raw 上。
  it('puts the main frame first and tags every raw with its frame', () => {
    const merged = mergeFrameCollections([
      frame(7, 'https://pay.example.com', ['card']),
      frame(0, 'https://shop.example.com', ['email', 'name'], true),
    ]);

    expect(merged.raws.map((item) => item.name)).toEqual(['email', 'name', 'card']);
    expect(merged.raws.map((item) => item.frameId)).toEqual([0, 0, 7]);
    expect(merged.raws[2].frameOrigin).toBe('https://pay.example.com');
    expect(merged.url).toBe('https://shop.example.com/page');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/frame-merge.test.ts`
Expected: FAIL — `Failed to resolve import "./frame-merge"`

- [ ] **Step 3: 写最小实现**

创建 `lib/agent/frame-merge.ts`：

```ts
// 多帧采集结果的合并、编号与截断（ref: docs/superpowers/specs/2026-09-04-iframe-addressing-design.md §4）。
//
// 抽成纯函数的理由与 fill-form-request.ts 一致：这段逻辑埋在 entrypoints/background.ts
// 里就没有任何 vitest project 能覆盖到，而「子帧字段不能挤掉主框架字段」「上限触发时
// 必须如实告诉模型丢了多少」都是需要被钉死的行为。
import type { CollectFormOutput, CollectedFormInfo } from './form-dom';
import type { RawFormField, RawScrollableContainer } from './form-schema';

/** 参与合并的子帧数上限。超出的按注入返回序丢弃。 */
export const MAX_COLLECTED_FRAMES = 16;
/** 单个子帧的字段数上限。 */
export const MAX_FIELDS_PER_CHILD_FRAME = 30;

export interface FrameCollection {
  frameId: number;
  origin: string;
  isMain: boolean;
  output: CollectFormOutput;
}

export type MergedRawField = RawFormField & { frameId: number; frameOrigin: string };

export interface MergedCollection {
  url: string;
  raws: MergedRawField[];
  forms: CollectedFormInfo[];
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  trailingText?: string;
  scrollables?: RawScrollableContainer[];
  /** 因 MAX_COLLECTED_FRAMES 被丢弃的子帧数。 */
  droppedFrames: number;
  /** 因 MAX_FIELDS_PER_CHILD_FRAME 被丢弃的子帧字段总数。 */
  droppedChildFields: number;
  /** 出现在 raws 里的帧清单，供渲染层做分组标题。 */
  frameOrigins: { frameId: number; origin: string }[];
}

export function mergeFrameCollections(collections: FrameCollection[]): MergedCollection {
  const main = collections.find((item) => item.isMain);
  const children = collections.filter((item) => !item.isMain);
  const keptChildren = children.slice(0, MAX_COLLECTED_FRAMES);

  const raws: MergedRawField[] = [];
  let droppedChildFields = 0;

  const push = (collection: FrameCollection, limit?: number): void => {
    const source = collection.output.raws;
    const kept = limit === undefined ? source : source.slice(0, limit);
    if (limit !== undefined) droppedChildFields += source.length - kept.length;
    for (const item of kept) {
      raws.push({ ...item, frameId: collection.frameId, frameOrigin: collection.origin });
    }
  };

  if (main) push(main);
  for (const child of keptChildren) push(child, MAX_FIELDS_PER_CHILD_FRAME);

  return {
    url: main?.output.url ?? collections[0]?.output.url ?? '',
    raws,
    forms: main?.output.forms ?? [],
    unreachable: {
      iframes: collections.reduce((sum, item) => sum + item.output.unreachable.iframes, 0),
      closedShadowRoots: collections.reduce((sum, item) => sum + item.output.unreachable.closedShadowRoots, 0),
    },
    truncated: collections.some((item) => item.output.truncated),
    trailingText: main?.output.trailingText,
    scrollables: main?.output.scrollables,
    droppedFrames: children.length - keptChildren.length,
    droppedChildFields,
    frameOrigins: collections
      .filter((item) => raws.some((field) => field.frameId === item.frameId))
      .map((item) => ({ frameId: item.frameId, origin: item.origin })),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/frame-merge.test.ts`
Expected: PASS

- [ ] **Step 5: 补双上限截断的测试**

追加到 `lib/agent/frame-merge.test.ts` 的 `describe` 内：

```ts
  // 会让这个用例失败的 production 改动：把 slice 上限去掉，或者丢弃时不计数——
  // 那样模型会以为自己看到了页面上全部字段。
  it('drops frames past MAX_COLLECTED_FRAMES and fields past MAX_FIELDS_PER_CHILD_FRAME', () => {
    const children = Array.from({ length: MAX_COLLECTED_FRAMES + 3 }, (_, index) =>
      frame(index + 1, `https://ad${index}.example.com`, ['x']),
    );
    const fat = frame(99, 'https://big.example.com', Array.from({ length: MAX_FIELDS_PER_CHILD_FRAME + 5 }, (_, i) => `f${i}`));

    const merged = mergeFrameCollections([
      frame(0, 'https://shop.example.com', ['email'], true),
      fat,
      ...children,
    ]);

    expect(merged.droppedFrames).toBe(3);
    expect(merged.droppedChildFields).toBe(5);
    expect(merged.raws.filter((item) => item.frameId === 99)).toHaveLength(MAX_FIELDS_PER_CHILD_FRAME);
  });

  // 会让这个用例失败的 production 改动：主框架缺席时（注入被 CSP 拒绝）抛异常而不是降级。
  it('survives a missing main frame instead of throwing', () => {
    const merged = mergeFrameCollections([frame(4, 'https://widget.example.com', ['q'])]);
    expect(merged.raws).toHaveLength(1);
    expect(merged.url).toBe('https://widget.example.com/page');
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/frame-merge.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 7: 类型检查并提交**

```bash
pnpm compile
git add lib/agent/frame-merge.ts lib/agent/frame-merge.test.ts
git commit -m "feat: 新增 frame-merge 多帧采集结果合并与双上限截断"
```

---

### Task 2: `collectFormFields` 接受 `scope` 并上报 origin

**Files:**
- Modify: `lib/agent/form-dom.ts:10-17`（`CollectFormInput`）、`:26-36`（`CollectFormOutput`）、`:38` 起（函数体内的采集分支）
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MergedCollection`（仅类型层面呼应，本任务不 import）
- Produces: `CollectFormInput.scope?: 'main' | 'child'`（缺省 `'main'`，保持既有调用点行为不变）；`CollectFormOutput.origin: string`

- [ ] **Step 1: 写失败测试——子帧 scope 只收可写字段与提交按钮**

追加到 `lib/agent/form-dom.dom.test.ts`：

```ts
describe('collectFormFields scope', () => {
  // 会让这个用例失败的 production 改动：子帧也走通用可交互元素采集分支——
  // 那样广告 iframe 里的几十个链接会把真正的目标字段挤出截断线。
  it('collects only writable fields and submits in child scope', () => {
    render(`
      <form>
        <input name="card" type="text" />
        <button type="submit">支付</button>
      </form>
      <a href="https://ad.example.com">广告链接</a>
      <div role="button" tabindex="0">自定义按钮</div>
    `);

    const child = collectFormFields({ ...INPUT, scope: 'child' });
    const main = collectFormFields({ ...INPUT, scope: 'main' });

    expect(child.raws.map((item) => item.tag)).toEqual(['input', 'button']);
    expect(main.raws.some((item) => item.tag === 'a')).toBe(true);
  });

  // 会让这个用例失败的 production 改动：不上报 origin——
  // 那样写入前的 frameId 复用比对（Task 4）就没有可比的东西。
  it('reports the document origin', () => {
    render('<input name="q" />');
    expect(collectFormFields({ ...INPUT }).origin).toBe(location.origin);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts -t "scope"`
Expected: FAIL — `scope` 不在 `CollectFormInput` 上（类型错误），且 `origin` 为 `undefined`

- [ ] **Step 3: 改类型**

`lib/agent/form-dom.ts`：

```ts
export interface CollectFormInput {
  selector?: string;
  includeHidden?: boolean;
  includeText?: boolean;
  includeScrollable?: boolean;
  maxFields: number;
  maxOptions: number;
  /**
   * 'child' 时只采可写字段与提交按钮（ref: 设计文档 §4.1）。缺省 'main' 保持既有行为。
   * 判断权由 background 下发而不是让本函数用 window.top === window 自己决定：
   * 规则留在参数层，form-schema 的纯函数才能覆盖它。
   */
  scope?: 'main' | 'child';
}
```

```ts
export interface CollectFormOutput {
  url: string;
  /** 本帧的 location.origin，写入前比对 frameId 是否被复用（ref: 设计文档 §3.3）。 */
  origin: string;
  raws: RawFormField[];
  // ...其余字段不变
}
```

- [ ] **Step 4: 改函数体**

在 `collectFormFields` 开头（`const includeScrollable = ...` 之后）加：

```ts
  const isChildScope = input.scope === 'child';
```

在 `walk()` 里，`if (!interactiveKind) continue;` 之后、真正 push 之前插入子帧过滤。复用函数内已有的 `isStandardFieldTag`（`form-dom.ts:165`）——它判定的正是 input/textarea/select/button/contenteditable，恰好等于「可写字段 + 提交按钮」，而链接、`role`/`tabindex` 与 `cursor:pointer` 驱动的元素都不在其中：

```ts
      // 子帧只要能写的字段和提交按钮：广告/埋点 iframe 几乎没有可写表单字段，
      // 因此在窄采集下自然贡献 0 条，而登录/支付/客服框要的字段一条不少。
      if (isChildScope && !isStandardFieldTag(element)) continue;
```

> `classifyInteractive` 的返回值是 `false | 'semantic' | 'cursor'`，没有 `'generic'` 这一档——不要照着直觉去比对不存在的字面量。

并在 `includeScrollable` 分支上加同样的守卫（子帧不采可滚动容器）：

```ts
      if (!isChildScope && includeScrollable && scrollables.length < MAX_SCROLLABLE_CONTAINERS && isScrollableContainer(element)) {
```

在 return 处补上 origin：

```ts
  return { url: location.href, origin: location.origin, raws, forms, unreachable, truncated, trailingText, scrollables };
```

> 实现提示：`interactiveKind` 的具体取值取决于 `classifyInteractive` 的现有返回值，实现时以该函数为准，不要照抄 `'generic'` 这个字面量——目标是"排除掉非表单控件的通用可交互元素（链接、`role`/`tabindex` 驱动的自定义控件）"，保留 `WRITABLE_KINDS` 与 submit。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS（含既有全部用例——`scope` 缺省必须与改动前行为完全一致）

- [ ] **Step 6: 类型检查并提交**

```bash
pnpm compile
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts
git commit -m "feat: collectFormFields 支持子帧窄采集并上报 origin"
```

---

### Task 3: `executeInTab` 支持 frameId 与 allFrames，`getForm` 走多帧

**Files:**
- Modify: `entrypoints/background.ts:1018-1032`（`executeInTab`）、`:612-625`（`snapshotFields` 的注入调用）、`:632-641`（句柄构造）
- Test: 无新增单测（纯 I/O 编排）；由 Task 1/2 的单测 + `pnpm compile` + 手动加载扩展验证

**Interfaces:**
- Consumes: `mergeFrameCollections` / `FrameCollection`（Task 1）、`CollectFormInput.scope` / `CollectFormOutput.origin`（Task 2）
- Produces: `executeInTab(tabId, input, func, options?: { frameId?: number })`；`executeInAllFrames(tabId, buildInput, func): Promise<FrameCollection[]>`

- [ ] **Step 1: 给 `executeInTab` 加 frameId**

```ts
async function executeInTab<TInput, TResult>(
  tabId: number,
  input: TInput,
  func: (input: TInput) => TResult | Promise<TResult>,
  options?: { frameId?: number },
): Promise<TResult> {
  const tab = await resolveTargetTab(tabId);
  const [frame] = await browser.scripting.executeScript({
    // frameId 缺省即主框架，与改动前的 { tabId } 等价。
    target: options?.frameId === undefined ? { tabId: tab.id } : { tabId: tab.id, frameIds: [options.frameId] },
    world: 'MAIN',
    args: [input],
    func,
  });
  return frame.result as TResult;
}
```

- [ ] **Step 2: 加 `executeInAllFrames`**

紧随 `executeInTab` 之后：

```ts
/**
 * 广播注入并按帧收集结果。跨源子帧靠 host_permissions '<all_urls>' 覆盖，
 * 不需要 webNavigation：每条 InjectionResult 自带 frameId。
 * 单帧注入失败（CSP 拒绝、帧已销毁）不该让整次采集失败——result 为空的帧直接跳过。
 */
async function executeInAllFrames<TInput, TResult extends { origin: string }>(
  tabId: number,
  buildInput: (isMain: boolean) => TInput,
  func: (input: TInput) => TResult | Promise<TResult>,
): Promise<{ frameId: number; origin: string; isMain: boolean; output: TResult }[]> {
  const tab = await resolveTargetTab(tabId);
  const results = await browser.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    args: [buildInput(true), buildInput(false)],
    // 注入函数自己判断身份来选参数：executeScript 无法给不同帧传不同 args。
    func: (mainInput: TInput, childInput: TInput) => func(window.top === window ? mainInput : childInput),
  });
  return results
    .filter((entry) => entry.result)
    .map((entry) => {
      const output = entry.result as TResult;
      return { frameId: entry.frameId, origin: output.origin, isMain: entry.frameId === 0, output };
    });
}
```

> 注意：`executeScript` 对所有帧发同一份 `args`，所以两份输入一起传进去、由注入侧按 `window.top === window` 选用。这与 Task 2 里"判断权在参数层"并不矛盾——分流规则（收什么）仍在参数里，这里选的只是用哪份参数。

- [ ] **Step 3: 改 `snapshotFields` 的采集调用**

把 `snapshotFields` 里的 `executeInTab(..., collectFormFields)` 换成：

```ts
  const frames = await executeInAllFrames(
    tabId,
    (isMain): CollectFormInput => ({
      // selector 是「把范围收窄到这个容器」，跨帧的容器概念不成立：传了就只采主框架。
      selector: payload?.selector,
      includeHidden: payload?.includeHidden,
      includeText: payload?.includeText,
      includeScrollable: payload?.includeScrollable,
      maxFields: MAX_FORM_FIELDS,
      maxOptions: MAX_SELECT_OPTIONS,
      scope: isMain ? 'main' : 'child',
    }),
    collectFormFields,
  );
  const scoped = payload?.selector ? frames.filter((frame) => frame.isMain) : frames;
  const collected = mergeFrameCollections(scoped);
```

- [ ] **Step 4: 句柄带上 frameId / frameOrigin**

`collected.raws.forEach` 里的句柄构造改为：

```ts
    handles[fieldId] = {
      path: raw.path,
      expect: { tag: raw.tag, type: raw.type, name: raw.name, label: descriptor.label, href: raw.href },
      sensitive: descriptor.sensitive,
      kind: descriptor.kind,
      // 主框架不写这两个字段：缺省即主框架，旧版本存下的句柄表因此仍然有效。
      frameId: raw.frameId === 0 ? undefined : raw.frameId,
      frameOrigin: raw.frameId === 0 ? undefined : raw.frameOrigin,
    };
```

- [ ] **Step 5: 类型检查**

Run: `pnpm compile`
Expected: 通过。若报 `CollectFormOutput` 缺 `origin`，说明 Task 2 未完成——先回去补。

- [ ] **Step 6: 跑全量测试确认没回归**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add entrypoints/background.ts
git commit -m "feat: executeInTab 支持 frameId，getForm 改为多帧采集"
```

---

### Task 4: 句柄表带 frameId/frameOrigin，写入前比对 origin

**Files:**
- Modify: `lib/agent/tab-form-fields.ts:8-14`（`FormFieldHandle`）
- Modify: `lib/agent/form-dom.ts`（`applyFormFill` 与 `clickElementInPage` 的输入类型与校验分支）
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Consumes: Task 3 写入的 `frameId` / `frameOrigin`
- Produces: `FormFieldHandle.frameId?: number`、`FormFieldHandle.frameOrigin?: string`；注入函数输入新增 `expectOrigin?: string`，不符时返回既有的 stale 状态

- [ ] **Step 1: 扩展 `FormFieldHandle`**

`lib/agent/tab-form-fields.ts`：

```ts
export interface FormFieldHandle {
  path: FormFieldPathStep[];
  expect: { tag: string; type?: string; name?: string; label?: string; href?: string };
  sensitive: boolean;
  kind: FormFieldKind;
  /** 该字段所在帧；缺省 = 主框架，旧版本存下的表读回来仍然有效（ref: 设计文档 §3.2）。 */
  frameId?: number;
  /**
   * 发放句柄时该帧的 origin。Chrome 会把回收掉的 frameId 复用给别的帧，
   * 只比对 frameId 会写到完全无关的页面上——origin 比对是堵这个的那道锁。
   */
  frameOrigin?: string;
}
```

- [ ] **Step 2: 写失败测试——origin 不符报 stale**

追加到 `lib/agent/form-dom.dom.test.ts`：

```ts
describe('applyFormFill origin guard', () => {
  // 会让这个用例失败的 production 改动：删掉 expectOrigin 比对分支——
  // 那样 frameId 被 Chrome 复用给另一个帧时，这次写入会落到完全无关的页面上。
  it('refuses to write when the frame origin no longer matches the handle', () => {
    render('<input name="card" value="" />');
    const items: ApplyFillItem[] = [
      {
        fieldId: 'f1',
        value: '4111111111111111',
        path: [{ kind: 'selector', selector: 'input', index: 0 }],
        expect: { tag: 'input', type: 'text', name: 'card' },
      },
    ];

    const result = applyFormFill({ items, expectOrigin: 'https://not-this-origin.example.com' });

    expect(result.fieldsTableStale).toBe(true);
    expect(result.outcomes[0].status).toBe('mismatch');
    expect(document.querySelector('input')!.value).toBe('');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts -t "origin guard"`
Expected: FAIL — 写入成功、`value` 变成了卡号

- [ ] **Step 4: 实现比对**

`applyFormFill` 的输入类型加 `expectOrigin?: string`，函数体最前面加：

```ts
  // frameId 复用检测：句柄发放时记下的 origin 与本帧当前 origin 不符，说明这个
  // frameId 已经被分配给了另一个帧。此时整批拒绝，绝不逐条尝试。
  if (input.expectOrigin && input.expectOrigin !== location.origin) {
    return {
      fieldsTableStale: true,
      outcomes: input.items.map((item) => ({
        fieldId: item.fieldId,
        status: 'mismatch' as const,
        detail: '目标框架已改变，请重新调用 browser_get_form。',
      })),
    };
  }
```

> 状态码用既有的 `'mismatch'` 加 `fieldsTableStale: true`，**不要新增状态值**：`FillFormFieldOutcome['status']` 的联合是 `'ok' | 'mismatch' | 'not_found' | 'not_writable' | 'invalid_value' | 'blocked_sensitive'`（`lib/messaging.ts:516`），而 `FillFormResult.fieldsTableStale`（`:526`）正是「句柄表已失效，模型必须重新 get_form」这个信号的既有载体。

对 `clickElementInPage` 做同样的处理：输入加 `expectOrigin?: string`，不符时返回既有的"句柄过期"结果分支。

- [ ] **Step 5: background 把 expectOrigin 传下去**

`entrypoints/background.ts` 的 `fillForm` / `clickElementByFieldId` 中，注入调用改为带 frameId 且传 origin：

```ts
  const handle = table?.fields[fieldId];
  const result = await executeInTab(
    tabId,
    { ...injectInput, expectOrigin: handle?.frameOrigin },
    applyFormFill,
    { frameId: handle?.frameId },
  );
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS

- [ ] **Step 7: 类型检查并提交**

```bash
pnpm compile && pnpm test
git add lib/agent/tab-form-fields.ts lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts entrypoints/background.ts
git commit -m "feat: 句柄带 frameId/frameOrigin，写入前比对帧 origin"
```

---

### Task 5: `planProbeTarget` — 提交探测跟着 frameId 走（安全关键）

**Files:**
- Modify: `lib/agent/fill-form-request.ts`（新增 `planProbeTarget`）
- Modify: `lib/agent/fill-form-request.test.ts`
- Modify: `entrypoints/background.ts:747`（`probeSubmitIntent`）、`:781`（`probeEnterSubmitIntent`）

**Interfaces:**
- Consumes: `FormFieldTable` / `FormFieldHandle`（含 Task 4 的新字段）
- Produces: `planProbeTarget(fieldId: string | undefined, table: FormFieldTable | undefined): { path?: FormFieldPathStep[]; frameId?: number; expectOrigin?: string }`

> **这是整个设计里唯一能静默打穿确认闸门的地方（spec §5.2）。** 探测若仍只注入主框架，子帧字段会探不到；而 `resolveSubmitIntent` 对探测失败的既有降级是按 `{ isSubmit: false }` 放行——两者叠加的结果是子帧里每一次表单提交都绕过 `confirm_always`。

- [ ] **Step 1: 写失败测试**

追加到 `lib/agent/fill-form-request.test.ts`：

```ts
describe('planProbeTarget', () => {
  // 会让这个用例失败的 production 改动：探测忽略 handle.frameId 只打主框架。
  // 后果不是"探不到"这么轻——探测失败会被 resolveSubmitIntent 降级成
  // { isSubmit: false } 放行，于是子帧里的每一次表单提交都绕过确认闸门。
  it('targets the frame recorded on the handle', () => {
    const plan = planProbeTarget(
      'f9',
      table({ f9: handle({ frameId: 7, frameOrigin: 'https://pay.example.com', kind: 'submit' }) }),
    );

    expect(plan.frameId).toBe(7);
    expect(plan.expectOrigin).toBe('https://pay.example.com');
    expect(plan.path).toBeDefined();
  });

  // 会让这个用例失败的 production 改动：主框架句柄也回传一个 frameId，
  // 那样 executeInTab 会走 frameIds 分支，与改动前的行为不再等价。
  it('leaves frameId undefined for a main-frame handle', () => {
    const plan = planProbeTarget('f1', table({ f1: handle() }));
    expect(plan.frameId).toBeUndefined();
  });

  // 会让这个用例失败的 production 改动：没有句柄时凭空造一个 path 去探测。
  it('returns an empty plan when the handle is unknown', () => {
    expect(planProbeTarget('f404', table({}))).toEqual({});
    expect(planProbeTarget(undefined, undefined)).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/fill-form-request.test.ts -t "planProbeTarget"`
Expected: FAIL — `planProbeTarget is not a function`

- [ ] **Step 3: 实现**

`lib/agent/fill-form-request.ts` 末尾：

```ts
/**
 * 探测该打哪个帧。抽成纯函数不是为了复用，是为了让「探测必须跟着 frameId 走」
 * 这条安全约束有测试守着——background 里的逻辑没有任何 vitest project 覆盖
 * （ref: 设计文档 §5.2）。
 */
export function planProbeTarget(
  fieldId: string | undefined,
  table: FormFieldTable | undefined,
): { path?: FormFieldHandle['path']; frameId?: number; expectOrigin?: string } {
  if (!fieldId || !table) return {};
  const handle = table.fields[fieldId];
  if (!handle) return {};
  return { path: handle.path, frameId: handle.frameId, expectOrigin: handle.frameOrigin };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/fill-form-request.test.ts`
Expected: PASS

- [ ] **Step 5: 接进 background 的两个探测函数**

`probeSubmitIntent` 中把手写的 handle 查找换掉：

```ts
  const target = planProbeTarget(payload?.submitFieldId, table);
  if (!payload?.selector && !target.path) return { isSubmit: false, fieldLabels };

  const probe = await executeInTab(
    tabId,
    { selector: payload?.selector, index: payload?.index, path: target.path },
    probeClickTarget,
    { frameId: target.frameId },
  );
```

`probeEnterSubmitIntent` 里对 `payload?.fieldId` 做同样的替换。

- [ ] **Step 6: 类型检查、全量测试并提交**

```bash
pnpm compile && pnpm test
git add lib/agent/fill-form-request.ts lib/agent/fill-form-request.test.ts entrypoints/background.ts
git commit -m "fix: 提交探测跟随句柄 frameId，堵住子帧提交绕过确认闸门的路径"
```

---

### Task 6: 确认卡显示 frame origin

**Files:**
- Modify: `lib/agent/form-submit.ts:16-20`（`SubmitIntent`）
- Modify: `lib/agent/confirm-summary.ts`
- Modify: `entrypoints/background.ts`（两个探测函数的返回值补 `frameOrigin`）
- Test: `lib/agent/confirm-summary.test.ts`

**Interfaces:**
- Consumes: `planProbeTarget().expectOrigin`（Task 5）
- Produces: `SubmitIntent.frameOrigin?: string`；`summarizeToolCallForConfirmation` 的第四个参数 `mainOrigin?: string`

- [ ] **Step 1: 写失败测试**

追加到 `lib/agent/confirm-summary.test.ts`：

```ts
describe('frame origin 提示', () => {
  // 会让这个用例失败的 production 改动：不渲染 frameOrigin——
  // 用户会以为在向主站提交，实际是在向嵌入的第三方支付域提交。
  it('names the embedding frame when the submit target is cross-origin', () => {
    const result = summarizeToolCallForConfirmation(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: '4111' }], submit: { fieldId: 'f2' }, frameOrigin: 'https://pay.example.com' },
      undefined,
      'https://shop.example.com',
    );
    expect(result.summary).toContain('pay.example.com');
  });

  // 会让这个用例失败的 production 改动：同 origin 也渲染这一行——
  // 绝大多数提交都在主框架，多这一行只是噪音。
  it('stays silent when the frame origin equals the main origin', () => {
    const result = summarizeToolCallForConfirmation(
      'browser_fill_form',
      { fields: [{ fieldId: 'f1', value: 'a' }], submit: { fieldId: 'f2' }, frameOrigin: 'https://shop.example.com' },
      undefined,
      'https://shop.example.com',
    );
    expect(result.summary).not.toContain('嵌入框架');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/confirm-summary.test.ts -t "frame origin"`
Expected: FAIL — summary 里没有 origin

- [ ] **Step 3: 实现**

`lib/agent/form-submit.ts`：

```ts
export interface SubmitIntent {
  isSubmit: boolean;
  formAction?: string;
  fieldCount?: number;
  /** 该表单所在帧的 origin；与主框架相同时由渲染层省略（ref: 设计文档 §5.3）。 */
  frameOrigin?: string;
}
```

`lib/agent/confirm-summary.ts` 的 `summarizeToolCallForConfirmation` 加第四个参数，并在 `result` 组装后追加：

```ts
  const frameOrigin = typeof record.frameOrigin === 'string' ? record.frameOrigin : '';
  // 只在跨 origin 时提示：同 origin 是绝大多数情况，多这一行只是噪音。
  if (frameOrigin && frameOrigin !== mainOrigin) {
    return { ...result, summary: `${result.summary}\n该表单位于嵌入框架 ${new URL(frameOrigin).host}。` };
  }
```

`background.ts` 的两个探测函数把 `target.expectOrigin` 并进返回值：

```ts
  return { ...decideSubmitIntent({ ... }), frameOrigin: target.expectOrigin, fieldLabels };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/confirm-summary.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查、全量测试并提交**

```bash
pnpm compile && pnpm test
git add lib/agent/form-submit.ts lib/agent/confirm-summary.ts lib/agent/confirm-summary.test.ts entrypoints/background.ts
git commit -m "feat: 确认卡标注表单所在的嵌入框架 origin"
```

---

### Task 7: 按帧分组呈现与旁注改写

**Files:**
- Modify: `lib/agent/form-render.ts:87-104`（`renderNotes`）与 `renderFormResultForModel` 的字段渲染段
- Modify: `lib/messaging.ts`（`GetFormResult` 加分帧信息）
- Modify: `lib/agent/system-prompt.ts:75`
- Test: `lib/agent/form-render.test.ts`

**Interfaces:**
- Consumes: `MergedCollection.frameOrigins` / `droppedFrames` / `droppedChildFields`（Task 1）；`FormFieldDescriptor` 需带 `frameOrigin?: string`
- Produces: `GetFormResult.droppedFrames?: number`、`GetFormResult.droppedChildFields?: number`；`FormFieldDescriptor.frameOrigin?: string`

- [ ] **Step 1: 写失败测试**

追加到 `lib/agent/form-render.test.ts`：

```ts
describe('分帧渲染', () => {
  // 会让这个用例失败的 production 改动：把子帧字段和主框架字段平铺在一起——
  // 模型无从判断这个「卡号」输入框属于哪一方。
  it('groups child-frame fields under an origin heading', () => {
    const rendered = renderFormResultForModel(resultWith({
      fields: [
        field({ fieldId: 'f1', label: '邮箱' }),
        field({ fieldId: 'f2', label: '卡号', frameOrigin: 'https://pay.example.com' }),
      ],
    }));

    expect(rendered).toContain('嵌入框架 https://pay.example.com');
    expect(rendered.indexOf('f1')).toBeLessThan(rendered.indexOf('嵌入框架'));
  });

  // 会让这个用例失败的 production 改动：保留旧的 unreachable.iframes 旁注——
  // 那句话现在是假的，会让模型主动放弃它其实够得着的表单。
  it('no longer tells the model that iframes are unreachable', () => {
    const rendered = renderFormResultForModel(resultWith({ unreachable: { iframes: 3, closedShadowRoots: 0 } }));
    expect(rendered).not.toContain('无法读取或操作');
  });

  // 会让这个用例失败的 production 改动：上限截断时不出旁注——
  // 模型会以为自己看到了页面上全部字段。
  it('reports how much was dropped by the frame and field caps', () => {
    const rendered = renderFormResultForModel(resultWith({ droppedFrames: 2, droppedChildFields: 7 }));
    expect(rendered).toContain('2');
    expect(rendered).toContain('7');
  });
});
```

> `resultWith` / `field` 是该测试文件里已有的构造辅助函数；若命名不同，以文件现状为准。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/form-render.test.ts -t "分帧渲染"`
Expected: FAIL

- [ ] **Step 3: 实现渲染**

`renderNotes` 里删掉 `unreachable.iframes` 分支，改为：

```ts
  if (data.droppedFrames) {
    notes.push(`页面嵌入框架过多，有 ${data.droppedFrames} 个框架未采集。`);
  }
  if (data.droppedChildFields) {
    notes.push(`嵌入框架中有 ${data.droppedChildFields} 个字段因单帧上限未列出。`);
  }
```

字段渲染段按 `frameOrigin` 分组：主框架（`frameOrigin` 为 undefined）先平铺，随后每个子帧 origin 输出一行标题再列该帧字段。**只写 origin，不写完整 URL**——嵌入框 URL 常带 token、订单号。

- [ ] **Step 4: 改系统提示词**

`lib/agent/system-prompt.ts:75` 那条替换为：

```ts
  '7. 表单字段按所在框架分组：带「嵌入框架」标题的字段位于 iframe 内，同样可以正常读取、填写和点击，不要因为它在 iframe 里就放弃。',
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/form-render.test.ts lib/agent/system-prompt.test.ts`
Expected: PASS

- [ ] **Step 6: 类型检查、全量测试并提交**

```bash
pnpm compile && pnpm test
git add lib/agent/form-render.ts lib/agent/form-render.test.ts lib/messaging.ts lib/agent/system-prompt.ts
git commit -m "feat: 表单结果按帧分组呈现，删除 iframe 够不着的旁注"
```

---

### Task 8: 只读裸选择器工具广播到所有帧

**Files:**
- Modify: `entrypoints/background.ts`（`queryDom` / `getHtml` / `getComputedStyle` 三个 handler）
- Test: 无新增单测（`executeInAllFrames` 已在 Task 3 落地）；由 `pnpm compile` + 手动验证

**Interfaces:**
- Consumes: `executeInAllFrames`（Task 3）
- Produces: `queryDomInPage` / `getHtmlInPage` / `getComputedStyleInPage` 的返回值各加一个 `origin: string`

> spec §4.6：**只读广播、写入不广播。** 否决方案 C 的理由（一次调用写入多个地方不可预期）只适用于写入；同一个选择器在多帧命中，对读取是有用信息。

- [ ] **Step 0: 先让三个注入函数上报 origin**

`executeInAllFrames` 的泛型约束是 `TResult extends { origin: string }`（Task 3），它靠结果自带的 origin 来标注每一段属于哪个帧。所以这三个注入函数必须和 `collectFormFields`（Task 2）一样，在返回值里加 `origin: location.origin`，对应的 Result 接口在 `lib/messaging.ts` 里同步加字段。漏掉这一步，Step 1 会直接编译不过。

- [ ] **Step 1: 把三个只读 handler 改为广播**

以 `queryDom` 为例，其余两个同型：

```ts
async function queryDom(payload: QueryDomPayload, tabId: number): Promise<QueryDomResult> {
  const frames = await executeInAllFrames(tabId, () => payload, queryDomInPage);
  return mergeReadResultsByFrame(frames);
}
```

结果里每帧一段，段首标注 origin；主框架段不加标题（与 Task 7 的分组呈现同一套观感）。

- [ ] **Step 2: 写工具的裸选择器兜底路径保持主框架**

确认 `browser_click` / `browser_type` / `browser_select` / `browser_modify_dom` / `browser_set_style` 在**没有 fieldId**、只有 selector 时仍走不带 frameId 的 `executeInTab`（即 Task 3 之后的缺省分支）。在这些 handler 上各加一行注释说明这是有意为之，并在结果文案里说明只作用于主框架。

`browser_scroll` 传坐标（非 `fieldId`）时同理只作用于主框架：跨帧滚动没有共同坐标系。

- [ ] **Step 3: 类型检查、全量测试并提交**

```bash
pnpm compile && pnpm test
git add entrypoints/background.ts
git commit -m "feat: 只读裸选择器工具广播到所有帧并按帧分段"
```

---

### Task 9: 执行遮罩的跨帧降级

**Files:**
- Modify: `lib/agent/form-dom.ts`（点击/填写注入函数里的光标事件与 250ms 等待）
- Modify: `entrypoints/background.ts`（写操作定向非主框架时的 `pushOverlayToTab`）
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `expectOrigin` 输入通道（同一批注入参数里加 `isChildFrame?: boolean`）

> spec §6：帧内高亮框自动正确（画在该帧自己的 `document.body`）；顶层模拟光标不可用（content script 只在顶层，子帧派发的 `runi:cursor-move` 无人接收，而其后的 250ms 等待照等不误）。

- [ ] **Step 1: 写失败测试——子帧不空等**

追加到 `lib/agent/form-dom.dom.test.ts`：

```ts
// 会让这个用例失败的 production 改动：子帧仍然派发 runi:cursor-move 并等 250ms——
// 顶层的 content script 收不到这个事件，那 250ms 是纯粹的浪费。
it('skips the cursor animation wait in a child frame', async () => {
  render('<button id="go">提交</button>');
  const seen: string[] = [];
  window.addEventListener('runi:cursor-move', () => seen.push('move'));

  const started = Date.now();
  await clickElementInPage({
    path: [{ kind: 'selector', selector: '#go', index: 0 }],
    expect: { tag: 'button' },
    isChildFrame: true,
  });

  expect(seen).toEqual([]);
  expect(Date.now() - started).toBeLessThan(200);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts -t "child frame"`
Expected: FAIL — 事件被派发，且耗时 ≥250ms

- [ ] **Step 3: 实现**

在 `clickElementInPage` 与 `applyFormFill` 的点击段，把光标事件与等待包进条件：

```ts
      // 子帧里没有 content script（它只在顶层跑），runi:cursor-move 无人接收；
      // 连带那 250ms 等待也就纯属浪费。高亮框不受影响——它画在本帧自己的
      // document.body 上，位置天然正确（ref: 设计文档 §6）。
      if (!input.isChildFrame) {
        // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致。
        window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x: centerX, y: centerY } }));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
```

同样包住 `runi:cursor-click` 的派发。

- [ ] **Step 4: background 推不带坐标的遮罩态**

写操作定向到非主框架（`handle?.frameId !== undefined`）时：

```ts
  // 跨帧操作无法定位顶层光标，改推一个只有 glow + 标签的遮罩态：
  // 用户仍有三个全局信号（glow、标签、header 状态行），精确位置由帧内高亮框给出。
  await pushOverlayToTab(tabId, { active: true, label: '正在嵌入框架中操作', cursor: false });
```

> `pushOverlayToTab` 的实际参数形状以 `lib/agent/tab-overlay-state.ts` 现状为准；若没有 `cursor` 字段就加一个，并在 `agent-overlay.ts` 里让它为 `false` 时隐藏模拟光标。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts lib/agent/agent-overlay.dom.test.ts`
Expected: PASS

- [ ] **Step 6: 类型检查、全量测试并提交**

```bash
pnpm compile && pnpm test
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts entrypoints/background.ts lib/agent/tab-overlay-state.ts lib/agent/agent-overlay.ts
git commit -m "feat: 跨帧写操作的遮罩降级——子帧跳过光标动画，顶层只留 glow 与标签"
```

---

### Task 10: 真实浏览器验收

**Files:** 无代码改动

- [ ] **Step 1: 构建并加载**

```bash
pnpm build
```

`chrome://extensions` → 开发者模式 → 加载 `.output/chrome-mv3`。

- [ ] **Step 2: 逐条走验收清单**

在一个含跨源 iframe 表单的页面上（例如任意带第三方登录或支付嵌入框的站点）：

1. `browser_get_form` 的结果里出现「嵌入框架 <origin>」分组，且主框架字段在前。
2. 对子帧字段 `browser_fill_form`，值真的落进 iframe 里的输入框，返回 `ok`。
3. 子帧里的提交按钮触发确认卡，**且卡片上写着该 iframe 的 origin**。
4. 子帧写操作期间：iframe 内出现高亮框；顶层有 glow 与标签，模拟光标不乱跑。
5. 让 iframe 重新加载后再用旧 fieldId 写入 → 报 stale，不误写。
6. `browser_query_dom` 对一个多帧命中的选择器返回按帧分段的结果。
7. 密码字段仍然被拒填（sensitive 拦截不受分帧影响）。

- [ ] **Step 3: 把验收结果记进 spec**

在 `docs/superpowers/specs/2026-09-04-iframe-addressing-design.md` 顶部把「状态：待实现」改为「状态：已实现（2026-XX-XX）」，并补一行未在真实浏览器覆盖到的场景。

```bash
git add docs/superpowers/specs/2026-09-04-iframe-addressing-design.md
git commit -m "docs: iframe 寻址设计标记为已实现并记录验收范围"
```
