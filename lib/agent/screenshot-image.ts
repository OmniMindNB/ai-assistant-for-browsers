// 截图瘦身的纯逻辑。canvas 调用留在 background.ts——这里只有尺寸计算与编码，
// 这样边界情况（极端长图、大数据编码）可以脱离浏览器环境测试。

/** Anthropic 计价按像素数走；1280×800 约 1365 token，是画质与成本的平衡点。 */
export const SCREENSHOT_MAX_EDGE = 1280;
export const SCREENSHOT_JPEG_QUALITY = 0.7;
/** 编码后的字节硬上限；超过时降质重试一次。 */
export const SCREENSHOT_MAX_BYTES = 1_500_000;
export const SCREENSHOT_FALLBACK_QUALITY = 0.5;

export interface ScreenshotResizePlan {
  width: number;
  height: number;
  resized: boolean;
}

export function planScreenshotResize(width: number, height: number, maxEdge: number): ScreenshotResizePlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width, height, resized: false };
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, resized: false };

  const scale = maxEdge / longest;
  return {
    // 极端长宽比下短边会被算成 0，canvas 拿到 0 会直接报错，兜到 1。
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/**
 * service worker 里没有 FileReader，只能手工编码。一次性
 * String.fromCharCode(...bytes) 在几十万字节上会爆栈，必须分块。
 */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return binary ? btoa(binary) : '';
}
