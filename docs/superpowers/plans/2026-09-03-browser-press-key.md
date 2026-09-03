# browser_press_key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `browser_press_key` 工具，让 agent 能向页面派发具名按键（Enter / Tab / Escape / 方向键等），并在 Enter 会触发表单隐式提交时走既有的确认闸门。

**Architecture:** 按键规范化（`key`/`code`/`keyCode`/修饰键）与 Enter 隐式提交判定都是纯函数，分别落在 `lib/agent/key-dispatch.ts` 与 `lib/agent/form-submit.ts`；注入页面的探测与派发函数放 `lib/agent/form-dom.ts`；`background.ts` 只做 I/O 编排。派发的事件 `isTrusted` 为 `false`，原生行为不触发，因此只显式补 Enter 的 `form.requestSubmit()` 这一个副作用。

**Tech Stack:** TypeScript、WXT（MV3）、vitest（`unit` 与 `dom` 两个 project）、`@earendil-works/pi-agent-core` 的 `AgentTool`、TypeBox（`Type.*`）。

**Spec:** `docs/superpowers/specs/2026-09-03-agent-tool-expansion-design.md`（本计划实现其 §4，以及 §6/§7 中与 press_key 相关的条目）

## Global Constraints

- 不新增任何 manifest 权限。`wxt.config.ts` 的 `permissions` 数组保持不变。
- `browser_press_key` 进 `AUTO_APPROVE_TOOL_NAMES`（因而自动进入 `WRITE_TOOL_NAMES`），**并且必须**进 `SUBMIT_CAPABLE_TOOLS`。
- **安全关键：** Enter 能提交表单，因此若 `browser_press_key` 不进 `SUBMIT_CAPABLE_TOOLS`，它就是绕过"结构化检测到的表单提交每次都要确认"这条硬边界的后门。这一条不可协商。
- 按键白名单固定为 13 个：`Enter`、`Tab`、`Escape`、`Backspace`、`Delete`、`ArrowUp`、`ArrowDown`、`ArrowLeft`、`ArrowRight`、`Home`、`End`、`PageUp`、`PageDown`。白名单外一律拒绝——输入文本用 `browser_type` / `browser_fill_form`。
- 只补 Enter 的表单提交这一个原生副作用。Tab 不模拟焦点移动，Escape 不模拟弹层关闭。工具 description 必须对模型明说这一点。
- 提交判定**只看结构，不看文案**。识别"下单""支付"这类字样会带来假阳性，毁掉确认的信噪比（`form-submit.ts` 开篇既有原则）。
- 注入页面的函数（`form-dom.ts` 内的 `probeKeyTarget` / `pressKeyInPage`）**不得引用任何模块作用域的绑定**，包括本文件的其它函数与常量。所有配置通过 `input` 参数传入，需要的常量在函数体内内联。`import type` 会被编译期擦除，不受此限制。
- 代码注释与提交信息用中文。
- 每个 vitest 命令都用 `pnpm vitest run <file>` 形式。

---

### Task 1: 按键规范化（纯函数）

**Files:**
- Create: `lib/agent/key-dispatch.ts`
- Test: `lib/agent/key-dispatch.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type PressableKey = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown'`
  - `interface KeyModifiers { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }`
  - `interface KeyDescriptor { key: PressableKey; code: string; keyCode: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; emitsKeypress: boolean }`
  - `function resolveKeyDescriptor(key: unknown, modifiers: unknown): { ok: true; descriptor: KeyDescriptor } | { ok: false; error: string }`
  - `const PRESSABLE_KEYS: PressableKey[]`

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/key-dispatch.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { PRESSABLE_KEYS, resolveKeyDescriptor } from './key-dispatch';

