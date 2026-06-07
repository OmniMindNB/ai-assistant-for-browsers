// 扩展配置（API Key / Provider / 模型）存储封装。
// 使用 chrome.storage.local，不同步到云端（ref: technical-plan.md §6 隐私）。

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  activeProviderId?: string;
  providers: ProviderConfig[];
}

const STORAGE_KEY = 'aluminum:settings';

const DEFAULT_SETTINGS: Settings = {
  providers: [],
};

export async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as Settings) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: settings });
}
