import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';

import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// rehype-highlight 默认注册 lowlight 的 `common` 语言集（37 种），
// 其中多数（rust/kotlin/swift/vbnet/wasm...）与浏览器助手场景无关，白白增大 sidepanel 包体。
// 这里只注册页面/脚本类场景实际会用到的语言。
const HIGHLIGHT_LANGUAGES = {
  bash,
  shell: bash,
  css,
  diff,
  json,
  javascript,
  js: javascript,
  jsx: javascript,
  python,
  py: python,
  typescript,
  ts: typescript,
  tsx: typescript,
  xml,
  html: xml,
  yaml,
  yml: yaml,
};

// Markdown 渲染（ref: technical-plan.md §2.2）。
// 渲染 LLM 输出，支持 GFM（表格/列表）与代码高亮。
export default function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES }]]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