describe('resolveKeyDescriptor', () => {
  it('Enter 映射出正确的 code 与 keyCode', () => {
    const resolved = resolveKeyDescriptor('Enter', undefined);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.descriptor.key).toBe('Enter');
      expect(resolved.descriptor.code).toBe('Enter');
      expect(resolved.descriptor.keyCode).toBe(13);
    }
  });

  // 仍有大量页面读已废弃的 keyCode，映射缺失会让这些页面完全无反应。
  it('每个白名单按键都有非零 keyCode 和非空 code', () => {
    for (const key of PRESSABLE_KEYS) {
      const resolved = resolveKeyDescriptor(key, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.descriptor.keyCode).toBeGreaterThan(0);
        expect(resolved.descriptor.code.length).toBeGreaterThan(0);
      }
    }
  });

  // 真实浏览器里这批按键中只有 Enter 产生 keypress，多派发反而与真实行为不符。
  it('只有 Enter 产生 keypress', () => {
    for (const key of PRESSABLE_KEYS) {
      const resolved = resolveKeyDescriptor(key, undefined);
      if (resolved.ok) expect(resolved.descriptor.emitsKeypress).toBe(key === 'Enter');
    }
  });

  it('修饰键写进描述符', () => {
    const resolved = resolveKeyDescriptor('Enter', { ctrl: true, shift: true });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.descriptor.ctrlKey).toBe(true);
      expect(resolved.descriptor.shiftKey).toBe(true);
      expect(resolved.descriptor.altKey).toBe(false);
      expect(resolved.descriptor.metaKey).toBe(false);
    }
  });

  it('拒绝白名单外的按键，并在错误里列出可用按键', () => {
    const resolved = resolveKeyDescriptor('F5', undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain('F5');
      expect(resolved.error).toContain('Enter');
    }
  });

  it('拒绝普通字符——输入文本该用 browser_type', () => {
    const resolved = resolveKeyDescriptor('a', undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('browser_type');
  });

  it('拒绝非字符串', () => {
    expect(resolveKeyDescriptor(13, undefined).ok).toBe(false);
    expect(resolveKeyDescriptor(undefined, undefined).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/key-dispatch.test.ts`
Expected: FAIL，无法解析模块 `./key-dispatch`。

- [ ] **Step 3: 写最小实现**

创建 `lib/agent/key-dispatch.ts`：

```ts
// browser_press_key 的按键规范化。纯函数，不碰 DOM。
//
// 只支持具名功能键，不支持任意字符：输入文本走 browser_type / browser_fill_form，
// 一次一个字符地按键既慢又绕过了写入验证。

export type PressableKey =
  | 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown';

export interface KeyModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface KeyDescriptor {
  key: PressableKey;
  code: string;
  /** 已废弃但仍被大量页面读取；缺了它这些页面会完全无反应。 */
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** 真实浏览器里只有 Enter 会在这批按键中产生 keypress。 */
  emitsKeypress: boolean;
}

const KEY_TABLE: Record<PressableKey, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

export const PRESSABLE_KEYS = Object.keys(KEY_TABLE) as PressableKey[];

export function resolveKeyDescriptor(
  key: unknown,
  modifiers: unknown,
): { ok: true; descriptor: KeyDescriptor } | { ok: false; error: string } {
  if (typeof key !== 'string' || !(key in KEY_TABLE)) {
    const shown = typeof key === 'string' ? `"${key}"` : String(key);
    const hint =
      typeof key === 'string' && key.length === 1
        ? '输入单个字符请用 browser_type 或 browser_fill_form，不要逐字符按键。'
        : '';
    return {
      ok: false,
      error: `不支持的按键 ${shown}。可用按键：${PRESSABLE_KEYS.join('、')}。${hint}`,
    };
  }

  const record = modifiers && typeof modifiers === 'object' ? (modifiers as Record<string, unknown>) : {};
  const entry = KEY_TABLE[key as PressableKey];
  return {
    ok: true,
    descriptor: {
      key: key as PressableKey,
      code: entry.code,
      keyCode: entry.keyCode,
      ctrlKey: record.ctrl === true,
      shiftKey: record.shift === true,
      altKey: record.alt === true,
      metaKey: record.meta === true,
      emitsKeypress: key === 'Enter',
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/key-dispatch.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm compile`（无输出），然后：

```bash
git add lib/agent/key-dispatch.ts lib/agent/key-dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat: browser_press_key 的按键规范化

13 个具名功能键的 key/code/keyCode 映射。keyCode 虽已废弃但仍被大量页面
读取，缺了它这些页面完全无反应。不支持任意字符：逐字符按键既慢又绕过了
browser_type 的写入验证，错误文案直接把模型引导回去。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 2: Enter 隐式提交判定（纯函数）

**Files:**
- Modify: `lib/agent/form-submit.ts`（在既有 `decideSubmitIntent` 之后追加）
- Test: `lib/agent/form-submit.test.ts`（追加 describe 块；文件已存在）

**Interfaces:**
- Consumes: 既有的 `SubmitIntent`
- Produces:
  - `interface EnterTargetInfo { tag: string; type?: string; hasFormOwner: boolean; formAction?: string; fieldCount?: number; hasSubmitButton: boolean; textLikeFieldCount: number }`
  - `function decideEnterSubmitIntent(info: EnterTargetInfo): SubmitIntent`

**为什么不能复用 `decideSubmitIntent`：** 后者的输入是 `ClickTargetInfo`，看的是被点元素本身是不是 `button` / `input[type=submit]`。Enter 走的是 HTML 的**隐式提交**规则——焦点在归属某 form 的文本类 input 上，且该 form 有提交按钮，或该 form 只有一个此类字段。输入形状与判据都不同。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/form-submit.test.ts` 末尾追加：

```ts
import { decideEnterSubmitIntent, type EnterTargetInfo } from './form-submit';

function enterTarget(overrides: Partial<EnterTargetInfo> = {}): EnterTargetInfo {
  return {
    tag: 'input',
    type: 'text',
    hasFormOwner: true,
    formAction: 'https://example.com/search',
    fieldCount: 3,
    hasSubmitButton: true,
    textLikeFieldCount: 2,
    ...overrides,
  };
}

describe('decideEnterSubmitIntent', () => {
  it('归属表单的文本框 + 表单有提交按钮 = 会提交', () => {
    expect(decideEnterSubmitIntent(enterTarget())).toEqual({
      isSubmit: true,
      formAction: 'https://example.com/search',
      fieldCount: 3,
    });
  });

  // HTML 隐式提交规则：没有提交按钮时，单字段表单仍然会被 Enter 提交。
  it('没有提交按钮但只有一个文本类字段 = 会提交', () => {
    const intent = decideEnterSubmitIntent(enterTarget({ hasSubmitButton: false, textLikeFieldCount: 1 }));
    expect(intent.isSubmit).toBe(true);
  });

  it('没有提交按钮且有多个文本类字段 = 不提交', () => {
    const intent = decideEnterSubmitIntent(enterTarget({ hasSubmitButton: false, textLikeFieldCount: 3 }));
    expect(intent.isSubmit).toBe(false);
  });

  it('不归属任何表单 = 不提交', () => {
    expect(decideEnterSubmitIntent(enterTarget({ hasFormOwner: false })).isSubmit).toBe(false);
  });

  // textarea 里 Enter 是换行，不是提交。
  it('textarea = 不提交', () => {
    expect(decideEnterSubmitIntent(enterTarget({ tag: 'textarea', type: undefined })).isSubmit).toBe(false);
  });

  it('checkbox / radio / button 类型的 input = 不提交', () => {
    for (const type of ['checkbox', 'radio', 'button', 'file']) {
      expect(decideEnterSubmitIntent(enterTarget({ type })).isSubmit).toBe(false);
    }
  });

  it('type 缺省的 input 按 text 处理 = 会提交', () => {
    expect(decideEnterSubmitIntent(enterTarget({ type: undefined })).isSubmit).toBe(true);
  });

  it('search/email/password/number 等文本类 type 都算', () => {
    for (const type of ['search', 'email', 'password', 'number', 'tel', 'url', 'date']) {
      expect(decideEnterSubmitIntent(enterTarget({ type })).isSubmit).toBe(true);
    }
  });

  // 与 decideSubmitIntent 同一原则：只看结构，不看文案。
  it('不因为按钮文案像"支付"就改变判定', () => {
    const intent = decideEnterSubmitIntent(enterTarget({ hasSubmitButton: false, textLikeFieldCount: 4 }));
    expect(intent.isSubmit).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/form-submit.test.ts`
Expected: FAIL，`decideEnterSubmitIntent` 未导出。

- [ ] **Step 3: 写最小实现**

在 `lib/agent/form-submit.ts` 末尾追加：

```ts
/**
 * Enter 键的隐式提交判定。输入形状与 ClickTargetInfo 不同，因此不复用
 * decideSubmitIntent：那个看的是被点元素本身是不是提交按钮，这个看的是
 * HTML 的隐式提交规则——焦点在归属表单的文本类 input 上，且该表单有提交
 * 按钮，或该表单只有一个此类字段。
 *
 * 同样只看结构不看文案，理由见本文件开头。
 */
export interface EnterTargetInfo {
  tag: string;
  type?: string;
  hasFormOwner: boolean;
  formAction?: string;
  fieldCount?: number;
  /** 所属表单里是否存在提交按钮。 */
  hasSubmitButton: boolean;
  /** 所属表单里参与隐式提交的文本类字段数量。 */
  textLikeFieldCount: number;
}

/** 参与隐式提交的 input type；空串代表未写 type（按 text 处理）。 */
const IMPLICIT_SUBMIT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'url', 'tel', 'email', 'password',
  'number', 'date', 'month', 'week', 'time', 'datetime-local',
]);

export function decideEnterSubmitIntent(info: EnterTargetInfo): SubmitIntent {
  if (!info.hasFormOwner) return { isSubmit: false };
  // textarea 里 Enter 是换行；只有 input 参与隐式提交。
  if (info.tag.toLowerCase() !== 'input') return { isSubmit: false };
  if (!IMPLICIT_SUBMIT_INPUT_TYPES.has((info.type ?? '').toLowerCase())) return { isSubmit: false };

  const isSubmit = info.hasSubmitButton || info.textLikeFieldCount === 1;
  if (!isSubmit) return { isSubmit: false };
  return { isSubmit: true, formAction: info.formAction, fieldCount: info.fieldCount };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/form-submit.test.ts`
Expected: PASS，新旧用例全通过。

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm compile`（无输出），然后：

```bash
git add lib/agent/form-submit.ts lib/agent/form-submit.test.ts
git commit -m "$(cat <<'EOF'
feat: Enter 键的隐式提交判定

不复用 decideSubmitIntent：那个看被点元素本身是不是提交按钮，这个看 HTML
的隐式提交规则（归属表单的文本类 input + 表单有提交按钮，或表单只有一个
此类字段）。输入形状与判据都不同。

沿用同一原则：只看结构，不看文案。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 3: 注入页面的探测与派发函数

**Files:**
- Modify: `lib/agent/form-dom.ts`（在 `probeClickTarget` 之后追加两个导出函数）
- Test: `lib/agent/press-key.dom.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `KeyDescriptor`（仅 `import type`）、既有的 `FormFieldPathStep`（仅 `import type`）
- Produces:
  - `interface ProbeKeyInput { path?: FormFieldPathStep[]; selector?: string; index?: number; useActiveElement?: boolean }`
  - `interface ProbeKeyOutput { found: boolean; tag: string; type?: string; hasFormOwner: boolean; formAction?: string; fieldCount?: number; hasSubmitButton: boolean; textLikeFieldCount: number }`
  - `function probeKeyTarget(input: ProbeKeyInput): ProbeKeyOutput`
  - `interface PressKeyInput { path?: FormFieldPathStep[]; selector?: string; index?: number; useActiveElement?: boolean; descriptor: KeyDescriptor; submitOnEnter: boolean }`
  - `interface PressKeyOutput { status: 'ok' | 'not_found' | 'no_focus'; target?: string; defaultPrevented: boolean; submitted: boolean }`
  - `function pressKeyInPage(input: PressKeyInput): PressKeyOutput`

**注意：** 两个函数都会被序列化注入，**不得引用模块作用域**——`probeClickTarget` 里的元素解析逻辑必须在每个函数体内各自内联一份，这是本文件既有的、有注释说明的约定（见 `scrollContainerInPage` 上方注释），不是重复代码的疏漏。

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/press-key.dom.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressKeyInPage, probeKeyTarget } from './form-dom';
import { resolveKeyDescriptor } from './key-dispatch';

function enterDescriptor() {
  const resolved = resolveKeyDescriptor('Enter', undefined);
  if (!resolved.ok) throw new Error('Enter 应该是合法按键');
  return resolved.descriptor;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('probeKeyTarget', () => {
  it('报告输入框所属表单的提交按钮与文本字段数', () => {
    document.body.innerHTML = `
      <form action="/search">
        <input id="q" name="q" type="search">
        <input name="tag" type="text">
        <button type="submit">搜索</button>
      </form>`;
    const output = probeKeyTarget({ selector: '#q', index: 0 });
    expect(output.found).toBe(true);
    expect(output.tag).toBe('input');
    expect(output.type).toBe('search');
    expect(output.hasFormOwner).toBe(true);
    expect(output.hasSubmitButton).toBe(true);
    expect(output.textLikeFieldCount).toBe(2);
  });

  it('没有提交按钮的单字段表单如实上报', () => {
    document.body.innerHTML = `<form action="/go"><input id="q" type="text"></form>`;
    const output = probeKeyTarget({ selector: '#q', index: 0 });
    expect(output.hasSubmitButton).toBe(false);
    expect(output.textLikeFieldCount).toBe(1);
  });

  it('表单外的输入框报告 hasFormOwner:false', () => {
    document.body.innerHTML = `<input id="loose" type="text">`;
    const output = probeKeyTarget({ selector: '#loose', index: 0 });
    expect(output.found).toBe(true);
    expect(output.hasFormOwner).toBe(false);
  });

  it('useActiveElement 时探测当前焦点元素', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    document.querySelector<HTMLInputElement>('#q')!.focus();
    const output = probeKeyTarget({ useActiveElement: true });
    expect(output.found).toBe(true);
    expect(output.hasSubmitButton).toBe(true);
  });

  it('找不到目标时返回 found:false', () => {
    const output = probeKeyTarget({ selector: '#missing', index: 0 });
    expect(output.found).toBe(false);
  });
});

describe('pressKeyInPage', () => {
  it('派发 keydown/keypress/keyup，keyCode 正确', () => {
    document.body.innerHTML = `<input id="q" type="text">`;
    const seen: { type: string; key: string; keyCode: number }[] = [];
    const input = document.querySelector<HTMLInputElement>('#q')!;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(type, (event) => {
        const e = event as KeyboardEvent;
        seen.push({ type: e.type, key: e.key, keyCode: e.keyCode });
      });
    }

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: false,
    });

    expect(output.status).toBe('ok');
    expect(seen.map((entry) => entry.type)).toEqual(['keydown', 'keypress', 'keyup']);
    expect(seen[0].key).toBe('Enter');
    expect(seen[0].keyCode).toBe(13);
  });

  it('非 Enter 按键不派发 keypress', () => {
    document.body.innerHTML = `<input id="q" type="text">`;
    const resolved = resolveKeyDescriptor('Escape', undefined);
    if (!resolved.ok) throw new Error('Escape 应该是合法按键');
    const types: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.querySelector('#q')!.addEventListener(type, (event) => types.push(event.type));
    }

    pressKeyInPage({ selector: '#q', index: 0, descriptor: resolved.descriptor, submitOnEnter: false });
    expect(types).toEqual(['keydown', 'keyup']);
  });

  it('submitOnEnter 且未被拦截时调用 requestSubmit', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const form = document.querySelector('form')!;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
    });

    expect(output.submitted).toBe(true);
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  // 页面自己 preventDefault 了 Enter，说明它要自行处理；此时再强行提交就是
  // 覆盖页面意图，会造成双重提交。
  it('keydown 被 preventDefault 时不提交', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const form = document.querySelector('form')!;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;
    document.querySelector('#q')!.addEventListener('keydown', (event) => event.preventDefault());

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: true,
    });

    expect(output.defaultPrevented).toBe(true);
    expect(output.submitted).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('submitOnEnter 为 false 时即使能提交也不提交', () => {
    document.body.innerHTML = `<form action="/s"><input id="q" type="text"><button type="submit">go</button></form>`;
    const requestSubmit = vi.fn();
    document.querySelector('form')!.requestSubmit = requestSubmit;

    const output = pressKeyInPage({
      selector: '#q', index: 0, descriptor: enterDescriptor(), submitOnEnter: false,
    });

    expect(output.submitted).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('没有焦点也没给目标时返回 no_focus', () => {
    document.body.innerHTML = `<div>无焦点</div>`;
    const output = pressKeyInPage({
      useActiveElement: true, descriptor: enterDescriptor(), submitOnEnter: false,
    });
    expect(output.status).toBe('no_focus');
  });

  it('目标不存在时返回 not_found', () => {
    const output = pressKeyInPage({
      selector: '#missing', index: 0, descriptor: enterDescriptor(), submitOnEnter: false,
    });
    expect(output.status).toBe('not_found');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/press-key.dom.test.ts`
Expected: FAIL，`probeKeyTarget` / `pressKeyInPage` 未从 `form-dom` 导出。

- [ ] **Step 3: 写最小实现**

在 `lib/agent/form-dom.ts` 顶部的 type 导入里加上 `KeyDescriptor`：

```ts
import type { KeyDescriptor } from './key-dispatch';
```

在 `probeClickTarget` 之后追加：

```ts
export interface ProbeKeyInput {
  path?: FormFieldPathStep[];
  selector?: string;
  index?: number;
  /** 不给 path/selector 时，探测 document.activeElement。 */
  useActiveElement?: boolean;
}

export interface ProbeKeyOutput {
  found: boolean;
  tag: string;
  type?: string;
  hasFormOwner: boolean;
  formAction?: string;
  fieldCount?: number;
  hasSubmitButton: boolean;
  textLikeFieldCount: number;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定：元素解析与文本类 type 集合都在函数体内
// 内联一份，与 probeClickTarget / scrollContainerInPage 同一既有约定。
export function probeKeyTarget(input: ProbeKeyInput): ProbeKeyOutput {
  const empty: ProbeKeyOutput = {
    found: false, tag: '', hasFormOwner: false, hasSubmitButton: false, textLikeFieldCount: 0,
  };

  let element: Element | null = null;
  if (input.path) {
    let scope: ParentNode | null = document;
    for (const step of input.path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) { element = null; break; }
        scope = shadowRoot;
        continue;
      }
      if (!scope) { element = null; break; }
      element = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`))[step.index] ?? null;
      if (!element) break;
      scope = element;
    }
  } else if (input.selector) {
    element = Array.from(document.querySelectorAll(input.selector))[input.index ?? 0] ?? null;
  } else if (input.useActiveElement) {
    const active = document.activeElement;
    element = active && active !== document.body ? active : null;
  }

  if (!element) return empty;

  const textLike = [
    '', 'text', 'search', 'url', 'tel', 'email', 'password',
    'number', 'date', 'month', 'week', 'time', 'datetime-local',
  ];
  const owner = (element as HTMLInputElement).form ?? null;

  let hasSubmitButton = false;
  let textLikeFieldCount = 0;
  if (owner) {
    for (const member of Array.from(owner.elements)) {
      const tag = member.tagName.toLowerCase();
      const type = (member.getAttribute('type') || '').toLowerCase();
      if ((tag === 'button' && (type === '' || type === 'submit')) ||
          (tag === 'input' && (type === 'submit' || type === 'image'))) {
        hasSubmitButton = true;
      }
      if (tag === 'input' && textLike.indexOf(type) >= 0) textLikeFieldCount += 1;
    }
  }

  return {
    found: true,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute('type') || undefined,
    hasFormOwner: owner != null,
    formAction: owner?.getAttribute('action') ? owner.action : undefined,
    fieldCount: owner ? owner.elements.length : undefined,
    hasSubmitButton,
    textLikeFieldCount,
  };
}

export interface PressKeyInput {
  path?: FormFieldPathStep[];
  selector?: string;
  index?: number;
  useActiveElement?: boolean;
  descriptor: KeyDescriptor;
  /** 由 background 依据探测 + 确认结果决定；页面侧不自行判断要不要提交。 */
  submitOnEnter: boolean;
}

export interface PressKeyOutput {
  status: 'ok' | 'not_found' | 'no_focus';
  /** 目标元素的简短描述，供模型确认自己按在了哪里。 */
  target?: string;
  defaultPrevented: boolean;
  submitted: boolean;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（元素解析逻辑内联，同上）。
export function pressKeyInPage(input: PressKeyInput): PressKeyOutput {
  let element: Element | null = null;
  if (input.path) {
    let scope: ParentNode | null = document;
    for (const step of input.path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) { element = null; break; }
        scope = shadowRoot;
        continue;
      }
      if (!scope) { element = null; break; }
      element = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`))[step.index] ?? null;
      if (!element) break;
      scope = element;
    }
  } else if (input.selector) {
    element = Array.from(document.querySelectorAll(input.selector))[input.index ?? 0] ?? null;
  } else if (input.useActiveElement) {
    const active = document.activeElement;
    element = active && active !== document.body ? active : null;
  }

  if (!element) {
    return {
      status: input.useActiveElement && !input.selector && !input.path ? 'no_focus' : 'not_found',
      defaultPrevented: false,
      submitted: false,
    };
  }

  const d = input.descriptor;
  const init: KeyboardEventInit & { keyCode: number; which: number } = {
    key: d.key,
    code: d.code,
    keyCode: d.keyCode,
    which: d.keyCode,
    ctrlKey: d.ctrlKey,
    shiftKey: d.shiftKey,
    altKey: d.altKey,
    metaKey: d.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  };

  // 派发前先聚焦：很多页面把 keydown 监听挂在元素上，但只有聚焦后才认为该
  // 元素处于"正在输入"状态。已经是焦点时 focus() 无副作用。
  if (typeof (element as HTMLElement).focus === 'function') (element as HTMLElement).focus();

  const keydown = new KeyboardEvent('keydown', init);
  const notPrevented = element.dispatchEvent(keydown);
  const defaultPrevented = !notPrevented;

  if (d.emitsKeypress) element.dispatchEvent(new KeyboardEvent('keypress', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));

  let submitted = false;
  // 页面自己 preventDefault 了，说明它要自行处理这次 Enter；再强行提交就是
  // 覆盖页面意图，可能造成双重提交。
  if (input.submitOnEnter && !defaultPrevented) {
    const owner = (element as HTMLInputElement).form ?? null;
    if (owner && typeof owner.requestSubmit === 'function') {
      owner.requestSubmit();
      submitted = true;
    }
  }

  const id = (element as HTMLElement).id ? `#${(element as HTMLElement).id}` : '';
  return {
    status: 'ok',
    target: `${element.tagName.toLowerCase()}${id}`,
    defaultPrevented,
    submitted,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/press-key.dom.test.ts`
Expected: PASS。

- [ ] **Step 5: 确认既有 DOM 测试没被打破，然后提交**

Run: `pnpm vitest run --project dom && pnpm compile`
Expected: 全部 PASS，`pnpm compile` 无输出。

```bash
git add lib/agent/form-dom.ts lib/agent/press-key.dom.test.ts
git commit -m "$(cat <<'EOF'
feat: 注入页面的按键探测与派发函数

probeKeyTarget 采集 Enter 隐式提交判定所需的结构信息（所属表单有无提交
按钮、文本类字段数）；pressKeyInPage 派发 keydown/keypress/keyup，只有
Enter 派发 keypress，与真实浏览器一致。

keydown 被 preventDefault 时不调 requestSubmit：页面自行处理这次 Enter
时再强行提交会造成双重提交。要不要提交由 background 依据探测与确认结果
决定，页面侧不自行判断。

元素解析逻辑在两个函数里各内联一份——序列化注入禁止引用模块作用域，这是
本文件既有约定，不是疏漏。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 4: 接线（消息类型 + background handler + 工具注册 + 权限与确认闸门）

**Files:**
- Modify: `lib/messaging.ts`
- Modify: `entrypoints/background.ts`
- Modify: `lib/agent/tools.ts`
- Modify: `lib/agent/permissions.ts:39-51`（`AUTO_APPROVE_TOOL_NAMES`）与 `:119`（`SUBMIT_CAPABLE_TOOLS`）
- Modify: `lib/agent/agent.ts:127-141`（`buildSubmitIntentProbePayload`）
- Modify: `lib/agent/action-result-text.ts`
- Test: `lib/agent/press-key-tool.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveKeyDescriptor`；Task 2 的 `decideEnterSubmitIntent`；Task 3 的 `probeKeyTarget` / `pressKeyInPage`
- Produces:
  - `lib/messaging.ts`：`'PRESS_KEY'` 与 `'PROBE_KEY_TARGET'` 加入 `MessageType`；`PressKeyPayload` / `PressKeyResult` / `ProbeKeyTargetPayload`（复用 `ProbeClickTargetResult` 作为结果类型）
  - `lib/agent/action-result-text.ts`：`function describePressKeyResult(result: PressKeyResult): string`
  - `lib/agent/tools.ts`：工具 `browser_press_key`

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/press-key-tool.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabSession } from './tab-session';
import { buildSubmitIntentProbePayload } from './agent';

const sendMessage = vi.fn();
vi.mock('@/lib/messaging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging')>('@/lib/messaging');
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessage(...args) };
});

const { createBrowserTools } = await import('./tools');
const { AUTO_APPROVE_TOOL_NAMES, WRITE_TOOL_NAMES, decideToolPermission } = await import('./permissions');

function getPressKeyTool() {
  const tool = createBrowserTools(createTabSession(1)).find((candidate) => candidate.name === 'browser_press_key');
  if (!tool) throw new Error('browser_press_key 未注册');
  return tool;
}

beforeEach(() => {
  sendMessage.mockReset();
});

describe('browser_press_key 工具', () => {
  it('已注册', () => {
    expect(getPressKeyTool().name).toBe('browser_press_key');
  });

  it('把 fieldId 与按键发给当前操作 tab', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { status: 'ok', key: 'Enter', target: 'input#q', defaultPrevented: false, submitted: true },
    });
    await getPressKeyTool().execute('call-1', { key: 'Enter', fieldId: 'f1' });

    expect(sendMessage).toHaveBeenCalledWith(
      'PRESS_KEY',
      expect.objectContaining({ key: 'Enter', fieldId: 'f1' }),
      1,
    );
  });

  it('非法按键在发消息之前就抛出', async () => {
    await expect(getPressKeyTool().execute('call-1', { key: 'F5' })).rejects.toThrow('F5');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('句柄表失效时提示重新读取表单', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { status: 'not_found', key: 'Enter', defaultPrevented: false, submitted: false, fieldsTableStale: true } });
    await expect(getPressKeyTool().execute('call-1', { key: 'Enter', fieldId: 'f1' })).rejects.toThrow('browser_get_form');
  });

  it('没有焦点时的失败文案要求给出 fieldId', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { status: 'no_focus', key: 'Enter', defaultPrevented: false, submitted: false } });
    await expect(getPressKeyTool().execute('call-1', { key: 'Enter' })).rejects.toThrow('fieldId');
  });

  it('结果文案报告是否被拦截以及是否触发提交', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { status: 'ok', key: 'Enter', target: 'input#q', defaultPrevented: true, submitted: false },
    });
    const output = await getPressKeyTool().execute('call-1', { key: 'Enter', fieldId: 'f1' });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain('Enter');
    expect(text).toContain('preventDefault');
  });
});

