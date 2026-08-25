# 通用元素句柄寻址 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `browser_click` 能用 `browser_get_form` 发放的 `fieldId` 精确点击任意可交互元素（链接、无表单归属的按钮、`role`/`tabindex` 驱动的自定义组件），不再强制模型现写 CSS 选择器；选择器路径继续作为兜底保留。

**Architecture:** 复用 Spec-0005 已验证的「可重新求值路径（`FormFieldPathStep`）+ 结构指纹校验」模式，把 `browser_get_form` 的采集谓词从「表单控件」扩展到「表单控件 + 通用可交互元素」，`browser_click` 新增 `fieldId` 参数并通过已有的 `applyFormFill`（把它当成"零字段、只点提交目标"的调用）执行点击，不新增任何注入函数，零重复实现点击派发逻辑。

**Tech Stack:** TypeScript、WXT、Vitest（unit/node 与 dom/jsdom 两个 project）、`browser.scripting.executeScript`。

**Spec:** `docs/superpowers/specs/2026-08-25-click-handle-addressing-design.md`

## Global Constraints

- `lib/agent/form-dom.ts` 里被 `executeScript` 序列化注入的函数（`collectFormFields`、`applyFormFill` 等）**不得引用任何模块作用域的绑定**——所有辅助逻辑必须是这些函数内部的局部闭包。
- 不做 iframe 穿透，不做 closed shadow root 穿透，不改 `browser_type`/`browser_select`，不改 `tool-policy.ts` 的预算数字或 `permissions.ts` 的权限分级，不做概念重命名（`form-schema.ts`/`form-dom.ts`/`tab-form-fields.ts`/`FormFieldDescriptor` 等命名全部保留）。
- 密码/支付类字段永远不读回、不写入——本次改动不触碰这条规则，也不需要触碰（点击目标不涉及字段值）。
- 每个任务改完就跑对应测试 project：`pnpm vitest run <file>`；全部任务完成后跑一次 `pnpm compile` 和 `pnpm test` 做总验收（Task 11）。
- 提交信息用英文，遵循仓库现有的简短祈使句风格（参考 `git log`）。

---

### Task 1: 共享类型扩展（`lib/messaging.ts`）

**Files:**
- Modify: `lib/messaging.ts:218-229`（`ClickElementPayload`/`ClickElementResult`）、`lib/messaging.ts:294-320`（`FormFieldKind`/`FormFieldDescriptor`）

**Interfaces:**
- Produces：`FormFieldKind` 新增 `'link'`；`FormFieldDescriptor.href?: string`；`ClickElementPayload.selector` 变为可选、新增 `fieldId?: string`；`ClickElementResult` 新增 `fieldsTableStale?: boolean`。后续所有任务都依赖这些字段名。

这是纯类型声明改动，没有运行时行为，因此本任务不写单测，只用 `pnpm compile` 验证类型改动没有破坏现有调用点（`ClickElementPayload.selector` 从必填改为可选是纯放宽，不会让任何现有调用点报错）。

- [ ] **Step 1: 编辑 `ClickElementPayload`/`ClickElementResult`**

把：

```ts
export interface ClickElementPayload {
  selector: string;
  index?: number;
}

export interface ClickElementResult {
  selector: string;
  matched: number;
  clickedIndex: number | null;
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
}
```

改成：

```ts
export interface ClickElementPayload {
  selector?: string;
  index?: number;
  /** browser_get_form 发放的字段句柄，优先于 selector。 */
  fieldId?: string;
}

export interface ClickElementResult {
  selector: string;
  matched: number;
  clickedIndex: number | null;
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  /** 句柄表已失效（页面已导航或 storage 丢失），模型必须重新调用 browser_get_form。 */
  fieldsTableStale?: boolean;
}
```

- [ ] **Step 2: 编辑 `FormFieldKind`/`FormFieldDescriptor`**

把：

```ts
export type FormFieldKind =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'contenteditable' | 'file' | 'submit' | 'button' | 'unsupported';

export interface FormFieldDescriptor {
  fieldId: string;
  kind: FormFieldKind;
  type?: string;
  name?: string;
  label?: string;
  placeholder?: string;
```

改成：

```ts
export type FormFieldKind =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'contenteditable' | 'file' | 'submit' | 'button' | 'link' | 'unsupported';

export interface FormFieldDescriptor {
  fieldId: string;
  kind: FormFieldKind;
  type?: string;
  name?: string;
  label?: string;
  /** 仅 kind === 'link' 时有值。 */
  href?: string;
  placeholder?: string;
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 通过，无新增类型错误（本任务只做可选字段新增/放宽，不应破坏任何现有调用点）。

- [ ] **Step 4: Commit**

```bash
git add lib/messaging.ts
git commit -m "feat: add fieldId to ClickElementPayload and link kind to FormFieldKind"
```

---

### Task 2: 表单/元素纯逻辑层扩展（`lib/agent/form-schema.ts`）

**Files:**
- Modify: `lib/agent/form-schema.ts`
- Test: `lib/agent/form-schema.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `FormFieldKind`（含 `'link'`）、`FormFieldDescriptor.href`。
- Produces：`RawFormField` 新增 `href?: string`、`elementText?: string`、`interactive?: boolean`；`resolveFieldKind` 能把 `<a href>` 判为 `'link'`、把 `interactive: true` 的元素判为 `'button'`；`pickFieldLabel` 对 `button`/`a`/`interactive` 元素追加"元素自身文本"作为兜底标签来源；`CLICKABLE_KINDS` 含 `'link'`；`toFieldDescriptor` 把 `raw.href` 透传到 `FormFieldDescriptor.href`。Task 3（`form-dom.ts`）依赖这些字段名与函数签名不变。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/form-schema.test.ts` 里追加（`resolveFieldKind` describe 块内追加两个 `it`，`pickFieldLabel` describe 块内追加两个 `it`，`toFieldDescriptor` describe 块内追加一个 `it`）：

```ts
  it('maps a hyperlink with an href to link', () => {
    expect(resolveFieldKind(raw({ tag: 'a', href: 'https://example.com' }))).toBe('link');
  });

  it('does not treat an anchor without href as a link', () => {
    expect(resolveFieldKind(raw({ tag: 'a' }))).toBe('unsupported');
  });

  it('maps a generic interactive element (role/tabindex) to button', () => {
    expect(resolveFieldKind(raw({ tag: 'div', interactive: true }))).toBe('button');
  });
