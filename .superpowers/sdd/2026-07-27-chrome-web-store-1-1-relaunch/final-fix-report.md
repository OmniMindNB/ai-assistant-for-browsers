# Chrome Web Store 1.1.0 Final Fix Report

## Status

Complete. No Chrome Web Store upload or review submission was performed.

## Implementation Commit

`92b9cbab242e5b3c1bad4c0497bab342f1fc2811` — `fix: remove user scripts from store release`

## Follow-Up: Consent Heading and Plan Scope

`0c5b505961e57aa1ee221a9420e9e99048fba05b` — `fix: clarify consent storage wording`

- Replaced the broad local-only consent headings with `Stored locally in your browser` and `保存在浏览器本地`.
- Added a dated, user-approved Option A amendment to the active relaunch plan and corrected its permission and retained-tool manual-QA lines.

RED command:

```bash
CI=true pnpm vitest run lib/final-review.test.ts
```

Result: failed as expected with the old English `Your data stays local` and Chinese `数据保留在本机` headings.

GREEN commands:

```bash
CI=true pnpm vitest run lib/final-review.test.ts
CI=true pnpm compile
```

Result: focused runtime suite passed 3/3 and TypeScript compilation passed. A plan scan found no remaining contradictory `userScripts` permission or wait/cancel/retry QA line; the only remaining text is the superseding amendment itself.

## Files Changed

- Store capability removal: `wxt.config.ts`, `lib/messaging.ts`, `entrypoints/background.ts`, `lib/agent/tools.ts`, `lib/agent/permissions.ts`, `lib/agent/agent.ts`, `lib/agent/confirm-summary.ts`, `entrypoints/sidepanel/store.ts`, `entrypoints/sidepanel/App.tsx`, and `lib/agent/tab-target.ts`.
- Removed capability-only code/tests: `lib/security.ts`, `lib/agent/inject-script-blocked.ts`, `lib/agent/inject-script-blocked.test.ts`, and `lib/agent/tools.test.ts`.
- Redirect-safe resource retrieval: `lib/page-resource-fetch.ts` and `lib/page-resource-fetch.test.ts`.
- Release/consent regression coverage: `lib/final-review.test.ts`, `lib/agent/permissions.test.ts`, `lib/agent/confirm-summary.test.ts`, and `lib/i18n/locales/{en,zh}.ts`.
- Store and privacy material: `docs/chrome-store-*`, `docs/privacy-policy*`, `docs/PROGRESS.md`, `docs/superpowers/specs/2026-07-27-chrome-web-store-1-1-relaunch-design.md`, `CLAUDE.md`, `package.json`, and `pnpm-lock.yaml`.

## RED Evidence

Command:

```bash
pnpm vitest run lib/final-review.test.ts lib/page-resource-fetch.test.ts
```

Result: failed as expected before production changes. The manifest assertion found `userScripts`; the English and Chinese consent-copy assertions found the prior local-only wording; and the SSRF suite could not import the not-yet-created `page-resource-fetch` module.

## GREEN and Final Validation

Focused GREEN command:

```bash
CI=true pnpm vitest run lib/final-review.test.ts lib/page-resource-fetch.test.ts lib/agent/permissions.test.ts lib/agent/confirm-summary.test.ts
```

Result: 4 files and 46 tests passed.

Final commands:

```bash
CI=true pnpm compile
CI=true pnpm test
CI=true pnpm build
CI=true pnpm zip
```

Result: compile passed; 19 test files and 180 tests passed; production build and ZIP creation passed. Generated and archived manifests were both checked for version `1.1.0`, `default_locale: "en"`, the `en` and `zh_CN` locale catalogs, and the absence of `userScripts`.

## ZIP Metadata

- ZIP: `.output/aluminum-1.1.0-chrome.zip`
- SHA-256: `cb29846193c173181e1d38b41f8240cb4f8596c9573b35155109610b9f1c3b46`
- Entries: `44`
- Permissions: `sidePanel`, `storage`, `scripting`, `activeTab`, `tabs`
- Host permission: `<all_urls>`

## Concerns

- Chrome-only interactive regression checks remain deferred because no interactive Chrome runtime is available here.
- `pnpm` required `CI=true` after its dependency-state guard requested a modules-directory purge; dependencies were restored with an approved registry install before validation.

## Scoped Re-review Residual: Opaque Redirects

The scoped reviewer confirmed the consent and `userScripts` findings were resolved, but identified that Chrome represents a manual redirect as an `opaqueredirect` response with status `0` and hidden headers. The original synthetic 3xx tests did not model that browser behavior.

RED command:

```bash
CI=true pnpm vitest run lib/page-resource-fetch.test.ts
```

Result: failed 1/19 because the opaque redirect returned the generic error `0 ` rather than an explicit safe failure.

Resolution: detect `opaqueredirect`/status `0` and reject it with a clear error instead of following an address Chrome does not expose for validation. The bilingual repository and live privacy policies now describe this fail-closed behavior.

GREEN commands:

```bash
CI=true pnpm vitest run lib/page-resource-fetch.test.ts
CI=true pnpm compile
```

Result: 19/19 focused tests passed and TypeScript compilation passed.
