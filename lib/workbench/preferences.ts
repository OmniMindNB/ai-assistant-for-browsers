export const WORKBENCH_PREFERENCES_KEY = 'workbenchPreferences';

export type WorkbenchMode = 'ask' | 'agent';

export interface WorkbenchPreferences {
  defaultMode: WorkbenchMode;
  attachPageByDefault: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  defaultMode: 'ask',
  attachPageByDefault: true,
};

export async function loadWorkbenchPreferences(): Promise<WorkbenchPreferences> {
  const stored = (await browser.storage.local.get(WORKBENCH_PREFERENCES_KEY))[WORKBENCH_PREFERENCES_KEY];
  if (stored === undefined) return DEFAULT_WORKBENCH_PREFERENCES;
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !['ask', 'agent'].includes((stored as { defaultMode?: string }).defaultMode ?? '') ||
    typeof (stored as { attachPageByDefault?: unknown }).attachPageByDefault !== 'boolean'
  ) {
    throw new Error('Invalid workbench preferences');
  }
  return stored as WorkbenchPreferences;
}

export async function saveWorkbenchPreferences(value: WorkbenchPreferences): Promise<void> {
  await browser.storage.local.set({ [WORKBENCH_PREFERENCES_KEY]: value });
}
