# Current-Repository Privacy Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the repository's canonical English and Simplified Chinese Runi privacy policies at stable GitHub Pages subpaths and replace every maintained reference to the retired `aluminum-legal` site.

**Architecture:** Jekyll renders the two existing Markdown policy files through one repository-local legal layout. A GitHub Pages workflow tests the repository, builds `docs/` with the official Jekyll Pages action, uploads the generated artifact, and deploys it through the `github-pages` environment. Vitest contracts protect the routes, bilingual navigation, workflow permissions, and current release-document URLs.

**Tech Stack:** Markdown, Jekyll/GitHub Pages, Liquid, HTML/CSS, GitHub Actions, TypeScript, Vitest, pnpm 11.10.0, Node.js 22

## Global Constraints

- English URL: `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/`.
- Simplified Chinese URL: `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/`.
- `docs/privacy-policy.en.md` and `docs/privacy-policy.md` remain the only policy-body sources.
- Do not modify, delete, archive, or redirect `OmniMindNB/aluminum-legal`.
- Do not change the substantive privacy-policy body in this migration.
- Do not add third-party scripts, analytics, remote fonts, cookies, tracking pixels, a custom domain, or a client-side application.
- Historical specs and plans remain unchanged; migrate only maintained release surfaces and active tests.
- GitHub Actions must use only `contents: read`, `pages: write`, and `id-token: write` permissions.
- A failed test or build must prevent deployment and leave the previous successful Pages deployment intact.

---

## File Structure

- Create `lib/legal-pages.test.ts`: active contract for policy metadata, legal layout, Jekyll configuration, deployment workflow, and maintained URLs.
- Create `docs/_layouts/privacy-policy.html`: shared semantic HTML and responsive CSS for both policies.
- Create `docs/_config.yml`: minimal Jekyll configuration for the Pages build.
- Create `.github/workflows/deploy-pages.yml`: test, Jekyll build, artifact upload, and Pages deployment.
- Modify `docs/privacy-policy.en.md`: add English Jekyll front matter only.
- Modify `docs/privacy-policy.md`: add Simplified Chinese Jekyll front matter only.
- Modify `docs/chrome-store-listing.en.md`: replace the English deployed-policy URL.
- Modify `docs/chrome-store-listing.zh-CN.md`: replace the Simplified Chinese deployed-policy URL.
- Modify `docs/chrome-store-permission-justifications.md`: replace both deployed-policy routes.
- Modify `docs/chrome-store-submission-guide.md`: replace all current policy URL instructions and checks.
- Modify `docs/chrome-store-release-checklist-1.1.md`: record the new routes as pending until the new deployment is verified.
- Modify `lib/brand-identity.test.ts`: stop permitting the legacy legal URL and require the new repository Pages URLs.

---

### Task 1: Canonical policy metadata and shared legal layout

**Files:**
- Create: `lib/legal-pages.test.ts`
- Create: `docs/_layouts/privacy-policy.html`
- Create: `docs/_config.yml`
- Modify: `docs/privacy-policy.en.md:1`
- Modify: `docs/privacy-policy.md:1`

**Interfaces:**
- Consumes: the existing Markdown body and its current `2026-08-02` effective date.
- Produces: Jekyll pages at `/privacy-policy/` and `/privacy-policy/zh-CN/`, using the `privacy-policy` layout and `alternate_path | relative_url` for bilingual navigation.

- [ ] **Step 1: Write the failing policy-site contract**

Create `lib/legal-pages.test.ts` with the metadata and layout tests below. The small front-matter parser deliberately accepts only the flat scalar metadata used by these two pages.

```ts
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

  it('uses one local, responsive, base-path-safe layout without tracking', () => {
    const layout = read('docs/_layouts/privacy-policy.html');

    expect(layout).toContain('<html lang="{{ page.lang }}">');
    expect(layout).toContain('name="viewport"');
    expect(layout).toContain('{{ page.alternate_path | relative_url }}');
    expect(layout).toContain('{{ content }}');
    expect(layout).toContain('prefers-color-scheme: dark');
    expect(layout).toContain('overflow-x: auto');
    expect(layout).not.toMatch(/<script|https?:\/\/|analytics|tracking/i);
  });

  it('keeps Jekyll configuration local and excludes internal planning artifacts', () => {
    const config = read('docs/_config.yml');

    expect(config).toContain('title: Runi Legal');
    expect(config).toContain('markdown: kramdown');
    expect(config).toContain('- superpowers');
    expect(config).toContain('- store-assets');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts
```

