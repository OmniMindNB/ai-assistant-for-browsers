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
  /**
   * 执行环境不可用（页面已关闭/导航中/被 CSP 拒绝等），与 error 不同——不是
   * 模型能修正的参数错误，工具不抛异常，走这里的专属文案。
   */
  unavailable?: boolean;
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
  if (outcome.unavailable) {
    return [
      `等待未完成：执行环境不可用（页面可能已关闭、正在导航，或被 CSP 拒绝），已等待 ${outcome.elapsedMs}ms。`,
      '页面在等待过程中就已经发生了变化，不要假设它还是等待前的状态——先用 browser_get_active_tab 或 browser_read_page 重新确认当前页面再决定下一步。',
    ].join('\n');
  }

  if (!outcome.met) {
    const advice =
      condition.kind === 'domIdle'
        ? '页面可能一直有零星变动（进度条、时钟、懒加载类名切换等），domIdle 未必会触发。换成 appear 或 disappear 盯住一个具体元素，而不是继续等"没有变动"。'
        : '页面可能仍在加载，也可能是条件本身写错了。不要原样重试——先用 browser_get_form 或 browser_read_page 确认页面当前状态。';
    return [
      `等待超时：${condition.timeoutMs}ms 内未满足条件（${describeCondition(condition)}），实际等待 ${outcome.elapsedMs}ms。`,
      advice,
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
