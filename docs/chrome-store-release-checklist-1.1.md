# Aluminum 1.1 Chrome Web Store Release Checklist

Release date: 2026-07-28

## Package

- [x] ZIP: `/Users/dongliu/startup/ai-assistant-for-browsers/.output/aluminum-1.1.0-chrome.zip`
- [x] SHA-256: `6a9a8631a9895e46e2e8c2639a746235a4fa8a429272689ef117e7d1d61b6410`
- [x] Generated manifest: `/Users/dongliu/startup/ai-assistant-for-browsers/.output/chrome-mv3/manifest.json`
- [x] Archive manifest matches the generated manifest exactly.
- [x] Archive manifest declares version `1.1.0` and `default_locale: "en"`.
- [x] Archive contains `_locales/en/messages.json` and `_locales/zh_CN/messages.json`.
- [x] Permissions: `sidePanel`, `storage`, `scripting`, `activeTab`, and `tabs`; host permission remains `<all_urls>`. The Store build does not request `userScripts`.

## Store Content and Policy

- [x] English listing document: `/Users/dongliu/startup/ai-assistant-for-browsers/docs/chrome-store-listing.en.md`
- [x] Simplified Chinese listing document: `/Users/dongliu/startup/ai-assistant-for-browsers/docs/chrome-store-listing.zh-CN.md`
- [x] Permission and data-disclosure answers: `/Users/dongliu/startup/ai-assistant-for-browsers/docs/chrome-store-permission-justifications.md`
- [ ] PENDING — English privacy policy: verify `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/` returns HTTP `200` after deployment.
- [ ] PENDING — Simplified Chinese privacy policy: verify `https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/` returns HTTP `200` after deployment.
- [ ] PENDING — Confirm the final Dashboard category choices against the live Chrome Web Store privacy-practices form before saving a draft.

## Store Images

- [ ] DEFERRED — English source directory: `/Users/dongliu/startup/ai-assistant-for-browsers/docs/store-assets/source/en/`; real Aluminum screenshots are not available.
- [ ] DEFERRED — Simplified Chinese source directory: `/Users/dongliu/startup/ai-assistant-for-browsers/docs/store-assets/source/zh-CN/`; real Aluminum screenshots are not available.
- [ ] DEFERRED — Store screenshots and small promo images; Task 7 is skipped. Do not upload or represent any existing PNG as a verified 1.1.0 Store image asset.

## Automated Verification

- [x] `pnpm compile` — exit `0`; `tsc --noEmit` produced no diagnostics.
- [x] `pnpm test` — exit `0`; 20 test files and 189 tests passed.
- [x] `pnpm build` — exit `0`; WXT built `.output/chrome-mv3` for production.
- [x] `pnpm zip` — exit `0`; WXT generated the release ZIP above.
- [x] `unzip -l .output/aluminum-1.1.0-chrome.zip` — archive contains 44 entries, including both locale directories.
- [x] `unzip -p .output/aluminum-1.1.0-chrome.zip manifest.json` — inspected the packaged manifest fields and permissions.
- [x] `shasum -a 256 .output/aluminum-1.1.0-chrome.zip` — recorded the package checksum above.

## Manual Chrome Regression QA

No interactive Chrome extension runtime is available in this environment. The following Chrome-only checks remain explicitly deferred or pending; passing automated tests do not replace these manual checks.

- [ ] DEFERRED — Fresh Chrome installation of the packaged extension.
- [ ] DEFERRED — Upgrade from Aluminum `1.0.0`.
- [ ] DEFERRED — Consent decline, acceptance, cross-surface persistence, and storage-write failure in Chrome. Automated component/storage coverage passes, but browser UI verification is pending.
- [ ] DEFERRED — English and Simplified Chinese language switching in Chrome.
- [ ] DEFERRED — Under the English UI, both `Summarize page` and `Explain selection` answer in English; under the Simplified Chinese UI, both shortcuts answer in Chinese.
- [ ] DEFERRED — Provider configuration with a real test provider.
- [ ] DEFERRED — Summarization and evidence analysis with a real provider.
- [ ] DEFERRED — Confirmation flow and turn-level undo in Chrome.

## Submission Gate

- [x] Chrome Web Store upload and `Submit for review` were not performed.
- [ ] User confirmed Submit for review.
