# Runi Brand Renaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the extension from Aluminum to Runi across runtime identity, fresh local persistence, current documentation, store assets, and iconography without migrating legacy Aluminum data.

**Architecture:** Treat branding, persistence, documentation, and raster assets as separate reviewable units. Runtime modules expose exact `runi:*` constants and Dexie opens a new `runi` database; there is no legacy read, copy, deletion, or fallback path. Current product surfaces become Runi while historical plans/specs and the existing `aluminum-legal` deployment URL remain intentional records or compatibility links.

**Tech Stack:** TypeScript 5.9, React 19, WXT 0.20, Dexie 4, Vitest 4, SVG, `rsvg-convert`, Markdown

## Global Constraints

- English name: **Runi**.
- Chinese reading: **如你**; it is a reading and brand association, not a separate localized product name.
- English tagline: **Your page, your way.**
- Chinese tagline: **网页，如你所愿。**
- Pronunciation: **roo-nee**.
- The product voice is light, friendly, calm, trustworthy, and capable; it must not become childish or mascot-led.
- Functional terms such as “AI,” “browser,” “agent,” and “sidebar” are descriptors, not part of the product name.
- Use `runi:settings`, `runi:shortcuts`, `runi:theme`, `runi:locale`, and IndexedDB database `runi`.
- Do not read, copy, import, delete, or fall back to data in the Aluminum namespace.
- Upgrading intentionally starts with default settings, no provider/API key, default shortcuts/theme/locale, and an empty conversation history.
- Keep historical files under `docs/superpowers/`, `docs/specs/`, and the completed `docs/chrome-store-release-checklist-1.1.md` unchanged.
- Keep `https://omnimindnb.github.io/aluminum-legal/` URLs until the separately scoped legal-site migration is ready.
- Do not change product behavior, permissions, or dependencies.

## File Map

- `lib/brand-namespace.test.ts`: single executable contract for all new persistence names and fresh-start behavior.
- `lib/settings.ts`, `lib/shortcuts.ts`, `lib/theme.ts`, `lib/i18n/index.tsx`: Chrome local-storage namespace owners.
- `lib/db.ts`: Dexie database namespace and database class.
- `components/settings-components.test.tsx`, `entrypoints/sidepanel/store-context.test.tsx`, `entrypoints/sidepanel/components/workbench-components.test.tsx`, `lib/theme.test.tsx`: existing storage/UI fixtures that must speak the Runi namespace.
- `lib/brand-identity.test.ts`: current runtime and package branding contract; deliberately excludes historical documents and legacy URLs.
- `package.json`, `public/_locales/*/messages.json`, `entrypoints/*/index.html`, `entrypoints/sidepanel/components/WorkbenchHeader.tsx`, `lib/i18n/locales/{en,zh}.ts`, `lib/agent/system-prompt.ts`, `entrypoints/background.ts`, `entrypoints/sidepanel/store.ts`: runtime product identity.
- `README.md`, `README.en.md`, `CLAUDE.md`, `docs/{README,agent-plan,technical-plan,privacy-policy,privacy-policy.en,chrome-store-listing.en,chrome-store-listing.zh-CN,chrome-store-permission-justifications,chrome-store-submission-guide}.md`, `demo/{README,outreach-message,trust-demo.html,store-assets-frame.html}`: maintained product and release documentation.
- `docs/store-assets/icon-source.svg`: editable Runi icon source.
- `public/icons/icon-{16,32,48,128}.png`, `docs/store-assets/icon-128.png`: generated icon rasters.
- `docs/store-assets/promo-small-440x280.png`, `docs/store-assets/screenshot-chat.png`, `docs/store-assets/screenshot-confirm.png`: store images requiring a visual audit and regeneration if they contain the old name/icon.

---

### Task 1: Move Chrome Storage to the Fresh Runi Namespace

**Files:**
- Create: `lib/brand-namespace.test.ts`
- Modify: `lib/settings.ts`
- Modify: `lib/shortcuts.ts`
- Modify: `lib/theme.ts`
- Modify: `lib/i18n/index.tsx`
- Modify: `components/settings-components.test.tsx`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`
- Modify: `lib/theme.test.tsx`

**Interfaces:**
- Produces: `STORAGE_KEY = 'runi:settings'`, `SHORTCUTS_STORAGE_KEY = 'runi:shortcuts'`, `THEME_KEY = 'runi:theme'`, and `LOCALE_KEY = 'runi:locale'`.
- Preserves: existing load/save function signatures and default-value behavior.

- [ ] **Step 1: Write the failing namespace contract**

Create `lib/brand-namespace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LOCALE_KEY } from './i18n';
import { STORAGE_KEY } from './settings';
import { SHORTCUTS_STORAGE_KEY } from './shortcuts';
import { THEME_KEY } from './theme';

