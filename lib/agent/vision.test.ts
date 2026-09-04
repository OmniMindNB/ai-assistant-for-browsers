import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@/lib/settings';
import { supportsVision } from './vision';

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'Test',
    baseURL: 'https://example.com/v1',
    apiKey: 'k',
    model: 'model-a',
    models: ['model-a', 'model-b'],
    ...overrides,
  };
}

describe('supportsVision', () => {
  it('模型在 visionModels 里时返回 true', () => {
    expect(supportsVision(provider({ visionModels: ['model-b'] }), 'model-b')).toBe(true);
  });

  it('模型不在 visionModels 里时返回 false', () => {
    expect(supportsVision(provider({ visionModels: ['model-b'] }), 'model-a')).toBe(false);
  });

  // 历史配置没有这个字段；默认必须是"不支持"，宁可少一个工具，也不要给
  // 本地小模型发图片直接把整轮打断。
  it('缺少 visionModels 字段时返回 false', () => {
    expect(supportsVision(provider(), 'model-a')).toBe(false);
  });

  it('visionModels 为空数组时返回 false', () => {
    expect(supportsVision(provider({ visionModels: [] }), 'model-a')).toBe(false);
  });

  it('provider 或 modelId 缺失时返回 false', () => {
    expect(supportsVision(undefined, 'model-a')).toBe(false);
    expect(supportsVision(provider({ visionModels: ['model-a'] }), undefined)).toBe(false);
  });

  it('比较时忽略首尾空白', () => {
    expect(supportsVision(provider({ visionModels: [' model-a '] }), 'model-a')).toBe(true);
  });
});
