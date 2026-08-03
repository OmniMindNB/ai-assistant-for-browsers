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
      className="mx-1 h-5 w-px shrink-0 self-center border-0 bg-neutral-300 dark:bg-neutral-700 md:mx-0 md:my-3 md:h-px md:w-full md:self-auto"
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
