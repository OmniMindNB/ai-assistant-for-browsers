// 会话导出：把一个会话变成可用于排查问题的诊断记录
// （ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md）。
// 脱敏只在 buildConversationExport 里做一次；Markdown 和附录 JSON 都从它产出的
// ConversationExport 渲染，不存在第二条未脱敏的输出路径。
import type { ChatMessageRecord, ConversationRecord } from '@/lib/db';
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { WRITE_TOOL_NAMES } from '@/lib/agent/permissions';
import type { ActivityStep } from '@/lib/agent/activity-steps';
import type { RunDiagnostics } from '@/lib/agent/run-diagnostics';
import type { TaskOutcome } from '@/lib/agent/task-outcome';
import type { TrajectoryStep } from '@/lib/agent/task-trajectory';
import type { ResolvedLocale, Translate } from '@/lib/i18n';

export const EXPORT_SCHEMA = 'runi-conversation-export/1';
const MAX_ARG_STRING_CHARS = 120;
const MAX_ARGS_JSON_CHARS = 300;

/** 写工具里承载"写进页面的值"的参数键：只导出长度（spec §4.2）。 */
export const MASKED_WRITE_ARG_KEYS: ReadonlySet<string> = new Set(['value', 'text']);
/** 写工具里的定位/枚举参数：排查"点错了元素"要靠它们，只脱敏不屏蔽。守护测试要求每个写工具字符串参数必居其一。 */
export const KEPT_WRITE_ARG_KEYS: ReadonlySet<string> = new Set([
  'selector', 'styles', 'action', 'attribute', 'fieldId', 'fieldIds', 'key', 'behavior', 'url', 'area',
]);

export interface ExportedAttachment {
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount?: number;
}

export interface ExportedStep {
  status: ActivityStep['status'];
  description: string;
  tabLabel?: string;
  attempt?: number;
  toolName?: string;
  /** 已屏蔽写入值、已脱敏、已截断的参数 JSON。 */
  args?: string;
  errorText?: string;
}

export interface ExportedMessage {
  role: 'user' | 'assistant';
  createdAt: number;
  kind?: 'input' | 'action';
  content: string;
  quotedText?: string;
  attachments?: ExportedAttachment[];
  tabReferences?: { title: string; url?: string }[];
  shortcut?: { id: string; name: string; scope: string };
  taskOutcome?: TaskOutcome;
  stopped?: boolean;
  contextTruncated?: boolean;
  steps?: ExportedStep[];
  trajectory?: TrajectoryStep[];
  runDiagnostics?: RunDiagnostics;
}

export interface ConversationExport {
  schema: typeof EXPORT_SCHEMA;
  exportedAt: number;
  extensionVersion: string;
  locale: ResolvedLocale;
  conversation: { title: string; url?: string; createdAt: number; updatedAt: number };
  messages: ExportedMessage[];
}

