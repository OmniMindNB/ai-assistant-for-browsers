import { memo, type ComponentPropsWithoutRef } from 'react';
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
export const HIGHLIGHT_LANGUAGES = {
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

// remarkPlugins/rehypePlugins/components 数组和对象字面量提到模块作用域：
// 内联在组件体里会在每次渲染都创建新的数组/对象实例，即使 content 没变，
// react-markdown 也会认为插件配置变化而跳过内部的 memo 优化。
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: [typeof rehypeHighlight, { languages: typeof HIGHLIGHT_LANGUAGES }][] = [
  [rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES }],
];
const MARKDOWN_COMPONENTS = {
  a: ({ node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
  table: ({ node: _node, ...props }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

// 表格单独套一层可横向滚动的容器：侧边栏只有三四百像素宽，react-markdown 直接吐出的
// <table> 在这个宽度下要么把列挤成每行一两个字，要么撑破容器——两种都不可用。包一层
// overflow-x 的 div，再让表格按内容宽度排版（见 tailwind.css 的 .md-table-wrap），
// 宽表格就变成容器内横向滚动，页面本身不会被撑开。
//
// memo 包裹：流式输出期间父级 Message 组件会因为不相关的 store 更新（输入框打字、
// 其他消息的活动步骤）而重渲染，content 没变时这里必须跳过整棵 remark/rehype-highlight
// 解析树的重建，否则长对话历史里每条消息都要在无关按键上白跑一遍高亮解析。
function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
