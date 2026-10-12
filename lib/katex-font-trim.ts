// KaTeX 的 @font-face 给每种字体同时列出 woff2 / woff / ttf 三种格式，Vite 会把 url() 引用到的
// 文件全部打进扩展包。扩展要求 Chrome 138+，只会用到 woff2，另外两种格式约 800 KB 纯属包体浪费。
// 在 Vite 解析 url() 之前删掉 woff / ttf 的引用，这两种文件就不会被打包。
// 由 wxt.config.ts 的 katexWoff2Only 插件调用；纯函数单独放这里以便单测。

const NON_WOFF2_SOURCE = /,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g;

export function stripNonWoff2FontSources(css: string): string {
  return css.replace(NON_WOFF2_SOURCE, '');
}
