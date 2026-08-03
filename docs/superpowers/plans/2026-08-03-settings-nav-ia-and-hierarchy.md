# Settings Nav IA & Hierarchy Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the settings page's weak-contrast text group headers with icon + divider grouping, reorder/regroup nav items (`Model providers` first, `Shortcuts` under general preferences, `About` moved to a muted footer slot), default the page to the `providers` section, and stop each settings panel from re-rendering the same title the nav already shows as active.

**Architecture:** Everything lives in three files: a new `components/settings-icons.tsx` module holding six line-icon components (styled like the existing `entrypoints/sidepanel/icons.tsx` set), `components/SettingsShell.tsx` (the nav shell, gains an `icon` field on each section descriptor, a `footerSections` prop, `role="group"` wrappers instead of visible `<p>` group titles, and a single responsive `<hr>` divider element that is a vertical bar on the mobile horizontal-scroll nav and a horizontal rule on the desktop vertical nav), and `entrypoints/options/App.tsx` (regroups sections, sets the icons, moves `about` into `footerSections`, changes the default section to `providers`, and drops the duplicate `<h2>` titles from all six panels).

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest + @testing-library/react (jsdom "ui" project in `vitest.config.ts`), WXT.

## Global Constraints

- No new icon library — reuse the hand-drawn linear SVG style from `entrypoints/sidepanel/icons.tsx` (`viewBox="0 0 24 24"`, `stroke="currentColor"`, `strokeWidth={1.8}`, round caps/joins).
- Do not change the `SettingsSection` union (`appearance | language | providers | shortcuts | privacy | about`) or add/remove settings items.
- `SettingsShell` is only consumed by `entrypoints/options/App.tsx` — no other call site to update.
- Icons must carry `aria-hidden="true"`; all nav semantics stay on the visible button text + `aria-current`.
- Final nav order: `Model providers` → divider → `Appearance`/`Language`/`Shortcuts` → divider → `Privacy & permissions` → divider → `About · v{version}` (muted footer style).
- Default section on page load: `providers` (was `appearance`).
- `pnpm compile` and `pnpm test` must pass at the end.

---

## Current State (for context)

