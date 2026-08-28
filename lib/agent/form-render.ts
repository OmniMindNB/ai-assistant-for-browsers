// GetFormResult 的「面向模型」渲染层。
//
// 为什么不直接 JSON.stringify：FormFieldDescriptor 有 20+ 个键，其中 fingerprint 是给写入
// 校验层用的哈希（snapshotFields 存句柄表、findNewFieldIds 比对新元素），模型永远用不到；
// writable/clickable/valueState 大多能从 kind 推出来。pretty-print 一个几十字段的后台表单
// 要烧掉数千 token，既抬高每轮成本，也提前吃掉 agent.ts 的 MAX_CONTEXT_MESSAGES 窗口
// （ref: docs/superpowers/specs/2026-08-28-form-recall-and-token-budget-design.md §3）。
//
// 核心规则一句话：等于默认值的项不输出。
import type { FormFieldDescriptor, FormFieldKind } from '@/lib/messaging';

const MAX_VALUE_CHARS = 80;
const MAX_HREF_CHARS = 100;
const MAX_LISTED_OPTIONS = 8;

/** 能承载「值」的 kind。其余（submit/button/link 等）标 empty 是纯噪音，不输出 valueState。 */
const VALUE_BEARING_KINDS = new Set<FormFieldKind>([
  'text',
  'textarea',
  'select',
  'contenteditable',
  'file',
]);

const TOGGLE_KINDS = new Set<FormFieldKind>(['checkbox', 'radio']);

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function renderOptions(options: { value: string; label: string; selected: boolean }[]): string {
  const listed = options.slice(0, MAX_LISTED_OPTIONS).map((option) => option.label || option.value);
  const suffix = options.length > MAX_LISTED_OPTIONS ? `|…(共 ${options.length} 个)` : '';
  return `options=${listed.join('|')}${suffix}`;
}

export function renderFieldLine(
  field: FormFieldDescriptor,
  options: { showFormId: boolean },
): string {
  const head = field.label
    ? `${field.fieldId} ${field.kind}「${field.label}」`
    : `${field.fieldId} ${field.kind}`;

  const attrs: string[] = [];

  // name 只在没有 label 时才有信息量——有 label 时它只是同一个东西的另一种叫法。
  if (!field.label && field.name) attrs.push(`name=${field.name}`);
  if (field.type && field.type !== field.kind) attrs.push(`type=${field.type}`);

  const hasValue = field.value !== undefined && field.value !== '';
  if (TOGGLE_KINDS.has(field.kind)) {
    // 勾选态已经计入 toFieldDescriptor 的 hasValue，再输出 value/valueState 是重复。
    attrs.push(field.checked ? 'checked' : 'unchecked');
  } else if (hasValue) {
    attrs.push(`value="${clip(field.value as string, MAX_VALUE_CHARS)}"`);
  } else if (VALUE_BEARING_KINDS.has(field.kind)) {
    attrs.push(field.valueState);
  }

  if (field.options && field.options.length > 0) attrs.push(renderOptions(field.options));
  if (field.href) attrs.push(`href=${clip(field.href, MAX_HREF_CHARS)}`);
  if (field.required) attrs.push('required');
  if (field.disabled) attrs.push('disabled');
  if (field.readOnly) attrs.push('readonly');
  if (!field.visible) attrs.push('hidden');
  if (field.sensitive) attrs.push('sensitive');
  if (field.isNew) attrs.push('new');
  if (field.validationMessage) attrs.push(`invalid="${field.validationMessage}"`);
  if (options.showFormId && field.formId) attrs.push(`form=${field.formId}`);

  const line = attrs.length > 0 ? `${head}${field.label ? '' : ' '}${attrs.join(' ')}` : head;
  return field.precedingText ? `${line}\n  ctx: ${field.precedingText}` : line;
}
