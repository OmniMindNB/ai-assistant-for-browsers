import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripNonWoff2FontSources } from './katex-font-trim';

describe('stripNonWoff2FontSources', () => {
  it('keeps only the woff2 source of a @font-face rule', () => {
    const css =
      '@font-face{font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),'
      + 'url(fonts/KaTeX_AMS-Regular.woff) format("woff"),url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}';
    expect(stripNonWoff2FontSources(css)).toBe(
      '@font-face{font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2")}',
    );
  });

  // 守住 KaTeX 升级：CSS 写法一变，正则就会静默失效，体积回涨却没人发现
  it('removes every woff/ttf reference from the installed katex.min.css', () => {
    const css = readFileSync('node_modules/katex/dist/katex.min.css', 'utf8');
    const trimmed = stripNonWoff2FontSources(css);
    expect(trimmed).not.toMatch(/\.(woff|ttf)\)/);
    expect(trimmed.match(/\.woff2\)/g)?.length).toBe(css.match(/\.woff2\)/g)?.length);
  });
});
