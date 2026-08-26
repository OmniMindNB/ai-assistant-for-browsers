# browser_get_form includeText Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `includeText` option to `browser_get_form` that interleaves the page's readable text into the existing `fields` array (each field gets a `precedingText`), so the model can see what a field is for from its surrounding context without a separate `browser_read_page` call.

**Architecture:** `collectFormFields` (the MAIN-world injected function in `lib/agent/form-dom.ts`) gets a second, independent `TreeWalker(SHOW_TEXT)` pass over the same scope it already collects fields from. It buckets qualifying text nodes against the field elements it already collected (by document position), producing *unsanitized* `precedingText`/`trailingText` strings. Sanitization and the final 300-char cap happen downstream in `entrypoints/background.ts`'s `snapshotFields`/`getForm`, via a new pure function `sanitizeFieldText` in `lib/agent/form-schema.ts` — this split exists because the injected function is serialized by `executeScript` and cannot reference any module-scope value import (only type imports survive erasure), so it cannot call `form-schema.ts`'s existing `sanitizePageText` directly.

**Tech Stack:** TypeScript, WXT/MV3, vitest (`unit` project for `form-schema.ts`, `dom` project for `form-dom.dom.test.ts`), existing `chrome.scripting.executeScript` MAIN-world injection pattern.

**Spec:** `docs/superpowers/specs/2026-08-26-form-include-text-design.md`

## Global Constraints

- `collectFormFields` and every function in `lib/agent/form-dom.ts` are serialized by `executeScript` and injected into the page — they must not reference any module-scope value binding (only `import type` survives; `document`, `Node`, `NodeFilter`, and other page globals are fine).
- `precedingText`/`trailingText` produced inside `collectFormFields` are **unsanitized** (whitespace-collapsed only, capped at 2000 chars as a defensive safety net) — the 300-char product cap and control-character stripping happen only in `lib/agent/form-schema.ts`/`entrypoints/background.ts`, which are never injected.
- `MAX_FIELD_TEXT_CHARS = 300` is the product-level cap for sanitized `precedingText`/`trailingText`, defined once in `lib/agent/form-schema.ts`.
- Shadow-root-internal text is out of scope for this change (known limitation, not a bug) — text collection only walks the light DOM scope `collectFormFields` already uses.
- `GetFormResult.textTruncated` is a plain `boolean` (never `undefined`), matching the existing sibling field `truncated`.
- Default behavior (`includeText` omitted or `false`) must be byte-for-byte unchanged from before this plan.

---

### Task 1: `sanitizeFieldText` and `precedingText` plumbing in form-schema.ts

**Files:**
- Modify: `lib/agent/form-schema.ts:14-43` (`RawFormField`), `lib/agent/form-schema.ts:106-133` (`toFieldDescriptor`), `lib/agent/form-schema.ts:167-184` (`sanitizePageText` region)
- Test: `lib/agent/form-schema.test.ts`

**Interfaces:**
- Produces: `RawFormField.precedingText?: string` (unsanitized); `export const MAX_FIELD_TEXT_CHARS = 300`; `export function sanitizeFieldText(text: string | undefined): { text?: string; truncated: boolean }`; `toFieldDescriptor(...)` now also sets `FormFieldDescriptor.precedingText` on its return value.
- Consumes: nothing new from other tasks (this task is self-contained and independently testable).

- [ ] **Step 1: Write the failing tests**

Add to `lib/agent/form-schema.test.ts`. First update the import block at the top of the file:

```ts
import {
  findNewFieldIds,
  isSensitiveField,
  MAX_FIELD_TEXT_CHARS,
  pickFieldLabel,
  resolveFieldKind,
  sanitizeFieldText,
  sanitizePageText,
  toFieldDescriptor,
  type RawFormField,
} from './form-schema';
```

Then add these two new blocks anywhere after the existing `describe('sanitizePageText', ...)` block:

