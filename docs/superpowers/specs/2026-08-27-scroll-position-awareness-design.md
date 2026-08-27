# 页面位置感 + 容器内滚动 · 设计说明

- 日期：2026-08-27
- 来源：`docs/superpowers/specs/2026-08-26-page-agent-benchmark.md` §三 P1「页面位置感 + 容器内滚动」
- 状态：已评审，待实现

## 1. 问题

`browser_scroll`（`lib/messaging.ts` `ScrollPagePayload`/`ScrollPageResult`，实现在 `entrypoints/background.ts:950`）现在只有两种模式：窗口坐标滚动（`x`/`y`）和 `scrollIntoView(selector)`。这带来两个缺口：

1. **误报 bug**：`scrollPage` 滚动结束后，无论 `selector` 落在哪个元素上，汇报的 `scrolledBy`/`pixelsAbove`/`pixelsBelow` 永远按**窗口**的 `scrollY`/`document.documentElement.scrollHeight` 计算。原生 `scrollIntoView` 其实会正确地把目标元素最近的可滚动祖先（一个 `overflow:auto` 的内层面板）滚动到位，但如果窗口本身没动，工具会误报"⚠️ 页面没有滚动"——这正是后台管理系统、聊天记录、虚拟列表这类"内层 overflow 面板"给人的观感是"基本滚不动"的真实成因：不是滚动失败了，是**汇报错了**。
2. **能力缺口**：模型不知道页面上有哪些可滚动容器，也没法在不知道具体目标元素的情况下直接滚动一个容器（比如"往下翻一屏加载虚拟列表的下一批"）。

对标 `alibaba/page-agent` 的 `dom/getPageInfo.ts`（可滚动容器标注）与 `scroll(index)`（滚指定容器，`actions.ts:275` 沿祖先链找最近可滚动祖先）。

## 2. 目标与非目标

**目标**

- 修复 `browser_scroll` 在 `selector` 模式下的误报：滚动后按"实际发生滚动的那个滚动盒"（可能是内层容器，可能是窗口）汇报，而不是恒定按窗口汇报。
- `browser_get_form` 新增可选采集：发现页面上的可滚动容器，用与表单字段同一套 `fieldId` 机制发放句柄。
- `browser_scroll` 新增 `fieldId` 参数：直接滚动一个已发现的容器，不需要该容器内部有具体目标元素。

**非目标（明确不做）**

| 不做 | 理由 |
|------|------|
| 水平滚动容器（`overflow-x`） | 对齐 page-agent 参考实现的 top/bottom 语义；横向滚动容器少见，YAGNI |
| 容器的父子层级表达 | 每个可滚动容器独立上报，不建立嵌套关系；模型按 `fieldId` 各自寻址就够用 |
| `selector` 模式下"目标未找到"的报错改进 | 维持现状的静默 `finalY = startY`，不在本次范围 |
| "翻一屏"式相对滚动语义 | `fieldId` 模式的 `y` 仍是容器内的绝对 `scrollTop` 目标值；模型可以从 `scrollableContainers` 读到当前 `scrollTop`/`clientHeight` 自己算，与滚窗口时必须自己算绝对坐标是同一套心智模型，不额外加新概念 |
| 影响权限分类 | `browser_get_form` 仍是 `always_allow`，`browser_scroll` 仍是 `auto_allow`（write），新增参数不改变分类 |

## 3. 关键决策

### 3.1 可滚动容器判定：`scrollHeight > clientHeight` 且 computed `overflow-y` 是 `auto`/`scroll`

只看 `scrollHeight > clientHeight` 不够：`overflow: visible` 的元素也可能因为内容溢出而 `scrollHeight > clientHeight`，但对它设置 `scrollTop` 浏览器会直接忽略（不建立滚动盒）。必须同时检查 computed `overflow-y` 是 `auto` 或 `scroll`，确认这是一个真正能被程序化滚动的容器。`html`/`body` 排除在外——它们对应窗口滚动，已有能力覆盖，不重复建模。

### 3.2 采集时机：复用 `collectFormFields` 现有的 `walk()`，`includeScrollable` 门控 `getComputedStyle` 开销

`walk()`（`form-dom.ts`）已经在用 `querySelectorAll('*')` 遍历全树并对每个候选字段调用 `isVisible()`（内部含一次 `getComputedStyle`）。可滚动容器判定同样需要 `getComputedStyle`，但对象是**全部元素**而不只是字段候选——对大页面这笔开销不小，因此必须像 `includeText` 一样门控在 `input.includeScrollable === true` 时才执行，默认调用零额外开销。检测逻辑放在 `walk()` 内部，字段判定（`isFieldTag`）的 `continue` 之前，避免可滚动容器通常是普通 `div`（不是 field tag）而被提前跳过。收集数量上限 `MAX_SCROLLABLE_CONTAINERS = 20`（`form-dom.ts` 内部常量，与 `maxFields`/`maxOptions` 一样是防御极端页面的硬上限，不需要做成参数）。

