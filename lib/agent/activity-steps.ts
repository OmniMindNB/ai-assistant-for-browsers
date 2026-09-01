export interface ActivityStep {
  id: string;
  description: string;
  status: 'running' | 'done' | 'failed';
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
