// 扩展配置（API Key / Provider / 模型）存储封装。
// 使用 chrome.storage.local，不同步到云端（ref: technical-plan.md §6 隐私）。

import { DEV_PROVIDER } from './dev-config';

export interface ProviderConfig {
  id: string;
  name: string;
  /** OpenAI 兼容的基础地址，至 /v1 为止（不含 /chat/completions） */
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  activeProviderId?: string;
  providers: ProviderConfig[];
}

/** 常用 OpenAI 兼容 Provider 预设（用于「设置」页快速填充） */
export const PROVIDER_PRESETS: Array<Omit<ProviderConfig, 'id' | 'apiKey'>> = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  {
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '本地 (Ollama)', baseURL: 'http://localhost:11434/v1', model: 'llama3.1' },
];

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

/** 返回当前激活的 Provider（无激活项时回退到第一个） */
export async function getActiveProvider(): Promise<ProviderConfig | undefined> {
  const settings = await loadSettings();
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0];
}

/** 生成 Provider 唯一 ID */
export function newProviderId(): string {
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 若 dev-config.ts 中启用了开发 Provider，则在尚未存在时自动注入并设为当前。
 * 仅用于本地开发自测（ref: lib/dev-config.ts）。
 */
export async function ensureDevProvider(): Promise<void> {
  if (!DEV_PROVIDER.enabled || !DEV_PROVIDER.apiKey) return;
  const settings = await loadSettings();
  if (settings.providers.some((p) => p.id === DEV_PROVIDER.id)) return;

  const { enabled: _enabled, ...config } = DEV_PROVIDER;
  settings.providers.push(config);
  if (!settings.activeProviderId) settings.activeProviderId = config.id;
  await saveSettings(settings);
}
