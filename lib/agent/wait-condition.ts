// browser_wait_for 的参数解析与结果文案。纯函数，不碰 DOM、不发消息，
// 这样等待条件的边界与措辞可以脱离浏览器环境测试。

export type WaitConditionKind = 'appear' | 'disappear' | 'textContains' | 'domIdle';

export interface WaitCondition {
  kind: WaitConditionKind;
  selector?: string;
  text?: string;
  idleMs: number;
  timeoutMs: number;
}

export interface WaitOutcome {
  met: boolean;
  elapsedMs: number;
  /** appear/disappear 命中时匹配到的元素数。 */
  matched?: number;
  /** 页面内错误（例如非法选择器）；有值时工具抛出，让模型修正参数。 */
  error?: string;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 5000;
export const MIN_WAIT_TIMEOUT_MS = 500;
/** 硬上限：一次盲等不应吃掉整轮时间。 */
export const MAX_WAIT_TIMEOUT_MS = 15000;
export const DEFAULT_DOM_IDLE_MS = 500;
const MIN_DOM_IDLE_MS = 100;
const MAX_DOM_IDLE_MS = 5000;

const KINDS: WaitConditionKind[] = ['appear', 'disappear', 'textContains', 'domIdle'];

export function parseWaitCondition(
  params: unknown,
): { ok: true; condition: WaitCondition } | { ok: false; error: string } {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const kind = record.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as WaitConditionKind)) {
    return { ok: false, error: `未知的等待条件 "${String(kind)}"，只支持：${KINDS.join('、')}。` };
  }

  const selector = typeof record.selector === 'string' ? record.selector.trim() : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';

  if ((kind === 'appear' || kind === 'disappear') && !selector) {
    return { ok: false, error: `${kind} 条件必须提供 selector。` };
  }
  if (kind === 'textContains' && !text) {
    return { ok: false, error: 'textContains 条件必须提供 text。' };
  }

  return {
    ok: true,
    condition: {
      kind: kind as WaitConditionKind,
      ...(selector ? { selector } : {}),
      ...(kind === 'textContains' ? { text } : {}),
      idleMs: clamp(record.idleMs, DEFAULT_DOM_IDLE_MS, MIN_DOM_IDLE_MS, MAX_DOM_IDLE_MS),
      timeoutMs: clamp(record.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
    },
  };
}

export function describeWaitResult(condition: WaitCondition, outcome: WaitOutcome): string {
  if (!outcome.met) {
    return [
      `等待超时：${condition.timeoutMs}ms 内未满足条件（${describeCondition(condition)}），实际等待 ${outcome.elapsedMs}ms。`,
      '页面可能仍在加载，也可能是条件本身写错了。不要原样重试——先用 browser_get_form 或 browser_read_page 确认页面当前状态。',
    ].join('\n');
  }

  switch (condition.kind) {
    case 'appear':
      return `等待成功：选择器 "${condition.selector}" 已出现（匹配 ${outcome.matched ?? 0} 个元素），耗时 ${outcome.elapsedMs}ms。`;
    case 'disappear':
      return `等待成功：选择器 "${condition.selector}" 已消失，耗时 ${outcome.elapsedMs}ms。`;
    case 'textContains':
      return `等待成功：${condition.selector ? `"${condition.selector}" 内` : '页面上'}已出现文本 "${condition.text}"，耗时 ${outcome.elapsedMs}ms。`;
    case 'domIdle':
      return `等待成功：页面 DOM 已连续 ${condition.idleMs}ms 无变动，耗时 ${outcome.elapsedMs}ms。`;
  }
}

function describeCondition(condition: WaitCondition): string {
  switch (condition.kind) {
    case 'appear':
      return `等待 "${condition.selector}" 出现`;
    case 'disappear':
      return `等待 "${condition.selector}" 消失`;
    case 'textContains':
      return `等待文本 "${condition.text}" 出现`;
    case 'domIdle':
      return `等待 DOM 连续 ${condition.idleMs}ms 无变动`;
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
