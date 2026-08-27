# Scroll Position Awareness + Container Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `browser_scroll`'s mis-reporting when a `selector` scroll actually moves an inner `overflow:auto` container instead of the window, and add the ability to discover scrollable containers (via `browser_get_form`) and scroll one directly by `fieldId`.

**Architecture:** Two independent capabilities sharing one mechanism. (1) `collectFormFields` (the MAIN-world injected function in `lib/agent/form-dom.ts`) gets an opt-in `includeScrollable` pass that finds `overflow-y: auto|scroll` elements whose content overflows and reports them as `ScrollableContainerDescriptor`s, addressed with `fieldId`s from the same handle-table mechanism `browser_click(fieldId)` already uses (`lib/agent/tab-form-fields.ts`). (2) `browser_scroll` gains a `fieldId` mode (new injected function `scrollContainerInPage`, resolves the handle and scrolls that element directly) and its existing `selector` mode is rewritten as `scrollPageInPage` (moved from `entrypoints/background.ts` into `form-dom.ts` so it is finally unit-testable) to walk up from the target element to the nearest real scrollable ancestor before measuring the scroll delta, instead of always measuring `window.scrollY`.

**Tech Stack:** TypeScript, WXT/MV3, vitest (`dom` project for `form-dom.dom.test.ts`, `unit` project for `fill-form-request.test.ts` and `action-result-text.test.ts`), existing `chrome.scripting.executeScript` MAIN-world injection pattern, existing `browser.storage.session`-backed `FormFieldTable` handle table.

**Spec:** `docs/superpowers/specs/2026-08-27-scroll-position-awareness-design.md`

## Global Constraints

- Every function in `lib/agent/form-dom.ts` (existing and new) is serialized by `executeScript` and injected into the page — it must not reference any module-scope value binding from this file or any other (only `import type` survives; `document`, `Node`, `ShadowRoot`, and other page globals are fine). Where two injected functions need the same logic (e.g. "is this element a scrollable container"), each inlines its own copy — do not extract a shared helper.
- Default behavior for every existing call shape (`includeScrollable` omitted, `browser_scroll` without `fieldId`, a `selector` whose nearest scrollable ancestor is the window) must be byte-for-byte unchanged from before this plan.
- "Scrollable container" means: not `document.documentElement`/`document.body`; `element.scrollHeight > element.clientHeight`; computed `overflow-y` is `auto` or `scroll`. Horizontal scrolling is out of scope.
- `MAX_SCROLLABLE_CONTAINERS = 20` is a local constant inside `collectFormFields` (`form-dom.ts`), not a caller-supplied parameter — it is a defensive cap, same role as the existing `RAW_TEXT_SAFETY_CAP`.
- Scrollable-container `fieldId`s use the `s{n}` namespace (`s1`, `s2`, ...), never overlapping with form fields' `f{n}` namespace, but stored in the same per-tab `FormFieldTable` (`lib/agent/tab-form-fields.ts`) so `browser_scroll(fieldId)` can reuse the existing stale/unknown-handle detection.
- `ScrollPageResult.status`/`fieldsTableStale` are only ever set by the `fieldId` mode; the `selector`/`x`/`y` modes never set them (omitted, not `false`) — this is what makes the change backward compatible for every existing consumer that never checked a status field.
- **jsdom caveat to watch for while implementing Tasks 4–5:** `scrollHeight`/`clientHeight` are always `0` in jsdom (no real layout engine) and must be stubbed per-element with `Object.defineProperty(el, 'scrollHeight', { value, configurable: true })` in tests (same technique this test file already uses for `getBoundingClientRect`). `Element.prototype.scrollIntoView` does not exist in jsdom at all and must be stubbed per-test (same technique `legacy-write-tools.dom.test.ts` already uses). If a numeric assertion in a new test doesn't match on the first run, check whether it's this kind of environment gap before assuming the production code is wrong.

---

### Task 1: `collectFormFields` discovers scrollable containers (`includeScrollable`)

**Files:**
- Modify: `lib/agent/form-dom.ts:9-15` (`CollectFormInput`), `lib/agent/form-dom.ts:24-32` (`CollectFormOutput`), `lib/agent/form-dom.ts:34-311` (`collectFormFields`)
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Produces: `CollectFormInput.includeScrollable?: boolean`; `export interface RawScrollableContainer { path: FormFieldPathStep[]; tag: string; label?: string; scrollTop: number; scrollHeight: number; clientHeight: number; }`; `CollectFormOutput.scrollables?: RawScrollableContainer[]` (only set — possibly to `[]` — when `includeScrollable` is `true`; `undefined` otherwise).
- Consumes: nothing from other tasks — fully self-contained.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `lib/agent/form-dom.dom.test.ts`, right after the closing `});` of the existing `describe('collectFormFields', ...)` block (i.e. right before the big jsdom-`:scope`-shim comment block that currently starts at line 299):

