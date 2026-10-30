import { useTranslation } from '@/lib/i18n';
import { BrandMark } from './BrandMark';

/**
 * 空状态只有品牌标识、标题和一句说明，不摆任何可点目标：一键执行的入口只留常驻的输入区快捷指令。
 * 曾经这里先后有过一排快捷指令胶囊和三条写操作示例，都和输入区的快捷指令在首屏把同一件事说两遍。
 */
export function WorkbenchEmptyState() {
  const { t } = useTranslation();

  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center text-center">
      {/* 与扩展图标同一张图：用户在工具栏点开的是什么，打开后迎面看到的就是什么。 */}
      <BrandMark className="mb-4 h-14 w-14 drop-shadow-sm" />
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t('workbench.emptyTitle')}
      </h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {t('workbench.emptyDescription')}
      </p>
    </div>
  );
}
