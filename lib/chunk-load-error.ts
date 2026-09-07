// 分包 chunk 请求失败时,不同浏览器措辞不完全一致,但都会提到“dynamically imported module”或
// “module script”。用于识别“预期内、已经有专门回退处理”的这一类错误——目前只有
// entrypoints/sidepanel/components/MarkdownBlock.tsx 的 ChunkErrorBoundary 会产出它。
const CHUNK_LOAD_ERROR_PATTERN = /dynamically imported module|module script failed/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CHUNK_LOAD_ERROR_PATTERN.test(message);
}
