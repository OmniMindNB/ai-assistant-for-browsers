import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';

// Markdown 渲染（ref: technical-plan.md §2.2）。
// 渲染 LLM 输出，支持 GFM（表格/列表）与代码高亮。
export default function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
