// entrypoints/sidepanel/markdown-languages.test.tsx
// 系统提示词告诉模型"这些语言标记能高亮"，实际高亮由 Markdown.tsx 注册的语言集决定。
// 两边一旦脱节，模型就会写出渲染不出高亮的代码块，这个测试守住这条耦合。
import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_LANGUAGES } from './Markdown';
import { HIGHLIGHTABLE_LANGUAGE_TAGS, SYSTEM_PROMPT } from '@/lib/agent/system-prompt';

describe('highlightable language tags', () => {
  it('are all registered in the markdown renderer', () => {
    const registered = new Set(Object.keys(HIGHLIGHT_LANGUAGES));
    const missing = HIGHLIGHTABLE_LANGUAGE_TAGS.filter((tag) => !registered.has(tag));
    expect(missing).toEqual([]);
  });

  it('are the ones the system prompt actually advertises', () => {
    for (const tag of HIGHLIGHTABLE_LANGUAGE_TAGS) {
      expect(SYSTEM_PROMPT).toContain(tag);
    }
  });
});
