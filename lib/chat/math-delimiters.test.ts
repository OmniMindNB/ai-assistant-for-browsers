import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from './math-delimiters';

describe('normalizeMathDelimiters', () => {
  it('leaves text without $ or backslashes untouched', () => {
    expect(normalizeMathDelimiters('普通段落\n\n- 一项')).toBe('普通段落\n\n- 一项');
  });

  it('keeps valid $…$ and $$…$$ formulas', () => {
    expect(normalizeMathDelimiters('质能方程 $E=mc^2$。')).toBe('质能方程 $E=mc^2$。');
    expect(normalizeMathDelimiters('$x$')).toBe('$x$');
    const block = '$$\n\\int_0^1 x\\,dx\n$$';
    expect(normalizeMathDelimiters(block)).toBe(block);
  });

  it('converts \\(…\\) to inline and \\[…\\] to display math', () => {
    expect(normalizeMathDelimiters('其中 \\( a^2 + b^2 \\) 成立')).toBe('其中 $a^2 + b^2$ 成立');
    expect(normalizeMathDelimiters('如下：\\[ \\frac{1}{2} \\]')).toBe('如下：\n$$\n\\frac{1}{2}\n$$\n');
  });

  it('does not treat escaped citation brackets as display math', () => {
    expect(normalizeMathDelimiters('见文献 \\[1\\]')).toBe('见文献 \\[1\\]');
  });

  it('escapes currency dollars so they are not parsed as math', () => {
    expect(normalizeMathDelimiters('价格从 $5 到 $10 不等')).toBe('价格从 \\$5 到 \\$10 不等');
    expect(normalizeMathDelimiters('售价 $19.99')).toBe('售价 \\$19.99');
    // 闭 $ 后紧跟数字：Pandoc 规则下不是公式
    expect(normalizeMathDelimiters('$a$1')).toBe('\\$a\\$1');
  });

  it('keeps already-escaped dollars as they are', () => {
    expect(normalizeMathDelimiters('花了 \\$5')).toBe('花了 \\$5');
  });

  it('escapes an unclosed $$ while the reply is still streaming', () => {
    expect(normalizeMathDelimiters('公式：$$\n\\frac{1}')).toBe('公式：\\$\\$\n\\frac{1}');
  });

  it('leaves code blocks and inline code alone', () => {
    const fenced = '```bash\necho $HOME \\(x\\)\n```';
    expect(normalizeMathDelimiters(`前文 $5\n${fenced}\n后文`)).toBe(`前文 \\$5\n${fenced}\n后文`);
    expect(normalizeMathDelimiters('变量 `$price` 和 $5')).toBe('变量 `$price` 和 \\$5');
    // 流式中未闭合的围栏也按代码处理
    expect(normalizeMathDelimiters('```js\nconst a = `$${b}`')).toBe('```js\nconst a = `$${b}`');
  });
});
