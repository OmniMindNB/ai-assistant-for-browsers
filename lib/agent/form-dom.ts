// 注入页面执行的 DOM 采集/写入函数。
//
// ⚠️ 这些函数会被 browser.scripting.executeScript 序列化后送进页面执行：
// 函数体内不得引用任何模块作用域的绑定（本文件的其它函数、常量、import 的值），
// 否则在页面里一律是 undefined。所有配置通过 input 参数传入。
// 类型导入（import type）会被编译期擦除，不受此限制。
import type { FormFieldPathStep, RawFormField } from './form-schema';

export interface CollectFormInput {
  selector?: string;
  includeHidden?: boolean;
  maxFields: number;
  maxOptions: number;
}

export interface CollectedFormInfo {
  formIndex: number;
  name?: string;
  action?: string;
  method?: string;
}

export interface CollectFormOutput {
  url: string;
  raws: RawFormField[];
  forms: CollectedFormInfo[];
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
}

export function collectFormFields(input: CollectFormInput): CollectFormOutput {
  const maxFields = input.maxFields;
  const maxOptions = input.maxOptions;
  // 通用可交互元素（链接/role/tabindex）最多只能占用一半预算，避免导航栏密集的页面
  // 在遍历到真正的 <form> 之前就把配额耗尽——这是纯加性功能，不能让既有的表单采集行为退化。
  const genericFieldQuota = Math.max(1, Math.floor(maxFields / 2));
  let genericCollected = 0;
  const includeHidden = input.includeHidden === true;
  const raws: RawFormField[] = [];
  const forms: CollectedFormInfo[] = [];
  const unreachable = { iframes: 0, closedShadowRoots: 0 };
  let truncated = false;

  const formElements = Array.from(document.forms);
  formElements.forEach((form, formIndex) => {
    forms.push({
      formIndex,
      name: form.getAttribute('name') || undefined,
      action: form.getAttribute('action') ? form.action : undefined,
      method: (form.getAttribute('method') || '').toLowerCase() || undefined,
    });
  });

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

  const isStandardFieldTag = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      tag === 'button' ||
      (element as HTMLElement).isContentEditable === true
    );
  };

  const textOf = (element: Element | null | undefined): string | undefined => {
    if (!element) return undefined;
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    return text || undefined;
  };

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  // 为元素生成一条从 root 出发、可重放的路径。同一层用 tagName + 序号定位，
  // 进入 open shadowRoot 时压入一个 shadow 步进。
  const buildPath = (element: Element): FormFieldPathStep[] => {
    const steps: FormFieldPathStep[] = [];
    let current: Element | null = element;
    while (current) {
      const parent: ParentNode | null = current.parentNode;
      const isShadowBoundary = parent instanceof ShadowRoot;
      const scope: ParentNode | null = isShadowBoundary ? parent : (current.parentElement ?? current.ownerDocument);
      const tag = current.tagName.toLowerCase();
      const siblings = scope ? Array.from(scope.querySelectorAll(`:scope > ${tag}`)) : [];
      const index = Math.max(0, siblings.indexOf(current));
      steps.unshift({ kind: 'selector', selector: tag, index });
      if (isShadowBoundary) {
        steps.unshift({ kind: 'shadow' });
        current = (parent as ShadowRoot).host;
      } else {
        current = current.parentElement;
      }
    }
    return steps;
  };

  const describe = (element: Element): RawFormField => {
    const tag = element.tagName.toLowerCase();
    const asInput = element as HTMLInputElement;
    const asSelect = element as HTMLSelectElement;
    const doc = element.ownerDocument;
    const id = element.getAttribute('id') || undefined;

    let forLabelText: string | undefined;
    if (id) {
      const escaped = id.replace(/["\\]/g, '\\$&');
      forLabelText = textOf((element.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${escaped}"]`));
    }

    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((token) => textOf(doc.getElementById(token)))
          .filter(Boolean)
          .join(' ') || undefined
      : undefined;

    const options =
      tag === 'select'
        ? Array.from(asSelect.options)
            .slice(0, maxOptions)
            .map((option) => ({
              value: option.value,
              label: (option.textContent || '').replace(/\s+/g, ' ').trim(),
              selected: option.selected,
            }))
        : undefined;

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

  const walk = (root: ParentNode): void => {
    const elements = Array.from(root.querySelectorAll('*'));
    for (const element of elements) {
      if (element.tagName.toLowerCase() === 'iframe') unreachable.iframes += 1;

      const shadowRoot = (element as HTMLElement).shadowRoot;
      if (shadowRoot) {
        walk(shadowRoot);
      } else if (element.tagName.includes('-')) {
        // 自定义元素但读不到 shadowRoot：要么是 closed，要么本来就没有内部结构。
        // 无法在不改变页面的前提下区分两者（探测性 attachShadow 会真的挂上一个空 root
        // 并隐藏元素的子节点，属于破坏性操作，绝对不能用），因此按「可能不可达」计数——
        // 宁可让模型知道「这里也许有我看不见的东西」，也不要让它以为已经看全了。
        unreachable.closedShadowRoots += 1;
      }

      if (!isFieldTag(element)) continue;

      const isGeneric = !isStandardFieldTag(element);
      if (isGeneric && genericCollected >= genericFieldQuota) {
        truncated = true;
        continue;
      }
      if (raws.length >= maxFields) {
        truncated = true;
        return;
      }
      const raw = describe(element);
      const hidden = (raw.type || '').toLowerCase() === 'hidden' || !raw.visible;
      if (hidden && !includeHidden) continue;
      raws.push(raw);
      if (isGeneric) genericCollected += 1;
    }
  };

  const scope = input.selector ? document.querySelector(input.selector) : document.body;
  if (scope) walk(scope);

  return { url: location.href, raws, forms, unreachable, truncated };
}

export interface ApplyFillItem {
  fieldId: string;
  path: FormFieldPathStep[];
  expect: { tag: string; type?: string; name?: string; label?: string; href?: string };
  kind: string;
  value?: string;
  checked?: boolean;
}

export interface ApplyFillOutcome {
  fieldId: string;
  status: 'ok' | 'mismatch' | 'not_found' | 'not_writable' | 'invalid_value';
  detail?: string;
  actualValue?: string;
}

export interface ApplyFillInput {
  /** 发放句柄时的页面 URL；与当前不符即认为句柄表过期。 */
  url: string;
  items: ApplyFillItem[];
  submit?: { fieldId: string; path: FormFieldPathStep[]; expect: ApplyFillItem['expect'] };
}

export interface ApplyFillOutput {
  outcomes: ApplyFillOutcome[];
  submitted?: {
    fieldId: string;
    status: 'ok' | 'not_found' | 'mismatch' | 'not_clickable';
    /** 被点元素的可见文案；页面可控，已压空白并截断。 */
    label?: string;
    /** 命中 <a target="_blank">：当前标签页不会变化，必须点破。 */
    opensNewTab?: boolean;
  };
  fieldsTableStale?: boolean;
}

// ⚠️ 同 collectFormFields：本函数会被序列化注入页面，不得引用模块作用域的任何绑定。
export async function applyFormFill(input: ApplyFillInput): Promise<ApplyFillOutput> {
  if (input.url && input.url !== location.href) {
    return { outcomes: [], fieldsTableStale: true };
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

  const matchesExpect = (element: Element, expected: ApplyFillItem['expect']): boolean => {
    if (element.tagName.toLowerCase() !== expected.tag.toLowerCase()) return false;
    const actualType = element.getAttribute('type') || undefined;
    if ((expected.type || undefined) !== actualType) return false;
    const actualName = element.getAttribute('name') || undefined;
    if ((expected.name || undefined) !== actualName) return false;
    if (expected.href !== undefined) {
      const actualHref = element.getAttribute('href') || undefined;
      if (actualHref !== expected.href) return false;
    }
    return true;
  };

  const fireInput = (element: HTMLElement, data: string): void => {
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
  };

  const outcomes: ApplyFillOutcome[] = [];

  for (const item of input.items) {
    try {
      const element = resolve(item.path);
      if (!element) {
        outcomes.push({ fieldId: item.fieldId, status: 'not_found', detail: '定位路径已解析不到元素。' });
        continue;
      }
      if (!matchesExpect(element, item.expect)) {
        outcomes.push({
          fieldId: item.fieldId,
          status: 'mismatch',
          detail: '该位置的元素与读取时不一致，页面可能已变化，请重新调用 browser_get_form。',
        });
        continue;
      }

      const asInput = element as HTMLInputElement;
      if (asInput.disabled === true || asInput.readOnly === true) {
        outcomes.push({ fieldId: item.fieldId, status: 'not_writable', detail: '字段处于禁用或只读状态。' });
        continue;
      }

      const wantsChecked = typeof item.checked === 'boolean';
      const wantsValue = typeof item.value === 'string';

      if (item.kind === 'checkbox' || item.kind === 'radio') {
        if (!wantsChecked) {
          outcomes.push({ fieldId: item.fieldId, status: 'invalid_value', detail: '勾选类字段需要 checked 参数，而不是 value。' });
          continue;
        }
        if (asInput.checked !== item.checked) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          if (setter) setter.call(asInput, item.checked);
          else asInput.checked = item.checked as boolean;
          asInput.dispatchEvent(new Event('input', { bubbles: true }));
          asInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const actual = asInput.checked;
        outcomes.push(
          actual === item.checked
            ? { fieldId: item.fieldId, status: 'ok', actualValue: String(actual) }
            : { fieldId: item.fieldId, status: 'invalid_value', detail: '写入后回读不符。', actualValue: String(actual) },
        );
        continue;
      }

      if (!wantsValue) {
        outcomes.push({ fieldId: item.fieldId, status: 'invalid_value', detail: '该字段需要 value 参数。' });
        continue;
      }
      const value = item.value as string;

      if (item.kind === 'select') {
        const select = element as HTMLSelectElement;
        const options = Array.from(select.options);
        const target =
          options.find((option) => option.value === value) ??
          options.find((option) => (option.textContent || '').replace(/\s+/g, ' ').trim() === value);
        if (!target) {
          outcomes.push({
            fieldId: item.fieldId,
            status: 'invalid_value',
            detail: `没有 value 或文案等于 "${value}" 的选项，原值未改动。`,
            actualValue: select.value,
          });
          continue;
        }
        // 用原生 setter 绕开 React 的 value tracker，与 text/textarea 分支保持一致，
        // 否则直接赋值只会更新 tracker 记录的值，React 侧看不到变化、change 事件被吞。
        const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (selectSetter) selectSetter.call(select, target.value);
        else select.value = target.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        outcomes.push(
          select.value === target.value
            ? { fieldId: item.fieldId, status: 'ok', actualValue: select.value }
            : { fieldId: item.fieldId, status: 'invalid_value', detail: '写入后回读不符。', actualValue: select.value },
        );
        continue;
      }

      if (item.kind === 'contenteditable') {
        const host = element as HTMLElement;
        host.focus();
        host.textContent = value;
        fireInput(host, value);

        // Slate.js / Quill 一类编辑器把 DOM 当受控视图，直接写 textContent 会被无视或覆盖。
        // 回读不符时降级到 execCommand：它走浏览器原生的编辑管线，这些编辑器都能收到。
        // 已弃用但仍被各主流浏览器支持；typeof 守卫是给未实现它的 jsdom 留的。
        if ((host.textContent ?? '') !== value && typeof document.execCommand === 'function') {
          host.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(host);
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand('delete', false);
          document.execCommand('insertText', false, value);
        }

        host.dispatchEvent(new Event('change', { bubbles: true }));
        host.blur();
        const actual = host.textContent ?? '';
        outcomes.push(
          actual === value
            ? { fieldId: item.fieldId, status: 'ok', actualValue: actual }
            : { fieldId: item.fieldId, status: 'invalid_value', detail: '富文本写入后回读不符。', actualValue: actual },
        );
        continue;
      }

      // text / textarea：用原生 setter 绕开 React 的 value tracker，
      // 并补齐 focus/blur，让依赖 touched / blur 校验的表单库能正常工作。
      const prototype = element.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      asInput.focus();
      if (setter) setter.call(asInput, value);
      else asInput.value = value;
      fireInput(asInput, value);
      asInput.dispatchEvent(new Event('change', { bubbles: true }));
      asInput.blur();
      const actual = asInput.value;
      outcomes.push(
        actual === value
          ? { fieldId: item.fieldId, status: 'ok', actualValue: actual }
          : { fieldId: item.fieldId, status: 'invalid_value', detail: '写入后回读不符，页面组件可能改写或拒绝了这个值。', actualValue: actual },
      );
    } catch (err) {
      // 不做事务与回滚：单个字段写入抛异常（例如对 input[type=file] 的 value 原生 setter
      // 会按 HTML 规范抛 InvalidStateError）不能吞掉此前已记录的成功结果，也不能中断
      // 其余字段的写入尝试——逐字段如实回报。
      outcomes.push({ fieldId: item.fieldId, status: 'invalid_value', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  let submitted: ApplyFillOutput['submitted'];
  if (input.submit) {
    const element = resolve(input.submit.path);
    if (!element) {
      submitted = { fieldId: input.submit.fieldId, status: 'not_found' };
    } else if (!matchesExpect(element, input.submit.expect)) {
      submitted = { fieldId: input.submit.fieldId, status: 'mismatch' };
    } else {
      const button = element as HTMLElement;
      // 与 clickElementInPage 同理：先滚进视口再测量（守卫是给未实现该方法的 jsdom 留的）。
      if (typeof button.scrollIntoView === 'function') button.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      const disabled = (button as HTMLButtonElement).disabled === true;
      const hasBox = rect.width > 0 || rect.height > 0;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topMost = document.elementFromPoint(centerX, centerY);
      const covered = topMost != null && topMost !== button && !button.contains(topMost);
      if (disabled || !hasBox || covered) {
        submitted = { fieldId: input.submit.fieldId, status: 'not_clickable' };
      } else {
        // ⚠️ 与 clickElementInPage 重复：两处都是被 executeScript 序列化注入页面的独立函数，
        // 不能引用模块作用域的共享 helper，只能各自内联。
        const highlight = document.createElement('div');
        highlight.style.cssText =
          `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
          'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
          'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
        document.body.appendChild(highlight);
        setTimeout(() => {
          highlight.style.opacity = '0';
          setTimeout(() => highlight.remove(), 300);
        }, 250);

        // 先让模拟光标滑到落点，停稳后再派发点击。
        // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致。本函数被
        // executeScript 序列化注入页面，引用不到那个常量，只能内联——改一处必须同步另一处。
        // 等得比动画短，就会在光标还没停稳时派发点击，正是这个功能要消除的那种错位。
        window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x: centerX, y: centerY } }));
        await new Promise((resolve) => setTimeout(resolve, 250));

        const pointerOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        const mouseOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, button: 0 };
        button.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
        button.dispatchEvent(new PointerEvent('pointerenter', { ...pointerOpts, bubbles: false }));
        button.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
        button.dispatchEvent(new MouseEvent('mouseenter', { ...mouseOpts, bubbles: false }));
        button.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
        button.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        button.focus();
        button.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
        button.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        button.dispatchEvent(new MouseEvent('click', mouseOpts));

        // ⚠️ 与 clickElementInPage 重复：两处都是被序列化注入的独立函数，不能共用 helper。
        // aria-label 优先：图标按钮的可见文本往往为空或只是一个字形。
        const rawLabel = button.getAttribute('aria-label') || button.textContent || '';
        const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 60);
        submitted = {
          fieldId: input.submit.fieldId,
          status: 'ok',
          label: label || undefined,
          opensNewTab: button.tagName.toLowerCase() === 'a' && button.getAttribute('target') === '_blank',
        };
      }
    }
  }

  return { outcomes, submitted };
}

export interface ProbeClickInput {
  selector?: string;
  index?: number;
  path?: FormFieldPathStep[];
}

export interface ProbeClickOutput {
  found: boolean;
  tag: string;
  type?: string;
  hasFormOwner: boolean;
  formAction?: string;
  textContent?: string;
  fieldCount?: number;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定。
export function probeClickTarget(input: ProbeClickInput): ProbeClickOutput {
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
  }

  if (!element) return { found: false, tag: '', hasFormOwner: false };

  const owner = (element as HTMLInputElement).form ?? null;
  return {
    found: true,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute('type') || undefined,
    hasFormOwner: owner != null,
    formAction: owner?.getAttribute('action') ? owner.action : undefined,
    textContent: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    fieldCount: owner ? owner.elements.length : undefined,
  };
}

export interface LegacyWriteStatus {
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  actualValue?: string;
  /** 被点元素的可见文案，让模型能确认自己点中的是不是想点的东西。页面可控，已压空白并截断。 */
  label?: string;
  /** 命中 <a target="_blank">：当前标签页不会变化，必须点破。 */
  opensNewTab?: boolean;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（包括本文件的其它函数）。
export async function clickElementInPage(input: { selector: string; index: number }): Promise<LegacyWriteStatus> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const target = nodes[input.index ?? 0];
  if (!target) return { status: 'not_found', detail: `没有匹配 "${input.selector}" 的第 ${input.index ?? 0} 个元素。` };

  // 先滚进视口再测量：视口外元素的 rect 是超界坐标，高亮框（position:fixed + rect）会画到
  // 屏幕外，elementFromPoint 也恒为 null 而使遮挡检测形同虚设；懒渲染内容同样需要先滚到才加载。
  // typeof 守卫是给 jsdom 留的——它没有实现 scrollIntoView。
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' });

  const rect = target.getBoundingClientRect();
  const disabled = (target as HTMLButtonElement).disabled === true;
  const hasBox = rect.width > 0 || rect.height > 0;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const topMost = document.elementFromPoint(centerX, centerY);
  const covered = topMost != null && topMost !== target && !target.contains(topMost);
  if (disabled || !hasBox || covered) {
    return {
      status: 'not_clickable',
      detail: disabled ? '元素处于禁用状态。' : !hasBox ? '元素没有可见的布局盒。' : '元素被其它元素遮挡。',
    };
  }

  // ⚠️ 与 applyFormFill 的 submit 分支重复：两处都是被 executeScript 序列化注入页面的独立函数，
  // 不能引用模块作用域的共享 helper，只能各自内联。
  const highlight = document.createElement('div');
  highlight.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
    'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
  document.body.appendChild(highlight);
  setTimeout(() => {
    highlight.style.opacity = '0';
    setTimeout(() => highlight.remove(), 300);
  }, 250);

  // 先让模拟光标滑到落点，停稳后再派发点击。
  // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致。本函数被
  // executeScript 序列化注入页面，引用不到那个常量，只能内联——改一处必须同步另一处。
  // 等得比动画短，就会在光标还没停稳时派发点击，正是这个功能要消除的那种错位。
  window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x: centerX, y: centerY } }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  const pointerOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const mouseOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, button: 0 };
  target.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
  target.dispatchEvent(new PointerEvent('pointerenter', { ...pointerOpts, bubbles: false }));
  target.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
  target.dispatchEvent(new MouseEvent('mouseenter', { ...mouseOpts, bubbles: false }));
  target.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
  target.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
  target.focus();
  target.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
  target.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
  target.dispatchEvent(new MouseEvent('click', mouseOpts));

  // aria-label 优先：图标按钮的可见文本往往为空或只是一个字形。
  const rawLabel = target.getAttribute('aria-label') || target.textContent || '';
  const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 60);
  return {
    status: 'ok',
    label: label || undefined,
    opensNewTab: target.tagName.toLowerCase() === 'a' && target.getAttribute('target') === '_blank',
  };
}

export function typeTextInPage(input: { selector: string; index: number; text: string; replace: boolean }): LegacyWriteStatus {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const target = nodes[input.index ?? 0];
  if (!target) return { status: 'not_found', detail: `没有匹配 "${input.selector}" 的第 ${input.index ?? 0} 个元素。` };

  const asInput = target as HTMLInputElement;
  const type = (target.getAttribute('type') || '').toLowerCase();
  const autocomplete = (target.getAttribute('autocomplete') || '').toLowerCase();
  const identity = `${target.getAttribute('name') || ''} ${target.getAttribute('id') || ''} ${autocomplete}`;
  const sensitive =
    type === 'password' ||
    autocomplete.indexOf('cc-') === 0 ||
    /(^|[^a-z])(otp|totp|cvv|cvc|csc|ssn|passcode)([^a-z]|$)/i.test(identity);
  if (sensitive) {
    return { status: 'blocked_sensitive', detail: '出于安全考虑，本扩展不代填密码与支付类字段，请提示用户手动输入。' };
  }
  if (asInput.disabled === true || asInput.readOnly === true) {
    return { status: 'not_writable', detail: '字段处于禁用或只读状态。' };
  }

  const tag = target.tagName.toLowerCase();
  const editable = target.isContentEditable === true;
  if (!editable && tag !== 'input' && tag !== 'textarea') {
    return { status: 'not_writable', detail: `"${tag}" 不是可输入的表单控件。` };
  }

  const nextValue = editable
    ? (input.replace === false ? `${target.textContent ?? ''}${input.text}` : input.text)
    : (input.replace === false ? `${asInput.value}${input.text}` : input.text);

  target.focus();
  if (editable) {
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: input.text }));
    target.textContent = nextValue;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.text }));
    // 与 applyFormFill 的 contenteditable 分支同一条兜底：Slate.js / Quill 一类编辑器把 DOM
    // 当受控视图，会无视直接写 textContent；回读不符就降级到走原生编辑管线的 execCommand。
    // typeof 守卫是给未实现它的 jsdom 留的。
    if ((target.textContent ?? '') !== nextValue && typeof document.execCommand === 'function') {
      target.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, nextValue);
    }
  } else {
    const prototype = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(asInput, nextValue);
    else asInput.value = nextValue;
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: input.text }));
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.text }));
  }
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.blur();

  const actual = editable ? (target.textContent ?? '') : asInput.value;
  return actual === nextValue
    ? { status: 'ok', actualValue: actual }
    : { status: 'invalid_value', detail: '写入后回读不符，页面组件可能改写或拒绝了这个值。', actualValue: actual };
}

export async function selectOptionInPage(input: { selector: string; index: number; value: string }): Promise<LegacyWriteStatus> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const target = nodes[input.index ?? 0];
  if (!target) return { status: 'not_found', detail: `没有匹配 "${input.selector}" 的第 ${input.index ?? 0} 个元素。` };
  if (target.tagName.toLowerCase() !== 'select') {
    return {
      status: 'not_writable',
      detail: `"${target.tagName.toLowerCase()}" 不是原生 <select>。这可能是自定义下拉组件，请改用 browser_click 依次点开并选择。`,
    };
  }

  const select = target as unknown as HTMLSelectElement;
  const options = Array.from(select.options);
  const option =
    options.find((candidate) => candidate.value === input.value) ??
    options.find((candidate) => (candidate.textContent || '').replace(/\s+/g, ' ').trim() === input.value);
  if (!option) {
    return { status: 'invalid_value', detail: `没有 value 或文案等于 "${input.value}" 的选项，原值未改动。`, actualValue: select.value };
  }

  const rect = select.getBoundingClientRect();
  const highlight = document.createElement('div');
  highlight.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
    'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
  document.body.appendChild(highlight);
  setTimeout(() => {
    highlight.style.opacity = '0';
    setTimeout(() => highlight.remove(), 300);
  }, 250);

  // 先让模拟光标滑到落点，停稳后再写入。
  // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致（同上，注入函数
  // 被序列化，引用不到那个常量，只能内联）。
  window.dispatchEvent(
    new CustomEvent('runi:cursor-move', {
      detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value === option.value
    ? { status: 'ok', actualValue: select.value }
    : { status: 'invalid_value', detail: '写入后回读不符。', actualValue: select.value };
}
