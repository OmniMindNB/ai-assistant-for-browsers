# Final fix wave 1 report

## Scope

- Live-refresh Provider and workbench-preference settings in an already-open sidepanel.
- Normalize displayed slash commands and matching with one helper.
- Preserve explicit denied/stopped Agent terminal states and localize their UI.
- Reset local conversation mode and page attachment only after a successful history open.
- Gate Provider CRUD behind initial loading/error/retry handling.
- Keep the model popup within the full composer width.
- Treat both Chrome Web Store host variants as restricted, including page-context classification.

## TDD evidence

Focused RED was captured before implementation: six targeted failures covering the missing slash normalization, terminal summaries, protected origins, and Provider loading gate. Additional focused regressions cover protected page-context classification, terminal card labels, and the full-width model menu structure.

## Verification

- `pnpm vitest run entrypoints/sidepanel/store-context.test.tsx entrypoints/sidepanel/components/workbench-components.test.tsx lib/workbench/presentation.test.ts lib/page-resource-fetch.test.ts components/settings-components.test.tsx` — 116 passed.
- `pnpm compile` — passed.
- `pnpm test` — 27 files, 321 tests passed.
- `pnpm build` — Chrome MV3 production build passed.
- `git diff --check` — passed.

## Notes

API keys remain masked, deny-first tool policy and detached turns remain intact, and no build output or credentials are included in the change.
