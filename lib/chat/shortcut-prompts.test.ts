import { describe, expect, it } from 'vitest';
import type { Translate } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import { buildExplainSelectionPrompt, buildSummarizePagePrompt } from './shortcut-prompts';

const translate = (dict: Record<keyof typeof zh, string>): Translate =>
  ((key) => dict[key]) as Translate;

describe('shortcut action prompts', () => {
  it('asks for an English summary in the English UI', () => {
    const prompt = buildSummarizePagePrompt(translate(en));
    expect(prompt).toContain('Summarize the current page');
    expect(prompt).toContain('Respond in English');
  });

  it('asks for a Chinese summary in the Chinese UI', () => {
    const prompt = buildSummarizePagePrompt(translate(zh));
    expect(prompt).toContain('总结');
    expect(prompt).toContain('请使用中文回答');
  });

  it('keeps the selected text and asks for an English explanation', () => {
    const prompt = buildExplainSelectionPrompt(translate(en), '选择的原文', 4000);
    expect(prompt).toContain('Explain the selected text');
    expect(prompt).toContain('Respond in English');
    expect(prompt).toContain('\"\"\"选择的原文\"\"\"');
  });

  it('keeps the selected text and asks for a Chinese explanation', () => {
    const prompt = buildExplainSelectionPrompt(translate(zh), 'selected source', 4000);
    expect(prompt).toContain('解释以下选中的内容');
    expect(prompt).toContain('请使用中文回答');
    expect(prompt).toContain('\"\"\"selected source\"\"\"');
  });

  it('preserves the existing selection character limit', () => {
    const prompt = buildExplainSelectionPrompt(translate(en), 'x'.repeat(4001), 4000);
    expect(prompt).toContain(`\"\"\"${'x'.repeat(4000)}\"\"\"`);
    expect(prompt).not.toContain('x'.repeat(4001));
  });
});
