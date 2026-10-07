import { useId } from 'react';

/**
 * Runi 品牌标记：与扩展图标 / 商店素材同一张图（docs/store-assets/icon-source.svg），内联成组件。
 *
 * 曾经侧边栏用的是手画的黑底白字 "R" 方块，跟用户在工具栏、商店里看到的渐变 "R" 是两套图形。
 * 路径与渐变照抄源文件，lib/brand-identity.test.ts 会比对两边的 path，防止改了一边忘了另一边。
 *
 * 渐变 id 用 useId 生成：同一页面里出现多个标记（header + 空状态）时，固定 id 会互相串用。
 */
export function BrandMark({ className }: { className?: string }) {
  // useId 的返回值带 ":" 之类的字符，放进 url(#...) 引用里不可靠，只留字母数字。
  const id = `runi-mark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const bg = `${id}-bg`;
  const accent = `${id}-accent`;
  return (
    <svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f8fbff" />
          <stop offset="1" stopColor="#eef2ff" />
        </linearGradient>
        <linearGradient id={accent} x1="39" y1="103" x2="96" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.55" stopColor="#5b6ff0" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="122" height="122" rx="30" fill={`url(#${bg})`} />
      <path
        d="M39 103V25H68C84 25 94 35 94 50C94 65 84 75 68 75H39M68 75L96 103"
        fill="none"
        stroke={`url(#${accent})`}
        strokeWidth="14"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
