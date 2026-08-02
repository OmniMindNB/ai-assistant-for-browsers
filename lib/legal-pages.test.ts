import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const frontMatter = (path: string) => {
  const source = read(path);
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, `${path} must start with Jekyll front matter`).not.toBeNull();

  return Object.fromEntries(
    match![1].split('\n').map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
};

describe('GitHub Pages privacy policies', () => {
  it.each([
    [
      'docs/privacy-policy.en.md',
      {
        layout: 'privacy-policy',
        title: 'Runi Privacy Policy',
        lang: 'en',
        permalink: '/privacy-policy/',
        alternate_path: '/privacy-policy/zh-CN/',
        alternate_label: '中文',
        current_language_label: 'English',
        language_navigation_label: 'Language',
      },
    ],
    [
      'docs/privacy-policy.md',
      {
        layout: 'privacy-policy',
        title: 'Runi 隐私政策',
        lang: 'zh-CN',
        permalink: '/privacy-policy/zh-CN/',
        alternate_path: '/privacy-policy/',
        alternate_label: 'English',
        current_language_label: '中文',
        language_navigation_label: '语言',
      },
    ],
  ])('%s declares its stable Pages route and alternate language', (path, expected) => {
    expect(frontMatter(path)).toMatchObject(expected);
  });
});

describe('maintained privacy-policy URLs', () => {
  const englishUrl =
    'https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/';
  const chineseUrl = `${englishUrl}zh-CN/`;
  const retiredUrl = 'https://omnimindnb.github.io/aluminum-legal/';
  const maintainedFiles = [
    'docs/chrome-store-listing.en.md',
    'docs/chrome-store-listing.zh-CN.md',
    'docs/chrome-store-permission-justifications.md',
    'docs/chrome-store-submission-guide.md',
    'docs/chrome-store-release-checklist-1.1.md',
  ];

  it.each(maintainedFiles)('%s does not reference the retired legal site', (path) => {
    expect(read(path)).not.toContain(retiredUrl);
  });

  it('publishes the English route on the English listing', () => {
    expect(read('docs/chrome-store-listing.en.md')).toContain(englishUrl);
  });

  it('publishes the Simplified Chinese route on the Chinese listing', () => {
    expect(read('docs/chrome-store-listing.zh-CN.md')).toContain(chineseUrl);
  });

  it.each(['docs/chrome-store-permission-justifications.md', 'docs/chrome-store-submission-guide.md'])(
    '%s contains both active routes',
    (path) => {
      expect(read(path)).toContain(englishUrl);
      expect(read(path)).toContain(chineseUrl);
    },
  );
});
