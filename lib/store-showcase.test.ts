import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const demoPath = resolve(process.cwd(), 'demo/store-showcase.html');
const assetFramePath = resolve(process.cwd(), 'demo/store-assets-frame.html');
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

  it.each([assetFramePath, assetGeneratorPath])(
    'keeps the fourth store screenshot focused on attachments without a stale version badge: %s',
    (path) => {
      const source = readFileSync(path, 'utf8');

      expect(source).toContain('Ask across pages and files');
      expect(source).toContain('结合网页与文件提问');
      expect(source).toContain('screenshot-04-attachments.png');
      expect(source).not.toContain('V1.1');
    },
  );
});
