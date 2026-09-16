import { t } from '@/lib/i18n';

/**
 * 活动步骤右侧那行灰字（"6 条结果"）。
 *
 * 只认结果天然可计数的少数工具：一个"点击成功"没有数量可言，硬凑一个数字比不写更糟。
 * 形状对不上一律返回 undefined——宁可空着，也不要编一个 0 出来读成"什么都没找到"。
 *
 * 和 activity-description.ts 一样在这里就 t() 成字符串：这个值会随消息存档进 IndexedDB，
 * 存渲染好的文字而不是 i18n key，历史记录才不会因为以后改键名而失效。
 */
export function describeToolResultNote(toolName: string, result: unknown): string | undefined {
  const details = (result as { details?: unknown })?.details;
  if (!details || typeof details !== 'object') return undefined;
  const record = details as Record<string, unknown>;

  switch (toolName) {
    case 'browser_find_text': {
      const matches = record.matches;
      if (!Array.isArray(matches)) return undefined;
      // truncated 时命中数只是个下界，写成确切数字会让用户以为页面上只有这些。
      return record.truncated === true
        ? t('agentActivity.note.resultsTruncated', { count: String(matches.length) })
        : t('agentActivity.note.results', { count: String(matches.length) });
    }
    case 'browser_query_dom': {
      const count = record.count;
      if (typeof count !== 'number') return undefined;
      return record.truncated === true
        ? t('agentActivity.note.resultsTruncated', { count: String(count) })
        : t('agentActivity.note.results', { count: String(count) });
    }
    case 'browser_get_form': {
      const fields = record.fields;
      if (!Array.isArray(fields)) return undefined;
      return t('agentActivity.note.fields', { count: String(fields.length) });
    }
    case 'browser_list_tabs': {
      const tabs = record.trackedTabs;
      if (!Array.isArray(tabs)) return undefined;
      return t('agentActivity.note.tabs', { count: String(tabs.length) });
    }
    case 'browser_fill_form': {
      const outcomes = record.outcomes;
      if (!Array.isArray(outcomes)) return undefined;
      // 写操作要报"几个真的落地了"，不是"请求了几个"：两者不一致正是用户最需要看见的时候。
      const landed = outcomes.filter((o) => (o as { status?: unknown })?.status === 'ok').length;
      return t('agentActivity.note.filled', { ok: String(landed), total: String(outcomes.length) });
    }
    default:
      return undefined;
  }
}
