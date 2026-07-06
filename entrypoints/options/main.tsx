import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/tailwind.css';
import { applyTheme } from '@/lib/theme';

// 先按系统偏好应用主题，避免加载前的闪烁；useTheme 会用存储的偏好修正。
applyTheme('auto');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
