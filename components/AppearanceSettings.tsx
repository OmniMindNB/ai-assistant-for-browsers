// 外观（主题）设置：跟随浏览器 / 浅色 / 深色。
// 纯展示组件，主题状态由父组件通过 useTheme 提供（ref: lib/theme.ts）。
import type { ThemeMode } from '@/lib/theme';

const OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'auto', label: '跟随浏览器' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export default function AppearanceSettings({
  mode,
  onSet,
}: {
  mode: ThemeMode;
  onSet: (mode: ThemeMode) => void;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">外观</h2>
      <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
        {OPTIONS.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onSet(opt.value)}
              className={[
                'rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                active
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
              ].join(' ')}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
