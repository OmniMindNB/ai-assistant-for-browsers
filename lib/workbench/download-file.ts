// 在扩展页面里直接触发文件下载：<a download> + Blob URL，不需要 downloads 权限
// （ref: docs/superpowers/specs/2026-09-24-conversation-export-design.md §5）。
export function downloadTextFile(fileName: string, text: string, mimeType = 'text/markdown;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 同步 revoke 在部分浏览器里会让下载拿不到数据；留一点余量再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
