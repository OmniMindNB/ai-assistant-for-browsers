// 把一次成功的工具调用整理成 TrajectoryStep（ref: 设计稿 §3）。只在 background 的
// run-registry.ts 里用；类型与渲染在 task-trajectory.ts，那边不能依赖这里的 permissions/脱敏。
//
// 顺序铁律：先 redactText 再截断。反过来会把手机号之类切成两半，脱敏正则就认不出来了
// （同 page-outline.ts 的约定）。
import { redactText, type RedactionSettings } from '@/lib/redaction';
import { WRITE_TOOL_NAMES } from './permissions';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';
import {
  MAX_TRAJECTORY_LABEL_CHARS,
  MAX_TRAJECTORY_STEPS,
  MAX_TRAJECTORY_VALUE_CHARS,
  type TrajectoryStep,
  type TrajectoryValue,
} from './task-trajectory';

export interface RecordInput {
  toolName: string;
  args: unknown;
  /** 执行前目标页的完整 URL；这里负责去掉 query/hash。 */
  url: string | undefined;
  /** 执行前目标页的句柄表——必须是执行前的那一份，见 run-registry.ts 的录制注释。 */
  table: FormFieldTable | undefined;
  /** 只有 browser_switch_tab 用得上：切换之后新目标页的 URL。 */
  afterUrl?: string;
  /**
   * tool_execution_end 事件上的 result.details（textResult 的第二个参数）。只用来过滤
   * "没落地的部分"：browser_fill_form / 批量 browser_click 只要有一项成功就不报错，
   * 逐项的 outcome 只在这里。标签仍然只从执行前的 table 解析，绝不从这里取。
   */
  details?: unknown;
  redaction: RedactionSettings;
}

/**
 * 录哪些调用：所有写工具，外加 browser_switch_tab——它本身只读，但决定了后面的操作落在哪个
 * 页面，丢了它多标签页任务的轨迹就断了。读工具一律不录：回放时模型反正要重读，录进去只会
 * 让它照抄多余的读取轮次。
 */
export function isRecordableTool(toolName: string): boolean {
  return WRITE_TOOL_NAMES.has(toolName) || toolName === 'browser_switch_tab';
}

export function stripUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

