# Chrome Web Store 1.1 Relaunch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Aluminum `1.1.0` as a fully verified English-default, Chinese-localized update to its existing Chrome Web Store item, including consent gating, Store materials, localized assets, and a published bilingual legal site.

**Architecture:** Add a fail-closed consent storage module and a shared React gate above both application roots so no Agent UI mounts before consent. Keep Store copy and privacy text in repository documents, publish equivalent static legal pages from the sibling `aluminum-legal` repository, and generate localized Store assets from real `1.1.0` UI captures on a controlled demo page.

**Tech Stack:** WXT Manifest V3, React 19, TypeScript 5.9, Vitest, Tailwind CSS 4, static HTML/CSS, Chrome Web Store, GitHub Pages.

## Amendment — 2026-07-28 (User-Approved Option A)

The final-review decision for the Chrome Web Store `1.1.0` build supersedes this plan wherever it describes AI-generated JavaScript execution. The Store build must not request `userScripts`, expose `browser_inject_script`, execute model-generated JavaScript, or include the associated Allow User Scripts wait/cancel/retry flow. Keep the remaining structured page tools and their confirmation behavior. This amendment also supersedes the permission and final manual-QA lines below.

## Global Constraints

- Update the existing Chrome Web Store item; preserve its item ID.
- Set the release version to exactly `1.1.0`.
- Set English as the manifest and Store default; keep complete `zh_CN` localization.
- Use `sidePanel`, `storage`, `scripting`, `activeTab`, and `tabs` permissions with `<all_urls>` host access; do not request `userScripts`.
- Store consent only in `chrome.storage.local`.
- Fail closed when consent cannot be read or written.
- Do not add analytics, accounts, a backend, cloud sync, or new dependencies.
- Do not rename Aluminum or redesign its icon.
- Use separate English and Chinese Store images; never mix both languages in one image.
- Do not use third-party brands or copyrighted page content in new Store screenshots.
- Publish `https://omnimindnb.github.io/aluminum-legal/` in English and `/zh-CN/` in Chinese.
- Stop before the Chrome Web Store `Submit for review` action.

---

### Task 1: Versioned Privacy Consent Storage

**Files:**
- Create: `lib/privacy-consent.ts`
- Create: `lib/privacy-consent.test.ts`

**Interfaces:**
- Produces: `PRIVACY_CONSENT_VERSION`, `PRIVACY_CONSENT_KEY`, `loadPrivacyConsent(): Promise<boolean>`, `savePrivacyConsent(now?: Date): Promise<void>`, `isCurrentPrivacyConsent(value: unknown): boolean`, and `privacyPolicyUrl(locale: 'en' | 'zh'): string`.
- Consumes: `browser.storage.local`.

- [ ] **Step 1: Write failing storage and version tests**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRIVACY_CONSENT_KEY,
  PRIVACY_CONSENT_VERSION,
  isCurrentPrivacyConsent,
  loadPrivacyConsent,
  privacyPolicyUrl,
  savePrivacyConsent,
} from './privacy-consent';

