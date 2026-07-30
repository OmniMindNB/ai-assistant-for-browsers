// 语言设置：跟随浏览器 / 中文 / English。结构与 AppearanceSettings.tsx 对称。
import { useTranslation, type LocaleMode } from '@/lib/i18n';

export default function LanguageSettings({
  mode,
  onSet,
}: {
  mode: LocaleMode;
  onSet: (mode: LocaleMode) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: LocaleMode; label: string }> = [
    { value: 'auto', label: t('common.followSystem') },
    { value: 'zh', label: t('language.zh') },
    { value: 'en', label: t('language.en') },
  ];
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {t('language.heading')}
      </h3>
      <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
        {options.map((opt) => {
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
