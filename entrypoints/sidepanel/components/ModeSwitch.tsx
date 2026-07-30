import type { WorkbenchMode } from '@/lib/workbench/preferences';

export interface ModeSwitchProps {
  mode: WorkbenchMode;
  onChange(mode: WorkbenchMode): void;
}

export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div role="group" aria-label="Workbench mode" className="inline-flex rounded-lg border border-neutral-200 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-900">
      {(['ask', 'agent'] as const).map((candidate) => {
        const active = mode === candidate;
        const label = candidate === 'ask' ? 'Ask' : 'Agent';
        return (
          <button
            key={candidate}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(candidate)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              active
                ? 'bg-indigo-600 text-white'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
