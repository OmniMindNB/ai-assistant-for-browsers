/**
 * 页面标题骨架：正文过长、只能截出头尾两段时，用它告诉模型中间省略的部分里还有哪些小节
 * （ref: docs/superpowers/specs/2026-09-20-page-prefetch-strategy-design.md §3.1）。
 *
 * 刻意不记录每个标题在正文里的字符偏移：正文在 background 侧还要过一遍 redactText，
 * 脱敏是整串替换、长度会变，偏移必然漂掉。一个默默偏掉的偏移比没有偏移更坏——
 * 它会让模型言之凿凿地引用一个不存在的位置。模型要的是「中段还有哪些小节」，
 * 拿标题原文配 browser_find_text 就够精准。
 */

export interface PageOutlineItem {
  level: 1 | 2 | 3;
  title: string;
}

/** 条数与单条长度都设上限，免得长目录页把骨架撑到比正文还占地方。 */
export const MAX_OUTLINE_ITEMS = 60;
export const MAX_OUTLINE_TITLE_CHARS = 80;

export function collectOutline(
  root: Document | HTMLElement | null | undefined,
): PageOutlineItem[] {
  if (!root) return [];
  const items: PageOutlineItem[] = [];
  for (const element of Array.from(root.querySelectorAll('h1, h2, h3'))) {
    const title = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    items.push({
      level: Number(element.tagName.slice(1)) as 1 | 2 | 3,
      title: title.slice(0, MAX_OUTLINE_TITLE_CHARS),
    });
    if (items.length >= MAX_OUTLINE_ITEMS) break;
  }
  return items;
}
