import type { Translate } from '@/lib/i18n';
import type { ResolvedShortcut } from '@/lib/shortcuts';

export const MAX_SHORTCUT_SELECTION_CHARS = 4000;

export interface ShortcutExecution {
  display: string;
  agentUserContent: string;
  browserTools: 'all' | 'none';
  systemPromptSuffix: string;
}

export function buildShortcutExecution(
  shortcut: ResolvedShortcut,
  translate: Translate,
  selection?: string,
): ShortcutExecution {
  if (shortcut.scope === 'page') {
    return {
      display: shortcut.name,
      agentUserContent: shortcut.prompt,
      browserTools: 'all',
      systemPromptSuffix: '',
    };
  }

  const systemPromptSuffix = translate('store.shortcutNoBrowserSystemPrompt');
  if (shortcut.scope === 'none') {
    return {
      display: shortcut.name,
      agentUserContent: shortcut.prompt,
      browserTools: 'none',
      systemPromptSuffix,
    };
  }

  const text = selection?.trim() ?? '';
  if (!text) throw new Error(translate('store.noSelection'));
  const truncated = text.slice(0, MAX_SHORTCUT_SELECTION_CHARS);
  const preview = truncated.length > 80 ? `${truncated.slice(0, 80)}…` : truncated;
  return {
    display: translate('store.shortcutSelectionDisplay', {
      name: shortcut.name,
      preview,
    }),
    agentUserContent: translate('store.shortcutSelectionPrompt', {
      instruction: shortcut.prompt,
      selection: JSON.stringify(truncated),
    }),
    browserTools: 'none',
    systemPromptSuffix,
  };
}
