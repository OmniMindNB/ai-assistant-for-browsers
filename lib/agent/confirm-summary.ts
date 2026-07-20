export interface ConfirmationSummary {
  summary: string;
  codePreview?: string;
}

export function summarizeToolCallForConfirmation(toolName: string, args: unknown): ConfirmationSummary {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');

  switch (toolName) {
    case 'browser_inject_script':
      return { summary: 'AI 想要注入一段脚本来修改当前页面。', codePreview: str('code') };
    case 'browser_set_style':
      return { summary: `AI 想要修改匹配 "${str('selector')}" 的元素样式。` };
    case 'browser_modify_dom':
      return { summary: `AI 想要对匹配 "${str('selector')}" 的元素执行 "${str('action')}"。` };
    case 'browser_click':
      return { summary: `AI 想要点击 "${str('selector')}"。` };
    case 'browser_type':
      return { summary: `AI 想要在 "${str('selector')}" 中输入文本。` };
    case 'browser_select':
      return { summary: `AI 想要把 "${str('selector')}" 的选项设为 "${str('value')}"。` };
    case 'browser_scroll':
      return { summary: 'AI 想要滚动页面。' };
    case 'browser_navigate':
      return { summary: `AI 想要跳转到 "${str('url')}"。` };
    case 'browser_set_storage':
      return { summary: `AI 想要写入 ${str('area')}Storage 的 "${str('key')}"。` };
    default:
      return { summary: `AI 想要执行 "${toolName}"。` };
  }
}
