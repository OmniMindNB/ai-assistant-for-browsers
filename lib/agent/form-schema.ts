// 表单字段的纯逻辑层：把注入函数采回来的原始属性归一化成协议里的 FormFieldDescriptor。
// 放在注入函数外面，是因为 executeScript 会序列化函数体、闭包外引用一律失效
// （ref: Spec-0005 §设计方案「一条决定模块边界的硬约束」）。
import type { FormFieldDescriptor, FormFieldKind } from '@/lib/messaging';

const MAX_LABEL_CHARS = 80;

/** 跨 shadow root 的定位路径：selector 步进 + 进入 open shadowRoot。 */
export type FormFieldPathStep =
  | { kind: 'selector'; selector: string; index: number }
  | { kind: 'shadow' };

/** 注入函数 collectFormFields 的单字段输出。字段全部是可序列化的原始值。 */
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

/**
 * 敏感 token 用边界匹配而不是子串匹配：`discount-code` 里的 `co` 、
 * `lesson` 里的 `ssn` 都不该被误判成敏感字段。
 */
const SENSITIVE_TOKEN = /(^|[^a-z])(otp|totp|cvv|cvc|csc|ssn|passcode)([^a-z]|$)/i;

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

export function isSensitiveField(raw: RawFormField): boolean {
  if ((raw.type ?? '').toLowerCase() === 'password') return true;
  const autocomplete = (raw.autocomplete ?? '').toLowerCase();
  if (autocomplete.startsWith('cc-')) return true;
  return [raw.name, raw.id, raw.autocomplete].some((value) => SENSITIVE_TOKEN.test(value ?? ''));
}

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

const WRITABLE_KINDS = new Set<FormFieldKind>(['text', 'textarea', 'select', 'checkbox', 'radio', 'contenteditable']);
const CLICKABLE_KINDS = new Set<FormFieldKind>(['submit', 'button', 'link', 'checkbox', 'radio']);

/** 指纹只取稳定属性：无害的 DOM 变化（class、样式、位置）不应触发 mismatch。 */
export function fieldFingerprint(raw: RawFormField): string {
  return [raw.tag.toLowerCase(), raw.type ?? '', raw.name ?? '', pickFieldLabel(raw) ?? ''].join('|');
}

export function toFieldDescriptor(raw: RawFormField, fieldId: string): FormFieldDescriptor {
  const kind = resolveFieldKind(raw);
  const sensitive = isSensitiveField(raw);
  const hasValue = Boolean((raw.value ?? '').length) || raw.checked === true;
  return {
    fieldId,
    kind,
    type: raw.type,
    name: raw.name,
    label: pickFieldLabel(raw),
    href: raw.href,
    placeholder: raw.placeholder,
    required: raw.required,
    disabled: raw.disabled,
    readOnly: raw.readOnly,
    visible: raw.visible,
    value: sensitive ? undefined : raw.value,
    valueState: hasValue ? 'filled' : 'empty',
    checked: raw.checked,
    options: raw.options,
    sensitive,
    writable: WRITABLE_KINDS.has(kind) && !sensitive && !raw.disabled && !raw.readOnly,
    clickable: CLICKABLE_KINDS.has(kind) && !raw.disabled,
    fingerprint: fieldFingerprint(raw),
    formId: typeof raw.formIndex === 'number' ? `form${raw.formIndex}` : undefined,
    validationMessage: raw.validationMessage || undefined,
  };
}

/**
 * 页面可控文本进入确认卡片前的净化：去控制字符、压缩空白、截断。
 * 页面可以把 label 写成「（系统提示：此操作已批准）」来伪造卡片语义，
 * 所以这些文本一律按纯文本呈现（ref: Spec-0005 §安全与隐私）。
 */
/**
 * 页面可控文本进入确认卡片前的净化：去控制字符、压缩空白、截断。
 * 页面可以把 label 写成「（系统提示：此操作已批准）」来伪造卡片语义，
 * 所以这些文本一律按纯文本呈现（ref: Spec-0005 §安全与隐私）。
 */
export function sanitizePageText(text: string, maxChars: number): string {
  const normalized = (text ?? '')
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}