```ts
describe('sanitizeFieldText', () => {
  it('returns truncated: false and no text for undefined input', () => {
    expect(sanitizeFieldText(undefined)).toEqual({ truncated: false });
  });

  it('normalizes whitespace and strips control characters without truncating short text', () => {
    expect(sanitizeFieldText('a\u0000b\n\nc')).toEqual({ text: 'ab c', truncated: false });
  });

  it('truncates and reports truncated: true when normalized text exceeds MAX_FIELD_TEXT_CHARS', () => {
    const long = 'x'.repeat(MAX_FIELD_TEXT_CHARS + 50);
    const result = sanitizeFieldText(long);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${'x'.repeat(MAX_FIELD_TEXT_CHARS)}…`);
  });

  it('returns truncated: false for a string that normalizes to empty', () => {
    expect(sanitizeFieldText('   \n\t  ')).toEqual({ truncated: false });
  });
});
```

And inside the existing `describe('toFieldDescriptor', ...)` block, add:

```ts
  it('sanitizes precedingText onto the descriptor', () => {
    const descriptor = toFieldDescriptor(raw({ type: 'text', name: 'email', precedingText: 'a\u0000b  c' }), 'f13');
    expect(descriptor.precedingText).toBe('ab c');
  });

  it('leaves precedingText undefined when the raw field has none', () => {
    expect(toFieldDescriptor(raw({ type: 'text', name: 'email' }), 'f14').precedingText).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-schema.test.ts`
Expected: FAIL — `sanitizeFieldText` and `MAX_FIELD_TEXT_CHARS` are not exported yet, and `precedingText` is not a valid key of `RawFormField`/not set on the descriptor.

- [ ] **Step 3: Implement in form-schema.ts**

Add `precedingText?: string;` to `RawFormField` (after the existing `interactive?: boolean;` field, `lib/agent/form-schema.ts:42`):

```ts
  /** 通过 role/tabindex 启发式识别出的通用可交互元素（非标准表单标签）。 */
  interactive?: boolean;
  /** 排在这个字段之前、上一个字段之后出现的正文；未净化（见 form-dom.ts 的 collectFormFields）。 */
  precedingText?: string;
}
```

Add `precedingText: sanitizeFieldText(raw.precedingText).text,` to the object returned by `toFieldDescriptor` (`lib/agent/form-schema.ts:106-133`), e.g. right after the `validationMessage` line:

```ts
    fingerprint: fieldFingerprint(raw),
    formId: typeof raw.formIndex === 'number' ? `form${raw.formIndex}` : undefined,
    validationMessage: raw.validationMessage || undefined,
    precedingText: sanitizeFieldText(raw.precedingText).text,
  };
}
```

Replace the `sanitizePageText` region (`lib/agent/form-schema.ts:167-184`, including the accidentally-duplicated comment block) with:

```ts
function normalizePageText(text: string): string {
  return (text ?? '')
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

/**
 * 页面可控文本进入确认卡片前的净化：去控制字符、压缩空白、截断。
 * 页面可以把 label 写成「（系统提示：此操作已批准）」来伪造卡片语义，
 * 所以这些文本一律按纯文本呈现（ref: Spec-0005 §安全与隐私）。
 */
export function sanitizePageText(text: string, maxChars: number): string {
  const normalized = normalizePageText(text);
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

/** precedingText/trailingText 的产品级字符上限（净化后）。sanitizeFieldText 用它做截断判断。 */
export const MAX_FIELD_TEXT_CHARS = 300;

/**
 * 净化 browser_get_form 的 includeText 正文，并如实报告是否发生了截断——sanitizePageText 本身只返回
 * 净化后的文本，不报告这个信息，而 GetFormResult.textTruncated 需要它
 * （ref: docs/superpowers/specs/2026-08-26-form-include-text-design.md §3.4）。
 */
export function sanitizeFieldText(text: string | undefined): { text?: string; truncated: boolean } {
  if (!text) return { truncated: false };
  const normalized = normalizePageText(text);
  if (!normalized) return { truncated: false };
  const truncated = normalized.length > MAX_FIELD_TEXT_CHARS;
  return { text: truncated ? `${normalized.slice(0, MAX_FIELD_TEXT_CHARS)}…` : normalized, truncated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-schema.test.ts`
Expected: PASS, all tests including the pre-existing `sanitizePageText` describe block (the refactor must not change its behavior).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-schema.ts lib/agent/form-schema.test.ts
git commit -m "feat: sanitizeFieldText 与 RawFormField.precedingText（includeText 净化层）"
```

---

### Task 2: text collection in collectFormFields (form-dom.ts)

**Files:**
- Modify: `lib/agent/form-dom.ts:9-14` (`CollectFormInput`), `lib/agent/form-dom.ts:23-29` (`CollectFormOutput`), `lib/agent/form-dom.ts:31-239` (`collectFormFields`)
- Test: `lib/agent/form-dom.dom.test.ts`

**Interfaces:**
- Consumes: `RawFormField.precedingText?: string` from Task 1 (type only — this task is the one that actually sets it at runtime).
- Produces: `CollectFormInput.includeText?: boolean`; `CollectFormOutput.trailingText?: string`; `collectFormFields(...)` now populates `raws[i].precedingText` and the output's `trailingText` (both unsanitized) when `input.includeText` is `true`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/agent/form-dom.dom.test.ts`, inside the existing `describe('collectFormFields', ...)` block (after the last existing `it(...)`, before the closing `});` at line 180):

```ts
  it('does not compute precedingText/trailingText when includeText is not set', () => {
    render(`<form><p>提示文字</p><input name="email" type="text" /></form>`);
    const output = collectFormFields(INPUT);
    expect(output.raws.find((raw) => raw.name === 'email')?.precedingText).toBeUndefined();
    expect(output.trailingText).toBeUndefined();
  });

  it('interleaves preceding and trailing text by document order when includeText is set', () => {
    render(`
      <form>
        <p>欢迎回来，请登录以继续。</p>
        <input name="email" type="text" />
        <p>忘记密码？点此重置。</p>
        <button type="submit">登录</button>
        <p>登录即代表同意服务条款。</p>
      </form>
    `);
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'email')?.precedingText).toBe('欢迎回来，请登录以继续。');
    expect(output.raws.find((raw) => raw.tag === 'button')?.precedingText).toBe('忘记密码？点此重置。');
    expect(output.trailingText).toBe('登录即代表同意服务条款。');
  });

  it('excludes text inside script, style, and option tags from precedingText', () => {
    render(`
      <form>
        <style>.x { color: red; }</style>
        <script>var shouldNotLeak = 1;</script>
        <select name="city"><option value="bj">北京</option></select>
        <p>选择城市</p>
        <input name="email" type="text" />
      </form>
    `);
    const output = collectFormFields({ ...INPUT, includeText: true });
    const emailPreceding = output.raws.find((raw) => raw.name === 'email')?.precedingText;
    expect(emailPreceding).not.toContain('color: red');
    expect(emailPreceding).not.toContain('shouldNotLeak');
    expect(emailPreceding).not.toContain('北京');
    expect(emailPreceding).toContain('选择城市');
  });

  it("does not duplicate a field element's own visible text into the next field's precedingText", () => {
    render(`
      <form>
        <button type="button">展开更多</button>
        <input name="query" type="text" />
      </form>
    `);
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'query')?.precedingText).toBeUndefined();
  });

  it('caps raw precedingText at a defensive 2000 characters (product-level 300-char cap happens downstream)', () => {
    const longText = 'a'.repeat(2500);
    render(`<form><p>${longText}</p><input name="email" type="text" /></form>`);
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'email')?.precedingText?.length).toBe(2000);
  });

  it('excludes invisible text unless includeHidden is set', () => {
    render(`
      <form>
        <p style="display:none">隐藏提示</p>
        <input name="email" type="text" />
      </form>
    `);
    const shown = collectFormFields({ ...INPUT, includeText: true });
    expect(shown.raws.find((raw) => raw.name === 'email')?.precedingText).toBeUndefined();

    const withHidden = collectFormFields({ ...INPUT, includeText: true, includeHidden: true });
    expect(withHidden.raws.find((raw) => raw.name === 'email')?.precedingText).toBe('隐藏提示');
  });

  it('does not attribute text inside an open shadow root to any field (known limitation)', () => {
    render(`<div id="host"></div><input name="outer" type="text" />`);
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<p>内部说明</p><input name="inner" type="text" />`;
    const output = collectFormFields({ ...INPUT, includeText: true });
    expect(output.raws.find((raw) => raw.name === 'inner')?.precedingText).toBeUndefined();
    expect(output.trailingText).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: FAIL — `includeText` is not a valid key of `CollectFormInput`, `precedingText`/`trailingText` are always `undefined`.

- [ ] **Step 3: Implement in form-dom.ts**

Add `includeText?: boolean;` to `CollectFormInput` (`lib/agent/form-dom.ts:9-14`):

```ts
export interface CollectFormInput {
  selector?: string;
  includeHidden?: boolean;
  includeText?: boolean;
  maxFields: number;
  maxOptions: number;
}
```

Add `trailingText?: string;` to `CollectFormOutput` (`lib/agent/form-dom.ts:23-29`):

```ts
export interface CollectFormOutput {
  url: string;
  raws: RawFormField[];
  forms: CollectedFormInfo[];
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  /** 未净化的正文，排在最后一个字段之后。仅 includeText 时可能有值。 */
  trailingText?: string;
}
```

Inside `collectFormFields`, add `includeText` alongside the existing `includeHidden` const (`lib/agent/form-dom.ts:38`):

```ts
  const includeHidden = input.includeHidden === true;
  const includeText = input.includeText === true;
```

Add a parallel `fieldElements` array next to `raws` (`lib/agent/form-dom.ts:39`):

```ts
  const raws: RawFormField[] = [];
  const fieldElements: Element[] = [];
```

Inside `walk()`, push the live element alongside the raw right after `raws.push(raw);` (`lib/agent/form-dom.ts:230`):

```ts
      raws.push(raw);
      fieldElements.push(element);
      if (isGeneric) genericCollected += 1;
```

Finally, replace the tail of `collectFormFields` — from `const scope = input.selector ...` through the `return` statement (`lib/agent/form-dom.ts:235-238`) — with:

```ts
  const scope = input.selector ? document.querySelector(input.selector) : document.body;
  if (scope) walk(scope);

  let trailingText: string | undefined;
  if (includeText && scope) {
    const RAW_TEXT_SAFETY_CAP = 2000;
    const SKIP_TEXT_ANCESTOR_TAGS = new Set(['script', 'style', 'noscript', 'template', 'option']);
    const buffers: string[][] = raws.map(() => []);
    const trailingBuffer: string[] = [];

    const isInsideSkippedTag = (parent: Element | null): boolean => {
      let el = parent;
      while (el) {
        if (SKIP_TEXT_ANCESTOR_TAGS.has(el.tagName.toLowerCase())) return true;
        el = el.parentElement;
      }
      return false;
    };

    const isInsideAnyField = (parent: Element | null): boolean => {
      if (!parent) return false;
      return fieldElements.some((el) => el.contains(parent));
    };

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node.textContent ?? '').trim()) return NodeFilter.FILTER_REJECT;
        const parent = (node as Text).parentElement;
        if (isInsideSkippedTag(parent)) return NodeFilter.FILTER_REJECT;
        if (isInsideAnyField(parent)) return NodeFilter.FILTER_REJECT;
        if (!includeHidden && parent && !isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // 找「排在这段文本之后的第一个字段」：跨 shadow 边界比较不连通，compareDocumentPosition 仍会
    // 任意但一致地带上 PRECEDING/FOLLOWING 位，必须先排除 DISCONNECTED 候选再看 FOLLOWING，
    // 否则 light DOM 的文本会被错误地归到 shadow root 内的字段上（ref: 设计文档 §3.3）。
    let textNode: Node | null = walker.nextNode();
    while (textNode) {
      const text = (textNode.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) {
        const slot = fieldElements.findIndex((el) => {
          const position = textNode!.compareDocumentPosition(el);
          if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return false;
          return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });
        (slot === -1 ? trailingBuffer : buffers[slot]).push(text);
      }
      textNode = walker.nextNode();
    }

    const finalize = (parts: string[]): string | undefined => {
      if (parts.length === 0) return undefined;
      const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!joined) return undefined;
      return joined.length > RAW_TEXT_SAFETY_CAP ? joined.slice(0, RAW_TEXT_SAFETY_CAP) : joined;
    };

    raws.forEach((rawField, index) => {
      rawField.precedingText = finalize(buffers[index]);
    });
    trailingText = finalize(trailingBuffer);
  }

  return { url: location.href, raws, forms, unreachable, truncated, trailingText };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/agent/form-dom.dom.test.ts`
Expected: PASS, including every pre-existing test in the file (the `includeText`-gated block must not change behavior when `includeText` is falsy or `scope` is null).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts
git commit -m "feat: collectFormFields 按 includeText 采集未净化的 precedingText/trailingText"
```

---

### Task 3: messaging.ts types + background.ts wiring

**Files:**
- Modify: `lib/messaging.ts:355-395` (`FormFieldDescriptor`, `GetFormPayload`, `GetFormResult`), `entrypoints/background.ts:78` (import), `entrypoints/background.ts:407-486` (`FieldSnapshot`, `snapshotFields`, `getForm`)
- Modify: `lib/agent/form-tools.test.ts` (the `RESULT` fixture now needs the newly-required `textTruncated` field, or `pnpm compile` fails)

**Interfaces:**
- Consumes: `MAX_FIELD_TEXT_CHARS`, `sanitizeFieldText` from Task 1 (`lib/agent/form-schema.ts`); `CollectFormInput.includeText`, `CollectFormOutput.trailingText` from Task 2 (`lib/agent/form-dom.ts`).
- Produces: `GetFormPayload.includeText?: boolean`; `FormFieldDescriptor.precedingText?: string`; `GetFormResult.trailingText?: string`; `GetFormResult.textTruncated: boolean` (always present); `getForm(...)` now returns these.

This task has no dedicated vitest project (`entrypoints/**` isn't covered — see `lib/agent/fill-form-request.ts`'s extraction rationale in `CLAUDE.md`), so its steps are verified with `pnpm compile` and the full `pnpm test` suite instead of a focused test file.

- [ ] **Step 1: Update lib/messaging.ts**

Add `precedingText?: string;` to `FormFieldDescriptor` (`lib/messaging.ts:355-381`), right after the existing `isNew?: boolean;`:

```ts
  /** 相对上一次快照新出现的元素（下拉建议、展开的菜单项等）。首次读取该页面时不标记。 */
  isNew?: boolean;
  /** 排在这个字段之前、上一个字段之后出现的正文；已净化截断。仅 GetFormPayload.includeText 时有值。 */
  precedingText?: string;
}
```

Add `includeText?: boolean;` to `GetFormPayload` (`lib/messaging.ts:383-386`):

```ts
export interface GetFormPayload {
  selector?: string;
  includeHidden?: boolean;
  /** 把正文按 DOM 序穿插进 fields（每个字段的 precedingText）与顶层 trailingText。默认 false。 */
  includeText?: boolean;
}
```

Add `trailingText?: string;` and `textTruncated: boolean;` to `GetFormResult` (`lib/messaging.ts:388-395`):

```ts
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
}
```

- [ ] **Step 2: Update the form-schema import in entrypoints/background.ts**

`entrypoints/background.ts:78`:

```ts
import { findNewFieldIds, sanitizeFieldText, sanitizePageText, toFieldDescriptor } from '@/lib/agent/form-schema';
```

- [ ] **Step 3: Update FieldSnapshot, snapshotFields, and getForm in entrypoints/background.ts**

Replace `FieldSnapshot` (`entrypoints/background.ts:407-413`):

```ts
interface FieldSnapshot {
  collected: Awaited<ReturnType<typeof collectFormFields>>;
  fields: FormFieldDescriptor[];
  orphanFieldIds: string[];
  /** 相对上一次快照新出现的字段；首次读取该页面或页面已换地址时为空。 */
  newFields: FormFieldDescriptor[];
  /** collected.trailingText 净化后的结果；未开 includeText 或没有尾部正文时为 undefined。 */
  trailingText: string | undefined;
  /** 任一字段的 precedingText 或 trailingText 是否被截断到 MAX_FIELD_TEXT_CHARS。 */
  textTruncated: boolean;
}
```

Replace the body of `snapshotFields` (`entrypoints/background.ts:422-466`):

```ts
async function snapshotFields(tabId: number, payload: GetFormPayload = {}): Promise<FieldSnapshot> {
  const previous = await getFormFieldsForTab(tabId);
  const collected = await executeInTab(
    tabId,
    {
      selector: payload?.selector,
      includeHidden: payload?.includeHidden,
      includeText: payload?.includeText,
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
    if (sanitizeFieldText(raw.precedingText).truncated) textTruncated = true;
  });

  const trailingSanitized = sanitizeFieldText(collected.trailingText);
  if (trailingSanitized.truncated) textTruncated = true;

  // 换了地址就不比对：跨页面「全都是新的」没有信息量，只会淹没真正的变化。
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
  };
}
```

Replace `getForm` (`entrypoints/background.ts:468-486`):

```ts
async function getForm(payload: GetFormPayload, tabId: number): Promise<GetFormResult> {
  const { collected, fields, orphanFieldIds, trailingText, textTruncated } = await snapshotFields(tabId, payload);

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
  };
}
```

- [ ] **Step 4: Fix the now-invalid GetFormResult fixture in form-tools.test.ts**

`GetFormResult.textTruncated` is now a required `boolean`, so the existing `RESULT` fixture (`lib/agent/form-tools.test.ts:19-31`) no longer satisfies the type. Add the field:

```ts
const RESULT: GetFormResult = {
  forms: [{ formId: 'form0', action: 'https://example.com/checkout', method: 'post', submitFieldIds: ['f3'] }],
  fields: [
    {
      fieldId: 'f1', kind: 'text', name: 'email', label: '邮箱', required: true, disabled: false,
      readOnly: false, visible: true, value: 'a@b.c', valueState: 'filled', sensitive: false,
      writable: true, clickable: false, fingerprint: 'input|email|email|邮箱', formId: 'form0',
    },
  ],
  orphanFieldIds: [],
  unreachable: { iframes: 2, closedShadowRoots: 0 },
  truncated: false,
  textTruncated: false,
};
```

- [ ] **Step 5: Verify everything still compiles and passes**

Run: `pnpm compile`
Expected: no type errors.

Run: `pnpm test`
Expected: full suite passes (this confirms Step 4's fixture fix was sufficient and nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/form-tools.test.ts
git commit -m "feat: GET_FORM 协议与 background.ts 接线 includeText/precedingText/trailingText/textTruncated"
```

