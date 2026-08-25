// 执行期遮罩：写操作获批后罩在被操作页面上的纯视觉信号（ref: 2026-08-25-execution-overlay-design.md）。
// 由 content script 持有并调用；这里只做 DOM，不碰消息协议，以便在 dom project 下测试。
//
// ⚠️ 两条硬约束，改动时不要绕过：
// 1. 全程 pointer-events:none —— 我们是侧边栏形态，用户随时接管是正常预期，遮罩绝不能阻断输入；
//    顺带保证它永远不是 elementFromPoint 的命中目标，不会干扰点击前的遮挡检测。
// 2. 动画一律走 element.animate()，不用 <style>/@keyframes —— 严格 CSP 的页面会挡掉 <style> 标签，
//    而银行、政务这类最需要代填表单的站点恰恰 CSP 最严。

export const OVERLAY_HOST_ID = 'runi-agent-overlay';
export const OVERLAY_WATCHDOG_MS = 15000;

/**
 * 光标缓动时长。
 * ⚠️ 同一个数字在 lib/agent/form-dom.ts 的注入函数里还有一份（那里 await 这么久再派发点击）。
 * 注入函数被 executeScript 序列化，引用不到这里的常量，只能各自内联——改这里必须同步改那边。
 * 若注入函数等得比动画短，就会在光标还没停稳时派发点击，正是本功能要消除的那种错位。
 */
export const CURSOR_MOVE_MS = 250;

const ACCENT = '#4f46e5';

interface OverlayRefs {
  host: HTMLElement;
  shadow: ShadowRoot;
  label: HTMLElement;
  cursor: HTMLElement;
}

let refs: OverlayRefs | null = null;
let currentLabel = '';
let watchdog: ReturnType<typeof setTimeout> | undefined;
let cursorPos: { x: number; y: number } | null = null;

export function getOverlayState(): {
  mounted: boolean;
  label: string;
  cursor: { x: number; y: number } | null;
} {
  return { mounted: refs !== null, label: currentLabel, cursor: cursorPos };
}

export function mountOverlay(label: string): void {
  if (!refs) refs = createOverlay();
  setLabel(label);
  renewOverlayWatchdog();
}

export function updateOverlayLabel(label: string): void {
  if (!refs) return;
  setLabel(label);
  renewOverlayWatchdog();
}

export function unmountOverlay(): void {
  clearTimeout(watchdog);
  watchdog = undefined;
  refs?.host.remove();
  refs = null;
  currentLabel = '';
  cursorPos = null;
}

/**
 * 看门狗：侧边栏被关闭、或 MV3 service worker 被驱逐时，没有任何人再发 hide，
 * 遮罩会永久挂在用户页面上。所以「撤下」不能只靠消息送达——每次收到活动信号就把
 * 倒计时推回 15s，一旦上游没了心跳，最多 15s 后页面自动干净。
 */
export function renewOverlayWatchdog(): void {
  if (!refs) return;
  clearTimeout(watchdog);
  watchdog = setTimeout(unmountOverlay, OVERLAY_WATCHDOG_MS);
}

/** 把坐标钳制在视口内，避免目标贴边时光标画到视口外看不见。 */
export function clampCursorPosition(
  x: number,
  y: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0));
  return { x: clamp(x, viewport.width), y: clamp(y, viewport.height) };
}

export function moveOverlayCursor(x: number, y: number): void {
  if (!refs) return;
  const next = clampCursorPosition(x, y, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  cursorPos = next;
  refs.cursor.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
  renewOverlayWatchdog();
}

function setLabel(label: string): void {
  currentLabel = label;
  if (refs) refs.label.textContent = label;
}

function createOverlay(): OverlayRefs {
  const host = document.createElement('div');
  host.id = OVERLAY_HOST_ID;
  // 逐属性赋值而非 cssText：style 属性字符串同样受页面 CSP 的 style-src-attr 约束。
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'closed' });

  const glow = document.createElement('div');
  glow.style.position = 'absolute';
  glow.style.inset = '0';
  glow.style.pointerEvents = 'none';
  glow.style.boxShadow = `inset 0 0 0 2px ${ACCENT}, inset 0 0 24px rgba(79, 70, 229, .28)`;
  shadow.appendChild(glow);

  const label = document.createElement('div');
  label.style.position = 'absolute';
  label.style.top = '12px';
  label.style.left = '50%';
  label.style.transform = 'translateX(-50%)';
  label.style.pointerEvents = 'none';
  label.style.padding = '6px 14px';
  label.style.borderRadius = '9999px';
  label.style.background = ACCENT;
  label.style.color = '#ffffff';
  label.style.font = '500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  label.style.boxShadow = '0 2px 8px rgba(0,0,0,0.24)';
  label.style.whiteSpace = 'nowrap';
  shadow.appendChild(label);

  const cursor = document.createElement('div');
  cursor.style.position = 'absolute';
  cursor.style.top = '0';
  cursor.style.left = '0';
  cursor.style.width = '24px';
  cursor.style.height = '24px';
  cursor.style.pointerEvents = 'none';
  cursor.style.willChange = 'transform';
  cursor.style.transition = `transform ${CURSOR_MOVE_MS}ms cubic-bezier(.22, 1, .36, 1)`;
  // 从视口右下角滑入，暗示「来自侧边栏那一侧」。
  cursor.style.transform = `translate3d(${window.innerWidth}px, ${window.innerHeight}px, 0)`;
  // 白描边保证在深浅背景上都可辨——因此不做 page-agent 那套页面背景色检测。
  cursor.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
    `<path d="M5 2 L19 12 L12.5 13 L16 20 L13 21.5 L9.5 14.5 L5 18 Z" fill="${ACCENT}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>` +
    '</svg>';
  shadow.appendChild(cursor);

  document.documentElement.appendChild(host);

  // 呼吸动画：jsdom 没有 Web Animations API，缺失时静默跳过（测试只断结构与状态）。
  if (typeof glow.animate === 'function') {
    glow.animate([{ opacity: 0.6 }, { opacity: 1 }], {
      duration: 2000,
      direction: 'alternate',
      iterations: Infinity,
      easing: 'ease-in-out',
    });
  }

  return { host, shadow, label, cursor };
}