```

（放进 `describe('resolveFieldKind', ...)` 块内，紧跟在 `it('falls back to unsupported for anything else', ...)` 之前或之后均可。）

```ts
  it("falls back to the element's own text for buttons, links and generic interactive elements", () => {
    expect(pickFieldLabel(raw({ tag: 'button', elementText: '下单' }))).toBe('下单');
    expect(pickFieldLabel(raw({ tag: 'a', href: '/x', elementText: '登录' }))).toBe('登录');
    expect(pickFieldLabel(raw({ tag: 'div', interactive: true, elementText: '展开菜单' }))).toBe('展开菜单');
  });

  it('does not fall back to element text for a plain text input', () => {
    expect(pickFieldLabel(raw({ tag: 'input', type: 'text', elementText: '一些无关文本' }))).toBeUndefined();
  });
```

（放进 `describe('pickFieldLabel', ...)` 块内。）

```ts
  it('marks links clickable and passes href through', () => {
    const descriptor = toFieldDescriptor(raw({ tag: 'a', href: '/settings' }), 'f11');
    expect(descriptor.clickable).toBe(true);
    expect(descriptor.href).toBe('/settings');
  });

  it('does not set href for a non-link field', () => {
    expect(toFieldDescriptor(raw({ type: 'text', name: 'email' }), 'f12').href).toBeUndefined();
  });
```

（放进 `describe('toFieldDescriptor', ...)` 块内。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/agent/form-schema.test.ts`
Expected: FAIL——`raw()` 助手函数还不接受 `href`/`elementText`/`interactive`（TS 编译错误或运行时 `undefined` 断言失败），`resolveFieldKind`/`pickFieldLabel`/`toFieldDescriptor` 还没有对应分支。

- [ ] **Step 3: 实现**

在 `lib/agent/form-schema.ts` 里，把 `RawFormField` 接口：

```ts
export interface RawFormField {
  path: FormFieldPathStep[];
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  ariaLabel?: string;
  labelledByText?: string;
  forLabelText?: string;
  ancestorLabelText?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  value?: string;
  checked?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
  validationMessage?: string;
  formIndex?: number;
  contentEditable: boolean;
  buttonRole?: 'submit' | 'button';
}
```

改成：

```ts
export interface RawFormField {
  path: FormFieldPathStep[];
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  ariaLabel?: string;
  labelledByText?: string;
  forLabelText?: string;
  ancestorLabelText?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  value?: string;
  checked?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
  validationMessage?: string;
  formIndex?: number;
  contentEditable: boolean;
  buttonRole?: 'submit' | 'button';
  /** 仅 <a> 标签有值：非空即视为链接。 */
  href?: string;
  /** 元素自身可见文本，裁剪空白后的结果；只用作 button/link/interactive 的标签兜底来源。 */
  elementText?: string;
  /** 通过 role/tabindex 启发式识别出的通用可交互元素（非标准表单标签）。 */
  interactive?: boolean;
}
```

把 `pickFieldLabel`：

```ts
export function pickFieldLabel(raw: RawFormField): string | undefined {
  const candidates = [
    raw.forLabelText,
    raw.ancestorLabelText,
    raw.ariaLabel,
    raw.labelledByText,
    raw.placeholder,
    raw.name,
  ];
  for (const candidate of candidates) {
    const normalized = (candidate ?? '').replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.slice(0, MAX_LABEL_CHARS);
  }
  return undefined;
}
```

改成：

```ts
export function pickFieldLabel(raw: RawFormField): string | undefined {
  const tag = raw.tag.toLowerCase();
  const isClickableTag = tag === 'button' || tag === 'a' || raw.interactive === true;
  const candidates = [
    raw.forLabelText,
    raw.ancestorLabelText,
    raw.ariaLabel,
    raw.labelledByText,
    raw.placeholder,
    raw.name,
    isClickableTag ? raw.elementText : undefined,
  ];
  for (const candidate of candidates) {
    const normalized = (candidate ?? '').replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.slice(0, MAX_LABEL_CHARS);
  }
  return undefined;
}
```

把 `resolveFieldKind`：

```ts
export function resolveFieldKind(raw: RawFormField): FormFieldKind {
  const tag = raw.tag.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return raw.buttonRole === 'submit' ? 'submit' : 'button';
  if (tag === 'input') {
    const type = (raw.type ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (type === 'submit' || type === 'image') return 'submit';
    if (type === 'button' || type === 'reset') return 'button';
    if (type === 'hidden') return 'unsupported';
    return 'text';
  }
  if (raw.contentEditable) return 'contenteditable';
  return 'unsupported';
}
```

改成：

```ts
export function resolveFieldKind(raw: RawFormField): FormFieldKind {
  const tag = raw.tag.toLowerCase();
  if (tag === 'a' && raw.href !== undefined) return 'link';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return raw.buttonRole === 'submit' ? 'submit' : 'button';
  if (tag === 'input') {
    const type = (raw.type ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (type === 'submit' || type === 'image') return 'submit';
    if (type === 'button' || type === 'reset') return 'button';
    if (type === 'hidden') return 'unsupported';
    return 'text';
  }
  if (raw.contentEditable) return 'contenteditable';
  if (raw.interactive) return 'button';
  return 'unsupported';
}
```

