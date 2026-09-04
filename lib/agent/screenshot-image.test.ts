import { describe, expect, it } from 'vitest';
import { SCREENSHOT_MAX_EDGE, encodeBase64, planScreenshotResize } from './screenshot-image';

describe('planScreenshotResize', () => {
  it('已经小于上限时不放大', () => {
    expect(planScreenshotResize(800, 600, SCREENSHOT_MAX_EDGE)).toEqual({
      width: 800, height: 600, resized: false,
    });
  });

  it('宽边超限时按比例缩小', () => {
    const plan = planScreenshotResize(2560, 1440, 1280);
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(720);
    expect(plan.resized).toBe(true);
  });

  it('高边超限时按比例缩小', () => {
    const plan = planScreenshotResize(800, 3200, 1280);
    expect(plan.height).toBe(1280);
    expect(plan.width).toBe(320);
  });

  // 极端长图（无限滚动页的整页截图）缩放后短边不能塌成 0，否则 canvas 报错。
  it('极端长宽比下短边至少为 1', () => {
    const plan = planScreenshotResize(20000, 10, 1280);
    expect(plan.width).toBe(1280);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });

  it('正方形按同一比例缩', () => {
    expect(planScreenshotResize(2000, 2000, 1280)).toEqual({ width: 1280, height: 1280, resized: true });
  });

  it('非法尺寸回退为不缩放', () => {
    expect(planScreenshotResize(0, 0, 1280).resized).toBe(false);
    expect(planScreenshotResize(Number.NaN, 100, 1280).resized).toBe(false);
  });
});

describe('encodeBase64', () => {
  it('与 btoa 对短数据结果一致', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(encodeBase64(bytes)).toBe(btoa('hello world'));
  });

  it('空数据返回空串', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('');
  });

  // service worker 里没有 FileReader，只能手工分块编码；一次性展开成参数会爆栈。
  it('大数据不爆栈且可解码还原', () => {
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const encoded = encodeBase64(bytes);
    const decoded = atob(encoded);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(12_345)).toBe(12_345 % 256);
  });
});
