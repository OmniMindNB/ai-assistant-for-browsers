export interface ConfirmationSummary {
  summary: string;
  codePreview?: string;
}

const MAX_VALUE_LENGTH = 200;

/** 长文本/HTML 值截断，避免确认卡片的 summary 段落被撑爆。 */
function truncate(value: string, max = MAX_VALUE_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function summarizeToolCallForConfirmation(toolName: string, args: unknown): ConfirmationSummary {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');

  switch (toolName) {
    case 'browser_inject_script':
      return { summary: 'AI 想要注入一段脚本来修改当前页面。', codePreview: str('code') };
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
    case 'browser_click':
      return { summary: `AI 想要点击 "${str('selector')}"。` };
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
    default:
      return { summary: `AI 想要执行 "${toolName}"。` };
  }
}
