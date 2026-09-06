import { useTranslation } from '@/lib/i18n';

/**
 * 空状态里展示的写操作示例。
 *
 * 为什么要有这一组：三个内置快捷指令（总结页面 / 解释选中 / 翻译选中）全是读操作，
 * 空状态只摆它们的话，第一印象会把产品定位成"页面问答"——代填表单、改页面、跨标签页
 * 操作这些真正的差异化能力，用户根本无从发现。
 *
 * 点击是**填进输入框**而不是直接发送：这些都是写操作，一次误点就动了用户的页面是不可接受的；
 * 填进去还能让用户按自己的页面改措辞。
 */
const WRITE_EXAMPLE_KEYS = [
  'workbench.exampleFillForm',
  'workbench.exampleReadable',
  'workbench.exampleExtract',
] as const;

export interface WorkbenchEmptyStateProps {
  busy: boolean;
  /** 把示例填进输入框（不发送）。不传则不展示示例区。 */
  onPickExample?(text: string): void;
}

/**
 * 空状态只负责"教会用户我能动手"，不再自己摆一排快捷指令胶囊——那排和输入区里的是同一份
 * `slice(0, 4)` 数据的两次渲染，首屏会把同样四个指令说两遍。一键执行的入口只留常驻的输入区。
 */
export function WorkbenchEmptyState({ busy, onPickExample }: WorkbenchEmptyStateProps) {
  const { t } = useTranslation();

  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      {/* 跟消息列表里助手头像（App.tsx 的 "R" 方块）用同一个符号，避免用户在
          "还没开始对话" 和 "已经在对话" 两个相邻状态里看到两套不同的品牌图形。 */}
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-xl font-bold text-white dark:bg-neutral-800">
        R
      </div>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('workbench.emptyTitle')}
      </h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {t('workbench.emptyDescription')}
      </p>
      {onPickExample && (
        <div className="mt-4 flex w-full flex-col gap-1.5">
          {WRITE_EXAMPLE_KEYS.map((key) => {
            const text = t(key);
            return (
              <button
                key={key}
                type="button"
                disabled={busy}
                onClick={() => onPickExample(text)}
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-xs text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
              >
                {text}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