describe('privacy consent', () => {
  const originalBrowser = (globalThis as any).browser;
  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
    vi.restoreAllMocks();
  });

  it('accepts only the current version with an acceptedAt timestamp', () => {
    expect(isCurrentPrivacyConsent({ version: PRIVACY_CONSENT_VERSION, acceptedAt: '2026-07-27T00:00:00.000Z' })).toBe(true);
    expect(isCurrentPrivacyConsent({ version: PRIVACY_CONSENT_VERSION - 1, acceptedAt: '2026-07-27T00:00:00.000Z' })).toBe(false);
    expect(isCurrentPrivacyConsent({ version: PRIVACY_CONSENT_VERSION })).toBe(false);
  });

  it('fails closed when storage is empty or throws', async () => {
    (globalThis as any).browser = { storage: { local: { get: async () => ({}) } } };
    expect(await loadPrivacyConsent()).toBe(false);
    (globalThis as any).browser.storage.local.get = async () => { throw new Error('blocked'); };
    expect(await loadPrivacyConsent()).toBe(false);
  });

  it('writes the current version and timestamp', async () => {
    const set = vi.fn(async () => {});
    (globalThis as any).browser = { storage: { local: { set } } };
    await savePrivacyConsent(new Date('2026-07-27T00:00:00.000Z'));
    expect(set).toHaveBeenCalledWith({
      [PRIVACY_CONSENT_KEY]: {
        version: PRIVACY_CONSENT_VERSION,
        acceptedAt: '2026-07-27T00:00:00.000Z',
      },
    });
  });

  it('returns stable localized policy URLs', () => {
    expect(privacyPolicyUrl('en')).toBe('https://omnimindnb.github.io/aluminum-legal/');
    expect(privacyPolicyUrl('zh')).toBe('https://omnimindnb.github.io/aluminum-legal/zh-CN/');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run lib/privacy-consent.test.ts`

Expected: FAIL because `lib/privacy-consent.ts` does not exist.

- [ ] **Step 3: Implement the minimal fail-closed module**

```ts
export const PRIVACY_CONSENT_VERSION = 1;
export const PRIVACY_CONSENT_KEY = 'aluminum:privacy-consent';

interface PrivacyConsentRecord {
  version: number;
  acceptedAt: string;
}

export function isCurrentPrivacyConsent(value: unknown): value is PrivacyConsentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PrivacyConsentRecord>;
  return record.version === PRIVACY_CONSENT_VERSION && typeof record.acceptedAt === 'string';
}

export async function loadPrivacyConsent(): Promise<boolean> {
  try {
    const result = await browser.storage.local.get(PRIVACY_CONSENT_KEY);
    return isCurrentPrivacyConsent(result[PRIVACY_CONSENT_KEY]);
  } catch {
    return false;
  }
}

export async function savePrivacyConsent(now = new Date()): Promise<void> {
  await browser.storage.local.set({
    [PRIVACY_CONSENT_KEY]: {
      version: PRIVACY_CONSENT_VERSION,
      acceptedAt: now.toISOString(),
    },
  });
}

export function privacyPolicyUrl(locale: 'en' | 'zh'): string {
  return locale === 'zh'
    ? 'https://omnimindnb.github.io/aluminum-legal/zh-CN/'
    : 'https://omnimindnb.github.io/aluminum-legal/';
}
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm vitest run lib/privacy-consent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the storage boundary**

```bash
git add lib/privacy-consent.ts lib/privacy-consent.test.ts
git commit -m "feat: add versioned privacy consent storage"
```

### Task 2: Shared Consent Gate and Localized UI

**Files:**
- Create: `components/PrivacyConsentGate.tsx`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `entrypoints/sidepanel/main.tsx:1`
- Modify: `entrypoints/options/main.tsx:1`

**Interfaces:**
- Consumes: Task 1 storage functions and `useTranslation()`.
- Produces: `PrivacyConsentGate({ children }: { children: ReactNode })`.

- [ ] **Step 1: Add matching translation keys**

Add these keys to both locale dictionaries:

```ts
'privacy.loading'
'privacy.title'
'privacy.intro'
'privacy.pageDataTitle'
'privacy.pageDataBody'
'privacy.localDataTitle'
'privacy.localDataBody'
'privacy.noBackendTitle'
'privacy.noBackendBody'
'privacy.readPolicy'
'privacy.notNow'
'privacy.agree'
'privacy.saving'
'privacy.deferred'
'privacy.saveFailed'
```

Use the approved meaning: page content/screenshots/conversations can go to the configured AI provider; API keys/settings/history remain local; Aluminum has no backend or analytics.

- [ ] **Step 2: Implement the gate**

Use this state and control flow:

```tsx
export default function PrivacyConsentGate({ children }: { children: ReactNode }) {
  const { t, resolved } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadPrivacyConsent().then((current) => {
      setAccepted(current);
      setLoading(false);
    });
  }, []);

  async function accept() {
    setSaving(true);
    setError(false);
    try {
      await savePrivacyConsent();
      setAccepted(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main aria-busy="true">{t('privacy.loading')}</main>;
  if (accepted) return <>{children}</>;

  const disclosures = [
    ['privacy.pageDataTitle', 'privacy.pageDataBody'],
    ['privacy.localDataTitle', 'privacy.localDataBody'],
    ['privacy.noBackendTitle', 'privacy.noBackendBody'],
  ] as const;

  return (
    <main className="min-h-screen bg-neutral-50 p-6 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <section className="mx-auto max-w-lg rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-xl font-semibold">{t('privacy.title')}</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{t('privacy.intro')}</p>
        <div className="my-5 space-y-3">
          {disclosures.map(([title, body]) => (
            <div key={title} className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800">
              <h2 className="text-sm font-medium">{t(title)}</h2>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">{t(body)}</p>
            </div>
          ))}
        </div>
        <a href={privacyPolicyUrl(resolved)} target="_blank" rel="noreferrer">{t('privacy.readPolicy')}</a>
        {deferred && <p>{t('privacy.deferred')}</p>}
        {error && <p role="alert">{t('privacy.saveFailed')}</p>}
        <button type="button" onClick={() => setDeferred(true)}>{t('privacy.notNow')}</button>
        <button type="button" onClick={accept} disabled={saving}>
          {saving ? t('privacy.saving') : t('privacy.agree')}
        </button>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Wrap both application roots**

Use this structure in both `main.tsx` files:

```tsx
<React.StrictMode>
  <LocaleProvider>
    <PrivacyConsentGate>
      <App />
    </PrivacyConsentGate>
  </LocaleProvider>
</React.StrictMode>
```

This placement is required: `App` and `useChat()` must not mount before consent.

- [ ] **Step 4: Verify translation type safety and buildability**

Run: `pnpm compile`

Expected: PASS; missing or mismatched translation keys fail compilation.

- [ ] **Step 5: Run automated tests**

Run: `pnpm test`

Expected: all tests PASS.

- [ ] **Step 6: Manually verify fail-closed behavior**

Load the unpacked extension and confirm:

- Empty storage shows the notice in the side panel and Options page.
- `Not now` leaves the notice visible.
- `Agree & continue` unlocks both surfaces after reopen.
- Changing the stored record to `{ version: 0, acceptedAt: "..." }` shows the notice again.
- Forcing `browser.storage.local.set` to reject shows the localized error and does not mount the product UI.

- [ ] **Step 7: Commit the consent UI**

```bash
git add components/PrivacyConsentGate.tsx lib/i18n/locales/en.ts lib/i18n/locales/zh.ts entrypoints/sidepanel/main.tsx entrypoints/options/main.tsx
git commit -m "feat: gate Aluminum behind privacy consent"
```

### Task 3: Release Metadata and Manifest Localization

**Files:**
- Modify: `package.json:5`
- Modify: `wxt.config.ts:19`
- Modify: `public/_locales/en/messages.json`
- Modify: `public/_locales/zh_CN/messages.json`

**Interfaces:**
- Produces: built manifest version `1.1.0` with `default_locale: "en"`.

- [ ] **Step 1: Update version and default locale**

Set:

```json
"version": "1.1.0"
```

and:

```ts
default_locale: 'en',
```

- [ ] **Step 2: Align localized manifest descriptions**

English:

```json
"AI sidebar agent to understand, transform, and automate the current page—with your approval"
```

Chinese:

```json
"可控的网页 AI 助手：理解、改造与自动化当前页面，修改前由你确认"
```

- [ ] **Step 3: Build and inspect the generated manifest**

Run:

```bash
pnpm build
node -e "const m=require('./.output/chrome-mv3/manifest.json'); console.log({version:m.version,default_locale:m.default_locale,permissions:m.permissions,host_permissions:m.host_permissions})"
```

Expected:

```text
version: 1.1.0
default_locale: en
permissions: sidePanel, storage, scripting, activeTab, tabs
host_permissions: <all_urls>
```

- [ ] **Step 4: Commit release metadata**

```bash
git add package.json wxt.config.ts public/_locales/en/messages.json public/_locales/zh_CN/messages.json
git commit -m "chore: prepare Aluminum 1.1 release metadata"
```

### Task 4: Store Copy, Privacy Text, and Submission Guidance

**Files:**
- Create: `docs/chrome-store-listing.en.md`
- Create: `docs/chrome-store-listing.zh-CN.md`
- Create: `docs/privacy-policy.en.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/chrome-store-permission-justifications.md`
- Modify: `docs/chrome-store-submission-guide.md`

**Interfaces:**
- Produces: paste-ready Store fields and canonical bilingual policy copy for Task 5.

- [ ] **Step 1: Write the English and Chinese listing documents**

Each document must contain: name, short description, category (`Productivity`), single purpose, detailed description, four screenshot captions, privacy-policy URL, and support contact.

Use this exact English short description:

```text
AI sidebar agent to understand, transform, and automate the current page—with your approval.
```

Use this exact Chinese short description:

```text
可控的网页 AI 助手：理解、改造与自动化当前页面，修改前由你确认。
```

- [ ] **Step 2: Rewrite both privacy-policy documents**

Keep English and Chinese structurally equivalent with these headings:

1. Summary
2. Data we process
3. How data is used
4. First-use consent
5. Local storage and deletion
6. Third-party AI providers
7. Browser permissions
8. External resources and SSRF protection
9. Children’s privacy
10. Chrome Web Store Limited Use
11. Policy changes
12. Contact

State that Aluminum itself has no backend while still clearly disclosing direct transmission to the user-configured provider.

- [ ] **Step 3: Re-audit permission and data-form answers**

Document the unchanged permission set and mark `Website content` as collected/processed for the core feature. Add a reviewer note to inspect the live Dashboard wording for conversation content that may include user-entered personal information; do not claim it is categorically impossible.

- [ ] **Step 4: Rewrite the submission guide as an existing-item update**

The guide must:

- Say `1.0.0 → 1.1.0`, not “create a new item”.
- Upload English as default and add `zh_CN` localization.
- Reference both localized asset directories.
- Reference `/` and `/zh-CN/` policy routes.
- Remove pre-2026-08-01 timing assumptions.
- End with a hard stop before `Submit for review`.

- [ ] **Step 5: Check copy consistency**

Run:

```bash
rg -n "1\\.0\\.0|中文为主|创建新条目|2026-08-01.*前" docs/chrome-store-*.md docs/privacy-policy*.md
rg -n "AI sidebar agent to understand, transform, and automate|可控的网页 AI 助手" docs/chrome-store-listing.*
```

Expected: old submission assumptions are absent; approved short descriptions appear exactly once per localized listing.

- [ ] **Step 6: Commit Store and policy copy**

```bash
git add docs/chrome-store-listing.en.md docs/chrome-store-listing.zh-CN.md docs/privacy-policy.en.md docs/privacy-policy.md docs/chrome-store-permission-justifications.md docs/chrome-store-submission-guide.md
git commit -m "docs: prepare bilingual Chrome Store submission copy"
```

### Task 5: Publish the Bilingual Legal Site

**Files (sibling repository):**
- Clone: `../aluminum-legal`
- Replace: `../aluminum-legal/index.html`
- Create: `../aluminum-legal/zh-CN/index.html`

**Interfaces:**
- Consumes: Task 4 privacy documents.
- Produces: live English `/` and Chinese `/zh-CN/` policy routes.

- [ ] **Step 1: Clone the legal repository**

Run:

```bash
git clone git@github.com:OmniMindNB/aluminum-legal.git ../aluminum-legal
```

Expected: branch `main` with the existing single `index.html`.

- [ ] **Step 2: Replace the English root page**

Preserve the lightweight static-page style, set `<html lang="en">`, add a visible `中文` link to `/zh-CN/`, and render every English heading from Task 4.

```html
<nav aria-label="Language"><strong>English</strong> · <a href="/aluminum-legal/zh-CN/">中文</a></nav>
<h1>Aluminum Privacy Policy</h1>
<p class="updated">Effective: 2026-07-27</p>
```

- [ ] **Step 3: Create the Chinese route**

Create `zh-CN/index.html`, set `<html lang="zh-CN">`, add a visible `English` link to `/`, and render the equivalent Chinese policy.

```html
<nav aria-label="语言"><a href="/aluminum-legal/">English</a> · <strong>中文</strong></nav>
<h1>Aluminum 隐私政策</h1>
<p class="updated">生效日期：2026-07-27</p>
```

- [ ] **Step 4: Test both routes locally**

Run:

```bash
python3 -m http.server 4174 --directory ../aluminum-legal
curl -fsS http://localhost:4174/ | rg "Privacy Policy|Chrome Web Store Limited Use"
curl -fsS http://localhost:4174/zh-CN/ | rg "隐私政策|Chrome Web Store Limited Use"
```

Expected: both commands match; both pages have working language links and no horizontal overflow at mobile width.

- [ ] **Step 5: Commit and publish GitHub Pages**

```bash
git -C ../aluminum-legal add index.html zh-CN/index.html
git -C ../aluminum-legal commit -m "Publish bilingual Aluminum privacy policy"
git -C ../aluminum-legal push origin main
```

- [ ] **Step 6: Verify the deployed site**

Run:

```bash
curl -fsS https://omnimindnb.github.io/aluminum-legal/ | rg "Privacy Policy|Chrome Web Store Limited Use"
curl -fsS https://omnimindnb.github.io/aluminum-legal/zh-CN/ | rg "隐私政策|Chrome Web Store Limited Use"
```

Expected: both live routes return the new content. If Pages is still deploying, wait for the GitHub Pages deployment to finish, then rerun these exact checks.

### Task 6: Controlled Bilingual Store Demo and Real UI Captures

**Files:**
- Create: `demo/store-showcase.html`
- Create: `docs/store-assets/source/en/`
- Create: `docs/store-assets/source/zh-CN/`
- Modify: `.gitignore`

**Interfaces:**
- Produces: eight real `1.1.0` source captures consumed by Task 7.

- [ ] **Step 1: Create a neutral bilingual demo page**

`demo/store-showcase.html` must switch copy from `?lang=en` or `?lang=zh-CN` and include:

- A fictional product documentation article.
- A CSS-only animated progress card for evidence analysis.
- A settings panel the Agent can restyle.
- No third-party names, logos, images, or copied text.

Use a small dictionary and stable element IDs so prompts work in both locales:

```html
<article id="implementation-notes">
  <h2 data-i18n="implementationTitle"></h2>
  <p data-i18n="implementationBody"></p>
  <div class="progress-card" id="animated-progress-card">
    <span class="progress-fill"></span>
  </div>
</article>
<section id="workspace-settings">
  <h2 data-i18n="settingsTitle"></h2>
  <button id="focus-mode-button" data-i18n="focusMode"></button>
</section>
<script>
  const locale = new URLSearchParams(location.search).get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
  const copy = {
    en: {
      implementationTitle: 'Implementation notes',
      implementationBody: 'The progress card uses a CSS keyframe and a transform-based fill.',
      settingsTitle: 'Workspace settings',
      focusMode: 'Enable focus mode',
    },
    'zh-CN': {
      implementationTitle: '实现说明',
      implementationBody: '进度卡片使用 CSS 关键帧和基于 transform 的填充动画。',
      settingsTitle: '工作区设置',
      focusMode: '开启专注模式',
    },
  };
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = copy[locale][element.dataset.i18n];
  });
