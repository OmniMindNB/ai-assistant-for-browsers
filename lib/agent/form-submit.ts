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
