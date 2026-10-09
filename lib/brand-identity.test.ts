import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const legacyBrandName = ['Alu', 'minum'].join('');
const legacyBrandPattern = new RegExp(legacyBrandName, 'i');
const repositoryPagesRoot =
  'https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/';
const retiredLegalRoot = `https://omnimindnb.github.io/${legacyBrandName.toLowerCase()}-legal/`;
const englishUpgradeNotice =
  `Brand upgrade notice: Runi uses a new local data namespace and does not read ${legacyBrandName} settings or conversations. After upgrading, configure your provider and API key again.`;
const chineseUpgradeNotice =
  `品牌升级说明：Runi 使用全新的本地数据空间，不会读取 ${legacyBrandName} 的本地设置或对话。升级后需要重新配置 Provider 和 API Key。`;
const englishLegalUrl = repositoryPagesRoot;
const chineseLegalUrl = `${repositoryPagesRoot}zh-CN/`;

const permittedLegacyReferencesByPath: Record<string, readonly string[]> = {
  'docs/chrome-store-listing.en.md': [],
  'docs/chrome-store-listing.zh-CN.md': [],
  'docs/chrome-store-permission-justifications.md': [],
  'docs/chrome-store-submission-guide.md': [],
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
    // extName 是商店标题，带搜索关键词，但必须以品牌名开头；纯品牌名由 short_name 承担。
    for (const locale of ['en', 'zh_CN']) {
      const messages = JSON.parse(read(`public/_locales/${locale}/messages.json`));
      expect(messages.extName.message).toMatch(/^Runi - /);
      // Chrome Web Store 限制：name ≤ 75、description ≤ 132 字符
      expect(messages.extName.message.length).toBeLessThanOrEqual(75);
      expect(messages.extDescription.message.length).toBeLessThanOrEqual(132);
    }
    expect(read('wxt.config.ts')).toContain("short_name: 'Runi'");
  });

  // 商店标题取自 manifest，listing 文档里的名称和简短说明必须与 manifest 文案逐字一致。
  it.each([
    ['en', 'docs/chrome-store-listing.en.md'],
    ['zh_CN', 'docs/chrome-store-listing.zh-CN.md'],
  ])('%s listing name and short description match the manifest', (locale, listing) => {
    const messages = JSON.parse(read(`public/_locales/${locale}/messages.json`));
    const blocks = [...read(listing).matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]);
    expect(blocks[0]).toBe(messages.extName.message);
    expect(blocks[1]).toBe(messages.extDescription.message);
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

  // 侧边栏空状态的品牌标记必须就是扩展图标那张图（BrandMark 内联了 icon-source.svg），
  // 改了一边忘了另一边，工具栏和面板里就又是两套图形；旧品牌的 "Al" 也不能回来。
  it('uses the official Runi icon as the side panel brand mark', () => {
    const iconPath = read('docs/store-assets/icon-source.svg').match(/<path d="([^"]+)"/)?.[1];
    expect(iconPath).toBeTruthy();
    expect(read('entrypoints/sidepanel/components/BrandMark.tsx')).toContain(`d="${iconPath}"`);
    // header 不放品牌：Chrome 侧边栏自带的标题栏已经是图标 + 名称。
    expect(read('entrypoints/sidepanel/components/WorkbenchEmptyState.tsx')).toContain('<BrandMark');
    for (const file of ['entrypoints/sidepanel/App.tsx', 'entrypoints/sidepanel/components/WorkbenchEmptyState.tsx']) {
      expect(read(file)).not.toMatch(/>\s*Al\s*</);
    }
  });

  const maintainedDocs = [
    'README.md',
    'README.en.md',
    'CLAUDE.md',
    'docs/README.md',
    'docs/privacy-policy.md',
    'docs/privacy-policy.en.md',
    'docs/chrome-store-listing.en.md',
    'docs/chrome-store-listing.zh-CN.md',
    'docs/chrome-store-permission-justifications.md',
    'docs/chrome-store-submission-guide.md',
    'demo/trust-demo.html',
    'demo/store-assets-frame.html',
  ];

  it.each(maintainedDocs)('%s uses Runi product wording', (path) => {
    const source = read(path);
    expect(withoutPermittedLegacyReferences(path, source)).not.toMatch(legacyBrandPattern);
  });

  it('does not keep obsolete relaunch upgrade notices on current store surfaces', () => {
    expect(read('docs/chrome-store-listing.en.md')).not.toContain(englishUpgradeNotice);
    expect(read('docs/chrome-store-listing.zh-CN.md')).not.toContain(chineseUpgradeNotice);
    expect(read('docs/chrome-store-submission-guide.md')).not.toContain(chineseUpgradeNotice);
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

  it.each(Object.keys(permittedLegacyReferencesByPath))(
    '%s does not permit the retired legal repository URL',
    (path) => {
      expect(withoutPermittedLegacyReferences(path, retiredLegalRoot)).toMatch(
        legacyBrandPattern,
      );
    },
  );
});