把 `CLICKABLE_KINDS`：

```ts
const CLICKABLE_KINDS = new Set<FormFieldKind>(['submit', 'button', 'checkbox', 'radio']);
```

改成：

```ts
const CLICKABLE_KINDS = new Set<FormFieldKind>(['submit', 'button', 'link', 'checkbox', 'radio']);
```

把 `toFieldDescriptor` 里 `label: pickFieldLabel(raw),` 这一行下面加一行 `href: raw.href,`：

```ts
    fieldId,
    kind,
    type: raw.type,
    name: raw.name,
    label: pickFieldLabel(raw),
    href: raw.href,
    placeholder: raw.placeholder,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/form-schema.test.ts`
Expected: PASS，全部用例（含新增的）通过。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-schema.ts lib/agent/form-schema.test.ts
git commit -m "feat: classify links and generic interactive elements as clickable fields"
```

---

### Task 3: DOM 采集器扩展（`lib/agent/form-dom.ts`）

**Files:**
- Modify: `lib/agent/form-dom.ts`
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `RawFormField.href`/`elementText`/`interactive`。
- Produces：`collectFormFields` 现在还会采集 `<a href>`、`role` 命中白名单、`[tabindex]>=0` 的通用元素，`describe()` 为它们填充 `href`/`elementText`/`interactive`。Task 5（`background.ts`）依赖 `collectFormFields`/`applyFormFill` 的导出签名保持不变（这次不改）。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/form-dom.dom.test.ts` 的 `describe('collectFormFields', ...)` 块内追加：

```ts
  it('collects a navigation link outside any form', () => {
    render(`<nav><a href="/settings">设置</a></nav>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'a');
    expect(field?.href).toBe('/settings');
    expect(field?.elementText).toBe('设置');
  });

  it('does not collect an anchor without an href', () => {
    render(`<a name="top">回到顶部锚点</a>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'a');
    expect(field).toBeUndefined();
  });

  it('collects a role="button" div as a generic interactive element', () => {
    render(`<div role="button" tabindex="0">展开菜单</div>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'div');
    expect(field?.interactive).toBe(true);
    expect(field?.elementText).toBe('展开菜单');
  });

  it('ignores a div with tabindex="-1" (explicitly not focusable)', () => {
    render(`<div tabindex="-1">仅用于程序聚焦</div>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'div');
    expect(field).toBeUndefined();
  });

  it('collects a native button outside any form with its own text as elementText', () => {
    render(`<button>下单</button>`);
    const field = collectFormFields(INPUT).raws.find((raw) => raw.tag === 'button');
    expect(field?.elementText).toBe('下单');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: FAIL——`isFieldTag` 还不认识 `<a>`/`role`/`tabindex`，`describe()` 还不产出 `href`/`elementText`/`interactive`。

- [ ] **Step 3: 实现**

在 `lib/agent/form-dom.ts` 的 `collectFormFields` 函数体内，把：

```ts
  const isFieldTag = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    return (element as HTMLElement).isContentEditable === true;
  };
```

改成（新增两个局部辅助函数 + 扩展 `isFieldTag`）：

```ts
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch']);

  const hasInteractiveRole = (element: Element): boolean =>
    INTERACTIVE_ROLES.has((element.getAttribute('role') || '').toLowerCase());

  const hasExplicitTabindex = (element: Element): boolean => {
    const attr = element.getAttribute('tabindex');
    if (attr === null) return false;
    const value = Number.parseInt(attr, 10);
    return Number.isFinite(value) && value >= 0;
  };

  const isFieldTag = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    if ((element as HTMLElement).isContentEditable === true) return true;
    if (tag === 'a' && element.getAttribute('href')) return true;
    return hasInteractiveRole(element) || hasExplicitTabindex(element);
  };
```

然后在 `describe()` 函数内，把：

```ts
    const buttonRole =
      tag === 'button'
        ? ((element.getAttribute('type') || 'submit').toLowerCase() === 'submit' ? 'submit' : 'button')
        : undefined;

    return {
      path: buildPath(element),
      tag,
      type: element.getAttribute('type') || undefined,
      name: element.getAttribute('name') || undefined,
      id,
      autocomplete: element.getAttribute('autocomplete') || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      labelledByText,
      forLabelText,
      ancestorLabelText: textOf(element.closest('label')),
      required: asInput.required === true,
      disabled: asInput.disabled === true,
      readOnly: asInput.readOnly === true,
      visible: isVisible(element),
      value: typeof asInput.value === 'string' ? asInput.value : undefined,
      checked: typeof asInput.checked === 'boolean' ? asInput.checked : undefined,
      options,
      validationMessage: typeof asInput.validationMessage === 'string' ? asInput.validationMessage : undefined,
      formIndex: asInput.form ? formElements.indexOf(asInput.form) : undefined,
      contentEditable: (element as HTMLElement).isContentEditable === true,
      buttonRole,
    };
  };
