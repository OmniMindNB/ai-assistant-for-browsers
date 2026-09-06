// 工具预算档位：把 tool-policy.ts 的两个数字暴露成一个用户可选的档位。
// 存于 chrome.storage.local，不同步到云端（与 lib/theme.ts、lib/shortcuts.ts 同一套惯例）。
//
// 为什么是档位而不是两个数字输入框：读档和写档的合理取值互相牵制（读档太小会逼着模型
// 在信息不足时动手），让用户自由填两个数只会把这层耦合甩给用户。
import { DEFAULT_READ_TOOL_CALL_BUDGET, DEFAULT_WRITE_TOOL_CALL_BUDGET } from './system-prompt';

export const TOOL_BUDGET_STORAGE_KEY = 'runi:tool-budget-profile';

export type ToolBudgetProfileId = 'standard' | 'generous';

export interface ToolBudgetProfile {
  /** 写入开始前的读取额度。 */
  readToolCallBudget: number;
  /** 写入获批后在已用次数之上追加的额度（ref: tool-policy.ts 的 writePhaseStart）。 */
  writeToolCallBudget: number;
}

export const DEFAULT_TOOL_BUDGET_PROFILE_ID: ToolBudgetProfileId = 'standard';

export const TOOL_BUDGET_PROFILES: Record<ToolBudgetProfileId, ToolBudgetProfile> = {
  // 与不选任何档位时的出厂常量保持同一组数字，由 budget-profile.test.ts 钉住。
  standard: {
    readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
    writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
  },
  // 长表单、跨页面流程这类本来就需要几十步的任务用；代价是跑偏时也会跑得更久，
  // 所以不设成默认值。
  generous: {
    readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET * 2,
    writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET * 2,
  },
};

export const TOOL_BUDGET_PROFILE_IDS = Object.keys(TOOL_BUDGET_PROFILES) as ToolBudgetProfileId[];

function isProfileId(value: unknown): value is ToolBudgetProfileId {
  return typeof value === 'string' && value in TOOL_BUDGET_PROFILES;
}

/** 未知档位（例如旧版本写进存储、这一版已经不认识的名字）一律回落到标准档。 */
export function resolveToolBudgetProfile(id: unknown): ToolBudgetProfile {
  return TOOL_BUDGET_PROFILES[isProfileId(id) ? id : DEFAULT_TOOL_BUDGET_PROFILE_ID];
}

export async function loadToolBudgetProfileId(): Promise<ToolBudgetProfileId> {
  const res = await browser.storage.local.get(TOOL_BUDGET_STORAGE_KEY);
  const stored = res[TOOL_BUDGET_STORAGE_KEY];
  return isProfileId(stored) ? stored : DEFAULT_TOOL_BUDGET_PROFILE_ID;
}

export async function saveToolBudgetProfileId(id: ToolBudgetProfileId): Promise<void> {
  await browser.storage.local.set({ [TOOL_BUDGET_STORAGE_KEY]: id });
}
