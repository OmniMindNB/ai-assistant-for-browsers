import type { Translate } from '@/lib/i18n';
import type { ResolvedShortcut } from '@/lib/shortcuts';

export const MAX_SHORTCUT_SELECTION_CHARS = 4000;

export interface ShortcutExecution {
  display: string;
  agentUserContent: string;
  browserTools: 'all' | 'none';
  systemPromptSuffix: string;
}

/** 页面文本预取结果；字段与 browser_read_page 工具的返回值同源，长度上限也保持一致（12000 字符）。 */
export interface PagePrefetch {
  title: string;
  url: string;
  text: string;
}

export function buildShortcutExecution(
  shortcut: ResolvedShortcut,
  translate: Translate,
  selection?: string,
  pagePrefetch?: PagePrefetch,
): ShortcutExecution {
  if (shortcut.scope === 'page') {
    // 有预取内容时把正文直接塞进首轮 user turn，模型不必再发起 browser_read_page 就能
    // 回答，省掉"总结本页"这类最高频场景里结构性多出来的一整轮 LLM 往返
    // （ref: [[project-sidepanel-perf-profile]]：提速唯一杠杆是减少轮数，减小 prompt 只省钱不提速，
    // 所以这里不为了控 token 而裁短文本，仍沿用工具原本的 12000 字符上限）。
    // 预取失败（页面不可读、超时等）时退回原路径，模型仍可自己调用 browser_read_page 兜底。
    if (pagePrefetch) {
      return {
        display: shortcut.name,
        agentUserContent: translate('store.shortcutPagePrompt', {
          instruction: shortcut.prompt,
          title: pagePrefetch.title,
          url: pagePrefetch.url,
          page: JSON.stringify(pagePrefetch.text),
        }),
        browserTools: 'all',
        systemPromptSuffix: '',
      };
    }
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
