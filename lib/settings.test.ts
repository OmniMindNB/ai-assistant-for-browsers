import { describe, expect, it } from 'vitest';
import {
  applyPresetToDraft,
  CUSTOM_PRESET,
  CUSTOM_PRESET_VALUE,
  draftPlaceholders,
  hasDuplicateProviderName,
  resolvePresetSelection,
  resolveProviderApi,
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

  it('fills empty fields from the preset when editing', () => {
    const { draft } = applyPresetToDraft(baseDraft, '', preset, true);
    expect(draft.name).toBe('DeepSeek');
    expect(draft.baseURL).toBe('https://api.deepseek.com');
    expect(draft.model).toBe('deepseek-v4-pro');
  });

  it('when editing, does not overwrite an existing baseURL (regression: previously always overwrote)', () => {
    const draft = { ...baseDraft, baseURL: 'https://my-proxy.example.com' };
    const result = applyPresetToDraft(draft, '', preset, true);
    expect(result.draft.baseURL).toBe('https://my-proxy.example.com');
  });

  it('when editing, does not overwrite existing name or model', () => {
    const draft = { ...baseDraft, name: 'Custom', model: 'custom-model' };
    const result = applyPresetToDraft(draft, '', preset, true);
    expect(result.draft.name).toBe('Custom');
    expect(result.draft.model).toBe('custom-model');
  });

  it('when editing, leaves extrasText untouched even though the preset has other models', () => {
    const result = applyPresetToDraft(baseDraft, '', preset, true);
    expect(result.extrasText).toBe('');
  });

  it('when editing, does not overwrite existing extrasText', () => {
    const result = applyPresetToDraft(baseDraft, 'my-custom-model', preset, true);
    expect(result.extrasText).toBe('my-custom-model');
  });

  describe('when adding a new (unsaved) provider', () => {
    const openai = { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

    it('overwrites fields already filled by a previously-selected preset, but leaves extrasText untouched', () => {
      const afterDeepSeek = applyPresetToDraft(baseDraft, 'my-custom-model', preset, false);
      const afterOpenAI = applyPresetToDraft(afterDeepSeek.draft, afterDeepSeek.extrasText, openai, false);
      expect(afterOpenAI.draft.name).toBe('OpenAI');
      expect(afterOpenAI.draft.baseURL).toBe('https://api.openai.com/v1');
      expect(afterOpenAI.draft.model).toBe('gpt-4o-mini');
      expect(afterOpenAI.extrasText).toBe('my-custom-model');
    });

    it('overwrites even fields the user manually typed, since nothing is saved yet', () => {
      const draft = { ...baseDraft, name: 'My Draft Name' };
      const result = applyPresetToDraft(draft, '', preset, false);
      expect(result.draft.name).toBe('DeepSeek');
    });
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

describe('resolveProviderApi', () => {
  it('defaults to openai-completions when api is not configured', () => {
    expect(resolveProviderApi(baseDraft)).toBe('openai-completions');
  });

  it('returns openai-completions when explicitly configured', () => {
    expect(resolveProviderApi({ ...baseDraft, api: 'openai-completions' })).toBe('openai-completions');
  });

  it('returns anthropic-messages when explicitly configured', () => {
    expect(resolveProviderApi({ ...baseDraft, api: 'anthropic-messages' })).toBe('anthropic-messages');
  });
});

describe('resolvePresetSelection', () => {
  it('returns the empty custom preset for the sentinel value', () => {
    expect(resolvePresetSelection(CUSTOM_PRESET_VALUE)).toEqual({
      name: '',
      baseURL: '',
      model: '',
    });
  });

  it('returns the matching built-in preset by name', () => {
    const preset = resolvePresetSelection('DeepSeek');
    expect(preset?.baseURL).toBe('https://api.deepseek.com');
  });

  it('returns undefined for the empty placeholder value', () => {
    expect(resolvePresetSelection('')).toBeUndefined();
  });

  it('returns undefined for an unknown vendor name', () => {
    expect(resolvePresetSelection('NoSuchVendor')).toBeUndefined();
  });
});

describe('applyPresetToDraft with the custom (empty) preset', () => {
  const filled: ProviderConfig = {
    id: '',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-keep-me',
    model: 'deepseek-v4-pro',
    api: 'anthropic-messages',
  };

  it('clears name/baseURL/model when adding a new provider', () => {
    const { draft } = applyPresetToDraft(filled, 'extra-a', CUSTOM_PRESET, false);
    expect(draft.name).toBe('');
    expect(draft.baseURL).toBe('');
    expect(draft.model).toBe('');
  });

  it('leaves apiKey, api and extrasText untouched when adding a new provider', () => {
    const result = applyPresetToDraft(filled, 'extra-a', CUSTOM_PRESET, false);
    expect(result.draft.apiKey).toBe('sk-keep-me');
    expect(result.draft.api).toBe('anthropic-messages');
    expect(result.extrasText).toBe('extra-a');
  });

  it('does not clear already-saved values when editing an existing provider', () => {
    const { draft } = applyPresetToDraft(filled, '', CUSTOM_PRESET, true);
    expect(draft.name).toBe('DeepSeek');
    expect(draft.baseURL).toBe('https://api.deepseek.com');
    expect(draft.model).toBe('deepseek-v4-pro');
  });
});

describe('draftPlaceholders', () => {
  it('gives vendor-neutral examples for the custom selection', () => {
    const p = draftPlaceholders(CUSTOM_PRESET_VALUE);
    expect(p.name).toBe('例如 我的中转站');
    expect(p.baseURL).toBe('https://your-host/v1');
    expect(p.model).toBe('例如 gpt-4o');
    expect(p.extras).toBe('例如 gpt-4o-mini, o3-mini');
  });

  it('never mentions DeepSeek under the custom selection', () => {
    const p = draftPlaceholders(CUSTOM_PRESET_VALUE);
    expect(JSON.stringify(p)).not.toContain('deepseek');
  });

  it('uses the selected preset own values as examples', () => {
    const p = draftPlaceholders('OpenAI');
    expect(p.name).toBe('例如 OpenAI');
    expect(p.baseURL).toBe('https://api.openai.com/v1');
    expect(p.model).toBe('gpt-5.6-sol');
    expect(p.extras).toBe('例如 gpt-5.6-terra, gpt-5.6-luna');
  });

  it('keeps the existing DeepSeek-flavoured examples for the empty placeholder state', () => {
    const p = draftPlaceholders('');
    expect(p.name).toBe('例如 DeepSeek');
    expect(p.baseURL).toBe('https://api.deepseek.com');
    expect(p.model).toBe('deepseek-v4-pro');
    expect(p.extras).toBe('例如 deepseek-v4-flash');
  });

  it('falls back to the default placeholders for an unknown vendor name', () => {
    expect(draftPlaceholders('NoSuchVendor')).toEqual(draftPlaceholders(''));
  });
});
