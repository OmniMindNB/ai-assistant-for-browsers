import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OVERLAY_HOST_ID,
  OVERLAY_WATCHDOG_MS,
  getOverlayState,
  mountOverlay,
  renewOverlayWatchdog,
  unmountOverlay,
  updateOverlayLabel,
} from './agent-overlay';

const host = () => document.getElementById(OVERLAY_HOST_ID);

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = '<body></body>';
});

afterEach(() => {
  unmountOverlay();
  vi.useRealTimers();
});

describe('mountOverlay', () => {
  it('挂载一个 closed shadow root 的宿主，且不拦截指针事件', () => {
    mountOverlay('正在操作此页面');

    const el = host();
    expect(el).not.toBeNull();
    // shadowRoot 为 null 正是 closed 的证据：open 时这里会返回 ShadowRoot。
    expect(el!.shadowRoot).toBeNull();
    expect(el!.style.pointerEvents).toBe('none');
    expect(getOverlayState()).toEqual({ mounted: true, label: '正在操作此页面' });
  });

  it('重复挂载不产生第二个宿主，只更新文案', () => {
    mountOverlay('第一句');
    mountOverlay('第二句');

    expect(document.querySelectorAll(`#${OVERLAY_HOST_ID}`)).toHaveLength(1);
    expect(getOverlayState().label).toBe('第二句');
  });

  it('挂在 documentElement 上而不是 body 上', () => {
    mountOverlay('x');
    expect(host()!.parentElement).toBe(document.documentElement);
  });
});

describe('updateOverlayLabel', () => {
  it('未挂载时是空操作，不抛错也不凭空创建宿主', () => {
    expect(() => updateOverlayLabel('无宿主')).not.toThrow();
    expect(host()).toBeNull();
  });
});

describe('unmountOverlay', () => {
  it('移除宿主并复位状态', () => {
    mountOverlay('x');
    unmountOverlay();

    expect(host()).toBeNull();
    expect(getOverlayState()).toEqual({ mounted: false, label: '' });
  });

  it('重复调用是安全的', () => {
    mountOverlay('x');
    unmountOverlay();
    expect(() => unmountOverlay()).not.toThrow();
  });
});

describe('看门狗', () => {
  it('超时后自动撤下遮罩', () => {
    mountOverlay('x');
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS);
    expect(host()).toBeNull();
  });

  it('超时前一刻仍在', () => {
    mountOverlay('x');
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    expect(host()).not.toBeNull();
  });

  it('续期把倒计时推回完整时长', () => {
    mountOverlay('x');
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    renewOverlayWatchdog();
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    expect(host()).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(host()).toBeNull();
  });

  it('更新文案也算一次续期', () => {
    mountOverlay('x');
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    updateOverlayLabel('y');
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    expect(host()).not.toBeNull();
  });

  it('未挂载时续期不会凭空起一个计时器', () => {
    renewOverlayWatchdog();
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS * 2);
    expect(host()).toBeNull();
  });
});
