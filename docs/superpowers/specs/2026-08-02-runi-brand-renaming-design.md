# Runi Brand Renaming Design

**Date:** 2026-08-02  
**Status:** Approved naming direction

## Objective

Rename the product from **Aluminum** to **Runi** with a shorter, friendlier, and more memorable identity that works naturally for both English- and Chinese-speaking users.

## Brand Decision

- **English name:** Runi
- **Chinese reading:** 如你
- **English tagline:** Your page, your way.
- **Chinese tagline:** 网页，如你所愿。
- **Pronunciation:** “roo-nee”; Chinese users can read it as “如你”

Runi expresses a product that works according to the user's choices. This matches the extension's core behavior: it uses the model provider selected by the user, keeps product data local, grounds answers in the current page, and requests approval before changing the page.

## Brand Character

Runi should feel:

- light and friendly;
- calm and trustworthy;
- capable without sounding technical or corporate;
- approachable without becoming childish or mascot-led.

The product name should stand on its own. Functional terms such as “AI,” “browser,” “agent,” and “sidebar” may appear in descriptions, but are not part of the brand name.

## Verbal Identity

Use **Runi** consistently in English and Chinese interfaces. “如你” is a reading and brand association, not a separate localized product name. Store listings may introduce it once as “Runi（如你）” when that helps Chinese users remember the pronunciation.

Preferred copy emphasizes user agency:

- “Your page, your way.”
- “网页，如你所愿。”
- “Runi helps you understand and work with the current page.”

Avoid copy that suggests Runi acts without the user, owns the page, or replaces user judgment. The tone should remain direct and reassuring rather than cute or overly conversational.

## Visual Direction

The existing cyan-to-violet accent may remain to preserve continuity, but the heavy metallic association should be removed. The refreshed identity should use:

- a lighter visual balance with more open space;
- rounded geometry;
- a simple **R**-based mark that remains legible at 16 px;
- motion or flowing forms that suggest adapting to the user;
- no metal textures, chemical symbols, ingots, or industrial imagery.

The icon must be tested at Chrome Web Store and browser-toolbar sizes before adoption. A mascot is outside the scope of this rename.

## Rename Scope

The implementation should update user-visible branding across:

- extension manifests and localized extension names;
- side-panel and settings UI;
- README files and product documentation;
- Chrome Web Store listing copy and promotional assets;
- privacy-policy product references and public support pages;
- demo content, screenshots, and accessibility text;
- developer-facing log prefixes where they are visible during support or diagnostics.

## Fresh Data Namespace

The rename intentionally starts with a new local data namespace. All persistence identifiers containing `aluminum` must be replaced with Runi identifiers, including:

- `aluminum:settings` → `runi:settings`;
- `aluminum:shortcuts` → `runi:shortcuts`;
- `aluminum:theme` → `runi:theme`;
- `aluminum:locale` → `runi:locale`;
- IndexedDB database `aluminum` → `runi`.

There is no migration or legacy fallback. The Runi release must not read, copy, import, or delete data from the old Aluminum namespace. After upgrading, users begin with default settings and an empty conversation history, and must configure their provider and API key again. The old Aluminum data may remain in browser storage but is inert and inaccessible to Runi.

Package identifiers, repository names, and published URLs may remain unchanged initially when changing them would break links or release continuity. They can be migrated later under a separate compatibility plan.

## Validation

Before release:

1. Search the repository case-insensitively for `Aluminum` and classify every occurrence as user-visible branding, compatibility-sensitive identifier, historical record, or intentional legacy URL.
2. Verify localized manifests and store listings display **Runi** consistently.
3. Confirm an upgrade from the current release ignores the Aluminum namespace and initializes default Runi settings with an empty Runi conversation database.
4. Confirm Runi does not delete or modify the inert Aluminum data during startup or normal use.
5. Verify settings, API keys, shortcuts, theme, locale, and new conversations persist normally in the Runi namespace after they are recreated.
6. Render the icon at 16, 32, 48, and 128 px and confirm that it remains recognizable.
7. Run the existing automated test suite and add focused tests for the new persistence identifiers and fresh-start behavior.

## Naming Risk

The initial web search found no exact browser-extension competitor named Runi, but this is not a trademark clearance. Before a public relaunch, perform formal trademark, domain, package-name, social-handle, and Chrome Web Store availability checks in target markets.

## Out of Scope

- Changing product behavior or permissions
- Introducing a mascot or character persona
- Migrating, importing, or deleting data from the Aluminum persistence namespace
- Repository or legal-site URL migration
- Formal trademark legal advice