describe('Runi persistence namespace', () => {
  it('uses only the fresh Runi chrome.storage keys', () => {
    expect(STORAGE_KEY).toBe('runi:settings');
    expect(SHORTCUTS_STORAGE_KEY).toBe('runi:shortcuts');
    expect(THEME_KEY).toBe('runi:theme');
    expect(LOCALE_KEY).toBe('runi:locale');
    for (const key of [STORAGE_KEY, SHORTCUTS_STORAGE_KEY, THEME_KEY, LOCALE_KEY]) {
      expect(key).not.toContain('aluminum');
    }
  });
});
```

- [ ] **Step 2: Run the test and verify the old namespace fails**

Run: `pnpm vitest run lib/brand-namespace.test.ts`

Expected: FAIL because `THEME_KEY` and `LOCALE_KEY` are not exported and existing constants contain `aluminum:`.

- [ ] **Step 3: Export and replace the four constants**

Use these exact declarations:

```ts
// lib/settings.ts
export const STORAGE_KEY = 'runi:settings';

// lib/shortcuts.ts
export const SHORTCUTS_STORAGE_KEY = 'runi:shortcuts';

// lib/theme.ts
export const THEME_KEY = 'runi:theme';

// lib/i18n/index.tsx
export const LOCALE_KEY = 'runi:locale';
```

Do not add fallback reads, storage-change listeners for old keys, migration helpers, or calls to `browser.storage.local.remove()`.

- [ ] **Step 4: Update existing fixtures to the new keys**

Mechanically replace only active test fixtures:

```ts
'aluminum:settings'  // old
'runi:settings'      // new

'aluminum:shortcuts' // old
'runi:shortcuts'     // new

'aluminum:theme'     // old
'runi:theme'         // new
```

Apply this in the four existing test files listed above. Do not edit historical Markdown examples.

- [ ] **Step 5: Run focused storage tests**

Run:

```bash
pnpm vitest run lib/brand-namespace.test.ts lib/theme.test.tsx lib/shortcuts.test.ts components/settings-components.test.tsx entrypoints/sidepanel/store-context.test.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
```

Expected: PASS, including default initialization when the Runi key is absent.

- [ ] **Step 6: Commit the storage namespace**

```bash
git add lib/brand-namespace.test.ts lib/settings.ts lib/shortcuts.ts lib/theme.ts lib/i18n/index.tsx components/settings-components.test.tsx entrypoints/sidepanel/store-context.test.tsx entrypoints/sidepanel/components/workbench-components.test.tsx lib/theme.test.tsx
git commit -m "feat: move preferences to Runi namespace"
```

### Task 2: Start an Empty Runi Conversation Database

**Files:**
- Modify: `lib/brand-namespace.test.ts`
- Modify: `lib/db.ts`

**Interfaces:**
- Consumes: the “no migration or legacy fallback” global constraint.
- Produces: exported `db` whose Dexie `name` is exactly `runi`; public conversation helper signatures remain unchanged.

- [ ] **Step 1: Add a failing Dexie-name assertion**

Append to `lib/brand-namespace.test.ts`:

```ts
import { db } from './db';

