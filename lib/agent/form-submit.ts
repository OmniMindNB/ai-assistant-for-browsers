// 「这次点击会不会提交表单」的结构判定。
// 只看结构，不看文案：识别「下单」「支付」这类字样会带来假阳性，
// 让普通按钮频繁弹二次确认，把确认的信噪比毁掉（ref: Spec-0005 §非目标）。

import type {
  ClickElementResult,
  FillFormResult,
  FormFieldKind,
  SelectOptionResult,
  TypeTextResult,
} from '@/lib/messaging';

export interface ClickTargetInfo {
  tag: string;
  type?: string;
  /** 目标是否属于某个 <form>（HTMLElement.form 非空，含 form 属性关联）。 */
  hasFormOwner: boolean;
  formAction?: string;
  /** 仅用于日志与卡片文案，不参与判定。 */
  textContent?: string;
  fieldCount?: number;
}

export interface SubmitIntent {
  isSubmit: boolean;
  formAction?: string;
  fieldCount?: number;
  /** 该表单所在帧的 origin；与主框架相同时由渲染层省略（ref: 设计文档 §5.3）。 */
  frameOrigin?: string;
}

export function decideSubmitIntent(info: ClickTargetInfo): SubmitIntent {
  if (!info.hasFormOwner) return { isSubmit: false };

  const tag = info.tag.toLowerCase();
  const type = (info.type ?? '').toLowerCase();

  const isSubmit =
    (tag === 'button' && (type === '' || type === 'submit')) ||
    (tag === 'input' && (type === 'submit' || type === 'image'));

  if (!isSubmit) return { isSubmit: false };
  return { isSubmit: true, formAction: info.formAction, fieldCount: info.fieldCount };
}

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

/**
 * 「批量填写后的提交性点击」阈值：本轮已落地多少个可写字段写入，才把按钮类目标的
 * 单目标点击当作疑似提交来确认（ref: 2026-11-08-formless-commit-confirmation-design.md §4.3）。
 * 3 = 搜索框（1）、聊天输入（1）、登录（密码被 sensitive 拦下后落地 1）不问；
 * 问卷/考试/注册（≥6）必问。唯一常量，不要在别处另写一份。
 */
export const FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES = 3;

/** 行为规则的输入：结构判定为「非提交」之后，结合运行上下文再判一次。 */
export interface FormlessCommitInfo {
  /** 探针实况（selector 路径，无句柄 kind 时用）。 */
  tag?: string;
  type?: string;
  role?: string;
  /** 句柄表里目标的 kind（fieldId 路径）。 */
  kind?: FormFieldKind;
  /** 本轮已落地的可写字段写入个数。 */
  landedFieldWrites?: number;
}

/** 点击计数只认可写字段：点按钮/链接是操作，不是填写。 */
const CLICK_COUNTED_KINDS = new Set<FormFieldKind>([
  'text',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'contenteditable',
]);

/**
 * 无 form 结构的提交确认（行为规则，ref: 2026-11-08 spec §4.1）：本轮已批量填写
 * 字段之后，对按钮类元素的单目标点击 / fill_form 的 submit 按疑似提交请求确认。
 *
 * 与 decideSubmitIntent 同一边界：只看结构与行为，不看文案。注意 kind === 'submit'
 * 不能单独触发——React 站点遍地都是无 type 的裸 <button>（HTML 缺省 type 即 submit），
 * 无填写时点它们也弹卡会把信噪比毁掉；它只是按钮类集合的一员，仍由阈值把门。
 */
export function decideFormlessCommitIntent(info: FormlessCommitInfo): boolean {
  if ((info.landedFieldWrites ?? 0) < FORM_COMMIT_CONFIRM_MIN_LANDED_WRITES) return false;
  if (info.kind) return info.kind === 'submit' || info.kind === 'button';
  const tag = (info.tag ?? '').toLowerCase();
  const type = (info.type ?? '').toLowerCase();
  if (tag === 'button') return true;
  if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'image')) return true;
  return (info.role ?? '').toLowerCase() === 'button';
}

/**
 * 数一次工具调用「成功落地了多少个可写字段写入」。只数回读确认过的：fill_form 的
 * pendingSelection（自动补全待选定）与一切非 ok 状态都不算。批量点击里逐个点选项
 * 是 <form_workflow> 规则 6 鼓励的合法路径，必须计入；点按钮/链接不计。
 * selector 兑底点击没有句柄 kind，不计（宁少不多，方向安全）。
 */
export function countLandedFieldWrites(toolName: string, details: unknown): number {
  if (toolName === 'browser_fill_form') {
    const outcomes = (details as FillFormResult | undefined)?.outcomes;
    if (!Array.isArray(outcomes)) return 0;
    return outcomes.filter((outcome) => outcome.status === 'ok' && !outcome.pendingSelection).length;
  }
  if (toolName === 'browser_type') {
    const result = details as TypeTextResult | undefined;
    return result?.status === 'ok' && !result.pendingSelection ? 1 : 0;
  }
  if (toolName === 'browser_select') {
    return (details as SelectOptionResult | undefined)?.status === 'ok' ? 1 : 0;
  }
  if (toolName === 'browser_click') {
    const result = details as ClickElementResult | undefined;
    if (!result) return 0;
    const counted = (kind: FormFieldKind | undefined): boolean =>
      kind !== undefined && CLICK_COUNTED_KINDS.has(kind);
    if (Array.isArray(result.outcomes)) {
      return result.outcomes.filter((outcome) => outcome.status === 'ok' && counted(outcome.kind)).length;
    }
    return result.status === 'ok' && counted(result.kind) ? 1 : 0;
  }
  return 0;
}
