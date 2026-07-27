import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/tailwind.css';
import { applyTheme } from '@/lib/theme';
import { applyLocale, LocaleProvider } from '@/lib/i18n';

// 先按系统偏好应用主题/语言，避免加载前的闪烁；useTheme/LocaleProvider 会用存储的偏好修正。
applyTheme('auto');
applyLocale('auto');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