### 3.3 fieldId 复用同一张句柄表，但用独立命名空间

`browser_scroll(fieldId)` 需要和 `browser_click(fieldId)` 一样的"查表 → 验证 expect → 操作"流程，最自然的做法是复用 `tab-form-fields.ts` 现有的 `FormFieldTable`（`Record<string, FormFieldHandle>`），而不是另起一张表——避免又维护一套"表已过期"探测逻辑。`FormFieldKind` 新增 `'scrollable'` 枚举值。

但可滚动容器的 `fieldId` 用独立前缀 `s1`/`s2`/...（表单字段是 `f1`/`f2`/...），不共享同一个递增序号。原因：两者是不同性质的资源（一个是"可操作的表单/可点击元素"，一个是"可滚动的容器"），共享序号除了让 `fieldId` 数字更连续之外没有实际好处，反而让模型更难从 `fieldId` 前缀本身猜出这是什么——`s` 前缀本身就是一个免费的语义提示。

`ScrollableContainerDescriptor` **不**并入 `FormFieldDescriptor`/`GetFormResult.fields`，而是单独的 `GetFormResult.scrollableContainers` 数组（类比 `trailingText` 独立于 `fields` 之外的先例）。理由：`FormFieldDescriptor` 的 `writable`/`clickable`/`sensitive`/`checked`/`options` 等语义都是"表单字段"专属的，可滚动容器套不上这些概念，硬塞进同一个类型只会让消费方（`toFieldDescriptor`、UI 展示等）多处理一堆恒为 `undefined`/`false` 的字段。独立类型更干净。

### 3.4 `selector` 模式的误报修复：滚动前后对比"最近可滚动祖先"的 `scrollTop`，而不是恒定看窗口

在 `scrollIntoView` 调用前，从目标元素沿 `parentElement` 链向上找最近的可滚动容器（判定同 §3.1，遇到 `ShadowRoot` 边界时跳到 `host` 继续向上，直到 `html`/`body` 或找不到为止）。记录该祖先（或窗口，如果没找到）滚动前的位置；`scrollIntoView` 之后，再读同一个祖先/窗口的位置算 `scrolledBy`/`pixelsAbove`/`pixelsBelow`。

如果祖先链一路走到 `html`/`body`（即页面本身没有嵌套的可滚动容器），退化为今天的窗口口径——完全向后兼容，现有测试与调用方不受影响。如果中途命中了别的元素，按该容器的 `scrollTop`/`scrollHeight`/`clientHeight` 计算，并在 `ScrollPageResult.container` 里带上 `{ tag, label? }`，让 `describeScrollResult` 能措辞为"已把内层 xxx 面板下滚"而不是含糊的"已下滚"。

`x`/`y` 模式（没有 `selector`）语义不变：显式指定窗口坐标，本来就是"滚窗口"的意思，没有目标元素可供祖先链查找，不做这个修复。

### 3.5 `fieldId` 模式复用同一个结果形状，靠 `status`/`fieldsTableStale` 表达失败

`browser_scroll({fieldId})` 是一条新的、可能失败的路径（fieldId 不存在 / 句柄表过期 / 页面已变化导致 expect 不匹配），需要仿 `browser_click(fieldId)` 的失败汇报方式。窗口/`selector` 模式历史上从不失败（`selector` 找不到就静默退化为"没滚动"），所以 `status`/`fieldsTableStale` 设计成可选字段：这两个模式不设置它们（等价于成功），只有 `fieldId` 模式会显式写 `'not_found'`/`'mismatch'` 或 `fieldsTableStale: true`。`tools.ts` 里 `makeScrollTool` 的失败处理直接照抄 `makeClickTool` 的模式（`fieldsTableStale` 优先检查，再检查 `status !== 'ok'`）。

`fieldId` 查表校验要多做一步 `browser_click` 没有的检查：`handle.kind === 'scrollable'`——如果模型把一个表单字段的 `fieldId` 传给 `browser_scroll`，必须明确报错而不是尝试对一个 `<input>` 做 `scrollTo`（大概率是模型搞混了两套 fieldId 命名空间，需要一个清楚的错误信息而不是静默的诡异行为）。

### 3.6 两个注入函数不能共享"是否可滚动"的判定逻辑

