// 「这次点击会不会提交表单」的结构判定。
// 只看结构，不看文案：识别「下单」「支付」这类字样会带来假阳性，
// 让普通按钮频繁弹二次确认，把确认的信噪比毁掉（ref: Spec-0005 §非目标）。

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