```ts
describe('collectFormFields — includeScrollable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function stubScrollMetrics(el: Element, scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  }

  it('does not collect scrollables when includeScrollable is not set', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    expect(collectFormFields(INPUT).scrollables).toBeUndefined();
  });

  it('detects an overflow-y:auto container whose content overflows', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables).toHaveLength(1);
    expect(output.scrollables![0]).toMatchObject({ tag: 'div', scrollTop: 0, scrollHeight: 800, clientHeight: 300 });
  });

  it('does not treat overflow-y:visible as scrollable even when content overflows', () => {
    render(`<div id="panel" style="overflow-y:visible"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    expect(collectFormFields({ ...INPUT, includeScrollable: true }).scrollables).toEqual([]);
  });

  it('does not treat a non-overflowing overflow-y:auto container as scrollable', () => {
    render(`<div id="panel" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 300, 300);
    expect(collectFormFields({ ...INPUT, includeScrollable: true }).scrollables).toEqual([]);
  });

  it('excludes body/documentElement even when a selector scope makes them iterable candidates', () => {
    render('<p>content</p>');
    document.documentElement.setAttribute('style', 'overflow-y:auto');
    document.body.setAttribute('style', 'overflow-y:auto');
    stubScrollMetrics(document.documentElement, 2000, 500);
    stubScrollMetrics(document.body, 2000, 500);
    const output = collectFormFields({ ...INPUT, includeScrollable: true, selector: 'html' });
    expect(output.scrollables!.some((s) => s.tag === 'body' || s.tag === 'html')).toBe(false);
  });

  it('discovers a scrollable container nested inside an open shadow root', () => {
    render(`<div id="host"></div>`);
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<div id="inner" style="overflow-y:auto"></div>`;
    const inner = host.shadowRoot!.querySelector('#inner')!;
    stubScrollMetrics(inner, 900, 400);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables).toHaveLength(1);
    expect(output.scrollables![0].path.some((step) => step.kind === 'shadow')).toBe(true);
  });

  it('caps the number of collected scrollable containers at 20', () => {
    render(Array.from({ length: 25 }, (_, i) => `<div id="p${i}" style="overflow-y:auto"></div>`).join(''));
    for (let i = 0; i < 25; i += 1) {
      stubScrollMetrics(document.getElementById(`p${i}`)!, 800, 300);
    }
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables).toHaveLength(20);
  });

  it('records a best-effort label from aria-label', () => {
    render(`<div id="panel" aria-label="聊天记录" style="overflow-y:auto"></div>`);
    stubScrollMetrics(document.getElementById('panel')!, 800, 300);
    const output = collectFormFields({ ...INPUT, includeScrollable: true });
    expect(output.scrollables![0].label).toBe('聊天记录');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: FAIL — `includeScrollable` is not a valid key of `CollectFormInput`, and `output.scrollables` is always `undefined`.

- [ ] **Step 3: Implement in form-dom.ts**

Add `includeScrollable?: boolean;` to `CollectFormInput` (`lib/agent/form-dom.ts:9-15`):

```ts
export interface CollectFormInput {
  selector?: string;
  includeHidden?: boolean;
  includeText?: boolean;
  includeScrollable?: boolean;
  maxFields: number;
  maxOptions: number;
}
```

Add `RawScrollableContainer` and `scrollables` to `CollectFormOutput` (`lib/agent/form-dom.ts:24-32`):

```ts
export interface RawScrollableContainer {
  path: FormFieldPathStep[];
  tag: string;
  /** 未净化，只做过空白压缩+截断（与 elementText/label 同款内联写法，不能从注入函数调用 form-schema.ts）。 */
  label?: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface CollectFormOutput {
  url: string;
  raws: RawFormField[];
  forms: CollectedFormInfo[];
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  /** 未净化的正文，排在最后一个字段之后。仅 includeText 时可能有值。 */
  trailingText?: string;
  /** 页面上发现的可滚动容器；仅 includeScrollable 时有值（可能是空数组）。 */
  scrollables?: RawScrollableContainer[];
}
```

Inside `collectFormFields`, add the new consts right after the existing `const includeText = input.includeText === true;` line (`lib/agent/form-dom.ts:42`):

```ts
  const includeHidden = input.includeHidden === true;
  const includeText = input.includeText === true;
  const includeScrollable = input.includeScrollable === true;
  const MAX_SCROLLABLE_CONTAINERS = 20;
  const scrollables: RawScrollableContainer[] = [];

  const isScrollableContainer = (element: Element): boolean => {
    if (element === document.documentElement || element === document.body) return false;
    if (element.scrollHeight <= element.clientHeight) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const overflowY = style?.overflowY;
    return overflowY === 'auto' || overflowY === 'scroll';
  };
```

Inside `walk()`, insert the scrollable-container check right after the existing shadow-root/closed-shadow-root bookkeeping and right before `if (!isFieldTag(element)) continue;` (`lib/agent/form-dom.ts:205-221`):

```ts
  const walk = (root: ParentNode): void => {
    const elements = Array.from(root.querySelectorAll('*'));
    for (const element of elements) {
      if (element.tagName.toLowerCase() === 'iframe') unreachable.iframes += 1;

      const shadowRoot = (element as HTMLElement).shadowRoot;
      if (shadowRoot) {
        walk(shadowRoot);
      } else if (element.tagName.includes('-')) {
        unreachable.closedShadowRoots += 1;
      }

      if (includeScrollable && scrollables.length < MAX_SCROLLABLE_CONTAINERS && isScrollableContainer(element)) {
        const rawLabel = element.getAttribute('aria-label') || element.id || '';
        scrollables.push({
          path: buildPath(element),
          tag: element.tagName.toLowerCase(),
          label: rawLabel ? rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined : undefined,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        });
      }

      if (!isFieldTag(element)) continue;
```

Finally, add `scrollables` to the return statement (`lib/agent/form-dom.ts:310`):

```ts
  return {
    url: location.href,
    raws,
    forms,
    unreachable,
    truncated,
    trailingText,
    scrollables: includeScrollable ? scrollables : undefined,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS, including every pre-existing test in the file (the new block is additive and gated behind `includeScrollable`, so nothing else should change).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts
git commit -m "feat: collectFormFields 按 includeScrollable 发现可滚动容器"
```

---

### Task 2: `browser_get_form` protocol + background.ts wiring for `scrollableContainers`

**Files:**
- Modify: `lib/messaging.ts:351-353` (`FormFieldKind`), `lib/messaging.ts:385-403` (`GetFormPayload`/`GetFormResult`)
- Modify: `entrypoints/background.ts:407-505` (`FieldSnapshot`, `snapshotFields`, `getForm`)
- Modify: `lib/agent/form-tools.test.ts` (`RESULT` fixture stays valid — `scrollableContainers` is optional, no change needed there, but double-check after Step 5)

**Interfaces:**
- Consumes: `CollectFormInput.includeScrollable`, `CollectFormOutput.scrollables` from Task 1.
- Produces: `GetFormPayload.includeScrollable?: boolean`; `export interface ScrollableContainerDescriptor { fieldId: string; tag: string; label?: string; scrollTop: number; scrollHeight: number; clientHeight: number; }`; `GetFormResult.scrollableContainers?: ScrollableContainerDescriptor[]`; `FormFieldKind` includes `'scrollable'`; `getForm(...)` now populates `scrollableContainers` and issues `s{n}` handles into the per-tab `FormFieldTable` with `kind: 'scrollable'`.

This task has no dedicated vitest project (`entrypoints/**` isn't covered — see `lib/agent/fill-form-request.ts`'s extraction rationale in `CLAUDE.md`), so it's verified with `pnpm compile` and `pnpm test` instead of a focused test file, same as the precedent in `docs/superpowers/plans/2026-08-26-form-include-text.md` Task 3.

- [ ] **Step 1: Update lib/messaging.ts**

Add `'scrollable'` to `FormFieldKind` (`lib/messaging.ts:351-353`):

```ts
export type FormFieldKind =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'contenteditable' | 'file' | 'submit' | 'button' | 'link' | 'unsupported'
  | 'scrollable';
```

Add `includeScrollable` to `GetFormPayload` and add `ScrollableContainerDescriptor` + `GetFormResult.scrollableContainers` (`lib/messaging.ts:385-403`):

```ts
export interface GetFormPayload {
  selector?: string;
  includeHidden?: boolean;
  /** 把正文按 DOM 序穿插进 fields（每个字段的 precedingText）与顶层 trailingText。默认 false。 */
  includeText?: boolean;
  /** 发现页面上的可滚动容器，随 GetFormResult.scrollableContainers 一起发放 fieldId。默认 false。 */
  includeScrollable?: boolean;
}

export interface ScrollableContainerDescriptor {
  /** "s1"/"s2"/... 独立命名空间，不与表单字段的 "f1"/"f2" 冲突。 */
  fieldId: string;
  tag: string;
  /** 尽力而为的标签：aria-label/id 兜底，页面可控，已压空白截断。 */
  label?: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface GetFormResult {
  forms: { formId: string; name?: string; action?: string; method?: string; submitFieldIds: string[] }[];
  fields: FormFieldDescriptor[];
  orphanFieldIds: string[];
  /** 如实上报「这里有内容但我看不见」，避免模型在主框架里反复试探。 */
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  /** 最后一个字段之后出现的正文；已净化截断。仅 includeText 时可能有值。 */
  trailingText?: string;
  /** precedingText/trailingText 中是否发生了截断。includeText 为 false 时恒为 false。 */
  textTruncated: boolean;
  /** 页面上发现的可滚动容器；仅 includeScrollable 时有值（可能是空数组）。 */
  scrollableContainers?: ScrollableContainerDescriptor[];
}
```

- [ ] **Step 2: Update FieldSnapshot, snapshotFields, and getForm in entrypoints/background.ts**

Replace `FieldSnapshot` (`entrypoints/background.ts:407-413`):

```ts
interface FieldSnapshot {
  collected: Awaited<ReturnType<typeof collectFormFields>>;
  fields: FormFieldDescriptor[];
  orphanFieldIds: string[];
  newFields: FormFieldDescriptor[];
  trailingText: string | undefined;
  textTruncated: boolean;
  scrollableContainers: ScrollableContainerDescriptor[] | undefined;
}
```

Update the top of `snapshotFields` to forward `includeScrollable` and add a scrollable-container loop after the existing `collected.raws.forEach(...)` block (`entrypoints/background.ts:426-467`):

```ts
async function snapshotFields(tabId: number, payload: GetFormPayload = {}): Promise<FieldSnapshot> {
  const previous = await getFormFieldsForTab(tabId);
  const collected = await executeInTab(
    tabId,
    {
      selector: payload?.selector,
      includeHidden: payload?.includeHidden,
      includeText: payload?.includeText,
      includeScrollable: payload?.includeScrollable,
      maxFields: MAX_FORM_FIELDS,
      maxOptions: MAX_SELECT_OPTIONS,
    },
    collectFormFields,
  );

  const fields: FormFieldDescriptor[] = [];
  const handles: Record<string, FormFieldHandle> = {};
  const orphanFieldIds: string[] = [];
  let textTruncated = false;

  collected.raws.forEach((raw, index) => {
    const fieldId = `f${index + 1}`;
    const descriptor = toFieldDescriptor(raw, fieldId);
    fields.push(descriptor);
    handles[fieldId] = {
      path: raw.path,
      expect: { tag: raw.tag, type: raw.type, name: raw.name, label: descriptor.label, href: raw.href },
      sensitive: descriptor.sensitive,
      kind: descriptor.kind,
    };
    if (!descriptor.formId) orphanFieldIds.push(fieldId);
    if (sanitizeFieldText(raw.precedingText, 'tail').truncated) textTruncated = true;
  });

  const scrollableContainers: ScrollableContainerDescriptor[] | undefined = collected.scrollables?.map(
    (raw, index) => {
      const fieldId = `s${index + 1}`;
      handles[fieldId] = { path: raw.path, expect: { tag: raw.tag }, sensitive: false, kind: 'scrollable' };
      return {
        fieldId,
        tag: raw.tag,
        label: raw.label,
        scrollTop: raw.scrollTop,
        scrollHeight: raw.scrollHeight,
        clientHeight: raw.clientHeight,
      };
    },
  );

  const trailingSanitized = sanitizeFieldText(collected.trailingText);
  if (trailingSanitized.truncated) textTruncated = true;

  const comparable = previous && previous.url === collected.url ? previous.fingerprints : undefined;
  const newFieldIds = findNewFieldIds(fields, comparable);
  for (const field of fields) {
    if (newFieldIds.has(field.fieldId)) field.isNew = true;
  }

  await setFormFieldsForTab(tabId, {
    url: collected.url,
    fields: handles,
    fingerprints: fields.map((field) => field.fingerprint),
  });

  return {
    collected,
    fields,
    orphanFieldIds,
    newFields: fields.filter((field) => field.isNew),
    trailingText: trailingSanitized.text,
    textTruncated,
    scrollableContainers,
  };
}
```

Update `getForm` to pass `scrollableContainers` through (`entrypoints/background.ts:485-505`):

```ts
async function getForm(payload: GetFormPayload, tabId: number): Promise<GetFormResult> {
  const { collected, fields, orphanFieldIds, trailingText, textTruncated, scrollableContainers } =
    await snapshotFields(tabId, payload);

  return {
    forms: collected.forms.map((form) => ({
      formId: `form${form.formIndex}`,
      name: form.name,
      action: form.action,
      method: form.method,
      submitFieldIds: fields
        .filter((field) => field.kind === 'submit' && field.formId === `form${form.formIndex}`)
        .map((field) => field.fieldId),
    })),
    fields,
    orphanFieldIds,
    unreachable: collected.unreachable,
    truncated: collected.truncated,
    trailingText,
    textTruncated,
    scrollableContainers,
  };
}
```

Add `ScrollableContainerDescriptor` to the `@/lib/messaging` import list at the top of `entrypoints/background.ts:9-10` (right after the existing `type FormFieldDescriptor,` line):

```ts
  type FormFieldDescriptor,
  type ScrollableContainerDescriptor,
  type GetComputedStylePayload,
```

- [ ] **Step 3: Verify everything still compiles and passes**

Run: `pnpm compile`
Expected: no type errors.

Run: `pnpm test`
Expected: full suite passes (`GetFormResult.scrollableContainers` and `FieldSnapshot.scrollableContainers` are both optional, so no existing fixture should need updating — if `pnpm compile` disagrees, fix the fixture the same way Task 3 of `docs/superpowers/plans/2026-08-26-form-include-text.md` did for `textTruncated`).

- [ ] **Step 4: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts
git commit -m "feat: GET_FORM 协议与 background.ts 接线 scrollableContainers 发现"
```

---

### Task 3: `browser_get_form` tool schema exposes `includeScrollable`

**Files:**
- Modify: `lib/agent/tools.ts:306-340` (`makeGetFormTool`)
- Test: `lib/agent/form-tools.test.ts`

**Interfaces:**
- Consumes: `GetFormPayload.includeScrollable` from Task 2 — the existing `const payload = params as GetFormPayload;` cast already forwards whatever the model passes, so only the schema and the result text change.

- [ ] **Step 1: Write the failing test**

Add to `lib/agent/form-tools.test.ts`, inside the existing `describe('browser_get_form', ...)` block:

```ts
  it('passes includeScrollable through to the GET_FORM payload', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    await getFormTool().execute('call-1', { includeScrollable: true });
    expect(sendMessage).toHaveBeenCalledWith('GET_FORM', { includeScrollable: true }, 1);
  });

  it('surfaces discovered scrollable containers in the result text', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { ...RESULT, scrollableContainers: [{ fieldId: 's1', tag: 'div', scrollTop: 0, scrollHeight: 900, clientHeight: 300 }] },
    });
    const output = await getFormTool().execute('call-1', { includeScrollable: true });
    expect((output.content[0] as { text: string }).text).toContain('s1');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: the first new test already passes today (the `params as GetFormPayload` cast forwards any shape regardless of schema) — the point of this task is the schema description for the model. The second test passes too, since `formatJson` already dumps the full result object as JSON including `scrollableContainers`. Run both to confirm this baseline before touching `tools.ts`; if either unexpectedly fails, stop and investigate before continuing.

