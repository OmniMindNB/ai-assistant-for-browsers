// 内置脚本模板（ref: technical-plan.md §4.2「内置常用模板」）。
// 这些模板为预置的安全脚本，运行在页面 MAIN world，无需经过 LLM 生成。

export interface ScriptTemplate {
  id: string;
  name: string;
  description: string;
  code: string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'reading-mode',
    name: '阅读模式',
    description: '居中正文、加大字号、柔和背景',
    code: `const article = document.querySelector('article') || document.body;
const wrap = document.createElement('div');
wrap.style.cssText = 'max-width:720px;margin:40px auto;padding:24px;background:#fffdf7;color:#222;font-size:18px;line-height:1.8;font-family:Georgia,serif;box-shadow:0 2px 16px rgba(0,0,0,.08);border-radius:8px;';
wrap.innerHTML = article.innerHTML;
document.body.innerHTML = '';
document.body.style.background = '#e9e6dd';
document.body.appendChild(wrap);`,
  },
  {
    id: 'remove-fixed',
    name: '去除悬浮/广告',
    description: '隐藏常见固定定位的悬浮层与广告位',
    code: `let n = 0;
document.querySelectorAll('*').forEach((el) => {
  const s = getComputedStyle(el);
  if ((s.position === 'fixed' || s.position === 'sticky') && el.offsetHeight > 0) {
    el.style.display = 'none';
    n++;
  }
});
document.querySelectorAll('[id*="ad" i],[class*="ad" i],[class*="banner" i]').forEach((el) => {
  el.style.display = 'none';
  n++;
});
return '已隐藏 ' + n + ' 个元素';`,
  },
  {
    id: 'dark-bg',
    name: '深色背景',
    description: '为页面切换到护眼深色背景',
    code: `document.documentElement.style.filter = 'invert(1) hue-rotate(180deg)';
document.querySelectorAll('img,video,picture,canvas,[style*="background-image"]').forEach((el) => {
  el.style.filter = 'invert(1) hue-rotate(180deg)';
});
return '已切换深色背景';`,
  },
];