Expected: FAIL because both Markdown files lack front matter and `docs/_layouts/privacy-policy.html` and `docs/_config.yml` do not exist.

- [ ] **Step 3: Add exact Jekyll metadata to both canonical Markdown files**

Prepend this block to `docs/privacy-policy.en.md` without changing the existing body after it:

```yaml
---
layout: privacy-policy
title: Runi Privacy Policy
lang: en
permalink: /privacy-policy/
alternate_path: /privacy-policy/zh-CN/
alternate_label: 中文
current_language_label: English
language_navigation_label: Language
---
```

Prepend this block to `docs/privacy-policy.md` without changing the existing body after it:

```yaml
---
layout: privacy-policy
title: Runi 隐私政策
lang: zh-CN
permalink: /privacy-policy/zh-CN/
alternate_path: /privacy-policy/
alternate_label: English
current_language_label: 中文
language_navigation_label: 语言
---
```

- [ ] **Step 4: Create the shared Jekyll layout**

Create `docs/_layouts/privacy-policy.html` with this structure and local CSS. Keep the language ordering natural on each page and send every cross-language link through `relative_url`.

```html
<!doctype html>
<html lang="{{ page.lang }}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>{{ page.title }}</title>
    <style>
      :root {
        color-scheme: light dark;
        --background: #ffffff;
        --foreground: #1b1d22;
        --muted: #5f6672;
        --border: #dfe3e8;
        --surface: #f4f6f8;
        --link: #275ea8;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #15171b;
          --foreground: #eef0f3;
          --muted: #abb2bd;
          --border: #343942;
          --surface: #20242a;
          --link: #8abcf0;
        }
      }
      * { box-sizing: border-box; }
      html { overflow-wrap: anywhere; }
      body {
        margin: 0;
        background: var(--background);
        color: var(--foreground);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Microsoft YaHei", sans-serif;
        line-height: 1.7;
      }
      main {
        width: min(100%, 52rem);
        margin: 0 auto;
        padding: 2rem 1.25rem 5rem;
      }
      nav { margin-bottom: 2rem; color: var(--muted); text-align: right; }
      h1 { margin: 0 0 0.35rem; font-size: clamp(1.8rem, 6vw, 2.35rem); line-height: 1.2; }
      h2 {
        margin: 2.5rem 0 0.75rem;
        padding-top: 1.5rem;
        border-top: 1px solid var(--border);
        font-size: 1.25rem;
        line-height: 1.35;
      }
      p, ul { margin: 0.8rem 0; }
      ul { padding-left: 1.4rem; }
      table {
        display: block;
        width: 100%;
        margin: 1rem 0;
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        border-collapse: collapse;
        font-size: 0.92rem;
      }
      th, td {
        min-width: 10rem;
        padding: 0.65rem 0.75rem;
        border: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      th { background: var(--surface); }
      code {
        padding: 0.1rem 0.35rem;
        border-radius: 0.25rem;
        background: var(--surface);
        font-size: 0.9em;
      }
      pre { max-width: 100%; overflow-x: auto; }
      a { color: var(--link); }
      @media (max-width: 36rem) {
        main { padding-top: 1.25rem; }
        nav { margin-bottom: 1.5rem; }
      }
    </style>
  </head>
  <body>
    <main>
      <nav aria-label="{{ page.language_navigation_label }}">
        {% if page.lang == "en" %}
          <strong>{{ page.current_language_label }}</strong> ·
          <a href="{{ page.alternate_path | relative_url }}" lang="zh-CN">{{ page.alternate_label }}</a>
        {% else %}
          <a href="{{ page.alternate_path | relative_url }}" lang="en">{{ page.alternate_label }}</a> ·
          <strong>{{ page.current_language_label }}</strong>
        {% endif %}
      </nav>
      <article>{{ content }}</article>
    </main>
  </body>
</html>
```

- [ ] **Step 5: Add minimal Jekyll configuration**