export interface ConversationExportInput {
  conversation: ConversationRecord;
  records: ChatMessageRecord[];
  redaction: RedactionSettings;
  extensionVersion: string;
  locale: ResolvedLocale;
  exportedAt: number;
  t: Translate;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 只留 scheme + host + pathname：query/hash 里常带 token、订单号。无法解析时返回 undefined，由调用方整段省略。 */
export function stripUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : `${parsed.protocol}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

export function sanitizeToolArgs(toolName: string, args: unknown, redaction: RedactionSettings, t: Translate): unknown {
  const maskWrites = WRITE_TOOL_NAMES.has(toolName);
  const visit = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') {
      if (maskWrites && key !== undefined && MASKED_WRITE_ARG_KEYS.has(key)) return t('export.maskedValue', { count: value.length });
      if (key === 'url') return stripUrl(value) ?? '';
      return clip(redactText(value, redaction), MAX_ARG_STRING_CHARS);
    }
    // 数组元素继承父键：fieldIds: ['f1'] 仍按 fieldIds 归类。
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    }
    return value;
  };
  return visit(args, undefined);
}

/** signature = `${toolName}:${JSON}`（tool-policy.ts 的 toolSignature）。JSON 坏了就只给工具名——原串可能含写入值。 */
function exportStep(step: ActivityStep, redaction: RedactionSettings, t: Translate): ExportedStep {
  const out: ExportedStep = { status: step.status, description: redactText(step.description, redaction) };
  if (step.tabLabel) out.tabLabel = redactText(step.tabLabel, redaction);
  if (step.attempt !== undefined) out.attempt = step.attempt;
  if (step.signature) {
    const colon = step.signature.indexOf(':');
    const toolName = colon === -1 ? step.signature : step.signature.slice(0, colon);
    out.toolName = toolName;
    if (colon !== -1) {
      try {
        const args = JSON.parse(step.signature.slice(colon + 1)) as unknown;
        out.args = clip(JSON.stringify(sanitizeToolArgs(toolName, args, redaction, t)), MAX_ARGS_JSON_CHARS);
      } catch {
        // 保持无 args。
      }
    }
  }
  if (step.errorText) out.errorText = step.errorText;
  return out;
}

function exportMessage(record: ChatMessageRecord & { role: 'user' | 'assistant' }, redaction: RedactionSettings, t: Translate): ExportedMessage {
  const out: ExportedMessage = {
    role: record.role,
    createdAt: record.createdAt,
    content: redactText(record.content, redaction),
  };
  if (record.kind) out.kind = record.kind;
  if (record.quotedText) out.quotedText = redactText(record.quotedText, redaction);
  if (record.attachments?.length) {
    out.attachments = record.attachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      ...(a.kind === 'pdf' ? { pageCount: a.pageCount } : {}),
    }));
  }
  if (record.tabReferences?.length) {
    out.tabReferences = record.tabReferences.map((ref) => {
      const url = stripUrl(ref.url);
      return { title: redactText(ref.title, redaction), ...(url ? { url } : {}) };
    });
  }
  if (record.rerun) {
    const { id, name, scope } = record.rerun.shortcut;
    out.shortcut = { id, name: redactText(name, redaction), scope };
  }
  if (record.taskOutcome) out.taskOutcome = record.taskOutcome;
  if (record.stopped) out.stopped = true;
  if (record.contextTruncated) out.contextTruncated = true;
  if (record.activitySteps?.length) out.steps = record.activitySteps.map((step) => exportStep(step, redaction, t));
  if (record.trajectory?.length) out.trajectory = record.trajectory;
  if (record.runDiagnostics) out.runDiagnostics = record.runDiagnostics;
  return out;
}

export function buildConversationExport(input: ConversationExportInput): ConversationExport {
  const { conversation, redaction, t } = input;
  const url = conversation.url ? stripUrl(conversation.url) : undefined;
  return {
    schema: EXPORT_SCHEMA,
    exportedAt: input.exportedAt,
    extensionVersion: input.extensionVersion,
    locale: input.locale,
    conversation: {
      title: redactText(conversation.title, redaction),
      ...(url ? { url } : {}),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messages: input.records
      .filter((r): r is ChatMessageRecord & { role: 'user' | 'assistant' } => r.role !== 'system')
      .map((r) => exportMessage(r, redaction, t)),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** 模型回复里未闭合的代码围栏会把后面的章节全吞进代码块；奇数个围栏行就补一个闭合。 */
function closeOpenFences(text: string): string {
  const fences = text.split('\n').filter((line) => /^\s*(`{3,}|~{3,})/.test(line));
  if (fences.length % 2 === 0) return text;
  const opener = fences[fences.length - 1].trim().match(/^(`{3,}|~{3,})/)![1];
  return `${text}\n${opener}`;
}

const STEP_STATUS_ICON: Record<ExportedStep['status'], string> = { done: '✓', failed: '✗', running: '…', notice: 'ℹ' };

function formatBytes(size: number): string {
  return size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`;
}

function renderMessage(m: ExportedMessage, t: Translate): string[] {
  const lines: string[] = [];
  const flags = [
    ...(m.stopped ? [t('export.stopped')] : []),
    ...(m.contextTruncated ? [t('export.contextTruncated')] : []),
  ];
  const role = m.role === 'user' ? t('export.roleUser') : t('export.roleAssistant');
  lines.push(`### ${[role, formatDateTime(m.createdAt), ...flags].join(' · ')}`, '');
  if (m.shortcut) lines.push(t('export.shortcut', { name: m.shortcut.name }), '');
  if (m.quotedText) {
    lines.push(...m.quotedText.split('\n').map((line, i) => `> ${i === 0 ? t('export.quote') : ''}${line}`), '');
  }
  if (m.content) lines.push(closeOpenFences(m.content), '');
  if (m.attachments?.length) {
    const list = m.attachments.map((a) => `${a.name}（${a.mimeType}，${formatBytes(a.size)}${a.pageCount !== undefined ? `，${a.pageCount}p` : ''}）`).join('、');
    lines.push(t('export.attachments', { list }), '');
  }
  if (m.tabReferences?.length) {
    const list = m.tabReferences.map((ref) => (ref.url ? `${ref.title} <${ref.url}>` : ref.title)).join('、');
    lines.push(t('export.tabReferences', { list }), '');
  }
  if (m.runDiagnostics) {
    const d = m.runDiagnostics;
    lines.push(
      t('export.runInfo', {
        provider: d.providerName,
        model: d.modelId,
        api: d.api,
        host: d.baseUrlHost || '-',
        vision: d.vision ? t('export.yes') : t('export.no'),
        duration: `${(d.durationMs / 1000).toFixed(1)}s`,
        turns: d.llmTurns,
        tools: d.toolCalls,
        read: d.readToolCallBudget,
        write: d.writeToolCallBudget,
      }) + (d.withoutBrowserTools ? t('export.withoutBrowserTools') : ''),
      '',
    );
  }
  if (m.taskOutcome) lines.push(t('export.taskOutcome', { outcome: m.taskOutcome.outcome, reason: m.taskOutcome.reason }), '');
  if (m.steps?.length) {
    lines.push(t('export.stepsTableHeader'), '|---|---|---|---|---|');
    m.steps.forEach((step, i) => {
      const status = `${STEP_STATUS_ICON[step.status]}${step.attempt ? ` ×${step.attempt}` : ''}`;
      const description = step.tabLabel ? `${step.description}（${step.tabLabel}）` : step.description;
      const call = step.toolName ? `${step.toolName}${step.args ? ` ${step.args}` : ''}` : '';
      lines.push(`| ${i + 1} | ${status} | ${escapeCell(description)} | ${escapeCell(call)} | ${escapeCell(step.errorText ?? '')} |`);
    });
    lines.push('');
  }
  return lines;
}

export function renderConversationExportMarkdown(doc: ConversationExport, t: Translate): string {
  const lines: string[] = [
    `# ${t('export.title', { title: doc.conversation.title })}`,
    '',
    `- ${t('export.exportedAt', { time: formatDateTime(doc.exportedAt) })}`,
    `- ${t('export.version', { version: doc.extensionVersion, locale: doc.locale })}`,
    ...(doc.conversation.url ? [`- ${t('export.pageUrl', { url: doc.conversation.url })}`] : []),
    `- ${t('export.privacyNote')}`,
    '',
  ];

  // 一轮 = 一条用户消息加上它后面的 assistant 消息；开头就是 assistant 的也单独成一轮。
  const rounds: ExportedMessage[][] = [];
  for (const m of doc.messages) {
    if (m.role === 'user' || rounds.length === 0) rounds.push([]);
    rounds[rounds.length - 1].push(m);
  }
  rounds.forEach((round, i) => {
    lines.push(`## ${t('export.round', { n: i + 1 })}`, '');
    for (const m of round) lines.push(...renderMessage(m, t));
  });

  const json = JSON.stringify(doc, null, 2);
  const longestRun = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  lines.push('---', '', `## ${t('export.appendix')}`, '', `${fence}json`, json, fence, '');
  return lines.join('\n');
}

export function exportFileName(title: string, exportedAt: number): string {
  const d = new Date(exportedAt);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const safe = Array.from(
    title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, ''),
  ).slice(0, 40).join('');
  return `runi-${safe || 'conversation'}-${stamp}.md`;
}