describe('browser_press_key 的权限分级', () => {
  it('是写工具，走自动放行', () => {
    expect(AUTO_APPROVE_TOOL_NAMES.has('browser_press_key')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('browser_press_key')).toBe(true);
    expect(decideToolPermission('browser_press_key', { key: 'Enter' })).toEqual({ level: 'auto_allow' });
  });
});

// Enter 能提交表单，因此 press_key 必须进 SUBMIT_CAPABLE_TOOLS——否则它就是
// 绕过"结构化检测到的提交每次都要确认"这条硬边界的后门。
describe('browser_press_key 的提交探测', () => {
  it('探测载荷带上 fieldId 与按键', () => {
    const payload = buildSubmitIntentProbePayload('browser_press_key', { key: 'Enter', fieldId: 'f1' });
    expect(payload).toMatchObject({ submitFieldId: 'f1', fieldIds: ['f1'] });
  });

  it('不给目标时探测走 activeElement', () => {
    const payload = buildSubmitIntentProbePayload('browser_press_key', { key: 'Enter' });
    expect(payload).toMatchObject({ useActiveElement: true });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/press-key-tool.test.ts`
Expected: FAIL，`browser_press_key 未注册`。

- [ ] **Step 3: 加消息类型**

在 `lib/messaging.ts` 的 `MessageType` 联合里，`'SELECT_OPTION'` 之后加：

```ts
  | 'PRESS_KEY'
  | 'PROBE_KEY_TARGET'
```

在 `ProbeClickTargetResult` 之后加：

```ts
/**
 * Enter 隐式提交的结构探测载荷。不复用 PROBE_CLICK_TARGET：那个消息名的语义
 * 是"探测一次点击的目标"，让它兼职按键探测会让名字变成假话。
 */
export interface ProbeKeyTargetPayload {
  fieldId?: string;
  selector?: string;
  index?: number;
  /** 不给 fieldId/selector 时探测 document.activeElement。 */
  useActiveElement?: boolean;
  /** 需要补齐 label 的字段，供确认卡片展示。 */
  fieldIds?: string[];
}

export interface PressKeyPayload {
  key: string;
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  fieldId?: string;
  selector?: string;
  index?: number;
}

export interface PressKeyResult {
  status: 'ok' | 'not_found' | 'no_focus';
  key: string;
  /** 目标元素的简短描述。 */
  target?: string;
  /** 页面是否 preventDefault 了 keydown。 */
  defaultPrevented: boolean;
  /** 是否触发了表单提交。 */
  submitted: boolean;
  detail?: string;
  fieldsTableStale?: boolean;
  newFields?: FormFieldDescriptor[];
}
```

- [ ] **Step 4: 加 background handler**

在 `entrypoints/background.ts` 的 import 区补上 `PressKeyPayload` / `PressKeyResult` / `ProbeKeyTargetPayload` 的 type 导入，并新增：

```ts
import { pressKeyInPage, probeKeyTarget } from '@/lib/agent/form-dom';
import { decideEnterSubmitIntent } from '@/lib/agent/form-submit';
import { resolveKeyDescriptor } from '@/lib/agent/key-dispatch';
```

把 `'PRESS_KEY'` 与 `'PROBE_KEY_TARGET'` 加进 `background.ts:120` 附近那个需要 tabId 的消息类型常量数组。

在 `handleMessage` 的 switch 里，`case 'SELECT_OPTION'` 之后加：

```ts
    case 'PRESS_KEY':
      return pressKey(message.payload as PressKeyPayload, requireTabId(message));

    case 'PROBE_KEY_TARGET':
      return probeEnterSubmitIntent(message.payload as ProbeKeyTargetPayload, requireTabId(message));
```

在 `probeSubmitIntent` 之后新增探测 handler：

```ts
/** Enter 的隐式提交探测。与 probeSubmitIntent 并列而非合并：判据与输入形状都不同。 */
async function probeEnterSubmitIntent(
  payload: ProbeKeyTargetPayload,
  tabId: number,
): Promise<ProbeClickTargetResult> {
  const needsTable = Boolean(payload?.fieldId || payload?.fieldIds?.length);
  const table = needsTable ? await getFormFieldsForTab(tabId) : undefined;

  const fieldLabels = payload?.fieldIds?.map((fieldId) => ({
    fieldId,
    label: table?.fields[fieldId]?.expect.label,
  }));

  const handle = payload?.fieldId ? table?.fields[payload.fieldId] : undefined;
  if (!handle && !payload?.selector && !payload?.useActiveElement) {
    return { isSubmit: false, fieldLabels };
  }

  const probe = await executeInTab(
    tabId,
    {
      path: handle?.path,
      selector: payload?.selector,
      index: payload?.index,
      useActiveElement: payload?.useActiveElement,
    },
    probeKeyTarget,
  );
  if (!probe.found) return { isSubmit: false, fieldLabels };

  return {
    ...decideEnterSubmitIntent({
      tag: probe.tag,
      type: probe.type,
      hasFormOwner: probe.hasFormOwner,
      formAction: probe.formAction,
      fieldCount: probe.fieldCount,
      hasSubmitButton: probe.hasSubmitButton,
      textLikeFieldCount: probe.textLikeFieldCount,
    }),
    fieldLabels,
  };
}
```

在 `selectOption` 之后新增派发 handler：

```ts
async function pressKey(payload: PressKeyPayload, tabId: number): Promise<PressKeyResult> {
  const resolved = resolveKeyDescriptor(payload?.key, payload?.modifiers);
  if (!resolved.ok) {
    return { status: 'not_found', key: String(payload?.key ?? ''), defaultPrevented: false, submitted: false, detail: resolved.error };
  }

  let path: FormFieldPathStep[] | undefined;
  if (payload?.fieldId) {
    const table = await getFormFieldsForTab(tabId);
    const plan = planFieldClick(payload.fieldId, table);
    if (!plan.ok || !plan.submit) {
      return {
        status: 'not_found',
        key: resolved.descriptor.key,
        defaultPrevented: false,
        submitted: false,
        detail:
          plan.reason === 'wrong_kind'
            ? '该 fieldId 是一个可滚动容器，不能对它按键。'
            : '未知的 fieldId，请重新调用 browser_get_form。',
        fieldsTableStale: plan.reason === 'no_table',
      };
    }
    path = plan.submit.path;
  }

  // Enter 是否提交由这里决定，页面侧不自行判断：确认闸门已经在 beforeToolCall
  // 里就同一份探测结果征得用户同意，这里必须用同一份判定，否则会出现
  // "确认时说不提交、执行时却提交了"的错位。
  let submitOnEnter = false;
  if (resolved.descriptor.key === 'Enter') {
    const intent = await probeEnterSubmitIntent(
      {
        fieldId: payload?.fieldId,
        selector: payload?.selector,
        index: payload?.index,
        useActiveElement: !payload?.fieldId && !payload?.selector,
      },
      tabId,
    );
    submitOnEnter = intent.isSubmit;
  }

  const result = await executeInTab(
    tabId,
    {
      path,
      selector: path ? undefined : payload?.selector,
      index: payload?.index,
      useActiveElement: !path && !payload?.selector,
      descriptor: resolved.descriptor,
      submitOnEnter,
    },
    pressKeyInPage,
  );

  return {
    status: result.status,
    key: resolved.descriptor.key,
    target: result.target,
    defaultPrevented: result.defaultPrevented,
    submitted: result.submitted,
    newFields: result.status === 'ok' ? await collectNewFieldsAfterWrite(tabId) : undefined,
  };
}
```

若 `FormFieldPathStep` 尚未在 `background.ts` 导入，从 `@/lib/agent/form-schema` 补上 type 导入。

- [ ] **Step 5: 加结果文案**

在 `lib/agent/action-result-text.ts` 末尾追加（并从 `@/lib/messaging` 补上 `PressKeyResult` 的 type 导入）：

```ts
export function describePressKeyResult(result: PressKeyResult): string {
  const target = result.target ? `在 ${result.target} 上` : '在当前焦点元素上';
  const lines = [`已${target}按下 ${result.key}。`];

  if (result.submitted) {
    lines.push('该按键触发了表单提交。');
  } else if (result.defaultPrevented) {
    // 被拦截不等于失败：页面自行处理了这次按键，很可能已经生效。
    lines.push('页面对这次按键调用了 preventDefault，已按页面自身的处理逻辑生效，未额外触发表单提交。');
  }

  if (result.key === 'Tab') {
    lines.push('注意：焦点不会因此移动——派发的事件不触发浏览器原生行为。要操作另一个元素请直接用它的 fieldId。');
  }
  if (result.key === 'Escape' && !result.defaultPrevented) {
    lines.push('注意：弹层不会因此自动关闭——派发的事件不触发浏览器原生行为。页面没有自己监听 Escape 时，这次按键没有任何效果。');
  }

  return lines.join('\n');
}
```

- [ ] **Step 6: 注册工具**

在 `lib/agent/tools.ts` 补上导入（`describePressKeyResult` 加入既有的 `./action-result-text` 导入列表；`PressKeyPayload` / `PressKeyResult` 加入 `@/lib/messaging` 的 type 导入），在 `tools` 数组的 `makeSelectTool(session),` 之后加：

```ts
    makePressKeyTool(session),
```

在 `makeSelectTool` 之后新增：

```ts
function makePressKeyTool(session: TabSessionController): BrowserAgentTool {
  return {
    name: 'browser_press_key',
    label: 'Press Key',
    description:
      'Press a named key on a page element. Target it with the fieldId from browser_get_form (preferred), a CSS selector, or neither — in which case it goes to the currently focused element. IMPORTANT: the dispatched events do not trigger native browser behaviour, so Tab does NOT move focus and Escape does NOT close dialogs; they only reach listeners the page registered itself. The one exception is Enter, which will submit the form when the page structure implies an implicit submission (that case asks the user for confirmation first). For entering text use browser_type or browser_fill_form instead of pressing keys one at a time.',
    parameters: Type.Object({
      key: Type.Union([
        Type.Literal('Enter'), Type.Literal('Tab'), Type.Literal('Escape'),
        Type.Literal('Backspace'), Type.Literal('Delete'),
        Type.Literal('ArrowUp'), Type.Literal('ArrowDown'),
        Type.Literal('ArrowLeft'), Type.Literal('ArrowRight'),
        Type.Literal('Home'), Type.Literal('End'),
        Type.Literal('PageUp'), Type.Literal('PageDown'),
      ]),
      modifiers: Type.Optional(
        Type.Object({
          ctrl: Type.Optional(Type.Boolean()),
          shift: Type.Optional(Type.Boolean()),
          alt: Type.Optional(Type.Boolean()),
          meta: Type.Optional(Type.Boolean()),
        }),
      ),
      fieldId: Type.Optional(Type.String({ description: 'Field id from browser_get_form. Prefer this over selector.' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector fallback.' })),
      index: Type.Optional(Type.Number({ description: 'Which matched element when using selector, 0-based. Defaults to 0.' })),
    }),
    execute: async (_toolCallId, params) => {
      const payload = params as PressKeyPayload;
      const resolved = resolveKeyDescriptor(payload?.key, payload?.modifiers);
      if (!resolved.ok) throw new Error(resolved.error);

      const response = (await sendMessage<PressKeyPayload, PressKeyResult>('PRESS_KEY', payload, session.currentTabId)) as MessageResponse<PressKeyResult>;
      if (!response.ok || !response.data) throw new Error(response.error ?? '按键失败');
      if (response.data.fieldsTableStale) {
        throw new Error('字段表已失效（页面已变化或已导航），请重新调用 browser_get_form 获取新的 fieldId 后再按键。');
      }
      if (response.data.status === 'no_focus') {
        throw new Error('当前页面没有聚焦的元素，无法确定按键目标。请先用 browser_get_form 取得 fieldId 并显式指定目标。');
      }
      if (response.data.status !== 'ok') {
        throw new Error(response.data.detail ?? '未找到按键目标。');
      }

      const pressed = describePressKeyResult(response.data);
      const appeared = describeNewFields(response.data.newFields ?? []);
      return textResult(appeared ? `${pressed}\n${appeared}` : pressed, response.data as unknown as Record<string, unknown>);
    },
  };
}
```

在 `tools.ts` 顶部补上 `import { resolveKeyDescriptor } from './key-dispatch';`。

- [ ] **Step 7: 加权限分级与提交探测（安全关键）**

在 `lib/agent/permissions.ts` 的 `AUTO_APPROVE_TOOL_NAMES` 里，`'browser_type',` 之后加：

```ts
  'browser_press_key',
```

把 `SUBMIT_CAPABLE_TOOLS`（`permissions.ts:119`）改成：

```ts
// Enter 能触发表单隐式提交，因此 browser_press_key 必须在列——否则它就是绕过
// 「结构化检测到的提交每次都要确认」这条硬边界的后门。
const SUBMIT_CAPABLE_TOOLS = new Set(['browser_click', 'browser_fill_form', 'browser_press_key']);
```

在 `lib/agent/agent.ts` 的 `buildSubmitIntentProbePayload` 里，`browser_click` 分支之前加：

```ts
  if (toolName === 'browser_press_key') {
    const fieldId = typeof record.fieldId === 'string' ? record.fieldId : '';
    // 只有 Enter 可能提交；其它按键直接给一个探不到目标的载荷，探测会返回 isSubmit:false。
    if (record.key !== 'Enter') return { fieldIds: [] };
    if (fieldId) return { submitFieldId: fieldId, fieldIds: [fieldId], useActiveElement: false };
    if (typeof record.selector === 'string' && record.selector) {
      return { selector: record.selector, index: Number(record.index ?? 0), fieldIds: [] };
    }
    return { useActiveElement: true, fieldIds: [] };
  }
```

`buildSubmitIntentProbePayload` 的返回类型改为 `ProbeClickTargetPayload | ProbeKeyTargetPayload`，并在 `agent.ts` 的 `resolveSubmitIntent` 里按工具名选择消息类型：

```ts
        resolveSubmitIntent: async (toolName, args) => {
          const payload = buildSubmitIntentProbePayload(toolName, args);
          const messageType = toolName === 'browser_press_key' ? 'PROBE_KEY_TARGET' : 'PROBE_CLICK_TARGET';
          try {
            const response = (await sendMessage<typeof payload, ProbeClickTargetResult>(
              messageType,
              payload,
              session.currentTabId,
            )) as MessageResponse<ProbeClickTargetResult> | undefined;
            return response?.ok && response.data ? response.data : { isSubmit: false };
          } catch {
            return { isSubmit: false };
          }
        },
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/press-key-tool.test.ts`
Expected: PASS。

- [ ] **Step 9: 全量验证**

Run: `pnpm test && pnpm compile`
Expected: 全部 PASS，`pnpm compile` 无输出。

`lib/final-review.test.ts` 若以精确列表断言工具名单，把 `browser_press_key` 补进去。

- [ ] **Step 10: 提交**

```bash
git add lib/messaging.ts entrypoints/background.ts lib/agent/tools.ts lib/agent/permissions.ts lib/agent/agent.ts lib/agent/action-result-text.ts lib/agent/press-key-tool.test.ts
git commit -m "$(cat <<'EOF'
feat: 注册 browser_press_key 工具

PRESS_KEY / PROBE_KEY_TARGET 消息 + background handler + 工具注册 + 写工具分级。

安全关键：browser_press_key 进 SUBMIT_CAPABLE_TOOLS。Enter 能触发表单隐式
提交，不进这个集合它就是绕过"结构化检测到的提交每次都要确认"的后门。
提交与否由 background 用与确认闸门同一份探测结果决定，避免"确认时说不提交、
执行时却提交了"的错位。

PROBE_KEY_TARGET 独立于 PROBE_CLICK_TARGET：让后者兼职按键探测会让消息名
变成假话，且两者判据不同。

结果文案对 Tab/Escape 明确说明原生行为不触发，避免模型误以为焦点已移动。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

### Task 5: 提示词引导与活动步骤文案

**Files:**
- Modify: `lib/agent/system-prompt.ts:173-196`（`buildToolStrategy`）
- Modify: `lib/agent/activity-description.ts`
- Modify: `lib/i18n/locales/zh.ts`、`lib/i18n/locales/en.ts`
- Test: `lib/agent/system-prompt.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 注册好的 `browser_press_key`
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/system-prompt.test.ts` 追加：

```ts
describe('按键策略引导', () => {
  it('提示词说明 Tab/Escape 不触发原生行为', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('browser_press_key');
    expect(prompt).toContain('Tab');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run lib/agent/system-prompt.test.ts`
Expected: FAIL，提示词不含 `browser_press_key`。

- [ ] **Step 3: 改提示词**

在 `buildToolStrategy` 的 `browser_get_computed_style` 那行之后加：

```ts
    '- 需要按键（回车提交搜索、方向键选择建议项等）：用 browser_press_key。注意它派发的事件不触发浏览器原生行为——Tab 不会移动焦点、Escape 不会关闭弹层，只有页面自己监听了这些按键才有反应；唯一例外是 Enter 会在页面结构表明会提交表单时真的提交（这种情况会先向用户确认）。输入文本一律用 browser_type / browser_fill_form，不要逐字符按键。',
```

- [ ] **Step 4: 加活动步骤文案**

在 `lib/agent/activity-description.ts` 的 `case 'browser_select':` 之后加：

```ts
    case 'browser_press_key':
      return withTarget(
        status,
        'agentActivity.now.pressKey',
        'agentActivity.done.pressKey',
        'agentActivity.failed.pressKey',
        str('key'),
      );
```

`lib/i18n/locales/zh.ts`：

```ts
  'agentActivity.now.pressKey': '正在按下 {target}',
  'agentActivity.done.pressKey': '已按下 {target}',
  'agentActivity.failed.pressKey': '按下 {target} 失败',
```

`lib/i18n/locales/en.ts`：

```ts
  'agentActivity.now.pressKey': 'Pressing {target}',
  'agentActivity.done.pressKey': 'Pressed {target}',
  'agentActivity.failed.pressKey': 'Failed to press {target}',
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run lib/agent/system-prompt.test.ts lib/i18n/i18n.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量验证**

Run: `pnpm test && pnpm compile`
Expected: 全部 PASS。

- [ ] **Step 7: 真机验证**

Run: `pnpm build`，从 `chrome://extensions` 加载 `.output/chrome-mv3`，然后验证三条路径：

1. **搜索框回车。** 打开任意搜索页，让 agent"在搜索框输入 X 并回车"。预期：弹出表单提交确认卡（因为搜索框归属带提交按钮的 form），批准后真的跳转到结果页。
2. **确认卡不可绕过。** 同一任务里点"拒绝"，确认没有发生提交。
3. **Escape 无原生行为。** 在一个原生 `<dialog>` 打开的页面上让 agent 按 Escape，确认弹层没关闭，且结果文案里说明了原因（而不是让模型误以为关掉了）。

- [ ] **Step 8: 提交**

```bash
git add lib/agent/system-prompt.ts lib/agent/activity-description.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts lib/agent/system-prompt.test.ts
git commit -m "$(cat <<'EOF'
feat: browser_press_key 的提示词引导与活动步骤文案

提示词里点名 Tab 不移焦点、Escape 不关弹层——不说清楚，模型会按了 Tab 就
以为焦点已经走了，然后基于错误前提继续操作。补上面板活动步骤的中英文案。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KqEoLQKBDFRD8n8uo4y3Sn
EOF
)"
```

---

## 完成标准

- `pnpm test` 全绿，`pnpm compile` 无输出。
- `decideToolPermission('browser_press_key', ...)` 返回 `auto_allow`，且 `SUBMIT_CAPABLE_TOOLS` 包含它。
- 真机上"搜索框输入并回车"会弹出提交确认卡，拒绝后不提交。
- 真机上 Escape 不关闭原生 `<dialog>`，且结果文案说明了原因。
