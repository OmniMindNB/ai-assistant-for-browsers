# PDF 划词气泡实现计划

1. 提取网页划词气泡，在阅读器中仅接受 PDF 正文选区。使用 DOM 回归测试验证跨页选区、点击提交与工具栏选区过滤。
2. 用已打包的 PDF.js worker 和 PDFViewer 渲染浏览器交付的 PDF 数据，提供页码、缩放、打开文件和切回原生阅读器的控件。
3. Chrome 构建注册顶层 PDF MIME handler，给较旧的 Chromium 保留菜单入口。验证类型、测试和构建产物。