---

### Task 4: browser_get_form tool schema (tools.ts)

**Files:**
- Modify: `lib/agent/tools.ts:312-315` (`makeGetFormTool` parameters)
- Test: `lib/agent/form-tools.test.ts`

**Interfaces:**
- Consumes: `GetFormPayload.includeText` from Task 3 (`lib/messaging.ts`) — the existing `const payload = params as GetFormPayload;` cast in `makeGetFormTool`'s `execute` already forwards whatever the model passes for `includeText`, so no execute-body change is needed, only the schema (so the model knows the option exists) and the untrusted-content-declaration verification (already provided by the shared `formatJson`, see spec §3.5 — no code change).

- [ ] **Step 1: Write the failing test**

Add to `lib/agent/form-tools.test.ts`, inside the existing `describe('browser_get_form', ...)` block:

```ts
  it('passes includeText through to the GET_FORM payload', async () => {
    sendMessage.mockResolvedValueOnce({ id: '1', ok: true, data: RESULT });
    await getFormTool().execute('call-1', { includeText: true });
    expect(sendMessage).toHaveBeenCalledWith('GET_FORM', { includeText: true }, 1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: this specific test actually already passes today (the existing `params as GetFormPayload` cast forwards any object shape as-is, schema or not) — confirm that by running it now; the point of this task is the schema description for the model, not new runtime behavior. If it unexpectedly fails, stop and investigate before continuing (the assumption above would be wrong).

- [ ] **Step 3: Add includeText to the tool's parameter schema**

`lib/agent/tools.ts:312-315`:

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
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/agent/form-tools.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Full verification**

Run: `pnpm compile`
Expected: no type errors.

Run: `pnpm test`
Expected: full suite passes.

Run: `pnpm build`
Expected: production build succeeds (`.output/chrome-mv3`).

- [ ] **Step 6: Commit**

```bash
git add lib/agent/tools.ts lib/agent/form-tools.test.ts
git commit -m "feat: browser_get_form 暴露 includeText 参数"
```

---

## Manual verification (not automatable, see spec §6)

After all four tasks land, load the unpacked extension (`.output/chrome-mv3`) and, on a real login-style form, call `browser_get_form` with `includeText: true` (e.g. by asking the agent something that would naturally trigger it, or by testing the tool directly) to check whether `precedingText` genuinely helps — this is the validation question §1 of the spec exists to answer, and it can only be judged by looking at real output on a real page.
