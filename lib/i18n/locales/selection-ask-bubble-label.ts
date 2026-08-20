// 划词提问气泡按钮文案。单独拆出这个极小的模块，是因为 entrypoints/content.ts（跑在每个
// 页面里的内容脚本）只需要这一个字符串，不能为此把完整的 en/zh 翻译字典（各自数十 KB）
// 打进内容脚本产物。lib/i18n/locales/{en,zh}.ts 里的 shortcut.selectionAskBubbleLabel
// 复用同一份值，保证只有一个真源。
export const SELECTION_ASK_BUBBLE_LABEL: Record<'zh' | 'en', string> = {
  zh: '问 Runi',
  en: 'Ask Runi',
};
