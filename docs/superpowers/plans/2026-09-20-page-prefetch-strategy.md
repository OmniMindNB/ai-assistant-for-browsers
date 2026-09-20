# 页面预取策略实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 page-scope 快捷方式的首轮预取在长正文时交出「头 + 尾 + 标题骨架」而不是静默截断的前 24000 字符，在正文过短时坦白失败并退回工具路径。

**Architecture:** 新增一个纯函数 `planPagePrefetch`（`lib/chat/page-prefetch.ts`）把「预取该交出什么」收敛成 skip / full / windowed 三个分支；`entrypoints/sidepanel/store.ts` 退化为 I/O，`lib/chat/shortcut-prompts.ts` 按分支选文案。标题骨架由新增的 `collectOutline`（`lib/page-outline.ts`）在内容脚本里采集，经 `PageContent.outline` 传出，并在 background 与正文一起脱敏。

**Tech Stack:** TypeScript、WXT（MV3）、Vitest（unit / ui / dom 三个 project）、@mozilla/readability。

**Spec:** `docs/superpowers/specs/2026-09-20-page-prefetch-strategy-design.md`

## Global Constraints

- 代码注释与提交信息用中文。
- 直接在 `main` 上提交，不开分支（ref: CLAUDE.md §Git）。
- 每个任务结束时 `pnpm vitest run <改动的测试文件>` 必须通过；最后一个任务额外跑 `pnpm compile` 与 `pnpm test`。
- 测试文件与被测代码同目录。**没有任何 vitest project 匹配 `entrypoints/**/*.test.ts`**：入口文件（`content.ts` / `background.ts` / `store.ts`）的不变量只能靠 `lib/final-review.test.ts` 的源码字符串断言来守，或者把逻辑挪进 `lib/` 里测。
- jsdom 用例必须命名为 `*.dom.test.ts` 才会被 dom project 收走；`lib/**/*.test.ts` 跑在 node 环境，没有 DOM。
- 常量单一来源：预取上限取 `MAX_TOOL_RESULT_CHARS`（`lib/agent/context-budget.ts`，值 48000），不要另写字面量。
- 进入 prompt 的页面文本一律用 `JSON.stringify` 包边界；防注入规则只属于系统提示词，不许写进 user turn（现有测试 `keeps the anti-injection rule out of the user turn in both locales` 会守这条）。

---

### Task 1: 标题骨架采集器 `collectOutline`

**Files:**
- Create: `lib/page-outline.ts`
- Test: `lib/page-outline.dom.test.ts`

**Interfaces:**
- Consumes: 无（本任务是叶子）
- Produces: `PageOutlineItem { level: 1 | 2 | 3; title: string }`、`collectOutline(root: Document | HTMLElement | null | undefined): PageOutlineItem[]`、`MAX_OUTLINE_ITEMS = 60`、`MAX_OUTLINE_TITLE_CHARS = 80`

- [ ] **Step 1: 写失败的测试**

创建 `lib/page-outline.dom.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { MAX_OUTLINE_ITEMS, MAX_OUTLINE_TITLE_CHARS, collectOutline } from './page-outline';

function docWith(html: string): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

describe('collectOutline', () => {
  it('keeps h1-h3 in document order with their level', () => {
    const doc = docWith('<h1>标题</h1><p>正文</p><h2>小节</h2><h3>子节</h3>');
    expect(collectOutline(doc)).toEqual([
      { level: 1, title: '标题' },
      { level: 2, title: '小节' },
      { level: 3, title: '子节' },
    ]);
  });

  it('ignores h4 and deeper, and drops empty headings', () => {
    const doc = docWith('<h1>保留</h1><h4>太深</h4><h2>   </h2><h2><span></span></h2>');
    expect(collectOutline(doc)).toEqual([{ level: 1, title: '保留' }]);
  });

  it('collapses whitespace inside a title', () => {
    const doc = docWith('<h2>  第 1 节\n\n  概述 </h2>');
    expect(collectOutline(doc)).toEqual([{ level: 2, title: '第 1 节 概述' }]);
  });

  it('truncates a long title', () => {
    const doc = docWith(`<h2>${'长'.repeat(MAX_OUTLINE_TITLE_CHARS + 20)}</h2>`);
    expect(collectOutline(doc)[0].title).toBe('长'.repeat(MAX_OUTLINE_TITLE_CHARS));
  });

  it('caps the list so a long table of contents cannot blow up the prompt', () => {
    const doc = docWith('<h2>节</h2>'.repeat(MAX_OUTLINE_ITEMS + 10));
    expect(collectOutline(doc)).toHaveLength(MAX_OUTLINE_ITEMS);
  });

  it('returns an empty list for a missing root', () => {
    expect(collectOutline(null)).toEqual([]);
    expect(collectOutline(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/page-outline.dom.test.ts`