export function appendTrajectorySteps(
  existing: readonly TrajectoryStep[],
  added: readonly TrajectoryStep[],
): TrajectoryStep[] {
  // 保留最后 N 步：越靠后越接近"最终走通的那条路"。
  return [...existing, ...added].slice(-MAX_TRAJECTORY_STEPS);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 从 details.outcomes 里取出落地（status === 'ok'）的 fieldId 集合；没有 outcomes 时返回
 * undefined，表示"无从判断，不过滤"。
 */
function landedFieldIds(details: unknown): Set<string> | undefined {
  const outcomes = asRecord(details).outcomes;
  if (!Array.isArray(outcomes)) return undefined;
  const landed = new Set<string>();
  for (const outcome of outcomes) {
    const record = asRecord(outcome);
    if (record.status === 'ok' && typeof record.fieldId === 'string') landed.add(record.fieldId);
  }
  return landed;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function buildTrajectorySteps(input: RecordInput): TrajectoryStep[] {
  const redact = (text: string) => redactText(text, input.redaction);
  const args = asRecord(input.args);
  const url = redact(stripUrl(input.url));
  const base: TrajectoryStep = { tool: input.toolName, url };

  // getFormFieldsForTab 只做类型断言不校验形状，旧版/畸形的表不能让录制抛出。
  const fields = input.table && input.table.fields && typeof input.table.fields === 'object'
    ? input.table.fields
    : undefined;
  const handleOf = (fieldId: unknown): FormFieldHandle | undefined => {
    if (typeof fieldId !== 'string' || !fields) return undefined;
    const handle = fields[fieldId];
    return handle && typeof handle === 'object' && handle.expect ? handle : undefined;
  };
  const labelTarget = (handle: FormFieldHandle | undefined): string | undefined => {
    const raw = (handle?.expect.label || handle?.expect.text || handle?.expect.name || '').trim();
    return raw ? `「${clip(redact(raw), MAX_TRAJECTORY_LABEL_CHARS)}」` : undefined;
  };
  const selectorTarget = (selector: unknown): string | undefined => {
    const raw = str(selector);
    return raw ? `\`${clip(redact(raw), MAX_TRAJECTORY_LABEL_CHARS)}\`` : undefined;
  };
  const value = (raw: string) => clip(redact(raw), MAX_TRAJECTORY_VALUE_CHARS);

  switch (input.toolName) {
    case 'browser_fill_form': {
      const entries = Array.isArray(args.fields) ? args.fields : [];
      const landed = landedFieldIds(input.details);
      const fillValue = (entry: unknown): TrajectoryValue | undefined => {
        const field = asRecord(entry);
        const handle = handleOf(field.fieldId);
        const target = labelTarget(handle) ?? `「${typeof field.fieldId === 'string' ? field.fieldId : '?'}」`;
        // planFormFill 在到达页面之前就丢掉了 sensitive 字段：这里既不录值，也不能暗示"已填"。
        // 它的 outcome 必然是 blocked_sensitive，但这一条本来就不是"已填"，而是"要用户自己填"的提示，所以不参与落地过滤。
        if (handle?.sensitive) return { target, sensitive: true };
        // 回读校验没通过（invalid_value/not_writable/mismatch…）的字段没写进页面，录成"填入"就是假话。
        if (landed && (typeof field.fieldId !== 'string' || !landed.has(field.fieldId))) return undefined;
        // 句柄无法解析时无法判断是否 sensitive，只记 target，不记值。
        // 同时 planFormFill 会拒掉 unknown fieldIds，所以不丢失真实功能。
        if (!handle) return { target };
        return {
          target,
          ...(typeof field.value === 'string' ? { value: value(field.value) } : {}),
          ...(typeof field.checked === 'boolean' ? { checked: field.checked } : {}),
        };
      };
      const values = entries.map(fillValue).filter((item): item is TrajectoryValue => item !== undefined);
      const steps: TrajectoryStep[] = values.length > 0
        ? [{ ...base, values, ...(values.some((item) => item.sensitive) ? { sensitive: true } : {}) }]
        : [];
      const submit = asRecord(args.submit);
      // 有结果可看时，只有 submitted.status === 'ok' 才算真的点了提交。
      const submitted = asRecord(asRecord(input.details).submitted);
      const hasResult = landed !== undefined || submitted.status !== undefined;
      const submitLanded = !hasResult || submitted.status === 'ok';
      if (submit.fieldId !== undefined && submitLanded) {
        const target = labelTarget(handleOf(submit.fieldId));
        steps.push({ tool: 'browser_click', url, ...(target ? { target } : {}) });
      }
      return steps;
    }
    case 'browser_click': {
      const batch = Array.isArray(args.fieldIds);
      const landed = batch ? landedFieldIds(input.details) : undefined;
      const ids = (batch ? (args.fieldIds as unknown[]) : args.fieldId !== undefined ? [args.fieldId] : [])
        // 批量点击只要一个目标点成就不报错：逐个目标的 outcome 决定哪些真的点到了。
        .filter((id) => !landed || (typeof id === 'string' && landed.has(id)));
      const labels = ids.map((id) => labelTarget(handleOf(id))).filter((label): label is string => Boolean(label));
      const target = labels.length > 0 ? labels.join('、') : selectorTarget(args.selector);
      return [{ ...base, ...(target ? { target } : {}) }];
    }
    case 'browser_type':
    case 'browser_select': {
      const target = selectorTarget(args.selector) ?? '「?」';
      const raw = input.toolName === 'browser_type' ? args.text : args.value;
      return [{ ...base, target, values: [{ target, ...(typeof raw === 'string' ? { value: value(raw) } : {}) }] }];
    }
    case 'browser_press_key': {
      const modifiers = asRecord(args.modifiers);
      const keys = [
        ...(modifiers.ctrl ? ['Ctrl'] : []),
        ...(modifiers.alt ? ['Alt'] : []),
        ...(modifiers.shift ? ['Shift'] : []),
        ...(modifiers.meta ? ['Meta'] : []),
        ...(str(args.key) ? [String(args.key)] : []),
      ];
      return [{ ...base, ...(keys.length > 0 ? { detail: keys.join('+') } : {}) }];
    }
    case 'browser_scroll': {
      const target = labelTarget(handleOf(args.fieldId)) ?? selectorTarget(args.selector);
      return [{ ...base, ...(target ? { target } : {}) }];
    }
    case 'browser_navigate':
    case 'browser_open_tab': {
      const detail = redact(stripUrl(str(args.url)));
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    case 'browser_switch_tab': {
      const detail = redact(stripUrl(input.afterUrl));
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    case 'browser_set_storage': {
      // 只记键名：storage 的值常常就是 token。
      const area = args.area === 'session' ? 'sessionStorage' : 'localStorage';
      const key = str(args.key);
      return [{ ...base, ...(key ? { detail: `${area}.${clip(redact(key), MAX_TRAJECTORY_LABEL_CHARS)}` } : {}) }];
    }
    case 'browser_modify_dom': {
      const selector = selectorTarget(args.selector);
      const action = str(args.action);
      const detail = [action, selector].filter(Boolean).join(' ');
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    case 'browser_set_style': {
      const selector = selectorTarget(args.selector);
      const properties = Object.keys(asRecord(args.styles));
      const detail = selector
        ? `${selector}${properties.length > 0 ? ` { ${properties.map((p) => clip(redact(p), 40)).join(', ')} }` : ''}`
        : undefined;
      return [{ ...base, ...(detail ? { detail } : {}) }];
    }
    default:
      return [base];
  }
}
