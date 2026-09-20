/**
 * 页面标题骨架：正文过长、只能截出头尾两段时，用它告诉模型中间省略的部分里还有哪些小节
 * （ref: docs/superpowers/specs/2026-09-20-page-prefetch-strategy-design.md §3.1）。
 *
 * 刻意不记录每个标题在正文里的字符偏移：正文在 background 侧还要过一遍 redactText，
 * 脱敏是整串替换、长度会变，偏移必然漂掉。一个默默偏掉的偏移比没有偏移更坏——
 * 它会让模型言之凿凿地引用一个不存在的位置。模型要的是「中段还有哪些小节」，
 * 拿标题原文配 browser_find_text 就够精准。
 *
 * Readability 常把文章的 <h1> 提到 article.title 里，并从 article.content 中摘掉，
 * 所以这里采集出的大纲经常缺 level 1——这是预期行为，不是漏采。
 */

export interface PageOutlineItem {
  level: 1 | 2 | 3;
  title: string;
}

/** 条数上限设在这里，免得长目录页把骨架撑到比正文还占地方。
 * 单条长度的上限（MAX_OUTLINE_TITLE_CHARS）不在这里应用：这里拿到的是脱敏之前的原文，
 * 先截断会把跨界的敏感号码切成两半，脱敏规则的锚定匹配就再也认不出来
 * （ref: 2026-08-31-page-redaction-pipeline-design.md）。截断放到 entrypoints/background.ts
 * 的 extractActivePage 里、redactText 之后执行；MAX_OUTLINE_TITLE_CHARS 仍从本模块导出，
 * 保持上限的单一来源。 */
export const MAX_OUTLINE_ITEMS = 60;
export const MAX_OUTLINE_TITLE_CHARS = 80;

export function collectOutline(root: Document | null | undefined): PageOutlineItem[] {
  if (!root) return [];
  const items: PageOutlineItem[] = [];
  for (const element of Array.from(root.querySelectorAll('h1, h2, h3'))) {
    const title = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    items.push({
      level: Number(element.tagName.slice(1)) as 1 | 2 | 3,
      title,
    });
    if (items.length >= MAX_OUTLINE_ITEMS) break;
  }
  return items;
}
