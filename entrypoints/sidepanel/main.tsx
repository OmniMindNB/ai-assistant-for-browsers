import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/tailwind.css';
import { applyTheme } from '@/lib/theme';
import { applyLocale, LocaleProvider } from '@/lib/i18n';
import { isChunkLoadError } from '@/lib/chunk-load-error';

// 先按系统偏好应用主题/语言，避免加载前的闪烁；useTheme/LocaleProvider 会用存储的偏好修正。
applyTheme('auto');
applyLocale('auto');

ReactDOM.createRoot(document.getElementById('root')!, {
  // MarkdownBlock 的 ChunkErrorBoundary 已经把「扩展重载后旧 chunk 被删」这类失败兜成了
  // 纯文本回退，界面上完全看不出异常。但 React 默认仍会把被错误边界捕获的原始报错打进
  // console.error——而扩展页面的 console.error 会被 chrome://extensions 的 Errors 面板
  // 收录，看起来像崩溃了一样。这里只吞掉这一种已识别、已兜底的失败，其它被捕获的错误
  // （说明 ChunkErrorBoundary 之外出了别的问题）继续按 React 默认方式打印，不静默掉。
  onCaughtError: (error, errorInfo) => {
    if (isChunkLoadError(error)) return;
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
