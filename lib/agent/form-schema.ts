// 表单字段的纯逻辑层：把注入函数采回来的原始属性归一化成协议里的 FormFieldDescriptor。
// 放在注入函数外面，是因为 executeScript 会序列化函数体、闭包外引用一律失效
// （ref: Spec-0005 §设计方案「一条决定模块边界的硬约束」）。
import type { FormFieldDescriptor, FormFieldKind, ScrollableContainerDescriptor } from '@/lib/messaging';
// 唯一的「这是子帧句柄吗」判据。fill-form-request 在运行时是一个叶子模块（它自己只有
// import type），从这里引用它不会形成循环依赖。
import { isChildFrameHandle } from './fill-form-request';

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
  /** 该元素是仅靠 computed cursor 判定命中的（廉价的标签/role/tabindex 检查全部落空）。 */
  byCursor?: true;
  /** 排在这个字段之前、上一个字段之后出现的正文；未净化（见 form-dom.ts 的 collectFormFields）。 */
  precedingText?: string;
}

/** 注入函数 collectFormFields 的单个可滚动容器输出。字段全部是可序列化的原始值。 */
export interface RawScrollableContainer {
  path: FormFieldPathStep[];
  tag: string;
  /** 未净化，只做过空白压缩+截断（与 elementText/label 同款内联写法，不能从注入函数调用 form-schema.ts）。 */
  label?: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
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

export function toFieldDescriptor(
  raw: RawFormField & { frameOrigin?: string; frameId?: number },
  fieldId: string,
): FormFieldDescriptor {
  const kind = resolveFieldKind(raw);
  const sensitive = isSensitiveField(raw);
  const hasValue = Boolean((raw.value ?? '').length) || raw.checked === true;
  const label = pickFieldLabel(raw);
  // precedingText 靠尾部截断（见 sanitizeFieldText 的 keepEnd）；这里再排除它和 label 完全相同的
  // 情况——<label for>/祖先 <label> 场景下，文本采集会把同一段 label 文案也当正文收进来，
  // 那对模型是纯重复，不是新信息（ref: 2026-08-26 review Fix 2，仅做精确匹配，不做后缀匹配）。
  const sanitizedPrecedingText = sanitizeFieldText(raw.precedingText, 'tail').text;
  const precedingText = sanitizedPrecedingText && sanitizedPrecedingText !== label ? sanitizedPrecedingText : undefined;
  return {
    fieldId,
    kind,
    type: raw.type,
    name: raw.name,
    label,
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
    // formIndex 是「本文档内第几个 <form>」，每个帧各自从 0 数起：不加区分地渲染成
    // form0/form1，子帧字段的 formId 就会和主框架的 formId 撞名。撞名的后果是
    // background 的 getForm() 在给主框架表单算 submitFieldIds 时（按 formId 相等过滤），
    // 可能把某个子帧的提交按钮算进主框架表单里，模型看到的表单分组因此失真
    // （ref: 2026-09-05 final review Important #2）。子帧的 formId 加 frameId 前缀即可，
    // 顶层 forms[] 本来就只收主框架的表单，子帧 formId 不需要能被反查。
    formId:
      typeof raw.formIndex !== 'number'
        ? undefined
        : isChildFrameHandle(raw)
          ? `f${raw.frameId}:form${raw.formIndex}`
          : `form${raw.formIndex}`,
    validationMessage: raw.validationMessage || undefined,
    precedingText,
    byCursor: raw.byCursor,
    frameOrigin: raw.frameOrigin,
  };
}

/** 把原始滚动指标折算成四向剩余距离——模型不用自己拿 scrollHeight-clientHeight-scrollTop
 *  再心算一遍（ref: 设计文档 §3.8，对标 alibaba/page-agent 的 data-scrollable 属性）。
 *  命名与 ScrollPageResult/ScrollContainerOutput 的 pixelsAbove/pixelsBelow 保持一致。 */
export function toScrollableContainerDescriptor(
  raw: RawScrollableContainer,
  fieldId: string,
): ScrollableContainerDescriptor {
  const maxScrollTop = Math.max(0, raw.scrollHeight - raw.clientHeight);
  const maxScrollLeft = Math.max(0, raw.scrollWidth - raw.clientWidth);
  return {
    fieldId,
    tag: raw.tag,
    label: raw.label,
    pixelsAbove: raw.scrollTop,
    pixelsBelow: Math.max(0, maxScrollTop - raw.scrollTop),
    pixelsLeft: raw.scrollLeft,
    pixelsRight: Math.max(0, maxScrollLeft - raw.scrollLeft),
  };
}

/**
 * 找出「上一步之后新出现」的字段：填完输入框弹出的下拉建议、点开的菜单项都靠它识别
 * （对标 alibaba/page-agent 的 *[n] 新元素标记）。
 *
 * 按指纹的**多重集**比较而不是 path：一页上五个一模一样的「删除」按钮共享同一个指纹，
 * 只看「指纹在不在」会全部漏判；而 path 里的 :nth-child 在列表顶部插入一条时会整体位移，
 * 又会把所有元素误判成新增。按文档序先到先得地消耗旧计数，多出来的（即文档序靠后的）算新增。
 *
 * previousFingerprints 为 undefined 表示首次读取该页面——此时「全都是新的」没有信息量，
 * 一律不标记。
 */
export function findNewFieldIds(
  fields: FormFieldDescriptor[],
  previousFingerprints: string[] | undefined,
): Set<string> {
  const newIds = new Set<string>();
  if (!previousFingerprints) return newIds;

  const budget = new Map<string, number>();
  for (const fingerprint of previousFingerprints) {
    budget.set(fingerprint, (budget.get(fingerprint) ?? 0) + 1);
  }

  for (const field of fields) {
    const remaining = budget.get(field.fingerprint) ?? 0;
    if (remaining > 0) budget.set(field.fingerprint, remaining - 1);
    else newIds.add(field.fieldId);
  }

  return newIds;
}

// sanitizePageText 和 sanitizeFieldText 共用这一个归一化实现；改动它时要同时确认两个调用方的需求都还满足。
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
 *
 * keepEnd 决定截断时保留哪一端：trailingText 的缓冲区离字段最近的内容在头部，头部截断
 * （保留头、省略号在尾）是对的；但 precedingText 的缓冲区是「自上一个字段以来的全部正文」，
 * 离当前字段最近、最相关的提示文字恰恰在尾部——头部截断会把这段最有信息量的文字砍掉，
 * 留下的反而是较远、较不相关的内容，所以 precedingText 必须保留尾部
 * （ref: 2026-08-26 review Fix 1）。
 */
export function sanitizeFieldText(
  text: string | undefined,
  keepEnd: 'head' | 'tail' = 'head',
): { text?: string; truncated: boolean } {
  if (!text) return { truncated: false };
  const normalized = normalizePageText(text);
  if (!normalized) return { truncated: false };
  const truncated = normalized.length > MAX_FIELD_TEXT_CHARS;
  if (!truncated) return { text: normalized, truncated: false };
  return keepEnd === 'tail'
    ? { text: `…${normalized.slice(-MAX_FIELD_TEXT_CHARS)}`, truncated: true }
    : { text: `${normalized.slice(0, MAX_FIELD_TEXT_CHARS)}…`, truncated: true };
}