</script>
```

- [ ] **Step 2: Allow localized PNG directories in Git**

Add:

```gitignore
!docs/store-assets/**/
!docs/store-assets/**/*.png
```

- [ ] **Step 3: Build and load `1.1.0`**

Run: `pnpm build`

Load `.output/chrome-mv3` in Chrome, clear `aluminum:privacy-consent`, accept the notice, and configure a test provider.

- [ ] **Step 4: Capture four English product states**

Set Aluminum to English and open `demo/store-showcase.html?lang=en`. Capture:

```text
docs/store-assets/source/en/01-summary.png
docs/store-assets/source/en/02-evidence.png
docs/store-assets/source/en/03-confirm.png
docs/store-assets/source/en/04-undo.png
```

Use real interactions:

1. Summarize the page.
2. Ask how the animated progress card works and require page evidence.
3. Ask to switch the page into a focused reading style; capture the confirmation card before approval.
4. Approve the change; capture the modified page with the undo bar visible.

- [ ] **Step 5: Capture equivalent Chinese product states**

Repeat with Aluminum set to Chinese and `?lang=zh-CN`, saving the same filenames under `source/zh-CN/`.

- [ ] **Step 6: Inspect every source capture**

Confirm that each image shows only controlled demo content, the correct locale, no API key, no email address, no browser profile information, and no unrelated tabs.

- [ ] **Step 7: Commit the demo and source captures**

```bash
git add .gitignore demo/store-showcase.html docs/store-assets/source
git commit -m "docs: capture bilingual Aluminum Store scenarios"
```

### Task 7: Generate Localized Store Marketing Assets

**Files:**
- Create: `demo/store-assets-frame.html`
- Create: `docs/store-assets/en/promo-small-440x280.png`
- Create: `docs/store-assets/en/screenshot-01-summary.png`
- Create: `docs/store-assets/en/screenshot-02-evidence.png`
- Create: `docs/store-assets/en/screenshot-03-confirm.png`
- Create: `docs/store-assets/en/screenshot-04-undo.png`
- Create: `docs/store-assets/zh-CN/promo-small-440x280.png`
- Create: `docs/store-assets/zh-CN/screenshot-01-summary.png`
- Create: `docs/store-assets/zh-CN/screenshot-02-evidence.png`
- Create: `docs/store-assets/zh-CN/screenshot-03-confirm.png`
- Create: `docs/store-assets/zh-CN/screenshot-04-undo.png`
- Delete: `docs/store-assets/promo-small-440x280.png`
- Delete: `docs/store-assets/screenshot-chat.png`
- Delete: `docs/store-assets/screenshot-confirm.png`
- Delete: `docs/store-assets/screenshot-undo.png`

**Interfaces:**
- Consumes: Task 6 source captures and Task 4 screenshot captions.
- Produces: final Store-upload images.

- [ ] **Step 1: Build the reusable HTML framing template**

Support query parameters `locale=en|zh-CN`, `scene=summary|evidence|confirm|undo`, and `kind=screenshot|promo`. The template must use the approved deep-blue brand frame, render locale-specific benefit copy, and embed the matching real source capture.

Use one source-of-truth map:

```js
const SCENES = {
  en: {
    summary: ['Understand any page', 'Summaries and answers grounded in the page'],
    evidence: ['See the evidence', 'Inspect DOM, styles, scripts, and computed behavior'],
    confirm: ['You stay in control', 'Every page change asks for approval first'],
    undo: ['Undo the whole turn', 'Restore page changes with one click'],
  },
  'zh-CN': {
    summary: ['快速理解任意网页', '基于当前页面生成总结与回答'],
    evidence: ['回答有据可查', '检查 DOM、样式、脚本与实际行为'],
    confirm: ['修改前由你确认', '页面写操作先展示内容，再等待批准'],
    undo: ['一键撤销整轮改动', '随时恢复本轮对页面造成的变化'],
  },
};
```

- [ ] **Step 2: Render four `1280×800` screenshots per locale**

Use the browser viewport capability or equivalent exact-size capture. Save the eight outputs to the paths listed above. Do not stretch source captures; use `object-fit: cover` with a deliberate crop.

- [ ] **Step 3: Render one `440×280` promo per locale**

Use the concise product-value headline, Aluminum icon/name, and a small real UI crop. Keep all critical copy inside safe margins.

- [ ] **Step 4: Verify dimensions**

Run:

```bash
file docs/store-assets/en/*.png docs/store-assets/zh-CN/*.png
```

Expected: four `1280 x 800` images and one `440 x 280` image in each locale.

- [ ] **Step 5: Visually inspect all ten final assets**

Check readability at thumbnail size, correct locale, no clipped controls, no misleading capability claims, and consistent deep-blue framing.

- [ ] **Step 6: Commit final assets**

```bash
git add demo/store-assets-frame.html docs/store-assets
git commit -m "docs: refresh localized Chrome Store assets"
```

### Task 8: Full Verification and Submission-Ready Package

**Files:**
- Create: `docs/chrome-store-release-checklist-1.1.md`
- Verify: `.output/chrome-mv3/manifest.json`
- Verify: `.output/aluminum-1.1.0-chrome.zip`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: the final handoff package without Store submission.

- [ ] **Step 1: Run the complete automated verification**

Run:

```bash
pnpm compile
pnpm test
pnpm build
pnpm zip
```

Expected: all commands exit `0`.

- [ ] **Step 2: Inspect the upload archive**

Run:

```bash
unzip -l .output/aluminum-1.1.0-chrome.zip
unzip -p .output/aluminum-1.1.0-chrome.zip manifest.json
```

Confirm version `1.1.0`, `default_locale: "en"`, both `_locales` directories, and no permission changes.

- [ ] **Step 3: Run final manual regression QA**

Verify new install, `1.0.0` upgrade, consent decline/accept/persistence/failure, English/Chinese switching, Provider configuration, summarization, evidence analysis, confirmation, undo, and the retained structured page tools.

- [ ] **Step 4: Write the release checklist**

Record:

- ZIP absolute path and SHA-256.
- English and Chinese listing document paths.
- English and Chinese asset directories.
- Live privacy-policy URLs.
- Permission and data-disclosure document path.
- Automated command results.
- Manual QA results.
- A final unchecked item: `User confirmed Submit for review`.

- [ ] **Step 5: Commit the checklist**

```bash
git add docs/chrome-store-release-checklist-1.1.md
git commit -m "docs: add Aluminum 1.1 Store release checklist"
```

- [ ] **Step 6: Stop before submission**

Present the package to the user. Do not upload to the Chrome Web Store or click `Submit for review` until the user gives a new explicit confirmation.
