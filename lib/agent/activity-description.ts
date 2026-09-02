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

function statusKey(status: ActivityStatus, nowKey: TranslationKey, doneKey: TranslationKey, failedKey: TranslationKey): TranslationKey {
  return status === 'running' ? nowKey : status === 'done' ? doneKey : failedKey;
}

export function describeToolActivity(toolName: string, args: unknown, status: ActivityStatus): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const num = (key: string): string => (typeof record[key] === 'number' ? String(record[key]) : '');

  switch (toolName) {
    case 'browser_get_active_tab':
      return plain(status, 'agentActivity.tool.getActiveTab');
    case 'browser_open_tab':
      return withTarget(status, 'agentActivity.now.openTab', 'agentActivity.done.openTab', 'agentActivity.failed.openTab', str('url'));
    case 'browser_switch_tab':
      return withTarget(status, 'agentActivity.now.switchTab', 'agentActivity.done.switchTab', 'agentActivity.failed.switchTab', num('tabId'));
    case 'browser_close_tab':
      return withTarget(status, 'agentActivity.now.closeTab', 'agentActivity.done.closeTab', 'agentActivity.failed.closeTab', num('tabId'));
    case 'browser_list_tabs':
      return plain(status, 'agentActivity.tool.listTabs');
    case 'ask_user':
      return withTarget(status, 'agentActivity.now.askUser', 'agentActivity.done.askUser', 'agentActivity.failed.askUser', str('question'));
    case 'wait': {
      const seconds = typeof record.seconds === 'number' && Number.isFinite(record.seconds) ? record.seconds : 2;
      return withTarget(status, 'agentActivity.now.wait', 'agentActivity.done.wait', 'agentActivity.failed.wait', String(seconds));
    }
    case 'browser_read_page':
      return plain(status, 'agentActivity.tool.readPage');
    case 'browser_get_page_meta':
      return plain(status, 'agentActivity.tool.getPageMeta');
    case 'browser_get_form':
      return plain(status, 'agentActivity.tool.getForm');
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
      return withTarget(status, 'agentActivity.now.click', 'agentActivity.done.click', 'agentActivity.failed.click', str('selector') || str('fieldId'));
    case 'browser_type': {
      const key = statusKey(status, 'agentActivity.now.type', 'agentActivity.done.type', 'agentActivity.failed.type');
      return t(key, { selector: truncate(str('selector')), text: truncate(str('text')) });
    }
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
    case 'browser_fill_form': {
      const fields = Array.isArray(record.fields) ? record.fields.length : 0;
      return withTarget(status, 'agentActivity.now.fillForm', 'agentActivity.done.fillForm', 'agentActivity.failed.fillForm', String(fields));
    }
    default:
      return plain(status, 'agentActivity.tool.unknown');
  }
}
