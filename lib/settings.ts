// 扩展配置（API Key / Provider / 模型）存储封装。
// 使用 chrome.storage.local，不同步到云端（ref: technical-plan.md §6 隐私）。

import { DEV_PROVIDER } from './dev-config';

export interface ProviderConfig {
  id: string;
  name: string;
  /** OpenAI 兼容的基础地址，至 /v1 为止（不含 /chat/completions） */
  baseURL: string;
  apiKey: string;
  /** 默认 / 当前选中的模型 */
  model: string;
  /** 该 Provider 下可在输入框切换的全部模型（含 model）；为空时回退到 [model] */
  models?: string[];
}

export interface Settings {
  activeProviderId?: string;
  providers: ProviderConfig[];
}

/** 常用 OpenAI 兼容 Provider 预设（用于「设置」页快速填充） */
export const PROVIDER_PRESETS: Array<Omit<ProviderConfig, 'id' | 'apiKey'>> = [
  {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
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

export const STORAGE_KEY = 'aluminum:settings';

const DEFAULT_SETTINGS: Settings = {
  providers: [],
};

export async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as Settings) ?? DEFAULT_SETTINGS;
}

/** 列出全部已配置 Provider（便于输入框选择器枚举）。 */
export async function listProviders(): Promise<ProviderConfig[]> {
  return (await loadSettings()).providers;
}

/** 返回 Provider 的可用模型列表（保证非空，至少含 model）。 */
export function providerModels(provider: ProviderConfig): string[] {
  return provider.models?.length ? provider.models : [provider.model];
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

/** 保存前统一 trim name/baseURL/model/apiKey，避免粘贴带来的首尾空白静默存入。 */
export function trimProviderDraft(draft: ProviderConfig): ProviderConfig {
  return {
    ...draft,
    name: draft.name.trim(),
    baseURL: draft.baseURL.trim(),
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
  };
}

/**
 * 将预设应用到草稿：仅在字段为空时填充（不覆盖用户已填写的内容）。
 * 「其他可用模型」文本框同理，为空时才用预设中除默认模型外的其余模型回填。
 */
export function applyPresetToDraft(
  draft: ProviderConfig,
  extrasText: string,
  preset: Omit<ProviderConfig, 'id' | 'apiKey'>,
): { draft: ProviderConfig; extrasText: string } {
  const nextDraft: ProviderConfig = {
    ...draft,
    name: draft.name || preset.name,
    baseURL: draft.baseURL || preset.baseURL,
    model: draft.model || preset.model,
  };
  const presetExtras = (preset.models ?? []).filter((m) => m !== preset.model);
  const nextExtrasText = extrasText.trim() ? extrasText : presetExtras.join(', ');
  return { draft: nextDraft, extrasText: nextExtrasText };
}

/** 是否存在另一个（id 不同于 excludeId）Provider 与给定名称（trim 后）重复。 */
export function hasDuplicateProviderName(
  providers: ProviderConfig[],
  name: string,
  excludeId?: string,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return providers.some((p) => p.id !== excludeId && p.name.trim() === trimmed);
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
