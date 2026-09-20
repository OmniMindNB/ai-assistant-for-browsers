/**
 * 预取层的取舍：page-scope 快捷方式在发给模型之前先把正文塞进首轮 user turn，
 * 省掉模型自己调 browser_read_page 那一整轮往返。本模块决定这一轮到底交出什么
 * （ref: docs/superpowers/specs/2026-09-20-page-prefetch-strategy-design.md）。
 *
 * 三个分支，此前的两个失效方向各占一个：
 * - skip：正文短到不足以支撑任何 page 任务时坦白失败，退回工具路径。此前空正文也被当成
 *   预取成功，模型拿着一个空串被告知「请直接使用」，于是回「页面内容太少」而不是重试。
 * - full：整页进上下文。
 * - windowed：头 + 尾 + 标题骨架。此前是无声的 slice(0, 24000)，长文只总结了开头，
 *   而模型看到的正文在它眼里是完整的。
 *
 * 不用 offset 分段续读：每续读一次多一整轮 LLM 往返，且 compactAgentMessages 会把上一段
 * 只读结果压成一行摘要移出上下文（ref: lib/agent/page-read-window.ts 的注释），边读边丢。
 * 面板这边本来就握着全文，不需要用往返去换内容。
 */

import { MAX_TOOL_RESULT_CHARS } from '@/lib/agent/context-budget';
import type { PageOutlineItem } from '@/lib/page-outline';

/** 比这更短的「正文」在实践中只会是骨架页或错误页（PDF 阅读器、canvas 应用、未渲染完的 SPA）。 */
export const MIN_PAGE_PREFETCH_CHARS = 200;

/** 上限与工具结果同源：两者最终进的是同一个上下文，各写各的迟早分叉，
 * 而分叉的表现是模型收到两条互相矛盾的截断提示。 */
export const MAX_PAGE_PREFETCH_CHARS = MAX_TOOL_RESULT_CHARS;

/** 头尾 2:1：开头承担「这是什么页面」，结尾承担「结论是什么」——纯头部截断恰好把结论全丢掉。 */
export const PAGE_PREFETCH_HEAD_CHARS = 32000;
export const PAGE_PREFETCH_TAIL_CHARS = MAX_PAGE_PREFETCH_CHARS - PAGE_PREFETCH_HEAD_CHARS;

export interface PagePrefetchInput {
  title: string;
  url: string;
  text: string;
  outline?: PageOutlineItem[];
}

export interface FullPagePrefetch {
  kind: 'full';
  title: string;
  url: string;
  text: string;
}

export interface WindowedPagePrefetch {
  kind: 'windowed';
  title: string;
  url: string;
  head: string;
  tail: string;
  /** 头段的结束偏移（不含），即 PAGE_PREFETCH_HEAD_CHARS。 */
  headEnd: number;
  /** 尾段的起始偏移。 */
  tailStart: number;
  total: number;
  omitted: number;
  outline: PageOutlineItem[];
}

export type PagePrefetchPlan = { kind: 'skip' } | FullPagePrefetch | WindowedPagePrefetch;

/**
 * 输入必须是**脱敏之后**的正文（background.ts 的 extractActivePage 已经跑过 redactText），
 * 这样长度判断和头尾切分用的就是模型最终会看到的那份文本，不会「按原文切、按脱敏后发」。
 */
export function planPagePrefetch(input: PagePrefetchInput): PagePrefetchPlan {
  const text = input.text ?? '';
  if (text.length < MIN_PAGE_PREFETCH_CHARS) return { kind: 'skip' };
  if (text.length <= MAX_PAGE_PREFETCH_CHARS) {
    return { kind: 'full', title: input.title, url: input.url, text };
  }
  const tailStart = text.length - PAGE_PREFETCH_TAIL_CHARS;
  return {
    kind: 'windowed',
    title: input.title,
    url: input.url,
    head: text.slice(0, PAGE_PREFETCH_HEAD_CHARS),
    tail: text.slice(tailStart),
    headEnd: PAGE_PREFETCH_HEAD_CHARS,
    tailStart,
    total: text.length,
    omitted: tailStart - PAGE_PREFETCH_HEAD_CHARS,
    outline: input.outline ?? [],
  };
}

/** 骨架也走 JSON 边界：标题同样是页面来源的不可信文本。 */
export function renderPageOutline(items: readonly PageOutlineItem[]): string {
  return JSON.stringify(items.map((item) => `${'#'.repeat(item.level)} ${item.title}`));
}
