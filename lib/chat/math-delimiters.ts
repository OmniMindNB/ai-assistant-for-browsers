// 模型回答里的数学公式预处理，跑在 remark-math 之前。解决两件 remark-math 自己不管的事：
//
// 1. 定界符：模型（尤其 OpenAI 系）常写 LaTeX 风格的 \(…\) / \[…\]，remark-math 只认 $ / $$。
//    这里统一转成 $…$ 和独立成行的 $$…$$。
// 2. 货币误判：浏览器助手的回答经常转述页面上的价格（"$5 到 $10"），remark-math 开了单 $
//    行内公式后会把 "5 到 " 渲染成公式。这里按 Pandoc 的规则判定单 $ 公式——开 $ 后紧跟非空白、
//    闭 $ 前紧挨非空白、闭 $ 后不紧跟数字——判不成公式的 $ 一律转义成 \$，原样显示。
//
// 代码块和行内代码原样保留，里面的 $ 和反斜杠都不是公式。

// 围栏代码块（流式输出时可能还没闭合，吃到末尾）和行内代码。
const CODE_SEGMENT = /(^|\n)( {0,3})(```|~~~)[\s\S]*?(?:\n {0,3}\3[^\n]*(?=\n|$)|$)|`[^`\n]+`/g;

// \[…\] 只有内容像公式才转：Markdown 里 \[1\] 也是合法的「转义方括号」写法（引用编号）。
const DISPLAY_BRACKETS = /\\\[([\s\S]+?)\\\]/g;
const INLINE_PARENS = /\\\(([\s\S]+?)\\\)/g;
const LOOKS_LIKE_MATH = /[\\^_=+{}<>]/;

// 依次匹配：已转义的 \$、$$…$$ 公式（可跨行）、合法的单 $ 公式、其余落单的 $。
const DOLLAR_TOKEN = /\\\$|\$\$[\s\S]+?\$\$|\$(?=[^\s$])[^$\n]*?[^\s\\$]\$(?!\d)|\$/g;

function normalizeText(text: string): string {
  return text
    .replace(DISPLAY_BRACKETS, (whole, body: string) =>
      LOOKS_LIKE_MATH.test(body) ? `\n$$\n${body.trim()}\n$$\n` : whole,
    )
    .replace(INLINE_PARENS, (_whole, body: string) => `$${body.trim()}$`)
    .replace(DOLLAR_TOKEN, (token) => (token === '$' ? '\\$' : token));
}

export function normalizeMathDelimiters(content: string): string {
  if (!content.includes('$') && !content.includes('\\')) return content;
  let out = '';
  let last = 0;
  for (const match of content.matchAll(CODE_SEGMENT)) {
    out += normalizeText(content.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + normalizeText(content.slice(last));
}