- [ ] **Step 3: Add includeScrollable to the tool's parameter schema**

`lib/agent/tools.ts` — locate the `makeGetFormTool` function's `parameters: Type.Object({...})` block (currently ends with the `includeText` entry) and add `includeScrollable` alongside it:

```ts
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: 'Limit collection to this container. Defaults to the whole document.' })),
      includeHidden: Type.Optional(Type.Boolean({ description: 'Include hidden and invisible fields. Defaults to false.' })),
      includeText: Type.Optional(
        Type.Boolean({
          description:
            "Interleave the page's readable text into the field list: each field gets a precedingText with the text that appeared right before it (after the previous field), and the result gets a trailingText for anything after the last field. Use this to understand what a field is for from its surrounding context (a hint or disclaimer next to it) without a separate browser_read_page call. Defaults to false.",
        }),
      ),
      includeScrollable: Type.Optional(
        Type.Boolean({
          description:
            'Also discover scrollable containers on the page (elements with their own overflow:auto/scroll scrollbar, distinct from the page/window itself) and list them under scrollableContainers, each with a fieldId. Pass that fieldId to browser_scroll to scroll that specific container directly — use this for panels, chat logs, and virtual lists where you need to page through content that has no single target element to scroll into view. Defaults to false.',
        }),
      ),
    }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Full verification**

Run: `pnpm compile` — expect no type errors.
Run: `pnpm test` — expect full suite passes.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/tools.ts lib/agent/form-tools.test.ts
git commit -m "feat: browser_get_form 暴露 includeScrollable 参数"
```

