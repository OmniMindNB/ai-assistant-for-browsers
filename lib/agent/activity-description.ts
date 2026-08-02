import { t, type TranslationKey } from '@/lib/i18n';

export type ActivityStatus = 'running' | 'done' | 'failed';

const MAX_TARGET_LENGTH = 60;

function truncate(value: string, max = MAX_TARGET_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function withTarget(
  status: ActivityStatus,
  nowKey: TranslationKey,
  doneKey: TranslationKey,
  failedKey: TranslationKey,
  target: string,
): string {
  const key = status === 'running' ? nowKey : status === 'done' ? doneKey : failedKey;
  return t(key, { target: truncate(target) });
}

function plain(status: ActivityStatus, labelKey: TranslationKey): string {
  const label = t(labelKey);
  return status === 'failed' ? t('agentActivity.actionFailed', { action: label }) : label;
}

export function describeToolActivity(toolName: string, args: unknown, status: ActivityStatus): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');

  switch (toolName) {
    case 'browser_get_active_tab':
      return plain(status, 'agentActivity.tool.getActiveTab');
    case 'browser_read_page':
      return plain(status, 'agentActivity.tool.readPage');
    case 'browser_get_page_meta':
      return plain(status, 'agentActivity.tool.getPageMeta');
    case 'browser_inspect_page_implementation': {
      const focus = str('focus');
      return focus
        ? withTarget(status, 'agentActivity.now.inspectFocus', 'agentActivity.done.inspectFocus', 'agentActivity.failed.inspectFocus', focus)
        : plain(status, 'agentActivity.tool.inspectPageImplementation');
    }
    case 'browser_query_dom':
      return withTarget(status, 'agentActivity.now.queryDom', 'agentActivity.done.queryDom', 'agentActivity.failed.queryDom', str('selector'));
    case 'browser_get_html':
      return withTarget(status, 'agentActivity.now.getHtml', 'agentActivity.done.getHtml', 'agentActivity.failed.getHtml', str('selector') || 'html');
    case 'browser_get_scripts':
      return plain(status, 'agentActivity.tool.getScripts');
    case 'browser_get_stylesheets':
      return plain(status, 'agentActivity.tool.getStylesheets');
    case 'browser_get_computed_style':
      return withTarget(status, 'agentActivity.now.getComputedStyle', 'agentActivity.done.getComputedStyle', 'agentActivity.failed.getComputedStyle', str('selector'));
    case 'browser_screenshot':
      return plain(status, 'agentActivity.tool.screenshot');
    case 'browser_set_style':
      return withTarget(status, 'agentActivity.now.setStyle', 'agentActivity.done.setStyle', 'agentActivity.failed.setStyle', str('selector'));
    case 'browser_modify_dom':
      return withTarget(status, 'agentActivity.now.modifyDom', 'agentActivity.done.modifyDom', 'agentActivity.failed.modifyDom', str('selector'));
    case 'browser_click':
      return withTarget(status, 'agentActivity.now.click', 'agentActivity.done.click', 'agentActivity.failed.click', str('selector'));
    case 'browser_type':
      return withTarget(status, 'agentActivity.now.type', 'agentActivity.done.type', 'agentActivity.failed.type', str('selector'));
    case 'browser_select':
      return withTarget(status, 'agentActivity.now.select', 'agentActivity.done.select', 'agentActivity.failed.select', str('selector'));
    case 'browser_scroll': {
      const selector = str('selector');
      return selector
        ? withTarget(status, 'agentActivity.now.scrollTo', 'agentActivity.done.scrollTo', 'agentActivity.failed.scrollTo', selector)
        : plain(status, 'agentActivity.tool.scroll');
    }
    case 'browser_navigate':
      return withTarget(status, 'agentActivity.now.navigate', 'agentActivity.done.navigate', 'agentActivity.failed.navigate', str('url'));
    case 'browser_set_storage':
      return withTarget(status, 'agentActivity.now.setStorage', 'agentActivity.done.setStorage', 'agentActivity.failed.setStorage', str('key'));
    default:
      return plain(status, 'agentActivity.tool.unknown');
  }
}