```

改成：

```ts
    const buttonRole =
      tag === 'button'
        ? ((element.getAttribute('type') || 'submit').toLowerCase() === 'submit' ? 'submit' : 'button')
        : undefined;

    const href = tag === 'a' ? (element.getAttribute('href') || undefined) : undefined;
    const isStandardFieldTag =
      tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || href !== undefined;
    const interactive =
      !isStandardFieldTag &&
      (element as HTMLElement).isContentEditable !== true &&
      (hasInteractiveRole(element) || hasExplicitTabindex(element))
        ? true
        : undefined;
    const elementText = tag === 'button' || tag === 'a' || interactive ? textOf(element) : undefined;

    return {
      path: buildPath(element),
      tag,
      type: element.getAttribute('type') || undefined,
      name: element.getAttribute('name') || undefined,
      id,
      autocomplete: element.getAttribute('autocomplete') || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      labelledByText,
      forLabelText,
      ancestorLabelText: textOf(element.closest('label')),
      required: asInput.required === true,
      disabled: asInput.disabled === true,
      readOnly: asInput.readOnly === true,
      visible: isVisible(element),
      value: typeof asInput.value === 'string' ? asInput.value : undefined,
      checked: typeof asInput.checked === 'boolean' ? asInput.checked : undefined,
      options,
      validationMessage: typeof asInput.validationMessage === 'string' ? asInput.validationMessage : undefined,
      formIndex: asInput.form ? formElements.indexOf(asInput.form) : undefined,
      contentEditable: (element as HTMLElement).isContentEditable === true,
      buttonRole,
      href,
      elementText,
      interactive,
    };
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS，全部用例（含既有的表单用例和新增的）通过。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts
git commit -m "feat: collect links and role/tabindex-driven elements alongside form fields"
```

---

### Task 4: fieldId 点击的查表纯函数（`lib/agent/fill-form-request.ts`）

**Files:**
- Modify: `lib/agent/fill-form-request.ts`
- Test: `lib/agent/fill-form-request.test.ts`

**Interfaces:**
- Consumes：`FormFieldHandle`/`FormFieldTable`（`./tab-form-fields`，已在文件顶部导入，无需新增 import）。
- Produces：`FieldClickPlan` 类型、`planFieldClick(fieldId: string, table: FormFieldTable | undefined): FieldClickPlan`。Task 5（`background.ts`）直接调用它。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/fill-form-request.test.ts` 末尾（`mergeFillOutcomes` 的 describe 块之后，或文件末尾）追加：

```ts
describe('planFieldClick', () => {
  it('reports no_table when the tab has no handle table at all', () => {
    expect(planFieldClick('f1', undefined)).toEqual({ ok: false, reason: 'no_table' });
  });

  it('reports unknown_field when the fieldId is not in the table', () => {
    expect(planFieldClick('f9', table({ f1: handle() }))).toEqual({ ok: false, reason: 'unknown_field' });
  });

  it('resolves a known fieldId to its path and expected fingerprint', () => {
    const h = handle({ kind: 'link', expect: { tag: 'a', label: '登录' } });
    expect(planFieldClick('f1', table({ f1: h }))).toEqual({
      ok: true,
      submit: { fieldId: 'f1', path: h.path, expect: h.expect },
    });
  });
});
```

并把顶部的 import：

```ts
import { mergeFillOutcomes, planFormFill } from './fill-form-request';
```

改成：

```ts
import { mergeFillOutcomes, planFieldClick, planFormFill } from './fill-form-request';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/agent/fill-form-request.test.ts`
Expected: FAIL——`planFieldClick` 尚未导出（TS 编译错误：找不到该导出成员）。

- [ ] **Step 3: 实现**

在 `lib/agent/fill-form-request.ts` 的 `mergeFillOutcomes` 函数之前（`planFormFill` 之后）插入：

```ts
export interface FieldClickPlan {
  ok: boolean;
  reason?: 'no_table' | 'unknown_field';
  submit?: { fieldId: string; path: FormFieldHandle['path']; expect: FormFieldHandle['expect'] };
}

/** browser_click(fieldId) 的查表与校验：background 只负责把结果送进页面执行。 */
export function planFieldClick(fieldId: string, table: FormFieldTable | undefined): FieldClickPlan {
  if (!table) return { ok: false, reason: 'no_table' };
  const handle = table.fields[fieldId];
  if (!handle) return { ok: false, reason: 'unknown_field' };
  return { ok: true, submit: { fieldId, path: handle.path, expect: handle.expect } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/fill-form-request.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/fill-form-request.ts lib/agent/fill-form-request.test.ts
git commit -m "feat: add planFieldClick for resolving a browser_click fieldId"
```

---

### Task 5: CLICK_ELEMENT 的 fieldId 分支（`entrypoints/background.ts`）

**Files:**
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes：Task 4 的 `planFieldClick`；既有的 `applyFormFill`（`./lib/agent/form-dom`，零改动，`items: []` 调用其"仅点提交目标"分支）、`getFormFieldsForTab`（`./lib/agent/tab-form-fields`）。
- Produces：`clickElement` 现在识别 `payload.fieldId`；不新增导出，`clickElementByFieldId` 是模块内部函数。

这一层是纯 I/O 编排（读 storage、调用 `executeInTab`），不在任何 vitest project 覆盖范围内（`entrypoints/**/*.test.ts` 不被任何 project 匹配，与 `fillForm` 一致）。用 `pnpm compile` 验证类型，真机行为留到 Task 11 的人工验收。

- [ ] **Step 1: 改 import**

把：

```ts
import { mergeFillOutcomes, planFormFill } from '@/lib/agent/fill-form-request';
```

改成：

```ts
import { mergeFillOutcomes, planFieldClick, planFormFill } from '@/lib/agent/fill-form-request';
```

- [ ] **Step 2: 改 `clickElement`，新增 `clickElementByFieldId`**

把：

```ts
async function clickElement(payload: ClickElementPayload, tabId: number): Promise<ClickElementResult> {
  const selector = payload?.selector || '';
  const index = payload?.index ?? 0;
  const result = await executeInTab(tabId, { selector, index }, clickElementInPage);
  return {
    selector,
    // clickElementInPage 只回报「给定 index 上的目标元素」的结果，不再统计选择器命中的总数；
    // matched/clickedIndex 保留字段是为了不破坏旧的结果形状，语义收窄为「该 index 上是否存在/点中了元素」。
    matched: result.status === 'not_found' ? 0 : 1,
    clickedIndex: result.status === 'ok' ? index : null,
    status: result.status,
    detail: result.detail,
  };
}
```

