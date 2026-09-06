// 工具调用预算档位设置（ref: lib/agent/budget-profile.ts）。
// 与 AppearanceSettings.tsx 的纯展示组件不同，这里自己读写 storage：预算档位没有任何
// 其它入口需要共享这份状态，抬到 options App 里只会多一层无人使用的 props。
import { useEffect, useState } from 'react';
import {
  DEFAULT_TOOL_BUDGET_PROFILE_ID,
  TOOL_BUDGET_PROFILES,
  TOOL_BUDGET_PROFILE_IDS,
  loadToolBudgetProfileId,
  saveToolBudgetProfileId,
  type ToolBudgetProfileId,
} from '@/lib/agent/budget-profile';
import { useTranslation } from '@/lib/i18n';

const PROFILE_LABEL_KEYS = {
  standard: 'budget.standard',
  generous: 'budget.generous',
} as const satisfies Record<ToolBudgetProfileId, string>;

export default function AgentBudgetSettings() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ToolBudgetProfileId>(DEFAULT_TOOL_BUDGET_PROFILE_ID);

  useEffect(() => {
    let cancelled = false;
    // 读失败就停在标准档：这是个纯偏好，不值得为它显示错误态或拦住整个设置页。
    loadToolBudgetProfileId()
      .then((id) => { if (!cancelled) setSelected(id); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function choose(id: ToolBudgetProfileId) {
    // 先落到 UI 再落盘：写失败时下次打开会读回旧值，比让单选框点了没反应更好解释。
    setSelected(id);
    void saveToolBudgetProfileId(id).catch(() => undefined);
  }

  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {t('budget.heading')}
      </h3>
      <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">{t('budget.description')}</p>
      <div role="radiogroup" aria-label={t('budget.heading')} className="space-y-2">
        {TOOL_BUDGET_PROFILE_IDS.map((id) => {
          const profile = TOOL_BUDGET_PROFILES[id];
          const active = selected === id;
          return (
            <label
              key={id}
              className={[
                'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                active
                  ? 'border-indigo-500 bg-indigo-50/60 dark:border-indigo-400 dark:bg-indigo-950/40'
                  : 'border-neutral-200 bg-white hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700',
              ].join(' ')}
            >
              <input
                type="radio"
                name="tool-budget-profile"
                className="mt-1 accent-indigo-600"
                checked={active}
                onChange={() => choose(id)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t(PROFILE_LABEL_KEYS[id])}</span>
                <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">
                  {t('budget.detail', {
                    read: profile.readToolCallBudget,
                    write: profile.writeToolCallBudget,
                  })}
                </span>
                {id === 'generous' && (
                  <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
                    {t('budget.generousHint')}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