it('opens a new Runi IndexedDB database', () => {
  expect(db.name).toBe('runi');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run lib/brand-namespace.test.ts`

Expected: FAIL with `expected 'aluminum' to be 'runi'`.

- [ ] **Step 3: Rename the active database class and database name**

Change `lib/db.ts` to:

```ts
class RuniDB extends Dexie {
  conversations!: Table<ConversationRecord, string>;
  messages!: Table<ChatMessageRecord, number>;

  constructor() {
    super('runi');
    this.version(1).stores({
      conversations: 'id, updatedAt',
      messages: '++id, conversationId, createdAt',
    });
  }
}

export const db = new RuniDB();
```

Do not call `Dexie.exists('aluminum')`, `Dexie.delete('aluminum')`, or open the old database for copying.

- [ ] **Step 4: Run database and namespace tests**

Run: `pnpm vitest run lib/brand-namespace.test.ts`

Expected: PASS and no test refers to an Aluminum database.

- [ ] **Step 5: Commit the database reset**

```bash
git add lib/brand-namespace.test.ts lib/db.ts
git commit -m "feat: start fresh Runi conversation database"
```

### Task 3: Replace Runtime and Package Identity

**Files:**
- Create: `lib/brand-identity.test.ts`
- Modify: `package.json`
- Modify: `public/_locales/en/messages.json`
- Modify: `public/_locales/zh_CN/messages.json`
- Modify: `entrypoints/options/index.html`
- Modify: `entrypoints/sidepanel/index.html`
- Modify: `entrypoints/sidepanel/components/WorkbenchHeader.tsx`
- Modify: `entrypoints/sidepanel/components/workbench-components.test.tsx`
- Modify: `lib/i18n/locales/en.ts`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/agent/system-prompt.ts`
- Modify: `entrypoints/background.ts`
- Modify: `entrypoints/sidepanel/store.ts`
- Modify: `entrypoints/sidepanel/store-context.test.tsx`

**Interfaces:**
- Consumes: the approved name, Chinese reading, taglines, and tone.
- Produces: all active manifests, UI, prompt identity, and diagnostics display **Runi**.

- [ ] **Step 1: Write a failing active-brand contract**

Create `lib/brand-identity.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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
  ])('%s has no active Aluminum branding', (path) => {
    expect(read(path)).not.toMatch(/Aluminum/);
  });
});
```

- [ ] **Step 2: Run the brand contract and verify it fails**

Run: `pnpm vitest run lib/brand-identity.test.ts`

Expected: FAIL on package metadata and every active file that still contains Aluminum.

- [ ] **Step 3: Update package, manifest locale messages, and HTML titles**

Use these exact user-visible values:

```json
{
  "name": "runi",
  "description": "Runi — Chromium 浏览器 AI 助手侧边栏插件"
}
```

Both `extName.message` fields become `Runi`. HTML titles become `Runi` and `Runi 设置` respectively. Keep the existing extension descriptions and permissions unchanged.

- [ ] **Step 4: Update active UI, localized copy, system prompt, and logs**

Replace product-name references with `Runi`, including:

```tsx
<span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">Runi</span>
```

```ts
'settings.pageTitle': 'Runi Settings'
'settings.pageTitle': 'Runi 设置'
'chat.emptyTitle': 'Chat with Runi'
'chat.emptyTitle': '和 Runi 对话'
```

The system prompt begins “你是 Runi…”. Diagnostic prefixes become `[Runi]`. Update exact string assertions in the existing component/store tests without changing behavior.

- [ ] **Step 5: Run focused identity and UI tests**

Run:

```bash
pnpm vitest run lib/brand-identity.test.ts lib/i18n/i18n.test.ts entrypoints/sidepanel/store-context.test.tsx entrypoints/sidepanel/components/workbench-components.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Compile and commit runtime identity**

Run: `pnpm compile`

Expected: exit 0.

```bash
git add package.json public/_locales entrypoints/options/index.html entrypoints/sidepanel/index.html entrypoints/sidepanel/components/WorkbenchHeader.tsx entrypoints/sidepanel/components/workbench-components.test.tsx lib/i18n/locales lib/agent/system-prompt.ts entrypoints/background.ts entrypoints/sidepanel/store.ts entrypoints/sidepanel/store-context.test.tsx lib/brand-identity.test.ts
git commit -m "feat: rename active extension identity to Runi"
```

### Task 4: Update Maintained Documentation and Store Copy

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `CLAUDE.md`
- Modify: `docs/README.md`
- Modify: `docs/agent-plan.md`
- Modify: `docs/technical-plan.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/privacy-policy.en.md`
- Modify: `docs/chrome-store-listing.en.md`
- Modify: `docs/chrome-store-listing.zh-CN.md`
- Modify: `docs/chrome-store-permission-justifications.md`
- Modify: `docs/chrome-store-submission-guide.md`
- Modify: `demo/README.md`
- Modify: `demo/outreach-message.md`
- Modify: `demo/trust-demo.html`
- Modify: `demo/store-assets-frame.html`

**Interfaces:**
- Consumes: runtime identity from Task 3 and fresh-start behavior from Tasks 1–2.
- Produces: maintained documentation that names Runi consistently and discloses the intentional local-data reset.

- [ ] **Step 1: Add documentation coverage to the brand contract**

Append to `lib/brand-identity.test.ts`:

```ts
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
  const withoutLegacyLegalUrl = source.replaceAll('aluminum-legal', 'legacy-legal');
  expect(withoutLegacyLegalUrl).not.toMatch(/Aluminum/);
});
```

- [ ] **Step 2: Run the documentation contract and verify it fails**

Run: `pnpm vitest run lib/brand-identity.test.ts`

Expected: FAIL on maintained documentation containing Aluminum.

- [ ] **Step 3: Replace current prose and introduce the approved taglines**

Replace product-name prose with Runi without rewriting technical or privacy claims. Add the approved taglines near the top of the READMEs and store descriptions:

```md
> 网页，如你所愿。
```

```md
> Your page, your way.
```

In the Chinese store listing, the first introduction may use `Runi（如你）`; subsequent references use `Runi`.

- [ ] **Step 4: Document the intentional upgrade reset**

Add a release note to both store listings and submission guidance:

```md
> 品牌升级说明：Runi 使用全新的本地数据空间，不会读取 Aluminum 的本地设置或对话。升级后需要重新配置 Provider 和 API Key。
```

```md
> Brand upgrade notice: Runi uses a new local data namespace and does not read Aluminum settings or conversations. After upgrading, configure your provider and API key again.
```

Do not claim that Runi deletes the old Aluminum data.

Add a release-blocker checklist to `docs/chrome-store-submission-guide.md`: before public relaunch, the owner must record completed trademark, domain, package-name, social-handle, and Chrome Web Store name checks for the intended target markets. This is a launch gate, not a claim of legal clearance.

- [ ] **Step 5: Preserve historical records and legacy legal URLs**

Do not edit `docs/superpowers/**`, `docs/specs/**`, or `docs/chrome-store-release-checklist-1.1.md`. Keep the exact `aluminum-legal` URLs, but change surrounding product prose to Runi and mark the URL as the currently deployed legal-policy location where relevant.

- [ ] **Step 6: Run documentation and store-copy tests**

Run:

```bash
pnpm vitest run lib/brand-identity.test.ts lib/final-review.test.ts lib/store-showcase.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit maintained documentation**

```bash
git add README.md README.en.md CLAUDE.md docs/README.md docs/agent-plan.md docs/technical-plan.md docs/privacy-policy.md docs/privacy-policy.en.md docs/chrome-store-listing.en.md docs/chrome-store-listing.zh-CN.md docs/chrome-store-permission-justifications.md docs/chrome-store-submission-guide.md demo/README.md demo/outreach-message.md demo/trust-demo.html demo/store-assets-frame.html lib/brand-identity.test.ts
git commit -m "docs: rename maintained product copy to Runi"
```

### Task 5: Replace the Aluminum Mark with a Rounded Runi Mark

**Files:**
- Modify: `docs/store-assets/icon-source.svg`
- Regenerate: `public/icons/icon-16.png`
- Regenerate: `public/icons/icon-32.png`
- Regenerate: `public/icons/icon-48.png`
- Regenerate: `public/icons/icon-128.png`
- Regenerate: `docs/store-assets/icon-128.png`
- Inspect/regenerate if branded: `docs/store-assets/promo-small-440x280.png`
- Inspect/regenerate if branded: `docs/store-assets/screenshot-chat.png`
- Inspect/regenerate if branded: `docs/store-assets/screenshot-confirm.png`

**Interfaces:**
- Consumes: existing cyan-to-violet accent and approved lighter, rounded visual direction.
- Produces: one canonical SVG and pixel-checked Chrome icon assets at 16, 32, 48, and 128 px.

- [ ] **Step 1: Record the current asset hashes**

Run:

```bash
shasum -a 256 docs/store-assets/icon-source.svg public/icons/icon-16.png public/icons/icon-32.png public/icons/icon-48.png public/icons/icon-128.png docs/store-assets/icon-128.png
```

Expected: six current hashes to compare against regenerated assets.

- [ ] **Step 2: Replace the A glyph with the approved R geometry**

Keep a 128×128 SVG. Use a light background and the existing cyan/indigo/violet accent family. The essential R mark is:

```svg
<rect x="3" y="3" width="122" height="122" rx="30" fill="url(#bg)"/>
<path d="M39 103V25H68C84 25 94 35 94 50C94 65 84 75 68 75H39M68 75L96 103"
      fill="none" stroke="url(#accent)" stroke-width="14"
      stroke-linecap="round" stroke-linejoin="round"/>
```

Define `bg` from `#f8fbff` to `#eef2ff` and retain an accent flowing from `#22d3ee` through `#5b6ff0` to `#a855f7`. Remove the Aluminum A glyph, metal/industrial cues, and decorative details that disappear at 16 px.

- [ ] **Step 3: Regenerate every icon raster from the canonical SVG**

Run:

```bash
rsvg-convert -w 16 -h 16 docs/store-assets/icon-source.svg -o public/icons/icon-16.png
rsvg-convert -w 32 -h 32 docs/store-assets/icon-source.svg -o public/icons/icon-32.png
rsvg-convert -w 48 -h 48 docs/store-assets/icon-source.svg -o public/icons/icon-48.png
rsvg-convert -w 128 -h 128 docs/store-assets/icon-source.svg -o public/icons/icon-128.png
rsvg-convert -w 128 -h 128 docs/store-assets/icon-source.svg -o docs/store-assets/icon-128.png
```

- [ ] **Step 4: Verify dimensions and visual legibility**

Run: `file public/icons/icon-*.png docs/store-assets/icon-128.png`

Expected: exact 16×16, 32×32, 48×48, and 128×128 dimensions.

Open all generated rasters with the image viewer. At 16 px the shape must still read as an R, have no clipped stroke, and remain distinguishable in both light and dark browser chrome. If it fails, adjust only the SVG and repeat Step 3.

- [ ] **Step 5: Audit and regenerate branded store images**

Open the three store PNGs. If old text or the old A icon is visible, render the updated `demo/store-assets-frame.html` and replace the affected PNG at its existing pixel dimensions. Verify `promo-small-440x280.png` remains exactly 440×280.

- [ ] **Step 6: Run store-asset verification and commit**

Run:

```bash
pnpm vitest run lib/store-showcase.test.ts
pnpm build
```

Expected: PASS and build exit 0.

```bash
git add docs/store-assets/icon-source.svg public/icons docs/store-assets/icon-128.png docs/store-assets/promo-small-440x280.png docs/store-assets/screenshot-chat.png docs/store-assets/screenshot-confirm.png
git commit -m "feat: add Runi brand icon and store assets"
```

### Task 6: Audit the Rename and Verify the Release Build

**Files:**
- Modify if required by findings: only active runtime, maintained documentation, or store assets listed in Tasks 1–5

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a build where every remaining Aluminum occurrence is intentionally historical or a legacy legal URL.

- [ ] **Step 1: Run the repository-wide Aluminum audit**

Run:

```bash
rg -n -i "aluminum" -g '!docs/superpowers/**' -g '!docs/specs/**' -g '!docs/chrome-store-release-checklist-1.1.md'
```

Expected: matches only in the approved design/implementation documents describing the rename, explicit upgrade-reset notices, and `aluminum-legal` URLs. There must be no match in `lib/`, `components/`, `entrypoints/`, `public/`, `package.json`, READMEs, active product prose, or demo UI.

- [ ] **Step 2: Run formatting and static verification**

Run:

```bash
git diff --check
pnpm compile
```

Expected: both exit 0.

- [ ] **Step 3: Run the full automated test suite**

Run: `pnpm test`

Expected: all Vitest files pass.

- [ ] **Step 4: Build and inspect the packaged manifest**

Run:

```bash
pnpm build
sed -n '1,220p' .output/chrome-mv3/manifest.json
```

Expected: build exits 0; manifest keeps the same permissions and uses localized `__MSG_extName__`; packaged locale messages resolve to Runi.

- [ ] **Step 5: Perform a manual fresh-upgrade check**

With the current Aluminum extension installed, create a recognizable provider and conversation. Load the Runi build over the same extension ID. Confirm Runi starts with default settings and an empty history and requires a new provider/API key. Confirm the Settings privacy disclosure accurately explains which data stays local and which relevant request content may be sent to the configured provider; initiating an Agent request is the user's action directing that transmission, and Runi does not store a separate consent record. Confirm write tools ask before the first write action in a turn and remember that decision only for the current turn. Confirm the old Aluminum keys/database were not modified or deleted by inspecting extension storage.

- [ ] **Step 6: Perform a manual brand and icon check**

Confirm the extensions page, toolbar tooltip, side-panel header, empty state, settings title, privacy notice, and browser console prefixes all display Runi. Verify the R icon at toolbar size and the English/Chinese Chrome locale variants.

- [ ] **Step 7: Route any audit finding back to its owning task**

If Steps 1–6 reveal a defect, return to the task that owns that file, repeat its focused test/build step, and include the correction in that task's commit. Do not create an empty or catch-all audit commit.