---

### Task 4: `scrollContainerInPage` — scroll a discovered container directly by handle

**Files:**
- Modify: `lib/agent/form-dom.ts` (add new exported function, after `applyFormFill`/`probeClickTarget` and before `clickElementInPage`, or anywhere after the existing type imports — exact position doesn't matter, keep it near the other page-injected functions)
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Consumes: `FormFieldPathStep` (existing type, from `form-schema.ts`).
- Produces: `export interface ScrollContainerInput { url: string; path: FormFieldPathStep[]; expect: { tag: string }; x?: number; y?: number; behavior?: 'auto' | 'smooth'; }`; `export interface ScrollContainerOutput { status: 'ok' | 'not_found' | 'mismatch'; x: number; y: number; scrolledBy: number; pixelsAbove: number; pixelsBelow: number; viewportHeight: number; tag?: string; label?: string; fieldsTableStale?: boolean; }`; `export function scrollContainerInPage(input: ScrollContainerInput): ScrollContainerOutput`.

- [ ] **Step 1: Write the failing tests**

Append this new `describe` block to the end of `lib/agent/form-dom.dom.test.ts` (after the closing `});` of the `describe('applyFormFill', ...)` block, i.e. at the very end of the file):

```ts
describe('scrollContainerInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function panel(scrollHeight: number, clientHeight: number, scrollTop = 0): HTMLElement {
    render(`<div id="panel"></div>`);
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  const PATH = [
    { kind: 'selector' as const, selector: 'body', index: 0 },
    { kind: 'selector' as const, selector: 'div', index: 0 },
  ];

  it('scrolls the container to an absolute y and reports container-relative metrics', () => {
    panel(1000, 400, 0);
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, y: 300 });
    expect(output.status).toBe('ok');
    expect(output.y).toBe(300);
    expect(output.scrolledBy).toBe(300);
    expect(output.pixelsAbove).toBe(300);
    expect(output.pixelsBelow).toBe(300); // maxScroll = 1000-400 = 600; 600-300 = 300
    expect(output.viewportHeight).toBe(400);
    expect(output.tag).toBe('div');
  });

  it('clamps the requested y to the container scroll range', () => {
    panel(1000, 400, 0);
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, y: 9999 });
    expect(output.y).toBe(600);
    expect(output.pixelsBelow).toBe(0);
  });

  it('returns not_found when the path resolves to nothing', () => {
    render(`<div></div>`);
    const output = scrollContainerInPage({
      url: location.href,
      path: [
        { kind: 'selector', selector: 'body', index: 0 },
        { kind: 'selector', selector: 'span', index: 0 },
      ],
      expect: { tag: 'span' },
    });
    expect(output.status).toBe('not_found');
  });

  it('returns mismatch when the resolved element no longer matches the expected tag', () => {
    panel(1000, 400);
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'section' } });
    expect(output.status).toBe('mismatch');
  });

  it('reports fieldsTableStale when the page has navigated since the handle was issued', () => {
    panel(1000, 400);
    const output = scrollContainerInPage({ url: 'https://elsewhere.test/', path: PATH, expect: { tag: 'div' } });
    expect(output.fieldsTableStale).toBe(true);
    expect(output.status).toBe('not_found');
  });

  it('reports a best-effort label from aria-label', () => {
    render(`<div id="panel" aria-label="聊天记录"></div>`);
    const el = document.getElementById('panel')!;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    const output = scrollContainerInPage({ url: location.href, path: PATH, expect: { tag: 'div' }, y: 100 });
    expect(output.label).toBe('聊天记录');
  });
});
```

Add `scrollContainerInPage` to the existing top-of-file import from `./form-dom` (currently `import { collectFormFields } from './form-dom';` and `import { applyFormFill, type ApplyFillItem } from './form-dom';` at lines 2–3) — add a third import line: `import { scrollContainerInPage } from './form-dom';`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: FAIL — `scrollContainerInPage` does not exist yet.

- [ ] **Step 3: Implement scrollContainerInPage in form-dom.ts**

```ts
export interface ScrollContainerInput {
  /** 发放句柄时的页面 URL；与当前不符即认为句柄表过期。 */
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
  viewportHeight: number;
  tag?: string;
  label?: string;
  fieldsTableStale?: boolean;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（包括本文件的其它函数）——resolve() 与
// applyFormFill/probeClickTarget 里的同名函数各自独立内联，是同一个既有约定。
export function scrollContainerInPage(input: ScrollContainerInput): ScrollContainerOutput {
  const empty = { x: 0, y: 0, scrolledBy: 0, pixelsAbove: 0, pixelsBelow: 0, viewportHeight: 0 };

  if (input.url && input.url !== location.href) {
    return { ...empty, status: 'not_found', fieldsTableStale: true };
  }

  const resolve = (path: FormFieldPathStep[]): Element | null => {
    let scope: ParentNode | null = document;
    let element: Element | null = null;
    for (const step of path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) return null;
        scope = shadowRoot;
        continue;
      }
      if (!scope) return null;
      const matches: Element[] = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`));
      element = matches[step.index] ?? null;
      if (!element) return null;
      scope = element;
    }
    return element;
  };

  const element = resolve(input.path);
  if (!element) return { ...empty, status: 'not_found' };
  if (element.tagName.toLowerCase() !== input.expect.tag.toLowerCase()) {
    return { ...empty, status: 'mismatch' };
  }

  const container = element as HTMLElement;
  const clientHeight = container.clientHeight;
  const maxScroll = Math.max(0, container.scrollHeight - clientHeight);
  const clamp = (value: number): number => Math.min(Math.max(value, 0), maxScroll);
  const startTop = container.scrollTop;
  const requestedTop = typeof input.y === 'number' ? input.y : startTop;
  const requestedLeft = typeof input.x === 'number' ? input.x : container.scrollLeft;

  const scrollableContainer = container as unknown as { scrollTo?: (opts: ScrollToOptions) => void };
  if (typeof scrollableContainer.scrollTo === 'function') {
    scrollableContainer.scrollTo({ top: requestedTop, left: requestedLeft, behavior: input.behavior ?? 'auto' });
  } else {
    container.scrollTop = requestedTop;
    container.scrollLeft = requestedLeft;
  }
  const finalTop = clamp(requestedTop);

  const rawLabel = container.getAttribute('aria-label') || container.id || '';
  const label = rawLabel ? rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined : undefined;

  return {
    status: 'ok',
    x: container.scrollLeft,
    y: Math.round(finalTop),
    scrolledBy: Math.round(finalTop - startTop),
    pixelsAbove: Math.round(finalTop),
    pixelsBelow: Math.round(Math.max(0, maxScroll - finalTop)),
    viewportHeight: clientHeight,
    tag: container.tagName.toLowerCase(),
    label,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS, including every pre-existing test in the file. If `output.y`/`pixelsBelow` don't match, check whether jsdom's `scrollTop` setter actually stores the value you expect (it should — unlike `scrollHeight`/`clientHeight`, jsdom's `scrollTop`/`scrollLeft` are plain stored properties, not layout-derived) before suspecting the production code.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts
git commit -m "feat: scrollContainerInPage —— 按句柄直接滚动一个可滚动容器"
```

---

### Task 5: `scrollPageInPage` — fix container mis-reporting for `selector`/`x`/`y` scrolling

**Files:**
- Modify: `lib/agent/form-dom.ts` (add new exported function)
- Modify: `entrypoints/background.ts:950-987` (`scrollPage` — deferred to Task 7; this task only adds the new function and its tests, it does not yet wire background.ts to call it)
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Produces: `export interface ScrollPageInPageInput { selector?: string; x?: number; y?: number; behavior?: 'auto' | 'smooth'; }`; `export interface ScrollPageInPageOutput { selector?: string; x: number; y: number; scrolledBy: number; pixelsAbove: number; pixelsBelow: number; viewportHeight: number; container?: { tag: string; label?: string }; }`; `export function scrollPageInPage(input: ScrollPageInPageInput): ScrollPageInPageOutput`.
- Consumes: nothing from other tasks — this is a straight port of the existing inline `scrollPage` injected callback (`entrypoints/background.ts:950-987`) plus the ancestor-detection fix; it does not depend on Tasks 1–4.

**Design note carried into this task (not in the original spec, decided during implementation planning):** inside the "found a scrollable ancestor" branch, the `scrollIntoView` call is issued with `behavior: 'auto'` regardless of what the caller requested, so the ancestor's `scrollTop` can be read back synchronously afterwards instead of racing an in-progress smooth-scroll animation. The window-only branches (no ancestor found, or `x`/`y` mode) are untouched and keep honoring the requested `behavior`, exactly as today. This trades away smooth-scroll animation only for the specific new case (scrolling into an inner panel) where accurate reporting is the entire point of this task.

- [ ] **Step 1: Write the failing tests**

Append this new `describe` block to the end of `lib/agent/form-dom.dom.test.ts` (after Task 4's `describe('scrollContainerInPage', ...)` block):

```ts
describe('scrollPageInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.scrollTo(0, 0);
  });

  it('scrolls the window to explicit x/y coordinates (unchanged from before)', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const output = scrollPageInPage({ y: 500 });
    expect(output.y).toBe(500);
    expect(output.scrolledBy).toBe(500);
    expect(output.pixelsAbove).toBe(500);
    expect(output.pixelsBelow).toBe(1700);
    expect(output.container).toBeUndefined();
  });

  it('falls back to window-only reporting when the selector target has no scrollable ancestor', () => {
    render(`<button id="target">目标</button>`);
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const target = document.getElementById('target')!;
    // 窗口分支按 rect 解析终点，不读滚动后的 window.scrollY（异步 smooth 滚动读不到最终值），
    // 所以这里要给一个非零 rect，而不是靠 scrollIntoView 的 stub 去移动 window.scrollY。
    target.getBoundingClientRect = () => ({ ...NON_ZERO_RECT, top: 1000, height: 20, bottom: 1020 } as DOMRect);
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    const output = scrollPageInPage({ selector: '#target' });
    expect(output.container).toBeUndefined();
    // finalY = clamp(startY(0) + rect.top(1000) + rect.height/2(10) - viewportHeight/2(400)) = 610
    expect(output.scrolledBy).toBe(610);
    expect(output.pixelsAbove).toBe(610);
    expect(output.pixelsBelow).toBe(1590); // maxScroll = 3000-800 = 2200; 2200-610 = 1590
  });

  it('reports the inner scrollable container that actually moved instead of the unchanged window', () => {
    render(`<div id="panel" style="overflow-y:auto"><button id="target">目标</button></div>`);
    const panel = document.getElementById('panel')!;
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
    const target = document.getElementById('target')!;
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      panel.scrollTop = 250; // 模拟真实浏览器把内层容器滚到位，窗口本身没动
    };

    const output = scrollPageInPage({ selector: '#target' });

    expect(output.container).toEqual({ tag: 'div', label: undefined });
    expect(output.scrolledBy).toBe(250);
    expect(output.pixelsAbove).toBe(250);
    expect(output.pixelsBelow).toBe(350); // maxScroll = 900-300 = 600; 600-250 = 350
    expect(output.viewportHeight).toBe(300);
  });

  it('walks past a non-scrollable wrapper to find the real scrollable ancestor', () => {
    render(`<div id="panel" style="overflow-y:auto"><div id="wrapper"><button id="target">目标</button></div></div>`);
    const panel = document.getElementById('panel')!;
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
    const target = document.getElementById('target')!;
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      panel.scrollTop = 100;
    };
    const output = scrollPageInPage({ selector: '#target' });
    expect(output.container?.tag).toBe('div');
    expect(output.scrolledBy).toBe(100);
  });

  it('reports zero movement with the selector echoed back when the selector matches nothing', () => {
    const output = scrollPageInPage({ selector: '#missing' });
    expect(output.scrolledBy).toBe(0);
    expect(output.container).toBeUndefined();
    expect(output.selector).toBe('#missing');
  });

  it('reports a best-effort label for the moved container from aria-label', () => {
    render(`<div id="panel" aria-label="聊天记录" style="overflow-y:auto"><button id="target">目标</button></div>`);
    const panel = document.getElementById('panel')!;
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
    const target = document.getElementById('target')!;
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      panel.scrollTop = 50;
    };
    const output = scrollPageInPage({ selector: '#target' });
    expect(output.container?.label).toBe('聊天记录');
  });
});
```

Add `scrollPageInPage` to the same `./form-dom` import line added in Task 4 (`import { scrollContainerInPage, scrollPageInPage } from './form-dom';`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: FAIL — `scrollPageInPage` does not exist yet.

- [ ] **Step 3: Implement scrollPageInPage in form-dom.ts**

```ts
export interface ScrollPageInPageInput {
  selector?: string;
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollPageInPageOutput {
  selector?: string;
  x: number;
  y: number;
  /** 垂直方向的实际位移，正数向下。滚不动时为 0。 */
  scrolledBy: number;
  pixelsAbove: number;
  pixelsBelow: number;
  viewportHeight: number;
  /** 实际发生滚动的是内层容器而非整个窗口时才有值。 */
  container?: { tag: string; label?: string };
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定。isScrollableContainer 与 collectFormFields 内部
// 的同名判定各自独立内联——两处逻辑必须保持一致，改一处要同步改另一处。
export function scrollPageInPage(input: ScrollPageInPageInput): ScrollPageInPageOutput {
  const behavior = input?.behavior ?? 'auto';

  const isScrollableContainer = (element: Element): boolean => {
    if (element === document.documentElement || element === document.body) return false;
    if (element.scrollHeight <= element.clientHeight) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const overflowY = style?.overflowY;
    return overflowY === 'auto' || overflowY === 'scroll';
  };

  const findScrollableAncestor = (start: Element | null): Element | null => {
    let node: Element | null = start;
    while (node) {
      if (isScrollableContainer(node)) return node;
      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  };

  const describeContainer = (element: Element): { tag: string; label?: string } => {
    const rawLabel = element.getAttribute('aria-label') || element.id || '';
    return {
      tag: element.tagName.toLowerCase(),
      label: rawLabel ? rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined : undefined,
    };
  };

  const windowMetrics = () => {
    const viewportHeight = window.innerHeight || 0;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
    return { viewportHeight, maxScroll, clamp: (value: number) => Math.min(Math.max(value, 0), maxScroll) };
  };

  if (input?.selector) {
    const target = document.querySelector(input.selector);
    if (!target) {
      const { viewportHeight, maxScroll } = windowMetrics();
      return {
        selector: input.selector,
        x: window.scrollX,
        y: Math.round(window.scrollY),
        scrolledBy: 0,
        pixelsAbove: Math.round(window.scrollY),
        pixelsBelow: Math.round(Math.max(0, maxScroll - window.scrollY)),
        viewportHeight,
      };
    }

    const ancestor = findScrollableAncestor(target.parentElement);
    if (!ancestor) {
      const { viewportHeight, maxScroll, clamp } = windowMetrics();
      const startY = window.scrollY;
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior, block: 'center' });
      const rect = target.getBoundingClientRect();
      const finalY = clamp(startY + rect.top + rect.height / 2 - viewportHeight / 2);
      return {
        selector: input.selector,
        x: window.scrollX,
        y: Math.round(finalY),
        scrolledBy: Math.round(finalY - startY),
        pixelsAbove: Math.round(finalY),
        pixelsBelow: Math.round(Math.max(0, maxScroll - finalY)),
        viewportHeight,
      };
    }

    const containerClientHeight = ancestor.clientHeight;
    const containerMaxScroll = Math.max(0, ancestor.scrollHeight - containerClientHeight);
    const startTop = ancestor.scrollTop;
    // 强制 auto：滚完要立即同步读回 ancestor.scrollTop，behavior:'smooth' 会让这一步读到
    // 动画中途的值。窗口分支不受影响，仍然按调用方要求的 behavior 走。
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'auto', block: 'center' });
    const finalTop = Math.min(Math.max(ancestor.scrollTop, 0), containerMaxScroll);
    return {
      selector: input.selector,
      x: window.scrollX,
      y: Math.round(finalTop),
      scrolledBy: Math.round(finalTop - startTop),
      pixelsAbove: Math.round(finalTop),
      pixelsBelow: Math.round(Math.max(0, containerMaxScroll - finalTop)),
      viewportHeight: containerClientHeight,
      container: describeContainer(ancestor),
    };
  }

  const { viewportHeight, maxScroll, clamp } = windowMetrics();
  const startY = window.scrollY;
  const requestedY = input?.y ?? startY;
  window.scrollTo({ left: input?.x ?? window.scrollX, top: requestedY, behavior });
  const finalY = clamp(requestedY);

  return {
    x: window.scrollX,
    y: Math.round(finalY),
    scrolledBy: Math.round(finalY - startY),
    pixelsAbove: Math.round(finalY),
    pixelsBelow: Math.round(Math.max(0, maxScroll - finalY)),
    viewportHeight,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS, including every pre-existing test. If `window.scrollTo({...})` (object form) turns out not to update `window.scrollX`/`scrollY` in this project's jsdom version, the "explicit x/y coordinates" test will reveal it immediately — if so, that's a pre-existing behavior of the code being relocated (it was never under test before this task), not a regression; note it in the commit message and keep the object-form call as-is (it works in every real browser, which is what matters in production).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts
git commit -m "feat: scrollPageInPage —— 滚动内层可滚动容器时按容器口径汇报，不再误报"
```

---

### Task 6: `planFieldScroll` — fieldId lookup and kind validation

**Files:**
- Modify: `lib/agent/fill-form-request.ts:92-98` (add new function after the existing `planFieldClick`, which currently ends the file)
- Test: `lib/agent/fill-form-request.test.ts`

**Interfaces:**
- Consumes: `FormFieldHandle`, `FormFieldTable` from `lib/agent/tab-form-fields.ts` (existing, `kind` now includes `'scrollable'` per Task 2's `FormFieldKind` change).
- Produces: `export interface FieldScrollPlan { ok: boolean; reason?: 'no_table' | 'unknown_field' | 'wrong_kind'; target?: { fieldId: string; path: FormFieldHandle['path']; expect: { tag: string } }; }`; `export function planFieldScroll(fieldId: string, table: FormFieldTable | undefined): FieldScrollPlan`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/agent/fill-form-request.test.ts`, after the existing `describe('planFieldClick', ...)` block. First update the import line at the top of the file:

```ts
import { mergeFillOutcomes, planFieldClick, planFieldScroll, planFormFill } from './fill-form-request';
```

Then add:

```ts
describe('planFieldScroll', () => {
  it('reports no_table when the tab has no handle table at all', () => {
    expect(planFieldScroll('s1', undefined)).toEqual({ ok: false, reason: 'no_table' });
  });

  it('reports unknown_field when the fieldId is not in the table', () => {
    expect(planFieldScroll('s9', table({ f1: handle() }))).toEqual({ ok: false, reason: 'unknown_field' });
  });

  it('reports wrong_kind when the fieldId belongs to a form field, not a scrollable container', () => {
    expect(planFieldScroll('f1', table({ f1: handle() }))).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('resolves a known scrollable fieldId to its path and expected tag', () => {
    const h = handle({ kind: 'scrollable', expect: { tag: 'div' } });
    expect(planFieldScroll('s1', table({ s1: h }))).toEqual({
      ok: true,
      target: { fieldId: 's1', path: h.path, expect: { tag: 'div' } },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/fill-form-request.test.ts`
Expected: FAIL — `planFieldScroll` does not exist yet.

- [ ] **Step 3: Implement planFieldScroll in fill-form-request.ts**

Add after the existing `planFieldClick` function:

```ts
export interface FieldScrollPlan {
  ok: boolean;
  reason?: 'no_table' | 'unknown_field' | 'wrong_kind';
  target?: { fieldId: string; path: FormFieldHandle['path']; expect: { tag: string } };
}

/** browser_scroll(fieldId) 的查表与校验：background 只负责把结果送进页面执行。 */
export function planFieldScroll(fieldId: string, table: FormFieldTable | undefined): FieldScrollPlan {
  if (!table) return { ok: false, reason: 'no_table' };
  const handle = table.fields[fieldId];
  if (!handle) return { ok: false, reason: 'unknown_field' };
  if (handle.kind !== 'scrollable') return { ok: false, reason: 'wrong_kind' };
  return { ok: true, target: { fieldId, path: handle.path, expect: { tag: handle.expect.tag } } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/fill-form-request.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/fill-form-request.ts lib/agent/fill-form-request.test.ts
git commit -m "feat: planFieldScroll —— browser_scroll(fieldId) 的查表与 kind 校验"
```

---

### Task 7: `browser_scroll` protocol + background.ts wiring for `fieldId`

**Files:**
- Modify: `lib/messaging.ts:277-295` (`ScrollPagePayload`/`ScrollPageResult`)
- Modify: `entrypoints/background.ts:950-987` (`scrollPage`) and its import block

**Interfaces:**
- Consumes: `scrollContainerInPage` (Task 4), `scrollPageInPage` (Task 5), `planFieldScroll` (Task 6).
- Produces: `ScrollPagePayload.fieldId?: string`; `ScrollPageResult.container?: { tag: string; label?: string }`; `ScrollPageResult.status?: 'ok' | 'not_found' | 'mismatch'`; `ScrollPageResult.fieldsTableStale?: boolean`; `scrollPage(...)` now dispatches on `payload.fieldId`.

No dedicated vitest project covers `entrypoints/**` — verified with `pnpm compile` + `pnpm test`, same as Task 2.

- [ ] **Step 1: Update lib/messaging.ts**

Replace `ScrollPagePayload`/`ScrollPageResult` (`lib/messaging.ts:277-295`):

```ts
export interface ScrollPagePayload {
  /** browser_get_form 的 scrollableContainers 里的 fieldId；优先于 selector。 */
  fieldId?: string;
  selector?: string;
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollPageResult {
  selector?: string;
  x: number;
  y: number;
  /** 垂直方向的实际位移，正数向下。滚不动时为 0。 */
  scrolledBy: number;
  /** 视口（或容器）上方 / 下方尚未查看的像素数，用来告诉模型「还剩多少没看」。 */
  pixelsAbove: number;
  pixelsBelow: number;
  /** 换算「约几屏」用；取不到时为 0，文案会省略屏数提示。 */
  viewportHeight: number;
  /** 实际发生滚动的是内层容器而非整个窗口时才有值。 */
  container?: { tag: string; label?: string };
  /** 仅 fieldId 模式会失败；window/selector 模式不设置此字段（向后兼容，等价于成功）。 */
  status?: 'ok' | 'not_found' | 'mismatch';
  /** 句柄表已失效（页面导航或 storage 丢失），模型必须重新调用 browser_get_form。 */
  fieldsTableStale?: boolean;
}
```

- [ ] **Step 2: Update the imports in entrypoints/background.ts**

Extend the existing `import { ... } from '@/lib/agent/form-dom';` block (`entrypoints/background.ts:69-77`):

```ts
import {
  applyFormFill,
  clickElementInPage,
  collectFormFields,
  probeClickTarget,
  scrollContainerInPage,
  scrollPageInPage,
  selectOptionInPage,
  typeTextInPage,
  type ApplyFillItem,
} from '@/lib/agent/form-dom';
```

Extend the existing `import { mergeFillOutcomes, planFieldClick, planFormFill } from '@/lib/agent/fill-form-request';` (`entrypoints/background.ts:68`):

```ts
import { mergeFillOutcomes, planFieldClick, planFieldScroll, planFormFill } from '@/lib/agent/fill-form-request';
```

- [ ] **Step 3: Rewrite scrollPage in entrypoints/background.ts**

Replace the existing `scrollPage` function (`entrypoints/background.ts:950-987`) with:

```ts
async function scrollPage(payload: ScrollPagePayload, tabId: number): Promise<ScrollPageResult> {
  if (payload?.fieldId) {
    return scrollContainerByFieldId(payload, tabId);
  }
  return executeInTab(tabId, { selector: payload?.selector, x: payload?.x, y: payload?.y, behavior: payload?.behavior }, scrollPageInPage);
}

// fieldId 路径复用 clickElementByFieldId 的模式：查表 → 校验 kind → 注入解析+滚动。
async function scrollContainerByFieldId(payload: ScrollPagePayload, tabId: number): Promise<ScrollPageResult> {
  const table = await getFormFieldsForTab(tabId);
  const plan = planFieldScroll(payload.fieldId!, table);
  if (!plan.ok || !plan.target) {
    return {
      x: 0,
      y: 0,
      scrolledBy: 0,
      pixelsAbove: 0,
      pixelsBelow: 0,
      viewportHeight: 0,
      status: 'not_found',
      fieldsTableStale: plan.reason === 'no_table',
    };
  }

  const result = await executeInTab(
    tabId,
    { url: table!.url, path: plan.target.path, expect: plan.target.expect, x: payload.x, y: payload.y, behavior: payload.behavior },
    scrollContainerInPage,
  );

  return {
    x: result.x,
    y: result.y,
    scrolledBy: result.scrolledBy,
    pixelsAbove: result.pixelsAbove,
    pixelsBelow: result.pixelsBelow,
    viewportHeight: result.viewportHeight,
    container: result.status === 'ok' ? { tag: result.tag!, label: result.label } : undefined,
    status: result.status,
    fieldsTableStale: result.fieldsTableStale,
  };
}
```

- [ ] **Step 4: Verify everything still compiles and passes**

Run: `pnpm compile` — expect no type errors.
Run: `pnpm test` — expect full suite passes.

- [ ] **Step 5: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts
git commit -m "feat: SCROLL_PAGE 协议接线 fieldId 容器滚动 + selector 误报修复"
```

---

### Task 8: `browser_scroll` tool schema + fieldId error handling

**Files:**
- Modify: `lib/agent/tools.ts:653-671` (`makeScrollTool`)
- Test: `lib/agent/form-tools.test.ts`

**Interfaces:**
- Consumes: `ScrollPagePayload.fieldId`, `ScrollPageResult.status`/`fieldsTableStale` from Task 7.

- [ ] **Step 1: Write the failing tests**

Add a new `describe('browser_scroll', ...)` block to `lib/agent/form-tools.test.ts` (anywhere after the existing `describe('browser_fill_form', ...)` block):

```ts
function scrollTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_scroll');
  if (!tool) throw new Error('browser_scroll 未注册');
  return tool;
}

