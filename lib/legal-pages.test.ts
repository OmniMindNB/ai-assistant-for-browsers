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
