import type { Translate } from '@/lib/i18n';
import type { ResolvedShortcut } from '@/lib/shortcuts';
import { renderTrajectoryForPrompt } from '@/lib/agent/task-trajectory';
import { renderPlaybookForPrompt } from './task-playbook';
import { renderPageOutline, type PagePrefetchPlan } from './page-prefetch';

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
  pagePrefetch?: PagePrefetchPlan,
  supplement?: string,
): ShortcutExecution {
  // 录制型指令：不做正文预取——回放要的是表单和按钮，不是正文，起始页也可能根本不是当前页
  // （ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §6.3）。
  if (shortcut.origin === 'recorded') {
    const note = supplement?.trim() ?? '';
    const display = translate(note ? 'store.recordedTaskDisplayWithNote' : 'store.recordedTaskDisplay', {
      name: shortcut.name,
      note,
    });
    // 有通用做法时只发做法：录制步骤是站点特有的，换到同类的别的网站只会把模型带偏
    // （ref: docs/superpowers/specs/2026-09-23-generalized-task-playbook-design.md §6）。
    const agentUserContent = shortcut.playbook
      ? translate(note ? 'store.recordedPlaybookPromptWithNote' : 'store.recordedPlaybookPrompt', {
          goal: shortcut.prompt,
          applicability: shortcut.playbook.applicability,
          steps: renderPlaybookForPrompt(shortcut.playbook),
          note,
        })
      : translate(note ? 'store.recordedTaskPromptWithNote' : 'store.recordedTaskPrompt', {
          goal: shortcut.prompt,
          steps: renderTrajectoryForPrompt(shortcut.trajectory ?? [], translate),
          note,
        });
    return { display, agentUserContent, browserTools: 'all', systemPromptSuffix: '' };
  }

  if (shortcut.scope === 'page') {
    // 有预取内容时把正文直接塞进首轮 user turn，模型不必再发起 browser_read_page 就能回答，
    // 省掉「总结本页」这类最高频场景里结构性多出来的一整轮 LLM 往返
    // （ref: [[project-sidepanel-perf-profile]]：提速唯一杠杆是减少轮数）。
    // 取多少、怎么取由 planPagePrefetch 决定，这里只负责把它渲染成文案。
    if (pagePrefetch?.kind === 'full') {
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
    if (pagePrefetch?.kind === 'windowed') {
      // 空大纲不是边缘情况：任何超过上限但没有 h1-h3（长论坛帖、<pre> 日志、法条、连载小说）
      // 都会命中。空大纲版本绝口不提「大纲」，改成让模型用任务本身的关键词去 browser_find_text，
      // 否则模型会拿着假前提（「下面的大纲覆盖全文」）和一条它执行不了的指令（「搜大纲里的小节标题」）。
      const hasOutline = pagePrefetch.outline.length > 0;
      return {
        display: shortcut.name,
        agentUserContent: translate(
          hasOutline ? 'store.shortcutPageWindowedPrompt' : 'store.shortcutPageWindowedNoOutlinePrompt',
          {
            instruction: shortcut.prompt,
            title: pagePrefetch.title,
            url: pagePrefetch.url,
            head: JSON.stringify(pagePrefetch.head),
            tail: JSON.stringify(pagePrefetch.tail),
            headEnd: pagePrefetch.headEnd,
            tailStart: pagePrefetch.tailStart,
            total: pagePrefetch.total,
            omitted: pagePrefetch.omitted,
            outline: hasOutline ? renderPageOutline(pagePrefetch.outline) : '',
          },
        ),
        browserTools: 'all',
        systemPromptSuffix: '',
      };
    }
    // 预取被跳过（正文太短）或根本没跑成：退回原路径，模型仍可自己调 browser_read_page 兜底。
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
