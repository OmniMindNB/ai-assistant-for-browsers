import { describe, expect, it } from 'vitest';
import {
  applyPresetToDraft,
  hasDuplicateProviderName,
  trimProviderDraft,
  type ProviderConfig,
} from './settings';

const baseDraft: ProviderConfig = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
};

describe('trimProviderDraft', () => {
  it('trims leading/trailing whitespace from name, baseURL, model, and apiKey', () => {
    const draft: ProviderConfig = {
      ...baseDraft,
      name: '  DeepSeek  ',
      baseURL: ' https://api.deepseek.com \n',
      apiKey: ' sk-abc123 \n',
      model: ' deepseek-v4-pro ',
    };
    expect(trimProviderDraft(draft)).toEqual({
      ...baseDraft,
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-abc123',
      model: 'deepseek-v4-pro',
    });
  });

  it('leaves already-trimmed values unchanged', () => {
    const draft: ProviderConfig = {
      ...baseDraft,
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-4o-mini',
    };
    expect(trimProviderDraft(draft)).toEqual(draft);
  });

  it('preserves id and models', () => {
    const draft: ProviderConfig = { ...baseDraft, id: 'p-1', name: ' A ', models: ['a', 'b'] };
    expect(trimProviderDraft(draft)).toEqual({ ...draft, name: 'A' });
  });
});

describe('applyPresetToDraft', () => {
  const preset = {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  };

  it('fills empty fields from the preset', () => {
    const { draft } = applyPresetToDraft(baseDraft, '', preset);
    expect(draft.name).toBe('DeepSeek');
    expect(draft.baseURL).toBe('https://api.deepseek.com');
    expect(draft.model).toBe('deepseek-v4-pro');
  });

  it('does not overwrite an existing baseURL (regression: previously always overwrote)', () => {
    const draft = { ...baseDraft, baseURL: 'https://my-proxy.example.com' };
    const result = applyPresetToDraft(draft, '', preset);
    expect(result.draft.baseURL).toBe('https://my-proxy.example.com');
  });

  it('does not overwrite existing name or model', () => {
    const draft = { ...baseDraft, name: 'Custom', model: 'custom-model' };
    const result = applyPresetToDraft(draft, '', preset);
    expect(result.draft.name).toBe('Custom');
    expect(result.draft.model).toBe('custom-model');
  });

  it("backfills extrasText with the preset's other models when extrasText is empty", () => {
    const result = applyPresetToDraft(baseDraft, '', preset);
    expect(result.extrasText).toBe('deepseek-v4-flash');
  });

  it('does not overwrite existing extrasText', () => {
    const result = applyPresetToDraft(baseDraft, 'my-custom-model', preset);
    expect(result.extrasText).toBe('my-custom-model');
  });

  it('produces empty extrasText when the preset has no extra models', () => {
    const singleModelPreset = {
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    };
    const result = applyPresetToDraft(baseDraft, '', singleModelPreset);
    expect(result.extrasText).toBe('');
  });
});

describe('hasDuplicateProviderName', () => {
  const providers: ProviderConfig[] = [
    { id: 'p-1', name: 'DeepSeek', baseURL: 'x', apiKey: '', model: 'm' },
    { id: 'p-2', name: 'OpenAI', baseURL: 'x', apiKey: '', model: 'm' },
  ];

  it('returns true when another provider has the same trimmed name', () => {
    expect(hasDuplicateProviderName(providers, ' DeepSeek ')).toBe(true);
  });

  it('returns false when no other provider matches', () => {
    expect(hasDuplicateProviderName(providers, 'Moonshot')).toBe(false);
  });

  it('excludes the provider being edited via excludeId', () => {
    expect(hasDuplicateProviderName(providers, 'DeepSeek', 'p-1')).toBe(false);
  });

  it('returns false for an empty/whitespace-only name', () => {
    expect(hasDuplicateProviderName(providers, '   ')).toBe(false);
  });
});
