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

/**
 * 工具结果里的 details（textResult 的第二个参数，也就是 tool_execution_end 事件上的
 * `result.details`）。调用参数说的是"打算做什么"，只有它能说"实际发生了什么"——
 * 两者在重定向和部分失败时会分岔，而步骤时间线是用户唯一能看见这件事的地方。
 */
function resultDetails(result: unknown): Record<string, unknown> {
  const details = result && typeof result === 'object' ? (result as { details?: unknown }).details : undefined;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
}

/** 只差末尾斜杠、默认端口这类归一化差异的两个地址算同一个，不值得标成"重定向"。 */
function isSameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * 落地地址与请求地址不一致（重定向，典型如被踢回登录页）时报落地地址并注明；
 * 其余情况退回按请求地址的常规文案。只在 done 上判断——running 时还没有落地地址，
 * failed 时该说的是"没跳成"，落地地址反而是噪音。
 */
function describeNavigation(
  status: ActivityStatus,
  keys: { now: TranslationKey; done: TranslationKey; failed: TranslationKey; redirected: TranslationKey },
  requested: string,
  landed: string,
): string {
  if (status === 'done' && landed && requested && !isSameUrl(landed, requested)) {
    return t(keys.redirected, { target: truncate(landed), requested: truncate(requested) });
  }
  return withTarget(status, keys.now, keys.done, keys.failed, requested);
}

export function describeToolActivity(
  toolName: string,
  args: unknown,
  status: ActivityStatus,
  /** tool_execution_end 事件上的 `result`；running 阶段没有，调用方不传。 */
  result?: unknown,
): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const details = resultDetails(result);
  const detailStr = (key: string): string => (typeof details[key] === 'string' ? (details[key] as string) : '');
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const num = (key: string): string => (typeof record[key] === 'number' ? String(record[key]) : '');

  switch (toolName) {
    case 'browser_get_active_tab':
      return plain(status, 'agentActivity.tool.getActiveTab');
    case 'browser_open_tab':
      return describeNavigation(
        status,
        {
          now: 'agentActivity.now.openTab',
          done: 'agentActivity.done.openTab',
          failed: 'agentActivity.failed.openTab',
          redirected: 'agentActivity.done.openTabRedirected',
        },
        str('url'),
        detailStr('url'),
      );
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
    case 'browser_wait_for': {
      const kind = str('kind');
      const target = str('selector') || str('text') || kind;
      return withTarget(
        status,
        'agentActivity.now.waitFor',
        'agentActivity.done.waitFor',
        'agentActivity.failed.waitFor',
        target,
      );
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
    case 'browser_get_storage':
      return plain(status, 'agentActivity.tool.getStorage');
    case 'browser_set_style':
      return withTarget(status, 'agentActivity.now.setStyle', 'agentActivity.done.setStyle', 'agentActivity.failed.setStyle', str('selector'));
    case 'browser_modify_dom':
      return withTarget(status, 'agentActivity.now.modifyDom', 'agentActivity.done.modifyDom', 'agentActivity.failed.modifyDom', str('selector'));
    case 'browser_click': {
      // 批量点击也要把目标列出来：面板的步骤时间线是用户唯一能看见 agent 动了哪些元素的
      // 地方，一次点 5 个却只显示「点击」等于把这一步藏起来。
      const batch = Array.isArray(record.fieldIds) ? (record.fieldIds as unknown[]).filter((id) => typeof id === 'string') : [];
      // 批量点击只在整批都没点成时才算失败（见 tools.ts 的 clickBatch），所以"部分成功"
      // 也是 done；此时光把 fieldIds 列出来等于说这几个都点到了。
      const outcomes = Array.isArray(details.outcomes) ? (details.outcomes as Array<{ status?: unknown }>) : undefined;
      if (status === 'done' && batch.length > 0 && outcomes) {
        const landed = outcomes.filter((outcome) => outcome?.status === 'ok').length;
        if (landed < batch.length) {
          return t('agentActivity.done.clickPartial', { ok: String(landed), total: String(batch.length) });
        }
      }
      const target = str('selector') || str('fieldId') || batch.join('、');
      return withTarget(status, 'agentActivity.now.click', 'agentActivity.done.click', 'agentActivity.failed.click', target);
    }
    case 'browser_type': {
      const key = statusKey(status, 'agentActivity.now.type', 'agentActivity.done.type', 'agentActivity.failed.type');
      return t(key, { selector: truncate(str('selector')), text: truncate(str('text')) });
    }
    case 'browser_select':
      return withTarget(status, 'agentActivity.now.select', 'agentActivity.done.select', 'agentActivity.failed.select', str('selector'));
    case 'browser_press_key':
      return withTarget(status, 'agentActivity.now.pressKey', 'agentActivity.done.pressKey', 'agentActivity.failed.pressKey', str('key'));
    case 'browser_scroll': {
      const selector = str('selector');
      return selector
        ? withTarget(status, 'agentActivity.now.scrollTo', 'agentActivity.done.scrollTo', 'agentActivity.failed.scrollTo', selector)
        : plain(status, 'agentActivity.tool.scroll');
    }
    case 'browser_navigate':
      return describeNavigation(
        status,
        {
          now: 'agentActivity.now.navigate',
          done: 'agentActivity.done.navigate',
          failed: 'agentActivity.failed.navigate',
          redirected: 'agentActivity.done.navigateRedirected',
        },
        str('url'),
        detailStr('url'),
      );
    // browser_navigate 的兄弟，但没有可展示的目标参数（退到哪只有执行完才知道），
    // 所以走 plain 而不是 withTarget。
    case 'browser_go_back':
      return plain(status, 'agentActivity.tool.goBack');
    case 'browser_find_text':
      return withTarget(status, 'agentActivity.now.findText', 'agentActivity.done.findText', 'agentActivity.failed.findText', str('text'));
    case 'browser_set_storage':
      return withTarget(status, 'agentActivity.now.setStorage', 'agentActivity.done.setStorage', 'agentActivity.failed.setStorage', str('key'));
    case 'browser_fill_form': {
      const fields = Array.isArray(record.fields) ? record.fields.length : 0;
      // 部分字段没落地时，按参数里的字段数说"已填写 N 个字段"等于把失败的也算成了成功；
      // 每个字段的写入都做过回读校验，ok 才是真的写进去了（ref: Spec-0005）。
      const outcomes = Array.isArray(details.outcomes) ? (details.outcomes as Array<{ status?: unknown }>) : undefined;
      if (status === 'done' && outcomes) {
        const landed = outcomes.filter((outcome) => outcome?.status === 'ok').length;
        if (landed < fields) {
          return t('agentActivity.done.fillFormPartial', { ok: String(landed), total: String(fields) });
        }
      }
      return withTarget(status, 'agentActivity.now.fillForm', 'agentActivity.done.fillForm', 'agentActivity.failed.fillForm', String(fields));
    }
    default:
      return plain(status, 'agentActivity.tool.unknown');
  }
}
