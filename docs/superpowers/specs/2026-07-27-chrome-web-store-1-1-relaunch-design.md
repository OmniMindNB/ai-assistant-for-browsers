# Chrome Web Store 1.1 Relaunch Design

Date: 2026-07-27

## Context

Aluminum `1.0.0` is already published in the Chrome Web Store. The product has since added a complete English UI and now targets both English- and Chinese-speaking users. This release updates the existing Store item and preserves its item ID.

The relaunch must also align the product, Store disclosures, public privacy policy, and marketing assets with the Chrome Web Store user-data requirements that take effect on 2026-08-01. The release will be prepared completely, but the final Store review submission remains a user-confirmed action.

## Goals

- Release the existing Store item as version `1.1.0`.
- Make English the default extension and Store language.
- Keep Simplified Chinese as a complete localized experience.
- Add an explicit first-use privacy notice and consent gate.
- Publish consistent English and Chinese privacy policies.
- Refresh the Store listing, disclosures, screenshots, and promotional image.
- Produce a verified upload ZIP and a submission-ready checklist.

## Non-Goals

- Do not create a new Chrome Web Store item.
- Do not rename Aluminum or redesign its icon.
- Do not add or broaden browser permissions.
- Do not add analytics, a developer backend, accounts, or cloud sync.
- Do not change the Agent's core product behavior beyond gating it on privacy consent.
- Do not create a marquee promotional image.
- Do not submit the release for Chrome Web Store review without final user confirmation.

## Release Structure

- Change the package version from `1.0.0` to `1.1.0`.
- Change the manifest `default_locale` from `zh_CN` to `en`.
- Keep `en` and `zh_CN` Chrome locale catalogs.
- Keep the existing permissions and host permissions unchanged.
- Treat the release as a normal update to the existing Store item.

Existing `1.0.0` users must complete the new privacy consent gate the first time they open `1.1.0`. The consent record stays only in `chrome.storage.local`.

## First-Use Privacy Consent

### Experience

Before consent, both the side panel and Options page show a dedicated full-page privacy notice instead of the normal product UI. The page explains:

- Page content, screenshots, and conversations may be sent to the AI provider configured by the user.
- API keys, provider settings, consent state, and conversation history remain in browser-local storage.
- Aluminum has no developer-operated backend, analytics, or advertising SDK.

The page provides:

- A link to the public privacy policy.
- `Not now` / `暂不同意`.
- `Agree & continue` / `同意并继续`.

Choosing `Not now` does not save consent and leaves the gate in place. Choosing `Agree & continue` stores the current consent version and opens the normal product flow.

### Data Boundary

Before consent, the extension must not:

- Extract page text, HTML, DOM, styles, scripts, or selections.
- Capture the visible tab.
- Call an AI provider.
- Initialize an Agent run.

Normal extension startup and local preference reads may still occur when required to render the consent page.

### Consent Storage

Store a versioned consent record in `chrome.storage.local`. The exact schema should be minimal and include at least the accepted consent version. A substantive future change to data use increments the required version and triggers renewed consent. Copy edits that do not change data use do not trigger renewed consent.

Consent loading fails closed. A read error is treated as no consent. A write error keeps the user on the notice and displays a localized error instead of entering the product.

## Store Listing

### Localization

English is the default Store listing. A complete `zh_CN` localized listing includes its own description and localized marketing images.

The extension name remains `Aluminum`.

Recommended English short description:

> AI sidebar agent to understand, transform, and automate the current page—with your approval.

The Chinese short description should carry the same single purpose without adding unrelated capabilities.

### Detailed Description

Both descriptions frame Aluminum as one controllable browser-page Agent. They cover:

1. Page summarization and question answering.
2. Evidence-grounded technical analysis.
3. User confirmation before page changes.
4. One-click undo for each modified turn.
5. Bring-your-own-provider and local-first history.

The text must avoid implying that Aluminum operates a cloud service or supports functionality that is not present in `1.1.0`.

### Dashboard Disclosures

The release materials include paste-ready English and Chinese answers for:

- Single purpose.
- `activeTab`.
- `tabs`.
- `scripting`.
- `storage`.
- `sidePanel`.
- `userScripts`.
- `<all_urls>` host access.
- Data collection and use.

