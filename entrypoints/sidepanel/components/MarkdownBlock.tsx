import { Component, lazy, Suspense, type ReactNode } from 'react';

// react-markdown + rehype-highlight 拉入较大的解析/高亮代码，单独分包，
// 避免其阻塞侧边栏首次渲染（消息为空时完全不需要加载）。
const Markdown = lazy(() => import('../Markdown'));

// 分包的代价：chunk 文件名带内容 hash。侧边栏是长期开着的扩展页面，扩展一旦重载/更新，
// 这个 document 仍是旧构建加载的，而懒加载要到「真正渲染一条 markdown 消息」时才去取 chunk，
// 那时旧文件已经不在了 → “Failed to fetch dynamically imported module”。
// <Suspense> 只兜 pending 不兜 reject，所以必须由错误边界接住，否则整条消息列表崩掉。
class ChunkErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// 加载中和加载失败用同一个回退：未经渲染的原文。内容一个字都不少，只是没有 markdown 样式，
// 用户刷新/重开侧边栏后就恢复正常。
export function MarkdownBlock({ content }: { content: string }) {
  const plain = <span className="whitespace-pre-wrap">{content}</span>;
  return (
    <ChunkErrorBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <Markdown content={content} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