Create `docs/_config.yml`:

```yaml
title: Runi Legal
markdown: kramdown
encoding: utf-8
strict_front_matter: true
exclude:
  - superpowers
  - store-assets
  - adr
  - specs
```

- [ ] **Step 6: Run the focused policy tests**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts lib/final-review.test.ts
```

Expected: PASS. The existing effective-date tests must still find `2026-08-02` after the front matter.

- [ ] **Step 7: Commit the policy rendering unit**

```bash
git add lib/legal-pages.test.ts docs/privacy-policy.en.md docs/privacy-policy.md docs/_layouts/privacy-policy.html docs/_config.yml
git commit -m "feat: render privacy policies with Jekyll"
```

---

### Task 2: Migrate every maintained privacy-policy URL

**Files:**
- Modify: `lib/legal-pages.test.ts`
- Modify: `lib/brand-identity.test.ts`
- Modify: `docs/chrome-store-listing.en.md`
- Modify: `docs/chrome-store-listing.zh-CN.md`
- Modify: `docs/chrome-store-permission-justifications.md`
- Modify: `docs/chrome-store-submission-guide.md`
- Modify: `docs/chrome-store-release-checklist-1.1.md`

**Interfaces:**
- Consumes: the two stable permalinks from Task 1.
- Produces: one active English policy URL and one active Simplified Chinese policy URL across every maintained Chrome Web Store release surface; old URLs remain only in immutable historical specs/plans.

- [ ] **Step 1: Extend the failing contract for active release URLs**

Append this suite to `lib/legal-pages.test.ts`:

```ts
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
```

In `lib/brand-identity.test.ts`, replace the old URL construction:

```ts
const legacyLegalRoot = `https://omnimindnb.github.io/${legacyBrandName.toLowerCase()}-legal/`;
const englishLegalUrl = legacyLegalRoot;
const chineseLegalUrl = `${legacyLegalRoot}zh-CN/`;
```

with:

```ts
const repositoryPagesRoot =
  'https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/';
const retiredLegalRoot = `https://omnimindnb.github.io/${legacyBrandName.toLowerCase()}-legal/`;
const englishLegalUrl = repositoryPagesRoot;
const chineseLegalUrl = `${repositoryPagesRoot}zh-CN/`;
```

Then replace the final invalid-URL examples with checks that `retiredLegalRoot` is rejected on every maintained release surface:

```ts
it.each(Object.keys(permittedLegacyReferencesByPath))(
  '%s does not permit the retired legal repository URL',
  (path) => {
    expect(withoutPermittedLegacyReferences(path, retiredLegalRoot)).toMatch(
      legacyBrandPattern,
    );
  },
);
```

- [ ] **Step 2: Run the URL tests to verify they fail**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts lib/brand-identity.test.ts
```

Expected: FAIL because maintained documents still contain `aluminum-legal` and the new URLs are absent.

- [ ] **Step 3: Replace the current English and Chinese listing URLs**

In `docs/chrome-store-listing.en.md`, replace the deployed URL with:

```text
https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/
```

In `docs/chrome-store-listing.zh-CN.md`, replace it with:

```text
https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/
```

- [ ] **Step 4: Replace both routes in permissions and submission documentation**

Use these exact routes everywhere the maintained documents describe the deployed policy:

```markdown
- English default: `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/`
- Simplified Chinese: `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/`
```

Update `docs/chrome-store-permission-justifications.md` and every current instruction/check in `docs/chrome-store-submission-guide.md`. Preserve the existing guidance to use rendered Pages URLs rather than repository blob URLs.

- [ ] **Step 5: Reset the release checklist to the new, not-yet-verified deployment**

Replace the two checked old URL lines in `docs/chrome-store-release-checklist-1.1.md` with:

```markdown
- [ ] PENDING — English privacy policy: verify `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/` returns HTTP `200` after deployment.
- [ ] PENDING — Simplified Chinese privacy policy: verify `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/` returns HTTP `200` after deployment.
```