`Website content` remains disclosed because the extension can process page text, HTML, DOM data, styles, external resources, and screenshots. The implementation review must also verify whether any other Dashboard category needs disclosure under the current form wording, especially user-provided conversations that may contain personal information.

The disclosure text must consistently state that data is processed only for the user-requested core feature, is sent only to the provider selected by the user, is not sold, and is not used for advertising, profiling, credit, or unrelated purposes.

## Public Privacy Policy

The existing public URL remains:

`https://omnimindnb.github.io/aluminum-legal/`

The `omnimindnb/aluminum-legal` repository will be obtained, updated, and published through GitHub Pages.

### Routes

- `/` is the English default.
- `/zh-CN/` is the Simplified Chinese version.
- Both pages contain a prominent language switch.

### Required Sections

Both language versions contain equivalent coverage of:

- Product identity and effective date.
- Data categories and data flow.
- Purpose and legal basis of processing.
- Local storage and deletion.
- Third-party AI providers.
- Browser permissions.
- External script and stylesheet retrieval.
- Children’s privacy.
- Policy change notification.
- Contact information.
- Chrome Web Store Limited Use compliance.

The policy must explain the first-use consent gate and distinguish data stored locally from data transmitted directly to a user-configured provider.

The extension repository remains a source of truth for the policy text. `docs/privacy-policy.md` is updated and an English counterpart is added. The Store listing, repository documents, and public legal site must not contradict each other.

## Marketing Assets

Keep the existing Aluminum name and icon. Replace the current Store screenshots that show Google and Wikipedia content with controlled demonstration content from this repository.

Use the approved product-value-first visual direction:

- Deep blue brand framing.
- A short benefit-led headline.
- Real `1.1.0` product UI as evidence.
- Separate English and Chinese assets.
- No mixed-language images.

Create these assets for each locale:

- One `440×280` small promotional image.
- Four `1280×800` screenshots:
  1. Page summarization and question answering.
  2. Evidence-grounded technical analysis.
  3. Confirmation before modification.
  4. One-click undo and local-first messaging.

Do not create a `1400×560` marquee image in this release.

Store localized files in clear per-locale directories and document where each file is uploaded in the Developer Dashboard.

## Documentation Updates

Update the Chrome Web Store submission guide to:

- Describe an existing-item `1.1.0` update instead of a first listing.
- Make English the default and Chinese the localization.
- Remove outdated assumptions about submitting before 2026-08-01.
- Link the new localized listing copy and asset directories.
- Include the revised privacy-practices answers.
- Include the published English and Chinese policy URLs.
- End at a user-confirmed final review checkpoint before Store submission.

Update the permission-justification document against actual API usage and current Dashboard wording.

## Testing and Verification

### Automated

- Add unit tests for consent loading, saving, version matching, version invalidation, and storage failures.
- Keep English and Chinese translation keys type-safe and structurally identical.
- Run `pnpm compile`.
- Run `pnpm test`.
- Run `pnpm build`.
- Run `pnpm zip`.
- Inspect the built manifest for version, default locale, locale catalogs, permissions, and host permissions.
- Verify all marketing asset dimensions.

### Manual

Verify:

- A new installation sees the consent gate.
- An upgrade from `1.0.0` sees the consent gate.
- `Not now` keeps the gate in place.
- `Agree & continue` persists across reopening the side panel and Options page.
- Storage failures do not bypass consent.
- English and Chinese versions render complete copy and correct links.
- Provider configuration, summarization, confirmation, undo, and the `userScripts` wait flow still work after consent.
- No page extraction or provider request occurs before consent.
- Both public privacy-policy routes are live and equivalent.
- The final English and Chinese screenshots match the released UI.

## Delivery

The completed relaunch package includes:

- Version `1.1.0` source changes.
- A verified Chrome upload ZIP.
- Paste-ready English and Chinese Store copy.
- Paste-ready permission and data-use answers.
- Localized promotional images and screenshots.
- A published bilingual legal site.
- A final submission checklist.

Work stops before the Chrome Web Store `Submit for review` action. The user reviews the package and explicitly confirms before any future submission step.

## References

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Chrome Web Store Listing Images](https://developer.chrome.com/docs/webstore/images)
- [Chrome Web Store Listing Guidance](https://developer.chrome.com/docs/webstore/best-listing)
