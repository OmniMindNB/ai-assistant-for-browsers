import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const demoPath = resolve(process.cwd(), 'demo/store-showcase.html');
const assetGeneratorPath = resolve(process.cwd(), 'scripts/generate-store-assets.mjs');
const gitignorePath = resolve(process.cwd(), '.gitignore');

describe('controlled bilingual store showcase', () => {
  it('provides stable interaction targets and localized controlled copy', () => {
    const source = readFileSync(demoPath, 'utf8');

    expect(source).toContain('id="implementation-notes"');
    expect(source).toContain('id="animated-progress-card"');
    expect(source).toContain('class="progress-fill"');
    expect(source).toContain('id="workspace-settings"');
    expect(source).toContain('id="focus-mode-button"');
    expect(source).toContain("get('lang') === 'zh-CN' ? 'zh-CN' : 'en'");
    expect(source).toContain("implementationTitle: 'Implementation notes'");
    expect(source).toContain("implementationTitle: '实现说明'");
    expect(source).toContain("document.documentElement.lang = locale");
    expect(source).not.toMatch(/Acme|Google|Microsoft|OpenAI|Anthropic|DeepSeek/i);
  });

  it('allows localized source PNG directories through the repository ignore rules', () => {
    const source = readFileSync(gitignorePath, 'utf8');

    expect(source).toContain('!docs/store-assets/**/');
    expect(source).toContain('!docs/store-assets/**/*.png');
  });

  // 第一张截图承担大部分转化，必须是差异化最强的自动填表，而不是人人都有的总结问答。
  it('leads the store screenshots with autofill and keeps the generated set brand-free', () => {
    const source = readFileSync(assetGeneratorPath, 'utf8');

    expect(source).toMatch(/const SCENES = \[\s*\['autofill', 'screenshot-01-autofill\.png'\]/);
    expect(source).toContain("headline: 'Autofill forms in one sentence'");
    expect(source).toContain("headline: '一句话自动填表'");
    expect(source).not.toContain('V1.1');
    // 只查场景文案；字体栈里的 "Microsoft YaHei" 是字体名，不是画面上的品牌。
    const copy = source.slice(source.indexOf('const locales = {'), source.indexOf('const esc ='));
    expect(copy).not.toMatch(/Acme|Google|Microsoft|OpenAI|Anthropic|DeepSeek/i);
  });
});