Expected: FAIL，报错类似 `Failed to resolve import "./page-outline"`。

- [ ] **Step 3: 写最小实现**

创建 `lib/page-outline.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/page-outline.dom.test.ts`
Expected: PASS，6 个用例。

- [ ] **Step 5: 提交**

```bash
git add lib/page-outline.ts lib/page-outline.dom.test.ts
git commit -m "feat(page): 新增正文标题骨架采集器"
```

提交信息正文（与命令分开写，避免嵌套引号）：

```
长正文只能截出头尾两段时，用标题骨架告诉模型中间省略的部分里还有哪些小节。
不记录字符偏移：正文还要过 redactText，脱敏会改变长度，偏移必然漂掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 2: 骨架接入 `PageContent`（内容脚本采集 + background 脱敏）

**Files:**
- Modify: `lib/messaging.ts:85-93`（`PageContent` 加可选字段）
- Modify: `entrypoints/content.ts:93-112`（`extractPage`）
- Modify: `entrypoints/background.ts:584-596`（`extractActivePage`）
- Test: `lib/final-review.test.ts`（新增一个 describe 块）

**Interfaces:**
- Consumes: Task 1 的 `collectOutline` / `PageOutlineItem`
- Produces: `PageContent.outline?: PageOutlineItem[]`，且到达面板时其中的 `title` 已脱敏

- [ ] **Step 1: 写失败的测试**

在 `lib/final-review.test.ts` 末尾追加一个 describe 块（文件顶部已有 `fs` / `path`，不要重复引入）：

```ts
describe('page extraction outline', () => {
  const contentSource = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/content.ts'),
    'utf8',
  );
  const backgroundSource = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/background.ts'),
    'utf8',
  );

  // 大纲标题同样是页面来源的不可信文本，不能因为「只是标题」就绕过脱敏管线
  // （ref: 2026-08-31-page-redaction-pipeline-design.md）。
  it('redacts outline titles alongside the page text', () => {
    expect(backgroundSource).toContain('title: redactText(item.title, redactionSettings)');
  });

  // 大纲要从 Readability 解析出的正文容器里取：直接扫 document 会把导航、侧栏、
  // 页脚的标题也算成小节，骨架就不再是「正文的骨架」了。
  it('collects the outline from the readable article, not the whole document', () => {
    expect(contentSource).toContain("new DOMParser().parseFromString(article.content, 'text/html')");
    expect(contentSource).toContain('collectOutline(document)');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/final-review.test.ts`
Expected: FAIL，两个新用例都报 `expected ... to contain ...`。

- [ ] **Step 3: 改 `PageContent`**

`lib/messaging.ts`，在文件已有的 import 区加类型引入：

```ts
import type { PageOutlineItem } from './page-outline';
```

并把 `PageContent` 改成：

```ts
export interface PageContent {
  title: string;
  url: string;
  lang: string;
  /** 纯文本正文（Phase 1 接入 Readability 优化） */
  text: string;
  /** 提取到的字符数 */
  length: number;
  /** 正文的 h1-h3 标题骨架；正文过长只能截头尾时，它补上中段的结构信息。没有标题的页面为 undefined。 */
  outline?: PageOutlineItem[];
}
```

- [ ] **Step 4: 改内容脚本的 `extractPage`**

`entrypoints/content.ts`，先加 import：

```ts
import { collectOutline, type PageOutlineItem } from '@/lib/page-outline';
```

再把 `extractPage` 整体替换为：

```ts
function extractPage(): PageContent {
  let text = '';
  let outline: PageOutlineItem[] = [];
  try {
    const docClone = document.cloneNode(true) as Document;
    const article = new Readability(docClone).parse();
    text = (article?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (text && article?.content) {
      // 只扫 Readability 认定的正文容器：直接扫 document 会把导航、侧栏、页脚的标题
      // 也算成小节，骨架就不再是「正文的骨架」。
      outline = collectOutline(new DOMParser().parseFromString(article.content, 'text/html'));
    }
  } catch {
    // 忽略，走回退方案
  }
  if (!text) {
    text = (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').trim();
    // Readability 整体失败时没有正文容器可扫，只能退回整篇文档。
    outline = collectOutline(document);
  }
  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || 'unknown',
    text,
    length: text.length,
    outline: outline.length > 0 ? outline : undefined,
  };
}
```

- [ ] **Step 5: 改 background 的脱敏**

`entrypoints/background.ts` 的 `extractActivePage`，把结尾两行换成：

```ts
  const redactionSettings = await loadRedactionSettings();
  return {
    ...response.data,
    text: redactText(response.data.text, redactionSettings),
    // 大纲标题同样是页面来源的文本，不能因为「只是标题」就绕过脱敏。
    outline: response.data.outline?.map((item) => ({
      ...item,
      title: redactText(item.title, redactionSettings),
    })),
  };
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `pnpm vitest run lib/final-review.test.ts && pnpm compile`
Expected: 测试 PASS；`tsc --noEmit` 无输出。

- [ ] **Step 7: 提交**

```bash
git add lib/messaging.ts entrypoints/content.ts entrypoints/background.ts lib/final-review.test.ts
git commit -m "feat(page): EXTRACT_PAGE 一并返回正文标题骨架"
```

提交信息正文：

```
大纲只从 Readability 认定的正文容器里取，避免把导航和侧栏的标题算成小节；
标题与正文一样过 redactText，不因为只是标题就绕过脱敏管线。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 3: 预取策略纯函数 `planPagePrefetch`

**Files:**
- Create: `lib/chat/page-prefetch.ts`
- Test: `lib/chat/page-prefetch.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PageOutlineItem`；`MAX_TOOL_RESULT_CHARS`（`lib/agent/context-budget.ts`）
- Produces: `MIN_PAGE_PREFETCH_CHARS = 200`、`MAX_PAGE_PREFETCH_CHARS`（= 48000）、`PAGE_PREFETCH_HEAD_CHARS = 32000`、`PAGE_PREFETCH_TAIL_CHARS`（= 16000）、`PagePrefetchInput`、`PagePrefetchPlan = { kind: 'skip' } | FullPagePrefetch | WindowedPagePrefetch`、`planPagePrefetch(input): PagePrefetchPlan`、`renderPageOutline(items): string`

- [ ] **Step 1: 写失败的测试**

创建 `lib/chat/page-prefetch.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { MAX_TOOL_RESULT_CHARS } from '@/lib/agent/context-budget';
import {
  MAX_PAGE_PREFETCH_CHARS,
  MIN_PAGE_PREFETCH_CHARS,
  PAGE_PREFETCH_HEAD_CHARS,
  PAGE_PREFETCH_TAIL_CHARS,
  planPagePrefetch,
  renderPageOutline,
} from './page-prefetch';

function page(text: string, outline?: Array<{ level: 1 | 2 | 3; title: string }>) {
  return { title: 'T', url: 'https://example.com/a', text, outline };
}

describe('planPagePrefetch', () => {
  it('shares its ceiling with the tool-result limit instead of inventing one', () => {
    expect(MAX_PAGE_PREFETCH_CHARS).toBe(MAX_TOOL_RESULT_CHARS);
    expect(PAGE_PREFETCH_HEAD_CHARS + PAGE_PREFETCH_TAIL_CHARS).toBe(MAX_PAGE_PREFETCH_CHARS);
  });

  it('skips a body too short to support any page-scope task', () => {
    expect(planPagePrefetch(page(''))).toEqual({ kind: 'skip' });
    expect(planPagePrefetch(page('x'.repeat(MIN_PAGE_PREFETCH_CHARS - 1)))).toEqual({ kind: 'skip' });
  });

  it('passes a body at the minimum through as full text', () => {
    const plan = planPagePrefetch(page('x'.repeat(MIN_PAGE_PREFETCH_CHARS)));
    expect(plan).toMatchObject({ kind: 'full', title: 'T', url: 'https://example.com/a' });
  });

  it('passes a body exactly at the ceiling through as full text', () => {
    expect(planPagePrefetch(page('x'.repeat(MAX_PAGE_PREFETCH_CHARS))).kind).toBe('full');
  });

  it('windows a body past the ceiling into head and tail', () => {
    const total = MAX_PAGE_PREFETCH_CHARS + 5000;
    const text =
      'h'.repeat(PAGE_PREFETCH_HEAD_CHARS) + 'm'.repeat(5000) + 't'.repeat(PAGE_PREFETCH_TAIL_CHARS);
    expect(text).toHaveLength(total);
    const plan = planPagePrefetch(page(text));
    expect(plan).toMatchObject({
      kind: 'windowed',
      headEnd: PAGE_PREFETCH_HEAD_CHARS,
      tailStart: total - PAGE_PREFETCH_TAIL_CHARS,
      total,
      omitted: 5000,
      outline: [],
    });
    if (plan.kind !== 'windowed') throw new Error('unreachable');
    expect(plan.head).toBe('h'.repeat(PAGE_PREFETCH_HEAD_CHARS));
    expect(plan.tail).toBe('t'.repeat(PAGE_PREFETCH_TAIL_CHARS));
    expect(plan.head).not.toContain('m');
    expect(plan.tail).not.toContain('m');
  });

  it('carries the outline into the windowed plan', () => {
    const plan = planPagePrefetch(
      page('x'.repeat(MAX_PAGE_PREFETCH_CHARS + 1), [{ level: 2, title: '第 4 节' }]),
    );
    expect(plan).toMatchObject({ outline: [{ level: 2, title: '第 4 节' }] });
  });
});

describe('renderPageOutline', () => {
  it('renders levels as heading marks inside one JSON array', () => {
    expect(
      renderPageOutline([
        { level: 1, title: '总览' },
        { level: 3, title: '细节' },
      ]),
    ).toBe(JSON.stringify(['# 总览', '### 细节']));
  });

  it('renders an empty outline as an empty array', () => {
    expect(renderPageOutline([])).toBe('[]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/chat/page-prefetch.test.ts`
Expected: FAIL，`Failed to resolve import "./page-prefetch"`。

- [ ] **Step 3: 写最小实现**

创建 `lib/chat/page-prefetch.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run lib/chat/page-prefetch.test.ts`
Expected: PASS，8 个用例。

- [ ] **Step 5: 提交**

```bash
git add lib/chat/page-prefetch.ts lib/chat/page-prefetch.test.ts
git commit -m "feat(chat): 预取策略收敛成一个纯函数的三个分支"
```

提交信息正文：

```
正文过短坦白失败退回工具路径，正常全文进上下文，超限给头尾加标题骨架。
上限取 MAX_TOOL_RESULT_CHARS，不另造常量。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 4: 窗口化文案与 `buildShortcutExecution` 三分支

**Files:**
- Modify: `lib/i18n/locales/zh.ts`（`store.shortcutPagePrompt` 之后插入新键）
- Modify: `lib/i18n/locales/en.ts`（同一位置插入同名键）
- Modify: `lib/chat/shortcut-prompts.ts`
- Test: `lib/chat/shortcut-prompts.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `PagePrefetchPlan` / `planPagePrefetch` / `renderPageOutline`
- Produces: `buildShortcutExecution(shortcut, translate, selection?, pagePrefetch?: PagePrefetchPlan)`；删除旧的 `PagePrefetch` 接口

- [ ] **Step 1: 写失败的测试**

`lib/chat/shortcut-prompts.test.ts` 顶部补一行 import：

```ts
import {
  MAX_PAGE_PREFETCH_CHARS,
  PAGE_PREFETCH_HEAD_CHARS,
  PAGE_PREFETCH_TAIL_CHARS,
  planPagePrefetch,
} from './page-prefetch';
```

在 `describe('buildShortcutExecution', ...)` 内追加四个用例（文件已有 `t` / `zhT` / `shortcut()` 辅助函数，直接用）：

```ts
  it('puts the whole body in the first turn when it fits', () => {
    const plan = planPagePrefetch({ title: 'Doc', url: 'https://example.com/a', text: 'x'.repeat(1000) });
    const result = buildShortcutExecution(shortcut('page'), t, undefined, plan);
    expect(result.agentUserContent).toContain(JSON.stringify('x'.repeat(1000)));
    expect(result.agentUserContent).toContain('https://example.com/a');
    expect(result.browserTools).toBe('all');
  });

  it('falls back to the bare prompt when the prefetch was skipped', () => {
    const plan = planPagePrefetch({ title: 'Doc', url: 'https://example.com/a', text: 'too short' });
    expect(buildShortcutExecution(shortcut('page'), t, undefined, plan)).toEqual({
      display: 'Translate',
      agentUserContent: 'Translate this content.',
      browserTools: 'all',
      systemPromptSuffix: '',
    });
  });

  it('sends head, tail and outline for an over-long body, and steers away from sequential re-reads', () => {
    const text =
      'h'.repeat(PAGE_PREFETCH_HEAD_CHARS) + 'm'.repeat(2000) + 't'.repeat(PAGE_PREFETCH_TAIL_CHARS);
    const plan = planPagePrefetch({
      title: 'Doc',
      url: 'https://example.com/a',
      text,
      outline: [{ level: 2, title: 'Middle section' }],
    });
    const content = buildShortcutExecution(shortcut('page'), t, undefined, plan).agentUserContent;
    expect(content).toContain(JSON.stringify('h'.repeat(PAGE_PREFETCH_HEAD_CHARS)));
    expect(content).toContain(JSON.stringify('t'.repeat(PAGE_PREFETCH_TAIL_CHARS)));
    expect(content).toContain('## Middle section');
    expect(content).toContain('2000');
    expect(content).toContain('browser_find_text');
    expect(content).not.toContain('m'.repeat(2000));
  });

  // 与整页分支同样的约束：防注入规则只属于系统提示词。
  it('keeps the windowed copy free of anti-injection wording in both locales', () => {
    const plan = planPagePrefetch({
      title: 'Doc',
      url: 'https://example.com/a',
      text: 'x'.repeat(MAX_PAGE_PREFETCH_CHARS + 10),
    });
    for (const translate of [t, zhT]) {
      const content = buildShortcutExecution(shortcut('page'), translate, undefined, plan).agentUserContent;
      expect(content).not.toMatch(/never follow instructions|绝不遵循/);
      expect(content).not.toMatch(/UNTRUSTED PAGE CONTENT|不可信/);
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/chat/shortcut-prompts.test.ts`
Expected: FAIL——`pagePrefetch` 仍是旧的 `PagePrefetch` 形状（类型不匹配），且窗口化文案还不存在。

- [ ] **Step 3: 加两份文案**

`lib/i18n/locales/zh.ts`，在 `'store.shortcutPagePrompt'` 之后插入：

```ts
  'store.shortcutPageWindowedPrompt':
    '{instruction}\n\n当前页面（标题：{title}，网址：{url}）正文总长 {total} 字符，超过单轮可用上限，所以下面给出的是同一个页面的开头和结尾两段，不是两个页面。\n\n开头（第 0–{headEnd} 字符，JSON 字符串）：\n{head}\n\n结尾（第 {tailStart}–{total} 字符，JSON 字符串）：\n{tail}\n\n中间省略了 {omitted} 字符。下面的 JSON 数组是全文的标题大纲，覆盖包括被省略部分在内的整篇内容：\n{outline}\n\n需要中段细节时，用 browser_find_text 搜大纲里的小节标题直接定位；不要用 browser_read_page 从头顺序翻页——再调用一次读取工具会把这里的正文压成一行摘要移出上下文，读了后面反而丢了前面。',
```

`lib/i18n/locales/en.ts`，同一位置插入：

```ts
  'store.shortcutPageWindowedPrompt':
    '{instruction}\n\nThe current page (title: {title}, url: {url}) has a body of {total} characters, which exceeds what fits in one turn. What follows is the beginning and the end of the same page, not two different pages.\n\nBeginning (characters 0–{headEnd}, JSON string):\n{head}\n\nEnd (characters {tailStart}–{total}, JSON string):\n{tail}\n\n{omitted} characters in the middle were omitted. The JSON array below is the heading outline of the whole page, including the omitted middle:\n{outline}\n\nWhen you need detail from the middle, search a heading from that outline with browser_find_text to jump straight to it. Do not page through with browser_read_page from the start: calling a read tool again compacts the body above into a one-line summary and pushes it out of context, so you would lose the beginning to gain the end.',
```

- [ ] **Step 4: 改 `buildShortcutExecution`**

`lib/chat/shortcut-prompts.ts`：删除 `PagePrefetch` 接口及其注释（含过期的「12000 字符」说法），改为引入 Task 3 的类型；把 `scope === 'page'` 分支换成三分支。改完后文件顶部与 page 分支应为：

```ts
import type { Translate } from '@/lib/i18n';
import type { ResolvedShortcut } from '@/lib/shortcuts';
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
): ShortcutExecution {
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
      return {
        display: shortcut.name,
        agentUserContent: translate('store.shortcutPageWindowedPrompt', {
          instruction: shortcut.prompt,
          title: pagePrefetch.title,
          url: pagePrefetch.url,
          head: JSON.stringify(pagePrefetch.head),
          tail: JSON.stringify(pagePrefetch.tail),
          headEnd: pagePrefetch.headEnd,
          tailStart: pagePrefetch.tailStart,
          total: pagePrefetch.total,
          omitted: pagePrefetch.omitted,
          outline: renderPageOutline(pagePrefetch.outline),
        }),
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
```

`selection` / `none` 两个分支保持原样，不要改动。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run lib/chat/shortcut-prompts.test.ts lib/i18n/i18n.test.ts`
Expected: PASS。`i18n.test.ts` 里「两份字典键集合一致」的用例会守住 en/zh 同时加了新键。

- [ ] **Step 6: 提交**

```bash
git add lib/chat/shortcut-prompts.ts lib/chat/shortcut-prompts.test.ts lib/i18n/locales/zh.ts lib/i18n/locales/en.ts
git commit -m "feat(chat): 超长正文改发头尾两段加标题骨架"
```

提交信息正文：

```
文案给出确切的区间和省略字符数，并明确下一步是用 browser_find_text 按小节
定位，而不是 browser_read_page 顺序翻页——后者会把已给的正文压成摘要挤出上下文。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 5: store 接线与全量验证

**Files:**
- Modify: `entrypoints/sidepanel/store.ts:41`（import）、`:46`（import）、`:201-203`（删常量）、`:1186`（局部变量类型）、`:1228-1241`（预取分支）
- Test: `lib/final-review.test.ts`（补一个 describe 块）

**Interfaces:**
- Consumes: Task 3 的 `planPagePrefetch` / `PagePrefetchPlan`、Task 4 的 `buildShortcutExecution` 新签名
- Produces: 无（终点任务）

- [ ] **Step 1: 写失败的测试**

在 Task 2 新增的 `describe('page extraction outline', ...)` 之后追加：

```ts
describe('side-panel page prefetch', () => {
  const storeSource = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/sidepanel/store.ts'),
    'utf8',
  );

  // 面板只做 I/O：取多少正文、超限怎么切，全部由 lib/chat/page-prefetch.ts 的纯函数决定，
  // 否则这段逻辑落在 entrypoints/ 里就没有任何 vitest project 能测到它。
  it('delegates the prefetch decision to the pure planner', () => {
    expect(storeSource).toContain('planPagePrefetch(response.data)');
    expect(storeSource).not.toContain('PAGE_PREFETCH_MAX_CHARS');
    expect(storeSource).not.toMatch(/text\.slice\(0,/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run lib/final-review.test.ts`
Expected: FAIL，三条断言全不满足（store 还在用 `PAGE_PREFETCH_MAX_CHARS` 和 `slice`）。

- [ ] **Step 3: 改 store 的 import 与常量**

`entrypoints/sidepanel/store.ts`：

把第 41 行的

```ts
import { buildShortcutExecution, MAX_SHORTCUT_SELECTION_CHARS, type PagePrefetch } from '@/lib/chat/shortcut-prompts';
```

换成两行：

```ts
import { buildShortcutExecution, MAX_SHORTCUT_SELECTION_CHARS } from '@/lib/chat/shortcut-prompts';
import { planPagePrefetch, type PagePrefetchPlan } from '@/lib/chat/page-prefetch';
```

删掉第 46 行的 `import { DEFAULT_READ_MAX_CHARS } from '@/lib/agent/context-budget';`（本文件已无其他用处），以及第 201-203 行的 `PAGE_PREFETCH_MAX_CHARS` 常量及其注释。

- [ ] **Step 4: 改预取分支**

把 `runResolvedShortcut` 里的局部声明改成：

```ts
  let pagePrefetch: PagePrefetchPlan | undefined;
```

并把 `EXTRACT_PAGE` 成功后的那段（含「与 browser_read_page 工具的默认上限保持一致」那条已经过期的注释）整体换成：

```ts
      if (response.ok && response.data) {
        // 预取跑在脱敏之后的正文上（background.ts 的 extractActivePage 已经过了 redactText），
        // 所以长度判断和头尾切分用的就是模型最终会看到的那份文本。
        // 正文太短时 planPagePrefetch 给出 skip：不设 pagePrefetch，退回工具路径，
        // 模型自己调 browser_read_page，读不到就如实说读不到——比拿着空串断言「页面内容太少」诚实。
        const plan = planPagePrefetch(response.data);
        if (plan.kind !== 'skip') pagePrefetch = plan;
      }
```

注意保留 `buildShortcutExecution(resolved, t, selectionText, pagePrefetch)` 这行调用的原样写法：`lib/final-review.test.ts` 有一条现存断言按字面匹配它。

- [ ] **Step 5: 确认没有残留的旧上限说法**

Run: `rg "12000|PAGE_PREFETCH_MAX_CHARS" lib/chat entrypoints/sidepanel/store.ts`
Expected: 无输出（Task 4 已删掉 `shortcut-prompts.ts` 里的过期注释；若仍有命中，就地删掉）。

- [ ] **Step 6: 全量验证**

Run: `pnpm compile && pnpm test`
Expected: `tsc --noEmit` 无输出；三个 vitest project 全绿。

若 `entrypoints/sidepanel/store-context.test.tsx` 里有构造 `EXTRACT_PAGE` 返回值的桩，确认其 `text` 长度 ≥ `MIN_PAGE_PREFETCH_CHARS`（200），否则预取会被判成 skip，既有断言会失败——这种情况把桩文本加长，**不要**调低 `MIN_PAGE_PREFETCH_CHARS`。

- [ ] **Step 7: 提交**

```bash
git add entrypoints/sidepanel/store.ts lib/final-review.test.ts lib/chat/shortcut-prompts.ts
git commit -m "feat(sidepanel): 快捷方式预取改由纯函数决定取多少正文"
```

提交信息正文：

```
面板退化为 I/O：长正文不再被静默切到 24000 字符，正文太短时坦白失败退回
工具路径，而不是拿着空串告诉模型请直接使用。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## 验收（手动，加载 `.output/chrome-mv3` 后）

- 打开一篇超过 48000 字符的长文，点「总结本页」：回答里应出现对结尾部分的引用，且模型不会声称页面内容不完整；活动区不应出现额外的 `browser_read_page` 调用。
- 在 Chrome 内置 PDF 阅读器里打开一个 PDF，点「总结本页」：模型应尝试 `browser_read_page` 并明确说明读不到正文，而不是断言「页面内容太少」。
- 普通文章页（几千字）行为与改动前一致：一轮出结果，无额外工具调用。
