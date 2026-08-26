import { sanitizePageText } from './form-schema';

export interface ConfirmationSummary {
  summary: string;
  codePreview?: string;
}

const MAX_VALUE_LENGTH = 200;
const MAX_CONFIRM_FIELDS = 10;
const MAX_VALUE_LENGTH_IN_CARD = 60;

/** 长文本/HTML 值截断，避免确认卡片的 summary 段落被撑爆。 */
function truncate(value: string, max = MAX_VALUE_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function summarizeToolCallForConfirmation(
  toolName: string,
  args: unknown,
  /** 目标 tab 不是面板绑定的那个时才传——用于在摘要前面标注"将操作标签页"（ref: 设计文档 §3.5）。 */
  targetTab?: { title?: string; url?: string },
): ConfirmationSummary {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');

  const result = ((): ConfirmationSummary => {
    switch (toolName) {
      case 'browser_set_style':
        return { summary: `AI 想要修改匹配 "${str('selector')}" 的元素样式。` };
      case 'browser_modify_dom': {
        const selector = str('selector');
        const action = str('action');
        const hasValue = typeof record.value === 'string';
        const hasAttribute = typeof record.attribute === 'string';
        const value = str('value');
        const attribute = str('attribute');
        let detail = '';
        if (hasAttribute && hasValue) {
          detail = `，把属性 "${attribute}" 设为 "${truncate(value)}"`;
        } else if (hasAttribute) {
          detail = `，涉及属性 "${attribute}"`;
        } else if (hasValue) {
          detail = `，值为 "${truncate(value)}"`;
        }
        return { summary: `AI 想要对匹配 "${selector}" 的元素执行 "${action}"${detail}。` };
      }
      case 'browser_click': {
        const fieldId = str('fieldId');
        if (fieldId) {
          const label = sanitizePageText(str('label') || fieldId, 40);
          return { summary: `AI 想要点击「${label}」。` };
        }
        return { summary: `AI 想要点击 "${str('selector')}"。` };
      }
      case 'browser_fill_form': {
        const rawFields = Array.isArray(record.fields) ? (record.fields as Record<string, unknown>[]) : [];
        const shown = rawFields.slice(0, MAX_CONFIRM_FIELDS).map((field) => {
          // label 与值都来自页面或模型，一律按纯文本净化后呈现，
          // 防止页面用 label 伪造卡片语义（ref: Spec-0005 §安全与隐私）。
          const label = sanitizePageText(String(field.label ?? field.fieldId ?? ''), 40);
          const value =
            typeof field.checked === 'boolean'
              ? field.checked ? '勾选' : '取消勾选'
              : sanitizePageText(String(field.value ?? ''), MAX_VALUE_LENGTH_IN_CARD);
          return `${label}：${value}`;
        });
        const rest = rawFields.length - shown.length;
        const submit = record.submit as { formAction?: string } | undefined;
        const tail = submit
          ? `，并提交表单${submit.formAction ? `到 ${sanitizePageText(submit.formAction, 80)}` : ''}`
          : '';
        const more = rest > 0 ? `，另 ${rest} 个字段` : '';
        return { summary: `AI 想要填写 ${rawFields.length} 个表单字段${tail}：\n${shown.join('\n')}${more}` };
      }
      case 'browser_type':
        return { summary: `AI 想要在 "${str('selector')}" 中输入文本："${truncate(str('text'))}"。` };
      case 'browser_select':
        return { summary: `AI 想要把 "${str('selector')}" 的选项设为 "${str('value')}"。` };
      case 'browser_scroll':
        return { summary: 'AI 想要滚动页面。' };
      case 'browser_navigate':
        return { summary: `AI 想要跳转到 "${str('url')}"。` };
      case 'browser_set_storage': {
        const area = str('area');
        const key = str('key');
        if (record.value === null) {
          return { summary: `AI 想要删除 ${area}Storage 的 "${key}"。` };
        }
        return { summary: `AI 想要写入 ${area}Storage 的 "${key}"，值为 "${truncate(str('value'))}"。` };
      }
      case 'browser_open_tab':
        return { summary: `AI 想要打开新标签页并跳转到 "${str('url')}"。` };
      case 'browser_close_tab':
        return { summary: `AI 想要关闭标签页 ${String(record.tabId ?? '')}。` };
      default:
        return { summary: `AI 想要执行 "${toolName}"。` };
    }
  })();

  if (!targetTab) return result;
  const targetTabNote = `将操作标签页：《${targetTab.title || '未命名页面'}》(${targetTab.url ?? ''})\n`;
  return { ...result, summary: `${targetTabNote}${result.summary}` };
}
