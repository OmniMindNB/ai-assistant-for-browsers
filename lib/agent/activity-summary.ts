import type { ActivityStep } from './activity-steps';
import type { ToolCategory } from './activity-category';

/**
 * 摘要行最多列几个类别。三个是一行能容下的上限——再多就要换行，
 * 而这一行收起时就是折叠头本身，换行会让折叠态比展开态还占地方。
 */
export const SUMMARY_MAX_CATEGORIES = 3;

export interface ActivitySummary {
  /** 出现过的类别，按首次出现顺序去重，至多 SUMMARY_MAX_CATEGORIES 个。 */
  categories: ToolCategory[];
  /** 真正的工具调用步数；旁白（narration）和流程提示（notice）不算。 */
  toolStepCount: number;
  /** 这一轮里有没有失败的步骤——折叠规则据此决定结束后是否仍默认展开。 */
  hasFailure: boolean;
}

/**
 * 把一串步骤压成折叠头要显示的那点信息。
 *
 * 只算结构、不拼文案：类别名和"共 N 步"的措辞都要过 i18n，留给组件用 useTranslation 渲染，
 * 这样这里可以是纯函数，测试也不必拖上一份词典。
 */
export function summarizeActivity(steps: ActivityStep[]): ActivitySummary {
  const categories: ToolCategory[] = [];
  let toolStepCount = 0;
  let hasFailure = false;

  for (const step of steps) {
    if (step.status === 'failed') hasFailure = true;
    // 没有 category 的行不是工具调用（旁白、流程提示、接管痕迹），既不计数也不进类别列表。
    if (step.category === undefined) continue;
    toolStepCount += 1;
    if (!categories.includes(step.category) && categories.length < SUMMARY_MAX_CATEGORIES) {
      categories.push(step.category);
    }
  }

  return { categories, toolStepCount, hasFailure };
}
