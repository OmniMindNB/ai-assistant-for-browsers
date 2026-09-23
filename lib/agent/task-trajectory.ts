// 任务回放的参考轨迹：一次成功运行里改变过页面的工具调用，整理成人能读、模型能照着走的步骤
// （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §3）。
//
// 这个文件只放类型、上限和纯渲染——面板、设置页、lib/shortcuts.ts 都要 import 它，
// 所以它不能依赖 permissions.ts / 脱敏这类 background 侧的东西；那一半在 trajectory-recorder.ts。

import type { Translate } from '@/lib/i18n';

export interface TrajectoryValue {
  /** 人读的字段名，已带书名号：「报销金额」。 */
  target: string;
  /** 文本类写入值，已脱敏、已截断。 */
  value?: string;
  /** 勾选类字段的目标状态。 */
  checked?: boolean;
  /** 密码/支付字段：值从未写入也从未记录（planFormFill 在到达页面前就丢掉了它）。 */
  sensitive?: boolean;
}

export interface TrajectoryStep {
  tool: string;
  /** 执行时目标页的 origin + pathname；query/hash 里常有订单号和 token，一律不留。 */
  url: string;
  /**
   * 人读的操作对象：按标签定位时是「下一步」，只能退回选择器时是 `button.submit`。
   * fieldId 不进来——它按元素身份分配，跨页面加载必然失效（见 field-id-allocation.ts）。
   */
  target?: string;
  values?: TrajectoryValue[];
  /** 其余关键参数的摘要：按键、跳转地址、存储键、DOM 操作类型等。 */
  detail?: string;
  /** 这一步涉及 sensitive 字段。 */
  sensitive?: boolean;
}

export const MAX_TRAJECTORY_STEPS = 50;
export const MAX_TRAJECTORY_VALUE_CHARS = 500;
export const MAX_TRAJECTORY_LABEL_CHARS = 120;

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function clipString(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function parseValue(raw: unknown): TrajectoryValue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.target !== 'string' || !item.target) return null;
  if (!isOptionalString(item.value) || (item.value?.length ?? 0) > MAX_TRAJECTORY_VALUE_CHARS) return null;
  if (item.checked !== undefined && typeof item.checked !== 'boolean') return null;
  if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') return null;

  // 存储不可信：手改过的条目可能在 sensitive 字段上还装着值。
  // 不是拒绝它，而是规范化：sensitive=true 时只保留 target，丢掉 value 和 checked。
  // 这样不管存储里是什么，业务不变量（敏感字段的值从不进轨迹）依然在这个边界上成立。
  if (item.sensitive) {
    return {
      target: clipString(item.target, MAX_TRAJECTORY_VALUE_CHARS) || item.target,
      sensitive: true,
    };
  }

  const clippedTarget = clipString(item.target, MAX_TRAJECTORY_VALUE_CHARS) || item.target;
  return {
    target: clippedTarget,
    ...(item.value !== undefined ? { value: item.value } : {}),
    ...(item.checked !== undefined ? { checked: item.checked as boolean } : {}),
  };
}

/**
 * 存储里读回来的轨迹一律当不可信数据：用户可能手改过 storage，也可能是别的版本写的。
 * 返回只含已知字段的干净副本；任何一处不合法就整体返回 null，由调用方决定怎么报错。
 */
