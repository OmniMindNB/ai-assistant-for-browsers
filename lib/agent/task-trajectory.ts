// 任务回放的参考轨迹：一次成功运行里改变过页面的工具调用，整理成人能读、模型能照着走的步骤
// （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §3）。
//
// 这个文件只放类型、上限和纯渲染——面板、设置页、lib/shortcuts.ts 都要 import 它，
// 所以它不能依赖 permissions.ts / 脱敏这类 background 侧的东西；那一半在 trajectory-recorder.ts。

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