`collectFormFields`（发现容器）与新的滚动祖先查找逻辑（`scrollPageInPage`，修复误报）都需要判定"这个元素是不是可滚动容器"，但两者都会被 `executeScript` 序列化注入页面，按 `form-dom.ts` 文件头部的既有约束——函数体内不得引用模块作用域的绑定——不能提取一个共享 helper 给两者 import。这与文件里已经存在的多处"⚠️ 与 X 重复"注释是同一个模式（`applyFormFill` 的 submit 分支与 `clickElementInPage` 就各自内联了一份点击派发逻辑）。因此判定逻辑在两处各自内联一份，行为上必须保持一致（改一处要同步改另一处，会加注释互相指涉）。

### 3.7 `scrollPage` 的注入函数从 `background.ts` 挪到 `form-dom.ts`

现有 `scrollPage` 的注入回调是直接以匿名箭头函数的形式写在 `background.ts` 里的（不违反"不引用模块作用域绑定"的约束，因为它本来就没引用任何东西）。这次要新增"祖先链查找"这一段有一定复杂度的逻辑，且要与新增的 `scrollContainerInPage`（`fieldId` 模式）共享"这是不是可滚动容器"这个判定的**文字**（不能共享代码，但要保持逻辑一致，见 §3.6）——两者放在同一个文件里更容易在改动时互相对照。因此把它改名为具名导出的 `scrollPageInPage`，从 `background.ts` 挪到 `form-dom.ts`，与 `collectFormFields`/`applyFormFill`/`scrollContainerInPage` 放在一起。这是服务于本次改动的针对性整理，不是无关重构。

## 4. 数据结构改动

```ts
// lib/messaging.ts

export type FormFieldKind =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'contenteditable' | 'file' | 'submit' | 'button' | 'link' | 'unsupported'
  | 'scrollable'; // 新增

export interface GetFormPayload {
  // ...现有字段不变
  includeScrollable?: boolean; // 新增
}

export interface ScrollableContainerDescriptor {
  fieldId: string; // "s1"/"s2"/...，独立于表单字段的 "f1"/"f2" 命名空间（见 §3.3）
  tag: string;
  /** 尽力而为的标签：aria-label/id 兜底，页面可控，已压空白截断。 */
  label?: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface GetFormResult {
  // ...现有字段不变
  /** 页面上发现的可滚动容器；仅 includeScrollable 时有值（可能是空数组）。 */
  scrollableContainers?: ScrollableContainerDescriptor[]; // 新增
}

export interface ScrollPagePayload {
  /** browser_get_form 的 scrollableContainers 里的 fieldId；优先于 selector。 */
  fieldId?: string; // 新增
  selector?: string;
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollPageResult {
  selector?: string;
  x: number;
  y: number;
  scrolledBy: number;
  pixelsAbove: number;
  pixelsBelow: number;
  viewportHeight: number;
  /** 实际发生滚动的是内层容器而非整个窗口时才有值。 */
  container?: { tag: string; label?: string }; // 新增
  /** 仅 fieldId 模式会失败；window/selector 模式不设置（向后兼容，等价于成功）。 */
  status?: 'ok' | 'not_found' | 'mismatch'; // 新增
  fieldsTableStale?: boolean; // 新增
}
```

```ts
// lib/agent/form-dom.ts

export interface CollectFormInput {
  // ...现有字段不变
  includeScrollable?: boolean; // 新增
}

export interface RawScrollableContainer {
  path: FormFieldPathStep[];
  tag: string;
  label?: string; // 未净化，只做过空白压缩+截断（内联写法，理由见 §3.3 的失败分析同款约束）
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface CollectFormOutput {
  // ...现有字段不变
  /** 仅 includeScrollable 时有值（可能是空数组）。 */
  scrollables?: RawScrollableContainer[]; // 新增
}

// 新增注入函数：fieldId 直接滚一个已发现的容器
export interface ScrollContainerInput {
  url: string;
  path: FormFieldPathStep[];
  expect: { tag: string };
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}
export interface ScrollContainerOutput {
  status: 'ok' | 'not_found' | 'mismatch';
  x: number;
  y: number;
  scrolledBy: number;
  pixelsAbove: number;
  pixelsBelow: number;
  viewportHeight: number; // = 容器的 clientHeight
  tag?: string;
  label?: string;
}
export function scrollContainerInPage(input: ScrollContainerInput): ScrollContainerOutput { /* ... */ }

// 从 background.ts 挪过来并改造：selector/x/y 模式 + 祖先链探测（见 §3.4/§3.7）
export function scrollPageInPage(input: {
  selector?: string; x?: number; y?: number; behavior?: 'auto' | 'smooth';
}): ScrollPageResult { /* ... */ }
```

