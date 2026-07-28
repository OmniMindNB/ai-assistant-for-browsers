import type { Translate } from '@/lib/i18n';

export function buildSummarizePagePrompt(translate: Translate): string {
  return translate('store.summarizePrompt');
}

export function buildExplainSelectionPrompt(
  translate: Translate,
  selection: string,
  maxChars: number,
): string {
  return `${translate('store.explainPrompt')}\n\n\"\"\"${selection.slice(0, maxChars)}\"\"\"`;
}
