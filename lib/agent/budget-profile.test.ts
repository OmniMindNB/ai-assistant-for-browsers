import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READ_TOOL_CALL_BUDGET,
  DEFAULT_WRITE_TOOL_CALL_BUDGET,
} from './system-prompt';
import {
  DEFAULT_TOOL_BUDGET_PROFILE_ID,
  TOOL_BUDGET_PROFILES,
  TOOL_BUDGET_STORAGE_KEY,
  loadToolBudgetProfileId,
  resolveToolBudgetProfile,
  saveToolBudgetProfileId,
  type ToolBudgetProfileId,
} from './budget-profile';

const originalBrowser = (globalThis as any).browser;

function installStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items));
  (globalThis as any).browser = {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set,
      },
    },
  };
  return { data, set };
}

afterEach(() => {
  (globalThis as any).browser = originalBrowser;
});

describe('tool budget profiles', () => {
  // 档位表和提示词/agent 的默认常量必须是同一组数字，否则设置页显示的"标准"
  // 与实际不选任何档位时跑的预算会悄悄分家。
  it('keeps the standard profile equal to the shipped defaults', () => {
    expect(TOOL_BUDGET_PROFILES[DEFAULT_TOOL_BUDGET_PROFILE_ID]).toEqual({
      readToolCallBudget: DEFAULT_READ_TOOL_CALL_BUDGET,
      writeToolCallBudget: DEFAULT_WRITE_TOOL_CALL_BUDGET,
    });
  });

  it('gives the generous profile strictly more room than the standard one', () => {
    const standard = TOOL_BUDGET_PROFILES.standard;
    const generous = TOOL_BUDGET_PROFILES.generous;
    expect(generous.readToolCallBudget).toBeGreaterThan(standard.readToolCallBudget);
    expect(generous.writeToolCallBudget).toBeGreaterThan(standard.writeToolCallBudget);
  });

  it('resolves a known profile id to its budgets', () => {
    expect(resolveToolBudgetProfile('generous')).toEqual(TOOL_BUDGET_PROFILES.generous);
  });

  // 存储里可能留着旧版本写入的、这一版已经不认识的档位名。
  it('falls back to the standard profile for an unknown id', () => {
    expect(resolveToolBudgetProfile('turbo')).toEqual(TOOL_BUDGET_PROFILES.standard);
    expect(resolveToolBudgetProfile(undefined)).toEqual(TOOL_BUDGET_PROFILES.standard);
  });
});

describe('tool budget profile storage', () => {
  it('defaults to the standard profile when nothing is stored', async () => {
    installStorage();
    await expect(loadToolBudgetProfileId()).resolves.toBe(DEFAULT_TOOL_BUDGET_PROFILE_ID);
  });

  it('loads a stored profile id', async () => {
    installStorage({ [TOOL_BUDGET_STORAGE_KEY]: 'generous' satisfies ToolBudgetProfileId });
    await expect(loadToolBudgetProfileId()).resolves.toBe('generous');
  });

  it('ignores a stored value that is no longer a known profile', async () => {
    installStorage({ [TOOL_BUDGET_STORAGE_KEY]: 'turbo' });
    await expect(loadToolBudgetProfileId()).resolves.toBe(DEFAULT_TOOL_BUDGET_PROFILE_ID);
  });

  it('persists the chosen profile under the storage key', async () => {
    const { set } = installStorage();
    await saveToolBudgetProfileId('generous');
    expect(set).toHaveBeenCalledWith({ [TOOL_BUDGET_STORAGE_KEY]: 'generous' });
  });
});