改成：

```ts
async function clickElement(payload: ClickElementPayload, tabId: number): Promise<ClickElementResult> {
  if (payload?.fieldId) {
    return clickElementByFieldId(payload.fieldId, tabId);
  }
  const selector = payload?.selector || '';
  const index = payload?.index ?? 0;
  const result = await executeInTab(tabId, { selector, index }, clickElementInPage);
  return {
    selector,
    // clickElementInPage 只回报「给定 index 上的目标元素」的结果，不再统计选择器命中的总数；
    // matched/clickedIndex 保留字段是为了不破坏旧的结果形状，语义收窄为「该 index 上是否存在/点中了元素」。
    matched: result.status === 'not_found' ? 0 : 1,
    clickedIndex: result.status === 'ok' ? index : null,
    status: result.status,
    detail: result.detail,
  };
}

// fieldId 路径复用 applyFormFill 的「解析 path → 比对 expect → 派发点击 → 回读」逻辑，
// 把这次调用当成「零字段、只点一个提交目标」的 FILL_FORM 请求——不新增任何注入函数，
// 避免和 applyFormFill 的 submit 分支重复实现同一段点击派发代码。
async function clickElementByFieldId(fieldId: string, tabId: number): Promise<ClickElementResult> {
  const table = await getFormFieldsForTab(tabId);
  const plan = planFieldClick(fieldId, table);
  if (!plan.ok || !plan.submit) {
    return {
      selector: '',
      matched: 0,
      clickedIndex: null,
      status: 'not_found',
      detail: '未知的 fieldId，请重新调用 browser_get_form。',
      fieldsTableStale: plan.reason === 'no_table',
    };
  }

  const applied = await executeInTab(
    tabId,
    { url: table!.url, items: [], submit: plan.submit },
    applyFormFill,
  );

  if (applied.fieldsTableStale) {
    return {
      selector: '',
      matched: 0,
      clickedIndex: null,
      status: 'not_found',
      detail: '页面已导航，字段表已失效，请重新调用 browser_get_form。',
      fieldsTableStale: true,
    };
  }

  const submitted = applied.submitted;
  if (!submitted || submitted.status === 'not_found' || submitted.status === 'mismatch') {
    return {
      selector: '',
      matched: 0,
      clickedIndex: null,
      status: 'not_found',
      detail:
        submitted?.status === 'mismatch'
          ? '该位置的元素与读取时不一致，页面可能已变化，请重新调用 browser_get_form。'
          : '定位路径已解析不到元素，请重新调用 browser_get_form。',
    };
  }

  return {
    selector: '',
    matched: 1,
    clickedIndex: submitted.status === 'ok' ? 0 : null,
    status: submitted.status,
  };
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 通过。`submitted.status`（排除 `not_found`/`mismatch` 后为 `'ok' | 'not_clickable'`）落在 `ClickElementResult.status` 联合类型内，无需类型断言。

- [ ] **Step 4: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: resolve a fieldId-based CLICK_ELEMENT through the existing form-fill engine"
```

---

### Task 6: `browser_click`/`browser_get_form` 工具签名与文案（`lib/agent/tools.ts`）

**Files:**
- Modify: `lib/agent/tools.ts`（`makeClickTool` 约在第 452-472 行、`makeGetFormTool` 约在第 247-275 行——用函数名定位，行号可能已随之前任务改动漂移）

**Interfaces:**
- Consumes：Task 1 的 `ClickElementPayload.fieldId`/`ClickElementResult.fieldsTableStale`。
- Produces：`browser_click` 工具的 `parameters`/`execute` 支持 `fieldId`。`tools.ts` 目前没有专门的测试文件（既有缺口，不在本次范围内一并补齐），本任务用 `pnpm compile` 验证，真机行为留到 Task 11。

- [ ] **Step 1: 改 `makeClickTool`**

把：

```ts
function makeClickTool(tabId: number): BrowserAgentTool {
  return {
    name: 'browser_click',
    label: 'Click',
    description: 'Click the first (or nth) element matching a CSS selector. Use this to interact with buttons, links, or other clickable elements.',
    parameters: Type.Object({
      selector: Type.String({ description: 'CSS selector for the element to click.' }),
      index: Type.Optional(Type.Number({ description: 'Which matched element to click, 0-based. Defaults to 0.' })),
    }),
    execute: async (_toolCallId, params) => {
      const payload = params as ClickElementPayload;
      const response = (await sendMessage<ClickElementPayload, ClickElementResult>('CLICK_ELEMENT', payload, tabId)) as MessageResponse<ClickElementResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '点击失败');
      if (response.data.status !== 'ok') throw new Error(response.data.detail ?? response.data.status);
      return textResult(
        `已点击匹配 "${response.data.selector}" 的第 ${response.data.clickedIndex} 个元素。`,
        response.data as unknown as Record<string, unknown>,
      );
    },
  };
}
```

改成：

