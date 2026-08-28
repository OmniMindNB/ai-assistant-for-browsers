export type TaskOutcomeValue = 'success' | 'partial' | 'failure';

export interface TaskOutcome {
  outcome: TaskOutcomeValue;
  /** 模型给出的一句话原因；partial/failure 时应说明卡在哪里。 */
  reason: string;
}

export const REPORT_TASK_OUTCOME_TOOL_NAME = 'report_task_outcome';