- [ ] **Step 6: Run URL and brand contracts**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts lib/brand-identity.test.ts
```

Expected: PASS. The legacy brand may remain only in the explicitly approved brand-upgrade notices, not in a legal URL.

- [ ] **Step 7: Confirm legacy URLs remain only in history**

Run:

```bash
rg -n "omnimindnb\.github\.io/aluminum-legal" . \
  --glob '!docs/superpowers/specs/**' \
  --glob '!docs/superpowers/plans/**' \
  --glob '!lib/legal-pages.test.ts' \
  --glob '!lib/brand-identity.test.ts'
```

Expected: no matches.

- [ ] **Step 8: Commit the URL migration**

```bash
git add lib/legal-pages.test.ts lib/brand-identity.test.ts docs/chrome-store-listing.en.md docs/chrome-store-listing.zh-CN.md docs/chrome-store-permission-justifications.md docs/chrome-store-submission-guide.md docs/chrome-store-release-checklist-1.1.md
git commit -m "docs: move privacy URLs to current repository"
```

---

### Task 3: Test and add the GitHub Pages deployment workflow

**Files:**
- Modify: `lib/legal-pages.test.ts`
- Create: `.github/workflows/deploy-pages.yml`

**Interfaces:**
- Consumes: Jekyll source in `docs/`, repository tests, and the two permalinks from Task 1.
- Produces: a `github-pages` artifact built only after tests pass and a deployment job authorized with Pages and OIDC write permissions.

- [ ] **Step 1: Add the failing workflow contract**

Append this suite to `lib/legal-pages.test.ts`:

```ts
describe('GitHub Pages deployment workflow', () => {
  const workflow = read('.github/workflows/deploy-pages.yml');

  it('builds on main and supports a manual deployment', () => {
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('tests before using the official Pages build and artifact actions', () => {
    expect(workflow).toContain('pnpm test');
    expect(workflow.indexOf('pnpm test')).toBeLessThan(
      workflow.indexOf('actions/jekyll-build-pages@v1'),
    );
    expect(workflow).toContain('source: ./docs');
    expect(workflow).toContain('destination: ./_site');
    expect(workflow).toContain('actions/configure-pages@v5');
    expect(workflow).toContain('actions/upload-pages-artifact@v4');
    expect(workflow).toContain('actions/deploy-pages@v4');
  });

  it('uses only the permissions required by GitHub Pages', () => {
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('contents: write');
  });

  it('deploys only the completed build through the github-pages environment', () => {
    expect(workflow).toContain('needs: build');
    expect(workflow).toContain('name: github-pages');
    expect(workflow).toContain('steps.deployment.outputs.page_url');
  });
});
```

- [ ] **Step 2: Run the workflow test to verify it fails**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts
```

Expected: FAIL with `ENOENT` for `.github/workflows/deploy-pages.yml`.

- [ ] **Step 3: Create the official Pages workflow**

Create `.github/workflows/deploy-pages.yml` using the current versions documented by GitHub Pages:

```yaml
name: Deploy privacy policies to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: github-pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11.10.0
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Test
        run: pnpm test

      - name: Configure GitHub Pages
        uses: actions/configure-pages@v5

      - name: Build with Jekyll
        uses: actions/jekyll-build-pages@v1
        with:
          source: ./docs
          destination: ./_site

      - name: Verify generated policy routes
        run: |
          test -f _site/privacy-policy/index.html
          test -f _site/privacy-policy/zh-CN/index.html
          grep -F "Runi Privacy Policy" _site/privacy-policy/index.html
          grep -F "Runi 隐私政策" _site/privacy-policy/zh-CN/index.html

      - name: Upload GitHub Pages artifact
        uses: actions/upload-pages-artifact@v4
        with:
          path: ./_site

  deploy:
    runs-on: ubuntu-latest
    needs: build
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: Run the workflow contract**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts
```

Expected: PASS.

- [ ] **Step 5: Perform static workflow checks**

Run:

```bash
rg -n "contents: write|pull_request_target|secrets\." .github/workflows/deploy-pages.yml
```

Expected: no matches. Then run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 6: Commit the deployment workflow**

```bash
git add lib/legal-pages.test.ts .github/workflows/deploy-pages.yml
git commit -m "ci: deploy privacy policies to GitHub Pages"
```

---

### Task 4: Full verification and live GitHub Pages publication

**Files:**
- Modify after successful live verification: `docs/chrome-store-release-checklist-1.1.md`

**Interfaces:**
- Consumes: all local changes from Tasks 1-3, the current repository's GitHub Pages settings, and the `main` branch deployment workflow.
- Produces: two live HTTPS policy pages returning HTTP 200 and a release checklist that records only checks actually completed against the deployed pages.

- [ ] **Step 1: Run the full local verification suite**

Run:

```bash
pnpm test
pnpm compile
pnpm build
git diff --check
```

Expected: all tests pass, TypeScript emits no errors, the Chrome MV3 production build succeeds, and `git diff --check` emits no output.

- [ ] **Step 2: Review the final changed-file boundary**

Run:

```bash
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: only the files named in this plan changed. No file in `OmniMindNB/aluminum-legal` is touched.

- [ ] **Step 3: Push the completed commits to `main`**

Run:

```bash
git push origin main
```

Expected: push succeeds and triggers `Deploy privacy policies to GitHub Pages`.

- [ ] **Step 4: Ensure the repository publishing source is GitHub Actions**

Use the repository Settings → Pages UI or the authenticated GitHub API to set the build type to `workflow`. Do not choose branch-directory publishing.

API verification command:

```bash
gh api repos/OmniMindNB/ai-assistant-for-browsers/pages --jq '{status, build_type, html_url}'
```

Expected after configuration: `build_type` is `workflow` and `html_url` is `https://omnimindnb.github.io/ai-assistant-for-browsers/`.

If the Pages site does not yet exist, create it with:

```bash
gh api --method POST repos/OmniMindNB/ai-assistant-for-browsers/pages -f build_type=workflow
```

If it exists with a different build type, update it with:

```bash
gh api --method PUT repos/OmniMindNB/ai-assistant-for-browsers/pages -f build_type=workflow
```

- [ ] **Step 5: Wait for the Pages workflow and inspect its result**

Run:

```bash
gh run list --workflow deploy-pages.yml --branch main --limit 1
PAGES_RUN_ID=$(gh run list --workflow deploy-pages.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$PAGES_RUN_ID" --exit-status
```

Expected: the latest workflow completes successfully, including the `deploy` job.

- [ ] **Step 6: Verify both live pages and language links**

Run:

```bash
curl -fsS https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/ | rg "Runi Privacy Policy|Effective date: 2026-08-02|/ai-assistant-for-browsers/privacy-policy/zh-CN/"
curl -fsS https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/ | rg "Runi 隐私政策|生效日期：2026-08-02|/ai-assistant-for-browsers/privacy-policy/"
```

Expected: both commands succeed and print all three expected markers. A failed request or missing marker leaves the release checklist pending.

- [ ] **Step 7: Mark only the verified checklist items complete**

After Step 6 succeeds, change the two pending entries in `docs/chrome-store-release-checklist-1.1.md` to:

```markdown
- [x] English privacy policy: `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/` returned HTTP `200` and the current Runi policy.
- [x] Simplified Chinese privacy policy: `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/` returned HTTP `200` and the current Runi policy.
```

- [ ] **Step 8: Re-run the affected tests and commit verification evidence**

Run:

```bash
pnpm vitest run lib/legal-pages.test.ts lib/brand-identity.test.ts lib/final-review.test.ts
```

Expected: PASS. Then commit:

```bash
git add docs/chrome-store-release-checklist-1.1.md
git commit -m "docs: verify current privacy policy pages"
git push origin main
```

Expected: the evidence commit is pushed and the subsequent Pages workflow also succeeds.

---

## Plan Self-Review

- **Spec coverage:** Task 1 covers canonical Markdown, stable routes, bilingual navigation, responsive local styling, and Jekyll configuration. Task 2 covers every maintained release URL and rejection of the retired site. Task 3 covers tests-before-build, official Pages Actions, permissions, artifact, environment, and concurrency. Task 4 covers full local verification, Pages configuration, push, deployment observation, live HTTP checks, and checklist evidence.
- **Type and name consistency:** Both test and front matter use `alternate_path`; both workflow contract and workflow use `build`, `deploy`, `./docs`, `./_site`, and `steps.deployment.outputs.page_url`. All active URLs use the same trailing-slash form.
- **Scope:** No task modifies the retired repository, historical specs/plans, policy body, product UI, or unrelated application code.