```ts
function makeClickTool(tabId: number): BrowserAgentTool {
  return {
    name: 'browser_click',
    label: 'Click',
    description:
      'Click an element. Prefer the fieldId returned by browser_get_form — it now also lists links and other clickable elements, not just form fields. Only fall back to a CSS selector for elements browser_get_form did not return (for example, inside an iframe).',
    parameters: Type.Object({
      fieldId: Type.Optional(Type.String({ description: 'Field id from browser_get_form. Prefer this over selector.' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector fallback for elements browser_get_form did not return.' })),
      index: Type.Optional(Type.Number({ description: 'Which matched element to click when using selector, 0-based. Defaults to 0.' })),
    }),
    execute: async (_toolCallId, params) => {
      const payload = params as ClickElementPayload;
      if (!payload?.fieldId && !payload?.selector) {
        throw new Error('必须提供 fieldId 或 selector 之一。');
      }
      const response = (await sendMessage<ClickElementPayload, ClickElementResult>('CLICK_ELEMENT', payload, tabId)) as MessageResponse<ClickElementResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '点击失败');
      if (response.data.fieldsTableStale) {
        throw new Error('字段表已失效（页面已变化或已导航），请重新调用 browser_get_form 获取新的 fieldId 后再点击。');
      }
      if (response.data.status !== 'ok') throw new Error(response.data.detail ?? response.data.status);
      const target = payload.fieldId
        ? `字段 ${payload.fieldId}`
        : `匹配 "${response.data.selector}" 的第 ${response.data.clickedIndex} 个元素`;
      return textResult(`已点击${target}。`, response.data as unknown as Record<string, unknown>);
    },
  };
}
```

- [ ] **Step 2: 改 `makeGetFormTool` 的描述文案**

把：

```ts
    description:
      'Read every form control on the page as structured data: kind, label, current value, checked state, select options, requiredness, visibility and native validation message. Each field gets a stable fieldId — always use these ids with browser_fill_form instead of writing your own CSS selectors. Prefer this over browser_read_page or browser_get_html for any form task; readable-text extraction strips form controls entirely.',
```

改成：

```ts
    description:
      "Read every form field and other clickable element on the page as structured data: kind (including link and button for non-form elements), label, current value, checked state, select options, requiredness, visibility and native validation message. Each field gets a stable fieldId — use these ids with browser_fill_form for form fields and with browser_click for any clickable element (buttons, links, form-less custom widgets), instead of writing your own CSS selectors. Prefer this over browser_read_page or browser_get_html for any form or click-target task; readable-text extraction strips these elements' structure entirely.",
```

- [ ] **Step 3: 类型检查**

Run: `pnpm compile`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add lib/agent/tools.ts
git commit -m "feat: let browser_click accept a fieldId from the broadened browser_get_form"
```

---

### Task 7: 提交意图探测的 payload 构造抽成纯函数（`lib/agent/agent.ts`）

**Files:**
- Modify: `lib/agent/agent.ts`
- Test: `lib/agent/agent.test.ts`

**Interfaces:**
- Produces：`export function buildSubmitIntentProbePayload(toolName: string, args: unknown): ProbeClickTargetPayload`。Task 8 的确认闸门依赖它间接产出的 `ProbeClickTargetResult.fieldLabels`（该部分在 `background.ts` 的 `probeSubmitIntent` 里已经通用实现，本任务不改 `background.ts`）。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/agent.test.ts` 顶部 import 里加入 `buildSubmitIntentProbePayload`：

```ts
import { buildSubmitIntentProbePayload, createBrowserAgentOptions, createModel, selectStreamFn } from './agent';
```

在文件末尾追加：

```ts
describe('buildSubmitIntentProbePayload', () => {
  it('builds a fieldId probe payload for browser_click with a fieldId', () => {
    expect(buildSubmitIntentProbePayload('browser_click', { fieldId: 'f7' })).toEqual({
      submitFieldId: 'f7',
      fieldIds: ['f7'],
    });
  });

  it('falls back to selector/index for browser_click without a fieldId', () => {
    expect(buildSubmitIntentProbePayload('browser_click', { selector: '#save', index: 2 })).toEqual({
      selector: '#save',
      index: 2,
    });
  });

  it('keeps the existing fill_form payload shape', () => {
    expect(
      buildSubmitIntentProbePayload('browser_fill_form', {
        fields: [{ fieldId: 'f1' }, { fieldId: 'f2' }],
        submit: { fieldId: 'f9' },
      }),
    ).toEqual({ submitFieldId: 'f9', fieldIds: ['f1', 'f2'] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: FAIL——`buildSubmitIntentProbePayload` 尚未从 `./agent` 导出。

- [ ] **Step 3: 实现**

在 `lib/agent/agent.ts` 里，找到 `resolveSubmitIntent: async (toolName, args) => { ... }` 内部构造 `payload` 的这段：

```ts
        resolveSubmitIntent: async (toolName, args) => {
          const record = (args ?? {}) as Record<string, unknown>;
          const payload: ProbeClickTargetPayload =
            toolName === 'browser_fill_form'
              ? {
                  submitFieldId: (record.submit as { fieldId?: string } | undefined)?.fieldId,
                  fieldIds: Array.isArray(record.fields)
                    ? (record.fields as { fieldId?: string }[]).map((field) => String(field.fieldId ?? '')).filter(Boolean)
                    : [],
                }
              : { selector: String(record.selector ?? ''), index: Number(record.index ?? 0) };
          // 探测失败时不阻断，退回普通 confirm 档位——探测只用于「升级」确认强度，
          // 它自己出错（包括消息通道本身没有响应、抛异常）不应该把一次正常的写操作也卡死。
          try {
            const response = (await sendMessage<ProbeClickTargetPayload, ProbeClickTargetResult>(
              'PROBE_CLICK_TARGET',
              payload,
              options.tabId,
            )) as MessageResponse<ProbeClickTargetResult> | undefined;
            return response?.ok && response.data ? response.data : { isSubmit: false };
          } catch {
            return { isSubmit: false };
          }
        },
