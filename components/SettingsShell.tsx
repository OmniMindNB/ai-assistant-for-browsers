import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'language'
  | 'providers'
  | 'shortcuts'
  | 'privacy'
  | 'about';

export interface SettingsSectionDescriptor {
  id: SettingsSection;
  label: string;
}

export interface SettingsSectionGroup {
  label: string;
  sections: SettingsSectionDescriptor[];
}

export interface SettingsShellProps {
  groups: SettingsSectionGroup[];
  activeSection: SettingsSection;
  onSelect(section: SettingsSection): void;
  navigationLabel: string;
  children: ReactNode;
}

export default function SettingsShell({
  groups,
  activeSection,
  onSelect,
  navigationLabel,
  children,
}: SettingsShellProps) {
  const buttonRefs = useRef<Record<SettingsSection, HTMLButtonElement | null>>({
    general: null,
    appearance: null,
    language: null,
    providers: null,
    shortcuts: null,
    privacy: null,
    about: null,
  });
  const sections = groups.flatMap((group) => group.sections);

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

  return (
    <div className="min-h-screen overflow-x-hidden bg-neutral-50 px-3 py-5 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <div className="gap-8 md:grid md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav
            aria-label={navigationLabel}
            className="-mx-3 mb-6 overflow-x-auto border-y border-neutral-200 px-3 py-2 dark:border-neutral-800 sm:mx-0 sm:px-0 md:sticky md:top-6 md:mb-0 md:self-start md:overflow-visible md:border-y-0 md:py-0"
          >
            <div className="flex min-w-max items-center gap-3 md:block md:min-w-0 md:space-y-5">
              {groups.map((group) => (
                <section key={group.label} className="flex items-center gap-1 md:block">
                  <p className="sr-only text-xs font-semibold uppercase tracking-wide text-neutral-500 md:not-sr-only md:mb-1 md:px-3 dark:text-neutral-400">
                    {group.label}
                  </p>
                  <div className="flex gap-1 md:block">
                    {group.sections.map((section) => {
                      const active = activeSection === section.id;
                      return (
                        <button
                          key={section.id}
                          ref={(node) => { buttonRefs.current[section.id] = node; }}
                          type="button"
                          onClick={() => onSelect(section.id)}
                          onKeyDown={(event) => moveSelection(event, section.id)}
                          aria-current={active ? 'page' : undefined}
                          className={[
                            'whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 md:mb-1 md:block md:w-full',
                            active
                              ? 'bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white'
                              : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white',
                          ].join(' ')}
                        >
                          {section.label}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </nav>
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
