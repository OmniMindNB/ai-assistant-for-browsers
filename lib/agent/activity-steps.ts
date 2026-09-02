export interface ActivityStep {
  id: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  /** 当前操作目标标签页的标题；只在目标不是面板自己绑定的 tab 时才有值（同 confirm-summary.ts 的约定）。 */
  tabLabel?: string;
}

export function upsertActivityStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === step.id);
  if (index === -1) return [...steps, step];
  const next = steps.slice();
  next[index] = step;
  return next;
}

export function finishActivityStep(
  steps: ActivityStep[],
  id: string,
  status: 'done' | 'failed',
  description: string,
): ActivityStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index === -1) return steps;
  const next = steps.slice();
  next[index] = { ...next[index], status, description };
  return next;
}