describe('browser_scroll', () => {
  it('is registered as a tool', () => {
    expect(scrollTool().name).toBe('browser_scroll');
  });

  it('passes fieldId through to the SCROLL_PAGE payload', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { x: 0, y: 300, scrolledBy: 300, pixelsAbove: 300, pixelsBelow: 300, viewportHeight: 400, status: 'ok' },
    });
    await scrollTool().execute('call-1', { fieldId: 's1', y: 300 });
    expect(sendMessage).toHaveBeenCalledWith('SCROLL_PAGE', { fieldId: 's1', y: 300 }, 1);
  });

  it('tells the model to re-read the form when the handle table is stale', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { x: 0, y: 0, scrolledBy: 0, pixelsAbove: 0, pixelsBelow: 0, viewportHeight: 0, status: 'not_found', fieldsTableStale: true },
    });
    await expect(scrollTool().execute('call-1', { fieldId: 's1' })).rejects.toThrow('browser_get_form');
  });

  it('throws when the fieldId does not resolve (not_found, table present)', async () => {
    sendMessage.mockResolvedValueOnce({
      id: '1',
      ok: true,
      data: { x: 0, y: 0, scrolledBy: 0, pixelsAbove: 0, pixelsBelow: 0, viewportHeight: 0, status: 'not_found' },
    });
    await expect(scrollTool().execute('call-1', { fieldId: 's1' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: FAIL — `browser_scroll`'s schema doesn't accept `fieldId` yet (the payload cast still forwards it today, so the first test may already pass; the two failure-handling tests will fail because `makeScrollTool`'s `execute` currently never inspects `status`/`fieldsTableStale`).

- [ ] **Step 3: Update makeScrollTool in tools.ts**

Replace the existing `makeScrollTool` function:

```ts
function makeScrollTool(session: TabSessionController): BrowserAgentTool {
  return {
    name: 'browser_scroll',
    label: 'Scroll',
    description:
      'Scroll the page to specific coordinates, scroll a specific element into view, or (with fieldId) scroll a specific container discovered by browser_get_form(includeScrollable: true) directly — use fieldId when you need to page through a panel, chat log, or virtual list that has no single target element to scroll into view.',
    parameters: Type.Object({
      fieldId: Type.Optional(Type.String({ description: 'A scrollable container fieldId from browser_get_form(includeScrollable: true). Takes priority over selector.' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector to scroll into view. If omitted (and fieldId is not given), scrolls the window to x/y.' })),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number({ description: 'Absolute vertical scroll target: window scrollY in the default mode, or that container\'s scrollTop when fieldId is given.' })),
      behavior: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('smooth')])),
    }),
    execute: async (_toolCallId, params) => {
      const payload = params as ScrollPagePayload;
      const response = (await sendMessage<ScrollPagePayload, ScrollPageResult>('SCROLL_PAGE', payload, session.currentTabId)) as MessageResponse<ScrollPageResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '滚动失败');
      if (response.data.fieldsTableStale) {
        throw new Error('字段表已失效（页面已变化或已导航），请重新调用 browser_get_form 获取新的 fieldId 后再滚动。');
      }
      if (response.data.status && response.data.status !== 'ok') {
        throw new Error(
          response.data.status === 'mismatch'
            ? '该容器与读取时不一致，页面可能已变化，请重新调用 browser_get_form。'
            : '未知的 fieldId，请重新调用 browser_get_form。',
        );
      }
      return textResult(describeScrollResult(response.data), response.data as unknown as Record<string, unknown>);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Full verification**

Run: `pnpm compile` — expect no type errors.
Run: `pnpm test` — expect full suite passes.
Run: `pnpm build` — expect production build succeeds (`.output/chrome-mv3`).

- [ ] **Step 6: Commit**

```bash
git add lib/agent/tools.ts lib/agent/form-tools.test.ts
git commit -m "feat: browser_scroll 暴露 fieldId 参数与失败处理"
```

---

### Task 9: `describeScrollResult` mentions the container that actually moved

**Files:**
- Modify: `lib/agent/action-result-text.ts:19-48` (`describeScrollResult`)
- Test: `lib/agent/action-result-text.test.ts`

**Interfaces:**
- Consumes: `ScrollPageResult.container` from Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `lib/agent/action-result-text.test.ts`, inside the existing `describe('describeScrollResult', ...)` block:

```ts
  it('names the container that actually scrolled instead of implying the whole page moved', () => {
    expect(
      describeScrollResult(
        scroll({ selector: '#target', scrolledBy: 250, pixelsBelow: 350, container: { tag: 'div', label: '聊天记录' } }),
      ),
    ).toBe('✅ 已把内层 <div>（"聊天记录"）容器下滚 250px。下方还有 350px（约 0.3 屏）未查看。');
  });

  it('names the container without a label when none is available', () => {
    expect(
      describeScrollResult(scroll({ scrolledBy: 300, pixelsBelow: 0, container: { tag: 'div' } })),
    ).toBe('✅ 已把内层 <div> 容器下滚 300px，已到达容器底部。');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/action-result-text.test.ts`
Expected: FAIL — `describeScrollResult` ignores `result.container` today, so the messages come out with the pre-existing generic wording instead.

- [ ] **Step 3: Update describeScrollResult in action-result-text.ts**

Replace the function:

```ts
export function describeScrollResult(result: ScrollPageResult): string {
  const { scrolledBy, pixelsAbove, pixelsBelow, viewportHeight, container } = result;
  const atTop = pixelsAbove <= 1;
  const atBottom = pixelsBelow <= 1;
  const place = container ? '容器' : '页面';

  if (scrolledBy === 0) {
    if (atBottom) return `⚠️ ${place}没有滚动：已在底部，无法继续下滚。`;
    if (atTop) return `⚠️ ${place}没有滚动：已在顶部，无法继续上滚。`;
    return `⚠️ ${place}没有发生滚动。上方 ${pixelsAbove}px，下方 ${pixelsBelow}px。`;
  }

  // 有 label 时括注紧贴标签名（"<div>（"聊天记录"）容器"）；没有 label 时用空格断词，
  // 否则 "<div>容器" 会读起来像标签名的一部分。
  const containerLabel = container?.label ? `（"${container.label}"）` : ' ';
  const target = container ? `内层 <${container.tag}>${containerLabel}容器` : undefined;

  const head = result.selector && !container
    ? `✅ 已把 "${result.selector}" 滚动到视口中央。`
    : target
      ? scrolledBy > 0
        ? `✅ 已把${target}下滚 ${scrolledBy}px`
        : `✅ 已把${target}上滚 ${Math.abs(scrolledBy)}px`
      : scrolledBy > 0
        ? `✅ 已下滚 ${scrolledBy}px`
        : `✅ 已上滚 ${Math.abs(scrolledBy)}px`;

  const forwardAtEdge = scrolledBy > 0 ? atBottom : atTop;
  const forwardPixels = scrolledBy > 0 ? pixelsBelow : pixelsAbove;
  const edgeLabel = scrolledBy > 0 ? '底部' : '顶部';
  const sideLabel = scrolledBy > 0 ? '下方' : '上方';

  if (result.selector && !container) {
    return forwardAtEdge ? `${head}已到达页面${edgeLabel}。` : `${head}${sideLabel}还有 ${describeRemaining(forwardPixels, viewportHeight)}。`;
  }
  return forwardAtEdge
    ? `${head}，已到达${place}${edgeLabel}。`
    : `${head}。${sideLabel}还有 ${describeRemaining(forwardPixels, viewportHeight)}。`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/action-result-text.test.ts`
Expected: PASS, including every pre-existing test in the file (all existing fixtures omit `container`, so `place` stays `'页面'` and the wording is byte-for-byte identical to before).

- [ ] **Step 5: Full verification**

Run: `pnpm compile` — expect no type errors.
Run: `pnpm test` — expect full suite passes.
Run: `pnpm build` — expect production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/action-result-text.ts lib/agent/action-result-text.test.ts
git commit -m "feat: describeScrollResult 区分内层容器滚动与整页滚动的措辞"
```

---

## Manual verification (not automatable, see spec §6)

After all nine tasks land, load the unpacked extension (`.output/chrome-mv3`) and:

1. On a real page with a virtual list or chat-log-style panel (an `overflow:auto` div with more content than fits), call `browser_get_form` with `includeScrollable: true` and confirm the panel shows up in `scrollableContainers` with plausible `scrollHeight`/`clientHeight`, then call `browser_scroll` with that `fieldId` and a `y` and confirm the panel actually scrolls and the reported numbers make sense.
2. On the same kind of page, use `browser_scroll` with a `selector` pointing at an element inside that panel (no `fieldId`) and compare the reported `scrolledBy`/`container` before and after this change — confirm the mis-report ("页面没有滚动" when the panel actually moved) is gone.
