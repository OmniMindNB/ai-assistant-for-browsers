import { useState } from 'react';
import { useTranslation, type Translate } from '@/lib/i18n';
import { summarizeToolActivities, type ToolActivityStatus } from '@/lib/workbench/presentation';
import type { ToolActivity } from '../store';
import { IconChevronRight } from '../icons';

const TOOL_LABEL_KEYS = {
  browser_get_active_tab: 'agentActivity.tool.getActiveTab',
  browser_read_page: 'agentActivity.tool.readPage',
  browser_get_page_meta: 'agentActivity.tool.getPageMeta',
  browser_inspect_page_implementation: 'agentActivity.tool.inspectPageImplementation',
  browser_query_dom: 'agentActivity.tool.queryDom',
  browser_get_html: 'agentActivity.tool.getHtml',
  browser_get_scripts: 'agentActivity.tool.getScripts',
  browser_get_stylesheets: 'agentActivity.tool.getStylesheets',
  browser_get_computed_style: 'agentActivity.tool.getComputedStyle',
  browser_screenshot: 'agentActivity.tool.screenshot',
  browser_set_style: 'agentActivity.tool.setStyle',
  browser_modify_dom: 'agentActivity.tool.modifyDom',
  browser_click: 'agentActivity.tool.click',
  browser_type: 'agentActivity.tool.type',
  browser_select: 'agentActivity.tool.select',
  browser_scroll: 'agentActivity.tool.scroll',
  browser_navigate: 'agentActivity.tool.navigate',
  browser_set_storage: 'agentActivity.tool.setStorage',
  browser_revert_changes: 'agentActivity.tool.revertChanges',
} as const;

export function AgentActivityCard({ activities }: { activities: ToolActivity[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolActivities(activities);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? t('agentActivity.hideDetails') : t('agentActivity.showDetails')}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-300"
      >
        <IconChevronRight
          className={`h-3.5 w-3.5 text-neutral-400 transition-transform dark:text-neutral-500${expanded ? ' rotate-90' : ''}`}
        />
        <span className={statusColor(summary.status)}>{summaryStatusLabel(summary.status, t)}</span>
        <span className="text-neutral-400 dark:text-neutral-500">{summary.completed} / {summary.total}</span>
      </button>
      {expanded && (
        <ul className="space-y-1 border-t border-neutral-100 px-3 py-2 dark:border-neutral-800">
          {summary.activities.map((activity) => (
            <li key={activity.id} className="flex items-start gap-2 text-xs">
              <span className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">
                <span className="font-medium">{toolLabel(activity.name, t)}</span>
                <span className="ml-1 break-words text-neutral-400 dark:text-neutral-500">
                  {activityDetailLabel(activity.status, t)}
                </span>
              </span>
              <span className={`shrink-0 ${statusColor(activity.status)}`}>{detailStatusLabel(activity.status, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toolLabel(name: string, t: Translate): string {
  const key = TOOL_LABEL_KEYS[name as keyof typeof TOOL_LABEL_KEYS];
  return key ? t(key) : t('agentActivity.tool.unknown');
}

function summaryStatusLabel(status: ToolActivityStatus, t: Translate): string {
  switch (status) {
    case 'running':
      return t('agentActivity.status.running');
    case 'confirming':
      return t('agentActivity.status.confirming');
    case 'blocked':
      return t('agentActivity.status.blocked');
    case 'error':
      return t('agentActivity.status.error');
    default:
      return t('agentActivity.status.done');
  }
}

function activityDetailLabel(status: ToolActivityStatus, t: Translate): string {
  switch (status) {
    case 'running':
      return t('agentActivity.detail.running');
    case 'confirming':
      return t('agentActivity.detail.confirming');
    case 'blocked':
      return t('agentActivity.detail.blocked');
    case 'error':
      return t('agentActivity.detail.error');
    default:
      return t('agentActivity.detail.done');
  }
}

function detailStatusLabel(status: ToolActivityStatus, t: Translate): string {
  switch (status) {
    case 'running':
      return t('status.running');
    case 'confirming':
      return t('status.confirming');
    case 'blocked':
      return t('status.blocked');
    case 'error':
      return t('status.error');
    default:
      return t('status.done');
  }
}

function statusColor(status: ToolActivityStatus): string {
  switch (status) {
    case 'running':
      return 'text-blue-700 dark:text-blue-300';
    case 'confirming':
    case 'blocked':
      return 'text-amber-700 dark:text-amber-300';
    case 'error':
      return 'text-red-700 dark:text-red-300';
    default:
      return 'text-emerald-700 dark:text-emerald-300';
  }
}