- `components/SettingsShell.tsx` renders `groups: SettingsSectionGroup[]` where each group is `{ label, sections: { id, label }[] }`. The group `label` is shown via a `<p className="sr-only ... md:not-sr-only ...">` — visible only ≥`md`, and even then low-contrast. Keyboard arrow nav (`moveSelection`) walks `groups.flatMap(g => g.sections)`.
- `entrypoints/options/App.tsx` builds 3 groups (`Preferences` → appearance/language; `AI & tools` → providers/shortcuts; `Safety` → privacy/about), defaults `useState<SettingsSection>('appearance')`, and wraps four of the six panels in a local `SettingsPanel` component that renders `<h2>{title}</h2>` — duplicating the nav's active-item label. `PrivacySection`/`AboutSection` each inline their own `<h2 id="...">{t(...)}</h2>` the same way.
- `entrypoints/sidepanel/icons.tsx` has the icon style to copy (a private, unexported `Svg` wrapper per file — `settings-icons.tsx` will define its own copy, matching the existing per-file pattern rather than sharing a cross-file export).
- Exact icon paths were already agreed with the user during brainstorming and are archived in `.superpowers/brainstorm/395-1785726526/content/c-refined.html` and `order-and-mobile.html` — copied verbatim into Task 1 below, no redesign needed.
- `components/settings-components.test.tsx` is the only test file covering this code (`vitest.config.ts`'s `ui` project includes `components/**/*.test.tsx`, so this **is** exercised by `pnpm test` — the "no test setup for entrypoints/components" note in `CLAUDE.md` is stale for this specific file).
- `lib/i18n/locales/zh.ts` is the source of truth for translation keys (`en.ts` is typed as `Record<keyof typeof zh, string>` — adding a key to one without the other is a `pnpm compile` error). Existing relevant keys: `settings.navProviders` ("Model providers" / "模型 Provider"), `settings.navAppearance`, `settings.navLanguage`, `settings.navShortcuts`, `settings.navPrivacy`, `settings.navAbout` ("About" / "关于"), `settings.groupPreferences`, `settings.groupAiTools`, `settings.groupSafety`, `settings.version` (`'Version {version}'` / `'版本 {version}'`).

---

### Task 1: `components/settings-icons.tsx` — new icon module

**Files:**
- Create: `components/settings-icons.tsx`

**Interfaces:**
- Produces: `IconModelProviders`, `IconAppearance`, `IconLanguage`, `IconShortcuts`, `IconPrivacy`, `IconAbout` — each `(props: { className?: string }) => ReactNode`. Task 2 and Task 3 import these by name.

This module is pure presentational SVG markup with no branching logic, so there is nothing meaningful to unit-test in isolation (consistent with `entrypoints/sidepanel/icons.tsx`, which also has no dedicated test file). Its correctness is verified structurally by `pnpm compile` (step 2) and behaviorally by the Task 2 `SettingsShell` tests, which assert every nav button renders an `aria-hidden` `<svg>`.

- [ ] **Step 1: Write the icon module**

```tsx
import type { ReactNode } from 'react';

type IconProps = { className?: string };

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? 'h-4 w-4'}
    >
      {children}
    </svg>
  );
}

export function IconModelProviders({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 9h6v6H9z" />
    </Svg>
  );
}

export function IconAppearance({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6L19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4L19 5" />
    </Svg>
  );
}

export function IconLanguage({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </Svg>
  );
}

export function IconShortcuts({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <path d="M7 11h.01M11 11h.01M15 11h.01M7 14h6" />
    </Svg>
  );
}

export function IconPrivacy({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    </Svg>
  );
}

export function IconAbout({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </Svg>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm compile`
Expected: no errors (this file has no consumers yet, so it only needs to type-check on its own).

- [ ] **Step 3: Commit**

```bash
git add components/settings-icons.tsx
git commit -m "feat: add settings nav icon set"
```

---

### Task 2: `components/SettingsShell.tsx` — icons, footer slot, divider, invisible groups

**Files:**
- Modify: `components/SettingsShell.tsx`
- Test: `components/settings-components.test.tsx` (new `describe('SettingsShell', ...)` block)

**Interfaces:**
- Consumes: nothing new from other tasks (icons passed in as props by the caller — Task 3 — so this task's tests use local dummy icons).
- Produces (for Task 3 to consume):
  - `SettingsSectionDescriptor` gains `icon: (props: { className?: string }) => ReactNode` (required field).
  - `SettingsShellProps` gains `footerSections?: SettingsSectionDescriptor[]` (optional, defaults to `[]`).
  - Rendering: each group is `<div role="group" aria-label={group.label}>` with **no visible text** for `group.label`; a `<hr aria-hidden="true">` divider renders between adjacent groups and (if `footerSections` is non-empty) between the last group and the footer; footer buttons get a muted (not-active) color treatment via the same `<button>` structure as regular items; keyboard arrow nav (`moveSelection`) now walks `[...groups.flatMap(g => g.sections), ...footerSections]` so `About` is reachable.

- [ ] **Step 1: Write the failing tests**

Add this import near the top of `components/settings-components.test.tsx` (alongside the existing `ProviderSettings`/`ShortcutSettings` imports):

```tsx
import SettingsShell, {
  type SettingsSectionDescriptor,
  type SettingsSectionGroup,
} from './SettingsShell';
```

Add this new `describe` block at the end of the file, before the final closing of the outer `describe('grouped options settings', ...)` — i.e. as a **sibling** top-level `describe`, after it:

```tsx
describe('SettingsShell', () => {
  function DummyIcon({ className }: { className?: string }) {
    return <svg data-testid="dummy-icon" className={className} />;
  }

  const groupA: SettingsSectionGroup = {
    label: 'Group A',
    sections: [
      { id: 'providers', label: 'Providers', icon: DummyIcon },
      { id: 'appearance', label: 'Appearance', icon: DummyIcon },
    ],
  };
  const groupB: SettingsSectionGroup = {
    label: 'Group B',
    sections: [{ id: 'privacy', label: 'Privacy', icon: DummyIcon }],
  };
  const footer: SettingsSectionDescriptor[] = [{ id: 'about', label: 'About', icon: DummyIcon }];

  it('exposes group boundaries to assistive tech without visible group titles', () => {
    render(
      <SettingsShell
        groups={[groupA, groupB]}
        activeSection="providers"
        onSelect={() => {}}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );

    expect(screen.getByRole('group', { name: 'Group A' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Group B' })).toBeVisible();
    expect(screen.queryByText('Group A')).not.toBeInTheDocument();
    expect(screen.queryByText('Group B')).not.toBeInTheDocument();
  });

  it('renders every nav button with an icon', () => {
    render(
      <SettingsShell
        groups={[groupA]}
        footerSections={footer}
        activeSection="providers"
        onSelect={() => {}}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );

    expect(screen.getAllByTestId('dummy-icon')).toHaveLength(3);
  });

  it('renders a divider between groups and before the footer, none for a single group with no footer', () => {
    const { container, rerender } = render(
      <SettingsShell groups={[groupA]} activeSection="providers" onSelect={() => {}} navigationLabel="Settings">
        content
      </SettingsShell>,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(0);

    rerender(
      <SettingsShell
        groups={[groupA, groupB]}
        footerSections={footer}
        activeSection="providers"
        onSelect={() => {}}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(2);
  });

  it('reaches the footer section via arrow-key navigation', () => {
    const handleSelect = vi.fn();
    render(
      <SettingsShell
        groups={[groupA, groupB]}
        footerSections={footer}
        activeSection="privacy"
        onSelect={handleSelect}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Privacy' }), { key: 'ArrowDown' });
    expect(handleSelect).toHaveBeenCalledWith('about');
  });

  it('omits the footer entirely when footerSections is not provided', () => {
    render(
      <SettingsShell groups={[groupA]} activeSection="providers" onSelect={() => {}} navigationLabel="Settings">
        content
      </SettingsShell>,
    );
    expect(screen.queryByRole('button', { name: 'About' })).not.toBeInTheDocument();
  });
});
```

`render`, `screen`, `fireEvent`, and `vi` are already imported at the top of the file (used by the existing tests), so no further import changes are needed for these assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: FAIL — `SettingsSectionGroup`/`SettingsSectionDescriptor` type errors (`icon` field doesn't exist yet) and/or missing `footerSections` prop, plus assertion failures (`role="group"` not present, no `<hr>`, `About` not reachable).

- [ ] **Step 3: Rewrite `components/SettingsShell.tsx`**

```tsx
import { Fragment, useRef, type KeyboardEvent, type ReactNode } from 'react';

export type SettingsSection =
  | 'appearance'
  | 'language'
  | 'providers'
  | 'shortcuts'
  | 'privacy'
  | 'about';

export interface SettingsSectionDescriptor {
  id: SettingsSection;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
}

export interface SettingsSectionGroup {
  label: string;
  sections: SettingsSectionDescriptor[];
}

export interface SettingsShellProps {
  groups: SettingsSectionGroup[];
  footerSections?: SettingsSectionDescriptor[];
  activeSection: SettingsSection;
  onSelect(section: SettingsSection): void;
  navigationLabel: string;
  children: ReactNode;
}

const BUTTON_BASE =
  'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 md:mb-1 md:w-full';
const BUTTON_ACTIVE = 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white';
const BUTTON_DEFAULT =
  'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white';
const BUTTON_MUTED =
  'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-900 dark:hover:text-neutral-300';

function GroupDivider() {
  return (
    <hr
      aria-hidden="true"
      className="mx-1 w-px self-stretch border-0 bg-neutral-300 dark:bg-neutral-700 md:mx-0 md:my-3 md:h-px md:w-full md:self-auto"
    />
  );
}

export default function SettingsShell({
  groups,
  footerSections = [],
  activeSection,
  onSelect,
  navigationLabel,
  children,
}: SettingsShellProps) {
  const buttonRefs = useRef<Record<SettingsSection, HTMLButtonElement | null>>({
    appearance: null,
    language: null,
    providers: null,
    shortcuts: null,
    privacy: null,
    about: null,
  });
  const sections = [...groups.flatMap((group) => group.sections), ...footerSections];

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, current: SettingsSection) {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
    if (direction === 0 || sections.length === 0) return;

    event.preventDefault();
    const currentIndex = sections.findIndex((section) => section.id === current);
    const nextIndex = (currentIndex + direction + sections.length) % sections.length;
    const next = sections[nextIndex];
    onSelect(next.id);
    buttonRefs.current[next.id]?.focus();
  }

  function renderButton(section: SettingsSectionDescriptor, muted: boolean) {
    const active = activeSection === section.id;
    const Icon = section.icon;
    return (
      <button
        key={section.id}
        ref={(node) => { buttonRefs.current[section.id] = node; }}
        type="button"
        onClick={() => onSelect(section.id)}
        onKeyDown={(event) => moveSelection(event, section.id)}
        aria-current={active ? 'page' : undefined}
        className={[BUTTON_BASE, active ? BUTTON_ACTIVE : muted ? BUTTON_MUTED : BUTTON_DEFAULT].join(' ')}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span>{section.label}</span>
      </button>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-neutral-50 px-3 py-5 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <div className="gap-8 md:grid md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav
            aria-label={navigationLabel}
            className="-mx-3 mb-6 overflow-x-auto border-y border-neutral-200 px-3 py-2 dark:border-neutral-800 sm:mx-0 sm:px-0 md:sticky md:top-6 md:mb-0 md:self-start md:overflow-visible md:border-y-0 md:py-0"
          >
            <div className="flex min-w-max items-center gap-1 md:block md:min-w-0">
              {groups.map((group, index) => (
                <Fragment key={group.label}>
                  {index > 0 && <GroupDivider />}
                  <div role="group" aria-label={group.label} className="flex items-center gap-1 md:block">
                    {group.sections.map((section) => renderButton(section, false))}
                  </div>
                </Fragment>
              ))}
              {footerSections.length > 0 && (
                <Fragment>
                  <GroupDivider />
                  <div className="flex items-center gap-1 md:block">
                    {footerSections.map((section) => renderButton(section, true))}
                  </div>
                </Fragment>
              )}
            </div>
          </nav>
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: the 5 new `SettingsShell` tests PASS. The pre-existing tests in the file will still fail at this point — that's expected, they're fixed in Task 3 (this task only changes `SettingsShell`'s prop contract, and `entrypoints/options/App.tsx` hasn't been updated to match yet).

- [ ] **Step 5: Commit**

```bash
git add components/SettingsShell.tsx components/settings-components.test.tsx
git commit -m "feat: replace settings nav group titles with icons and a divider"
```

---

### Task 3: `entrypoints/options/App.tsx` — regroup, default section, drop duplicate titles

**Files:**
- Modify: `entrypoints/options/App.tsx`
- Modify: `lib/i18n/locales/zh.ts`
- Modify: `lib/i18n/locales/en.ts`
- Test: `components/settings-components.test.tsx` (existing `describe('grouped options settings', ...)` block)

**Interfaces:**
- Consumes: `IconModelProviders`, `IconAppearance`, `IconLanguage`, `IconShortcuts`, `IconPrivacy`, `IconAbout` from `components/settings-icons.tsx` (Task 1); `SettingsShellProps.footerSections`, `SettingsSectionDescriptor.icon` from `components/SettingsShell.tsx` (Task 2).
- Produces: nothing further downstream — this is the leaf consumer.

- [ ] **Step 1: Add the footer version translation key**

In `lib/i18n/locales/zh.ts`, add this line directly after the existing `'settings.navAbout': '关于',` line:

```ts
  'settings.navAboutVersion': '关于 · v{version}',
```

In `lib/i18n/locales/en.ts`, add this line directly after the existing `'settings.navAbout': 'About',` line:

```ts
  'settings.navAboutVersion': 'About · v{version}',
```

(`en.ts` is typed as `Record<keyof typeof zh, string>` — both files must gain the key together or `pnpm compile` fails.)

- [ ] **Step 2: Write the failing tests**

Replace the existing test:

```tsx
  it('navigates between grouped settings sections', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    await user.click(screen.getByRole('button', { name: 'Model providers' }));

    expect(screen.getByRole('heading', { name: 'Model providers' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Model providers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
```

with these three tests (same spot in the file):

```tsx
  it('defaults to the Model providers section and highlights it in the nav', async () => {
    renderWithLocale(<OptionsApp />);

    expect(screen.getByRole('button', { name: 'Model providers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('list', { name: 'Configured providers' })).toBeVisible();
  });

  it('navigates between grouped settings sections without re-rendering the nav label as a heading', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    await user.click(screen.getByRole('button', { name: 'Privacy & permissions' }));

    expect(screen.getByRole('button', { name: 'Privacy & permissions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Page data is sent to your AI provider')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Configured providers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Privacy & permissions' })).not.toBeInTheDocument();
  });

  it('shows the About footer item with the current version and opens the About panel', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    const aboutButton = screen.getByRole('button', { name: 'About · v1.1.0' });
    expect(aboutButton).toBeVisible();

    await user.click(aboutButton);

    expect(aboutButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Version 1.1.0')).toBeVisible();
  });
```

(The mock in this file's `beforeEach` already sets `browser.runtime.getManifest` to return `{ version: '1.1.0' }` and `t('settings.version', { version })` renders as `"Version 1.1.0"` — see `lib/i18n/locales/en.ts`'s `'settings.version': 'Version {version}'` — so the third test's assertion matches the existing `AboutSection` panel content unchanged.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: FAIL — `Model providers` nav button doesn't yet default to active (default section is still `appearance`), `About · v1.1.0` button doesn't exist yet (nav still has a plain `About` item inside a group, not a footer item with the version suffix), and the duplicate-heading assertions fail because `App.tsx` still renders `<h2>Privacy & permissions</h2>` etc.

- [ ] **Step 4: Rewrite `entrypoints/options/App.tsx`**

```tsx
import { useState, type ReactNode } from 'react';
import AppearanceSettings from '@/components/AppearanceSettings';
import LanguageSettings from '@/components/LanguageSettings';
import ProviderSettings from '@/components/ProviderSettings';
import {
  IconAbout,
  IconAppearance,
  IconLanguage,
  IconModelProviders,
  IconPrivacy,
  IconShortcuts,
} from '@/components/settings-icons';
import SettingsShell, {
  type SettingsSection,
  type SettingsSectionDescriptor,
  type SettingsSectionGroup,
} from '@/components/SettingsShell';
import ShortcutSettings from '@/components/ShortcutSettings';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

export default function App() {
  const { mode, setMode } = useTheme();
  const { t, locale, setLocale } = useTranslation();
  const [section, setSection] = useState<SettingsSection>('providers');
  const version = browser.runtime.getManifest().version;

  const groups: SettingsSectionGroup[] = [
    {
      label: t('settings.groupAiTools'),
      sections: [
        { id: 'providers', label: t('settings.navProviders'), icon: IconModelProviders },
      ],
    },
    {
      label: t('settings.groupPreferences'),
      sections: [
        { id: 'appearance', label: t('settings.navAppearance'), icon: IconAppearance },
        { id: 'language', label: t('settings.navLanguage'), icon: IconLanguage },
        { id: 'shortcuts', label: t('settings.navShortcuts'), icon: IconShortcuts },
      ],
    },
    {
      label: t('settings.groupSafety'),
      sections: [
        { id: 'privacy', label: t('settings.navPrivacy'), icon: IconPrivacy },
      ],
    },
  ];
  const footerSections: SettingsSectionDescriptor[] = [
    { id: 'about', label: t('settings.navAboutVersion', { version }), icon: IconAbout },
  ];

  return (
    <SettingsShell
      groups={groups}
      footerSections={footerSections}
      activeSection={section}
      onSelect={setSection}
      navigationLabel={t('common.settings')}
    >
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.pageTitle')}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.description')}</p>
      </header>
      {section === 'appearance' && <SettingsPanel><AppearanceSettings mode={mode} onSet={setMode} /></SettingsPanel>}
      {section === 'language' && <SettingsPanel><LanguageSettings mode={locale} onSet={setLocale} /></SettingsPanel>}
      {section === 'providers' && <SettingsPanel><ProviderSettings /></SettingsPanel>}
      {section === 'shortcuts' && <SettingsPanel><ShortcutSettings /></SettingsPanel>}
      {section === 'privacy' && <PrivacySection />}
      {section === 'about' && <AboutSection />}
    </SettingsShell>
  );
}

function SettingsPanel({ children }: { children: ReactNode }) {
  return <section className="max-w-3xl">{children}</section>;
}

function PrivacySection() {
  const { t } = useTranslation();
  const disclosures = [
    ['privacy.pageDataTitle', 'privacy.pageDataBody'],
    ['privacy.localDataTitle', 'privacy.localDataBody'],
    ['privacy.noBackendTitle', 'privacy.noBackendBody'],
  ] as const;
  return (
    <section className="max-w-2xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('settings.privacyDescription')}</p>
      <div className="mt-5 space-y-3">
        {disclosures.map(([title, body]) => (
          <article key={title} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <h3 className="text-sm font-medium">{t(title)}</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{t(body)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const version = browser.runtime.getManifest().version;
  return (
    <section className="max-w-2xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('settings.aboutDescription')}</p>
      <p className="mt-5 rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        {t('settings.version', { version })}
      </p>
    </section>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run components/settings-components.test.tsx`
Expected: all tests in the file PASS, including the Task 2 `SettingsShell` tests and the three rewritten tests from Step 2.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/options/App.tsx lib/i18n/locales/zh.ts lib/i18n/locales/en.ts components/settings-components.test.tsx
git commit -m "feat: reorder settings nav, default to providers, drop duplicate panel titles"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Type-check the whole project**

Run: `pnpm compile`
Expected: no errors.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (both the `unit` and `ui` Vitest projects).

- [ ] **Step 3: Manual smoke check**

Run: `pnpm dev`, load `.output/chrome-mv3` as an unpacked extension, open the options page, and confirm against the spec's acceptance criteria:
- No visible one-line group titles; nav order is `Model providers` → divider → `Appearance`/`Language`/`Shortcuts` → divider → `Privacy & permissions` → divider → `About · v{version}` (muted).
- Every nav item has a left-aligned icon.
- Page opens on `Model providers`, matching the nav highlight.
- No settings panel repeats the nav's active-item label as a heading.
- Keyboard arrow keys cycle through all items including `About`.
- Narrow the window below the `md` breakpoint and confirm the horizontal-scroll nav shows vertical divider bars between clusters instead of nothing.

This step has no automated pass/fail signal — report what you observed instead of asserting success.

---

## Self-Review Notes

- **Spec coverage:** every acceptance-criteria bullet in `docs/specs/0004-settings-nav-ia-and-hierarchy.md` maps to a task — invisible-but-accessible groups (Task 2), dividers desktop+mobile via one responsive `<hr>` (Task 2), reorder + icons (Task 3), default section `providers` (Task 3), no duplicate titles (Task 3), keyboard reach to `About` (Task 2), `About` panel still shows full version (Task 3, `AboutSection` body unchanged), test file updated + `pnpm compile`/`pnpm test` green (Task 3 + Task 4).
- **Placeholder scan:** no TBD/TODO — every step has literal code, exact test assertions, and exact commands.
- **Type consistency:** `SettingsSectionDescriptor.icon` (Task 2) is the same shape used by `IconModelProviders` etc. (Task 1) and by every entry built in Task 3's `groups`/`footerSections`. `footerSections` is optional with `= []` default in `SettingsShell` and always passed (non-empty) from `App.tsx`.