```ts
// lib/agent/fill-form-request.ts

export interface FieldScrollPlan {
  ok: boolean;
  reason?: 'no_table' | 'unknown_field' | 'wrong_kind';
  target?: { fieldId: string; path: FormFieldHandle['path']; expect: { tag: string } };
}

/** browser_scroll(fieldId) 的查表与校验，仿 planFieldClick，多校验 kind === 'scrollable'。 */
export function planFieldScroll(fieldId: string, table: FormFieldTable | undefined): FieldScrollPlan { /* ... */ }
```

## 5. 影响面

| 文件 | 改动 |
|------|------|
| `lib/messaging.ts` | 见 §4 |
| `lib/agent/form-dom.ts` | `collectFormFields` 加 `includeScrollable` 分支；新增 `scrollContainerInPage`；新增 `scrollPageInPage`（从 `background.ts` 挪入并加祖先链探测） |
| `lib/agent/fill-form-request.ts` | 新增 `planFieldScroll` |
| `entrypoints/background.ts` | `getForm`/`snapshotFields` 透传 `includeScrollable`、构建 `scrollableContainers` 及对应句柄（`kind: 'scrollable'`，独立 `s{n}` 计数器）；`scrollPage` 改为按 `payload.fieldId` 分流到 `scrollContainerByFieldId`（新，仿 `clickElementByFieldId`）或 `scrollPageInPage`（原逻辑迁入 `form-dom.ts` 后在此调用） |
| `lib/agent/tools.ts` | `browser_get_form` 的 `parameters` 加 `includeScrollable`；`browser_scroll` 的 `parameters` 加 `fieldId`，失败处理仿 `makeClickTool`（`fieldsTableStale` → 提示重新 `browser_get_form`；`status !== 'ok'` → 抛出 detail） |
| `lib/agent/action-result-text.ts` | `describeScrollResult` 感知 `result.container`，措辞区分"滚了窗口"还是"滚了内层面板" |
| `lib/agent/form-dom.dom.test.ts` | 新增用例见 §6 |
| `lib/agent/fill-form-request.test.ts` | 新增 `planFieldScroll` 用例 |
| `lib/agent/action-result-text.test.ts` | 新增 `describeScrollResult` 带 `container` 的用例 |

`lib/agent/permissions.ts` 不改动：`browser_get_form` 仍是 `always_allow`，`browser_scroll` 仍是 `auto_allow`。

## 6. 测试

`lib/agent/form-dom.dom.test.ts`（jsdom，`dom` project）新增：

1. `includeScrollable` 缺省/`false` 时，`scrollables` 为 `undefined`，行为与改动前一致（回归保护）
2. 一个 `overflow-y: auto` 且内容溢出的 `div` 被识别为可滚动容器，记录正确的 `scrollTop`/`scrollHeight`/`clientHeight`
3. `overflow-y: visible` 但同样溢出的元素**不**被识别（§3.1 的判定条件）
4. `html`/`body` 不出现在 `scrollables` 里
5. 数量超过 `MAX_SCROLLABLE_CONTAINERS`（20，`form-dom.ts` 内部常量）时被截断
6. shadow root 内的可滚动容器也能被发现（复用 `walk()` 已有的递归下探）
7. `scrollPageInPage`：`selector` 命中内层可滚动容器时，`container` 字段被设置，`scrolledBy` 按容器口径计算，即使窗口 `scrollY` 没变
8. `scrollPageInPage`：`selector` 命中的元素没有可滚动祖先（一路到 `body`）时，`container` 为 `undefined`，行为与改动前完全一致
9. `scrollContainerInPage`：`url` 不匹配、`path` 解析不到、`expect.tag` 不匹配三种失败路径

`lib/agent/fill-form-request.test.ts`（node env，`unit` project）新增：

10. `planFieldScroll`：`no_table`/`unknown_field`/`wrong_kind`（fieldId 存在但 `kind !== 'scrollable'`）三种失败路径，以及成功路径

`lib/agent/action-result-text.test.ts` 新增：

11. `describeScrollResult`：`result.container` 有值时的措辞（提及容器 tag/label），无值时维持现有措辞（回归保护）

消息协议的类型收敛由 `pnpm compile` 保证。`entrypoints/background.ts` 里 `getForm`/`scrollPage` 的编排逻辑（透传 payload、分流 fieldId）按项目既有惯例不单独测试——真正有逻辑的部分（`planFieldScroll`、`scrollPageInPage`/`scrollContainerInPage` 的判定与计算）已经在对应的 test project 里覆盖。

**自动测不了、需手动验证的清单：**

1. 真实页面（一个带虚拟列表/聊天记录的后台系统）上，`includeScrollable: true` 采集到的容器是否准确、`fieldId` 滚动是否符合预期。
2. 同一个页面上，`selector` 模式滚动内层面板时，修复前后的汇报口径对比——确认误报确实消失了。
