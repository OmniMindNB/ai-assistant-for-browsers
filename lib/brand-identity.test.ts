import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const legacyBrandName = ['Alu', 'minum'].join('');
const legacyBrandPattern = new RegExp(legacyBrandName, 'i');
const legacyLegalRoot = `https://omnimindnb.github.io/${legacyBrandName.toLowerCase()}-legal/`;
const englishUpgradeNotice =
  `Brand upgrade notice: Runi uses a new local data namespace and does not read ${legacyBrandName} settings or conversations. After upgrading, configure your provider and API key again.`;
const chineseUpgradeNotice =
  `品牌升级说明：Runi 使用全新的本地数据空间，不会读取 ${legacyBrandName} 的本地设置或对话。升级后需要重新配置 Provider 和 API Key。`;
const englishLegalUrl = legacyLegalRoot;
const chineseLegalUrl = `${legacyLegalRoot}zh-CN/`;

const permittedLegacyReferencesByPath: Record<string, readonly string[]> = {
  'docs/chrome-store-listing.en.md': [englishUpgradeNotice, englishLegalUrl],
  'docs/chrome-store-listing.zh-CN.md': [chineseUpgradeNotice, chineseLegalUrl],
  'docs/chrome-store-permission-justifications.md': [englishLegalUrl, chineseLegalUrl],
  'docs/chrome-store-submission-guide.md': [chineseUpgradeNotice, englishLegalUrl, chineseLegalUrl],
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactLegacyUrlPattern = (url: string, flags?: string) =>
  new RegExp(
    `${escapeRegExp(url)}(?![A-Za-z0-9._~:/?%#;@!$&'()*+,=\\[\\]-])`,
    flags,
  );

const hasExactPermittedLegacyReference = (source: string, permittedReference: string) => {
  if (!permittedReference.startsWith('https://')) {
    return source.includes(permittedReference);
  }

  return exactLegacyUrlPattern(permittedReference).test(source);
};

const replacePermittedLegacyReference = (source: string, permittedReference: string) => {
  if (!permittedReference.startsWith('https://')) {
    return source.replaceAll(permittedReference, 'Runi');
  }

  return source.replace(exactLegacyUrlPattern(permittedReference, 'g'), 'Runi');
};

const withoutPermittedLegacyReferences = (path: string, source: string) =>
  (permittedLegacyReferencesByPath[path] ?? []).reduce(
    replacePermittedLegacyReference,
    source,
  );

describe('Runi active product identity', () => {
  it('uses Runi in package and extension locale metadata', () => {
    expect(JSON.parse(read('package.json'))).toMatchObject({
      name: 'runi',
      description: expect.stringContaining('Runi'),
    });
    expect(JSON.parse(read('public/_locales/en/messages.json')).extName.message).toBe('Runi');
    expect(JSON.parse(read('public/_locales/zh_CN/messages.json')).extName.message).toBe('Runi');
  });

  it.each([
    'entrypoints/options/index.html',
    'entrypoints/sidepanel/index.html',
    'entrypoints/sidepanel/components/WorkbenchHeader.tsx',
    'lib/i18n/locales/en.ts',
    'lib/i18n/locales/zh.ts',
    'lib/agent/system-prompt.ts',
    'entrypoints/background.ts',
    'entrypoints/sidepanel/store.ts',
  ])('%s has no active legacy branding', (path) => {
    expect(read(path)).not.toMatch(legacyBrandPattern);
  });

  it('uses the Runi monogram for assistant messages', () => {
    const sidePanel = read('entrypoints/sidepanel/App.tsx');
    expect(sidePanel).not.toMatch(/>\s*Al\s*</);
    expect(sidePanel).toMatch(/>\s*R\s*</);
  });

  const maintainedDocs = [
    'README.md',
    'README.en.md',
    'CLAUDE.md',
    'docs/README.md',
    'docs/agent-plan.md',
    'docs/technical-plan.md',
    'docs/privacy-policy.md',
    'docs/privacy-policy.en.md',
    'docs/chrome-store-listing.en.md',
    'docs/chrome-store-listing.zh-CN.md',
    'docs/chrome-store-permission-justifications.md',
    'docs/chrome-store-submission-guide.md',
    'demo/README.md',
    'demo/outreach-message.md',
    'demo/trust-demo.html',
    'demo/store-assets-frame.html',
  ];

  it.each(maintainedDocs)('%s uses Runi product wording', (path) => {
    const source = read(path);
    expect(withoutPermittedLegacyReferences(path, source)).not.toMatch(legacyBrandPattern);
  });

  it('keeps the exact fresh-data upgrade notices on the relaunch surfaces', () => {
    expect(read('docs/chrome-store-listing.en.md')).toContain(englishUpgradeNotice);
    expect(read('docs/chrome-store-listing.zh-CN.md')).toContain(chineseUpgradeNotice);
    expect(read('docs/chrome-store-submission-guide.md')).toContain(chineseUpgradeNotice);
  });

  it.each([
    ['docs/chrome-store-listing.en.md', englishLegalUrl],
    ['docs/chrome-store-listing.zh-CN.md', chineseLegalUrl],
    ['docs/chrome-store-permission-justifications.md', englishLegalUrl],
    ['docs/chrome-store-permission-justifications.md', chineseLegalUrl],
    ['docs/chrome-store-submission-guide.md', englishLegalUrl],
    ['docs/chrome-store-submission-guide.md', chineseLegalUrl],
  ])('%s keeps the exact deployed legal-policy URL', (path, legalUrl) => {
    expect(hasExactPermittedLegacyReference(read(path), legalUrl)).toBe(true);
  });

  it('does not treat the localized legal URL as the standalone default URL', () => {
    const sourceWithBothUrls = `${englishLegalUrl}\n${chineseLegalUrl}`;
    const sourceWithOnlyLocalizedUrl = replacePermittedLegacyReference(
      sourceWithBothUrls,
      englishLegalUrl,
    );

    expect(sourceWithOnlyLocalizedUrl).toContain(chineseLegalUrl);
    expect(hasExactPermittedLegacyReference(sourceWithOnlyLocalizedUrl, englishLegalUrl)).toBe(
      false,
    );
  });

  it.each([
    ['lowercase legacy prose', `${legacyBrandName.toLowerCase()} settings remain available`],
    ['an upgrade notice on an unapproved surface', englishUpgradeNotice],
  ])('does not permit %s on an unapproved surface', (_description, legacyReference) => {
    expect(withoutPermittedLegacyReferences('README.md', legacyReference)).toMatch(
      legacyBrandPattern,
    );
  });

  it.each([
    `${legacyLegalRoot}unapproved/`,
    `${legacyLegalRoot};unapproved`,
  ])('does not permit the non-deployed legal URL %s on an approved surface', (url) => {
    expect(withoutPermittedLegacyReferences('docs/chrome-store-listing.en.md', url)).toMatch(
      legacyBrandPattern,
    );
  });
});
