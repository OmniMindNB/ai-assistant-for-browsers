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
  /** 协议类型；缺省按 'openai-completions' 处理（兼容未设置该字段的历史配置） */
  api?: 'openai-completions' | 'anthropic-messages';
}

export interface Settings {
  activeProviderId?: string;
  providers: ProviderConfig[];
}

/**
 * 常用 OpenAI 兼容 Provider 预设（用于「设置」页快速填充）。
 * model/models 按各厂商官方文档核对（2026-07），moonshot-v1/qwen-plus/glm-4-flash 等旧模型
 * 已停用或被取代，deepseek-chat/deepseek-reasoner 亦即将下线。
 * 默认模型统一取各厂商当前最新旗舰（能力最强档位），其余档位放入 models 供「其他可用模型」参考。
 */
export const PROVIDER_PRESETS: Array<Omit<ProviderConfig, 'id' | 'apiKey'>> = [
  {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  },
  {
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
  },
  {
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    models: ['glm-5.2', 'glm-4.7', 'glm-4.7-flash'],
  },
  {
    name: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
  },
  {
    name: '本地 (Ollama)',
    baseURL: 'http://localhost:11434/v1',
    model: 'llama3.1',
    models: ['llama3.1', 'qwen3', 'deepseek-r1'],
  },
];

/**
 * 「自定义」在「快速预设」下拉中的哨兵值。
 * `__` 前缀确保不与任何 PROVIDER_PRESETS.name 冲突。
 */
export const CUSTOM_PRESET_VALUE: string = '__custom__';

/**
 * 「自定义」= 一个空预设：语义上等价于「不套用任何厂商」。
 * 穿过 applyPresetToDraft 时，添加态（!isEditing）整体覆盖 → 清空字段；
 * 编辑态（isEditing）「非空不覆盖」→ 已保存的值不被误清。
 */
export const CUSTOM_PRESET: Omit<ProviderConfig, 'id' | 'apiKey'> = {
  name: '',
  baseURL: '',
  model: '',
};

/** 下拉值 → 预设；返回 undefined 表示占位符态（不做任何填充）。 */
export function resolvePresetSelection(
  value: string,
): Omit<ProviderConfig, 'id' | 'apiKey'> | undefined {
  // 哨兵优先判断：即使将来出现同名预设也不会被误解析。
  if (value === CUSTOM_PRESET_VALUE) return CUSTOM_PRESET;
  return PROVIDER_PRESETS.find((p) => p.name === value);
}

/** 「添加/编辑 Provider」表单四个输入框的 placeholder 文案。 */
export interface DraftPlaceholders {
  name: string;
  baseURL: string;
  model: string;
  extras: string;
}

/** 自定义态：示例必须与具体厂商无关，否则会误导用户以为该字段有固定取值。 */
const CUSTOM_PLACEHOLDERS: DraftPlaceholders = {
  name: '例如 我的中转站',
  baseURL: 'https://your-host/v1',
  model: '例如 gpt-4o',
  extras: '例如 gpt-4o-mini, o3-mini',
};

/** 占位符态（尚未选择任何预设）沿用既有的 DeepSeek 风格示例。 */
const DEFAULT_PLACEHOLDERS: DraftPlaceholders = {
  name: '例如 DeepSeek',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  extras: '例如 deepseek-v4-flash',
};

/**
 * 下拉值 → 各输入框 placeholder。
 * 「其他可用模型」不被任何预设填充，故其 placeholder 需随选中预设切换，展示该厂商的其他模型示例。
 */
export function draftPlaceholders(value: string): DraftPlaceholders {
  if (value === CUSTOM_PRESET_VALUE) return CUSTOM_PLACEHOLDERS;
  const preset = PROVIDER_PRESETS.find((p) => p.name === value);
  if (!preset) return DEFAULT_PLACEHOLDERS;
  const extras = (preset.models ?? []).filter((m) => m !== preset.model);
  return {
    name: `例如 ${preset.name}`,
    baseURL: preset.baseURL,
    model: preset.model,
    extras: extras.length ? `例如 ${extras.join(', ')}` : DEFAULT_PLACEHOLDERS.extras,
  };
}

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

/** 解析 Provider 的协议类型；未显式配置时统一按 OpenAI 兼容处理（历史配置兼容）。 */
export function resolveProviderApi(provider: ProviderConfig): 'openai-completions' | 'anthropic-messages' {
  return provider.api ?? 'openai-completions';
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
 * 将预设应用到草稿；「其他可用模型」文本框不受预设影响，始终保留用户输入。
 * 编辑已有 Provider 时（isEditing）仅在字段为空时填充，避免误触预设下拉静默丢失已保存的自定义值。
 * 添加新 Provider 时（!isEditing）草稿本就未保存，直接用预设值整体覆盖，
 * 使「快速预设」可在多个预设间自由切换比对，而不会被上一次选择的预设「锁死」。
 */
export function applyPresetToDraft(
  draft: ProviderConfig,
  extrasText: string,
  preset: Omit<ProviderConfig, 'id' | 'apiKey'>,
  isEditing: boolean,
): { draft: ProviderConfig; extrasText: string } {
  if (!isEditing) {
    return {
      draft: { ...draft, name: preset.name, baseURL: preset.baseURL, model: preset.model },
      extrasText,
    };
  }
  const nextDraft: ProviderConfig = {
    ...draft,
    name: draft.name || preset.name,
    baseURL: draft.baseURL || preset.baseURL,
    model: draft.model || preset.model,
  };
  return { draft: nextDraft, extrasText };
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
