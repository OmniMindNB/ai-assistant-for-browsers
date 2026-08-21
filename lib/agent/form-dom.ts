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

  const isFieldTag = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    return (element as HTMLElement).isContentEditable === true;
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
      if (raws.length >= maxFields) {
        truncated = true;
        return;
      }
      const raw = describe(element);
      const hidden = (raw.type || '').toLowerCase() === 'hidden' || !raw.visible;
      if (hidden && !includeHidden) continue;
      raws.push(raw);
    }
  };

  const scope = input.selector ? document.querySelector(input.selector) : document.body;
  if (scope) walk(scope);

  return { url: location.href, raws, forms, unreachable, truncated };
}