export function parseTrajectory(value: unknown): TrajectoryStep[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRAJECTORY_STEPS) return null;
  const steps: TrajectoryStep[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.tool !== 'string' || !item.tool) return null;
    if (typeof item.url !== 'string') return null;
    if (!isOptionalString(item.target) || !isOptionalString(item.detail)) return null;
    if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') return null;
    let values: TrajectoryValue[] | undefined;
    if (item.values !== undefined) {
      if (!Array.isArray(item.values)) return null;
      values = [];
      for (const rawValue of item.values) {
        const parsed = parseValue(rawValue);
        if (!parsed) return null;
        values.push(parsed);
      }
    }
    const clippedTarget = clipString(item.target as string | undefined, MAX_TRAJECTORY_VALUE_CHARS);
    const clippedDetail = clipString(item.detail as string | undefined, MAX_TRAJECTORY_VALUE_CHARS);
    steps.push({
      tool: item.tool,
      url: clipString(item.url, MAX_TRAJECTORY_VALUE_CHARS) ?? item.url,
      ...(clippedTarget !== undefined ? { target: clippedTarget } : {}),
      ...(values ? { values } : {}),
      ...(clippedDetail !== undefined ? { detail: clippedDetail } : {}),
      ...(item.sensitive ? { sensitive: true } : {}),
    });
  }
  return steps;
}

function describeValue(value: TrajectoryValue, translate: Translate): string {
  if (value.sensitive) return translate('trajectory.fillSensitive', { target: value.target });
  if (value.checked === true) return translate('trajectory.fillChecked', { target: value.target });
  if (value.checked === false) return translate('trajectory.fillUnchecked', { target: value.target });
  return translate('trajectory.fillValue', { target: value.target, value: JSON.stringify(value.value ?? '') });
}

/**
 * 一步的人读描述。保存抽屉和回放 prompt 共用这一个函数：用户在抽屉里看到的，
 * 就是模型将收到的，两边不能各写一份。写入值用 JSON.stringify 包起来，边界一眼可见。
 */
export function describeTrajectoryStep(step: TrajectoryStep, translate: Translate): string {
  const target = step.target ?? translate('trajectory.someField');
  const detail = step.detail ?? '';
  switch (step.tool) {
    case 'browser_fill_form': {
      const values = step.values ?? [];
      if (values.length === 1) return describeValue(values[0], translate);
      return translate('trajectory.fillList', {
        items: values.map((value) => describeValue(value, translate)).join(translate('trajectory.listSeparator')),
      });
    }
    case 'browser_click':
      return step.target ? translate('trajectory.click', { target: step.target }) : translate('trajectory.clickUnknown');
    case 'browser_type':
      return translate('trajectory.type', { target, value: JSON.stringify(step.values?.[0]?.value ?? '') });
    case 'browser_select':
      return translate('trajectory.select', { target, value: JSON.stringify(step.values?.[0]?.value ?? '') });
    case 'browser_press_key':
      return translate('trajectory.pressKey', { detail });
    case 'browser_scroll':
      return step.target ? translate('trajectory.scrollTo', { target: step.target }) : translate('trajectory.scroll');
    case 'browser_navigate':
      return translate('trajectory.navigate', { detail });
    case 'browser_open_tab':
      return translate('trajectory.openTab', { detail });
    case 'browser_switch_tab':
      return translate('trajectory.switchTab', { detail });
    case 'browser_close_tab':
      return translate('trajectory.closeTab');
    case 'browser_go_back':
      return translate('trajectory.goBack');
    case 'browser_set_storage':
      return translate('trajectory.setStorage', { detail });
    case 'browser_modify_dom':
      return translate('trajectory.modifyDom', { detail });
    case 'browser_set_style':
      return translate('trajectory.setStyle', { detail });
    default:
      return translate('trajectory.generic', { tool: step.tool, detail });
  }
}

/** 回放 prompt 里的步骤清单：编号 + 所在页面；连续同页写成「同上」，省 token 也更好读。 */
export function renderTrajectoryForPrompt(steps: readonly TrajectoryStep[], translate: Translate): string {
  let previousUrl: string | undefined;
  return steps
    .map((step, index) => {
      const where = !step.url ? '' : step.url === previousUrl ? `[${translate('trajectory.sameUrl')}] ` : `[${step.url}] `;
      if (step.url) previousUrl = step.url;
      return `${index + 1}. ${where}${describeTrajectoryStep(step, translate)}`;
    })
    .join('\n');
}