```

改成：

```ts
        resolveSubmitIntent: async (toolName, args) => {
          const payload = buildSubmitIntentProbePayload(toolName, args);
          // 探测失败时不阻断，退回普通 confirm 档位——探测只用于「升级」确认强度，
          // 它自己出错（包括消息通道本身没有响应、抛异常）不应该把一次正常的写操作也卡死。
          try {
            const response = (await sendMessage<ProbeClickTargetPayload, ProbeClickTargetResult>(
              'PROBE_CLICK_TARGET',
              payload,
              options.tabId,
            )) as MessageResponse<ProbeClickTargetResult> | undefined;
            return response?.ok && response.data ? response.data : { isSubmit: false };
          } catch {
            return { isSubmit: false };
          }
        },
```

并在文件里新增一个顶层导出函数（放在 `createBrowserAgentOptions` 定义之前即可，与 `createModel`/`selectStreamFn` 同级）：

```ts
/**
 * browser_fill_form 走「句柄表批量查」；browser_click 只在带 fieldId 时走同一条路径
 * （复用 background 侧已有的 fieldIds → fieldLabels 查表逻辑），否则退回 selector/index。
 */
export function buildSubmitIntentProbePayload(toolName: string, args: unknown): ProbeClickTargetPayload {
  const record = (args ?? {}) as Record<string, unknown>;
  if (toolName === 'browser_fill_form') {
    return {
      submitFieldId: (record.submit as { fieldId?: string } | undefined)?.fieldId,
      fieldIds: Array.isArray(record.fields)
        ? (record.fields as { fieldId?: string }[]).map((field) => String(field.fieldId ?? '')).filter(Boolean)
        : [],
    };
  }
  if (toolName === 'browser_click' && typeof record.fieldId === 'string' && record.fieldId) {
    return { submitFieldId: record.fieldId, fieldIds: [record.fieldId] };
  }
  return { selector: String(record.selector ?? ''), index: Number(record.index ?? 0) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/agent.test.ts`
Expected: PASS，全部用例（含既有的 tool-policy 用例和新增的）通过。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/agent.ts lib/agent/agent.test.ts
git commit -m "refactor: extract buildSubmitIntentProbePayload so a click fieldId can request its label"
```

---

### Task 8: 确认闸门支持 fieldId 富化（`lib/agent/permissions.ts`）

**Files:**
- Modify: `lib/agent/permissions.ts`
- Test: `lib/agent/permissions.test.ts`

**Interfaces:**
- Consumes：Task 7 后 `resolveSubmitIntent` 对 `browser_click(fieldId)` 也会返回 `fieldLabels`（这是 `background.ts` 里 `probeSubmitIntent` 已有的通用逻辑，本任务不改 `background.ts`）。
- Produces：`beforeToolCallPermissionGate` 在 `browser_click` 带 `fieldId` 时，往 `confirmArgs` 上附加 `label` 字段，供 Task 9 的 `confirm-summary.ts` 读取。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/permissions.test.ts` 的 `describe('submit intent escalation', ...)` 块末尾（`it('enriches only the copy handed to the confirmation UI, ...')` 之后）追加：

```ts
  it('enriches a browser_click(fieldId) confirmation with the field label, without touching the model args', async () => {
    const args = { fieldId: 'f7' };
    const onConfirm = vi.fn().mockResolvedValue(true);

    await beforeToolCallPermissionGate(
      { toolCall: { id: 'call-1', name: 'browser_click' }, args } as any,
      {
        gateState: createConfirmGateState(),
        onConfirm,
        resolveSubmitIntent: async () => ({ isSubmit: false, fieldLabels: [{ fieldId: 'f7', label: '登录' }] }),
      },
    );

    expect((onConfirm.mock.calls[0][2] as any).label).toBe('登录');
    expect((args as any).label).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/agent/permissions.test.ts`
Expected: FAIL——`onConfirm` 收到的第三个参数（`confirmArgs`）目前不带 `label` 字段。

- [ ] **Step 3: 实现**

在 `lib/agent/permissions.ts` 的 `beforeToolCallPermissionGate` 里，把：

```ts
  if (options.resolveSubmitIntent && SUBMIT_CAPABLE_TOOLS.has(toolName)) {
    const intent = await options.resolveSubmitIntent(toolName, context.args);
    if (intent?.isSubmit) {
      always = true;
      reason = intent.formAction
        ? `该操作会把表单提交到 ${intent.formAction}，需要单独确认。`
        : '该操作会提交表单，需要单独确认。';
    }
    const labels = intent?.fieldLabels;
    const record = (context.args ?? {}) as Record<string, unknown>;
    if (labels?.length && Array.isArray(record.fields)) {
      confirmArgs = {
        ...record,
        fields: (record.fields as Record<string, unknown>[]).map((field) => ({
          ...field,
          label: labels.find((entry) => entry.fieldId === field.fieldId)?.label,
        })),
        submit: intent?.isSubmit ? { ...(record.submit as object), formAction: intent?.formAction } : record.submit,
      };
    }
  }
```

改成：

```ts
  if (options.resolveSubmitIntent && SUBMIT_CAPABLE_TOOLS.has(toolName)) {
    const intent = await options.resolveSubmitIntent(toolName, context.args);
    if (intent?.isSubmit) {
      always = true;
      reason = intent.formAction
        ? `该操作会把表单提交到 ${intent.formAction}，需要单独确认。`
        : '该操作会提交表单，需要单独确认。';
    }
    const labels = intent?.fieldLabels;
    const record = (context.args ?? {}) as Record<string, unknown>;
    if (labels?.length && Array.isArray(record.fields)) {
      confirmArgs = {
        ...record,
        fields: (record.fields as Record<string, unknown>[]).map((field) => ({
          ...field,
          label: labels.find((entry) => entry.fieldId === field.fieldId)?.label,
        })),
        submit: intent?.isSubmit ? { ...(record.submit as object), formAction: intent?.formAction } : record.submit,
      };
    } else if (labels?.length && typeof record.fieldId === 'string') {
      confirmArgs = { ...record, label: labels.find((entry) => entry.fieldId === record.fieldId)?.label };
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/permissions.test.ts`
Expected: PASS，全部用例（含既有的和新增的）通过。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/permissions.ts lib/agent/permissions.test.ts
git commit -m "feat: enrich a fieldId-based click confirmation with its field label"
```

---

### Task 9: 确认卡片文案（`lib/agent/confirm-summary.ts`）

**Files:**
- Modify: `lib/agent/confirm-summary.ts`
- Test: `lib/agent/confirm-summary.test.ts`

**Interfaces:**
- Consumes：Task 8 后 `browser_click` 的 confirm-args 在 fieldId 路径下带有 `label`。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/confirm-summary.test.ts` 里，紧跟在 `it('summarizes click, type, select, scroll, navigate, set_storage', ...)` 之后追加：

```ts
  it('summarizes a fieldId-based click using the enriched label', () => {
    const result = summarizeToolCallForConfirmation('browser_click', { fieldId: 'f7', label: '登录' });
    expect(result.summary).toContain('登录');
    expect(result.summary).not.toContain('f7');
  });

  it('falls back to the fieldId when no label was enriched', () => {
    const result = summarizeToolCallForConfirmation('browser_click', { fieldId: 'f7' });
    expect(result.summary).toContain('f7');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/agent/confirm-summary.test.ts`
Expected: FAIL——现有 `browser_click` 分支只读 `selector`，`fieldId`/`label` 路径下 summary 是空字符串占位。

- [ ] **Step 3: 实现**

把：

```ts
    case 'browser_click':
      return { summary: `AI 想要点击 "${str('selector')}"。` };
```

改成：

```ts
    case 'browser_click': {
      const fieldId = str('fieldId');
      if (fieldId) {
        const label = sanitizePageText(str('label') || fieldId, 40);
        return { summary: `AI 想要点击「${label}」。` };
      }
      return { summary: `AI 想要点击 "${str('selector')}"。` };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/agent/confirm-summary.test.ts`
Expected: PASS，全部用例（含既有的 `selector` 用例和新增的）通过。

- [ ] **Step 5: Commit**

```bash
git add lib/agent/confirm-summary.ts lib/agent/confirm-summary.test.ts
git commit -m "feat: show the field label instead of a raw fieldId on the click confirmation card"
```

---

### Task 10: 更新 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 `tools.ts` 的一行描述**

把（`CLAUDE.md` 里 `**tools.ts**` 条目的最后一句）：

```
For forms, `browser_get_form` returns a structured field list with stable `fieldId` handles (piercing open shadow roots) and `browser_fill_form` writes many fields in one call; every write is verified before and after (structure fingerprint + read-back), so a write that does not land reports a failure status instead of success (ref: Spec-0005).
```

改成：

```
For forms, `browser_get_form` returns a structured field list with stable `fieldId` handles (piercing open shadow roots); its collection scope also covers general clickable elements (links, form-less buttons, `role`/`tabindex`-driven custom widgets), so `browser_click` can address any of them by `fieldId` instead of a hand-written CSS selector. `browser_fill_form` writes many fields in one call; every write (and every `fieldId`-based click) is verified before and after (structure fingerprint + read-back), so a write that does not land reports a failure status instead of success (ref: Spec-0005, click-handle-addressing).
```

- [ ] **Step 2: 更新 `form-schema.ts`/`form-dom.ts`/... 条目的最后一句**

把：

```
Password and payment fields are never read back and never written, and the drop happens in `planFormFill` before anything reaches the page (ref: Spec-0005).
```

改成：

```
Password and payment fields are never read back and never written, and the drop happens in `planFormFill` before anything reaches the page (ref: Spec-0005). `fill-form-request.ts` also holds `planFieldClick`, the same look-up-the-handle-table step for a bare `browser_click(fieldId)` (ref: click-handle-addressing design, 2026-08-25).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the broadened browser_get_form scope and fieldId clicks"
```

---

### Task 11: 全量验证与真机验收

**Files:** 无代码改动。

- [ ] **Step 1: 全量测试与类型检查**

Run: `pnpm test`
Expected: 全部 project（unit/ui/dom）通过。

Run: `pnpm compile`
Expected: 无类型错误。

- [ ] **Step 2: 构建**

Run: `pnpm build`
Expected: 成功产出 `.output/chrome-mv3`。

- [ ] **Step 3: 真机验收（人工，对照 spec 的验收标准）**

用 `pnpm dev` 或加载 `.output/chrome-mv3` 未打包扩展，找一个真实页面（含导航栏、一个 `role="button"` 的自定义组件——例如某个下拉菜单触发器、一个不在 `<form>` 里的原生 `<button>`）：

1. 调用 `browser_get_form`，确认返回结果里这三类元素都带非空 `fieldId` 与非空 `label`（导航链接的 `kind` 应为 `link` 且带 `href`）。
2. 对这三类元素分别用 `browser_click({ fieldId })` 点击，观察确认卡片文案是"点击「具体标签文本」"而不是选择器字符串或裸 `fieldId`。
3. 点击后刷新页面，重放同一个旧 `fieldId` 调用 `browser_click`，确认报错文案引导"请重新调用 browser_get_form"。
4. 用 `browser_click({ selector: '...' })` 走纯选择器路径，确认行为与改动前一致（不受本次改动影响）。
5. 确认一个真正的表单提交按钮（`<button type="submit">` 在 `<form>` 内）依然会触发 `confirm_always`（每次都问，即使本轮已批准过其它写操作）。

- [ ] **Step 4: 如验收有问题，记录并修复**

若上述任一步骤不符合预期，回到对应任务修复、补测试、重新走一遍本任务。若一切符合预期，无需额外 commit（本任务无代码改动）。
