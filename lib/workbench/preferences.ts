export const WORKBENCH_PREFERENCES_KEY = 'runi:workbench-preferences';

export interface WorkbenchPreferences {
  attachPageByDefault: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  attachPageByDefault: true,
};

export async function loadWorkbenchPreferences(): Promise<WorkbenchPreferences> {
  const stored = (await browser.storage.local.get(WORKBENCH_PREFERENCES_KEY))[WORKBENCH_PREFERENCES_KEY];
  if (stored === undefined) return DEFAULT_WORKBENCH_PREFERENCES;
  if (
    typeof stored !== 'object' ||
    stored === null ||
    typeof (stored as { attachPageByDefault?: unknown }).attachPageByDefault !== 'boolean'
  ) {
    throw new Error('Invalid workbench preferences');
  }
  return stored as WorkbenchPreferences;
}

export async function saveWorkbenchPreferences(value: WorkbenchPreferences): Promise<void> {
  await browser.storage.local.set({ [WORKBENCH_PREFERENCES_KEY]: value });
}
