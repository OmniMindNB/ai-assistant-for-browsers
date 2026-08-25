# 执行期遮罩与模拟光标 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写操作获批后，在被操作的页面上显示一层纯视觉、不阻断的遮罩与模拟光标，让用户看得见 agent 正在动这一页、以及下一次点击将落在哪里。

**Architecture:** 遮罩由常驻的 content script 持有（写工具是一次性 MAIN world 注入，持不住跨调用状态），全部 DOM 逻辑抽在 `lib/agent/agent-overlay.ts` 里以便测试。光标坐标由注入函数自己算完直接派发 `runi:cursor-move` CustomEvent，content script 在 ISOLATED world 监听——光标停的位置与事件派发的位置因此必然是同一个值。content script 侧 15s 看门狗兜底，保证侧边栏关闭或 SW 驱逐时遮罩不会永久残留。

**Tech Stack:** WXT / Manifest V3、TypeScript、Vitest（`dom` project 走 jsdom）、Web Animations API。

**Spec:** `docs/superpowers/specs/2026-08-25-execution-overlay-design.md`

## Global Constraints

- 遮罩全程 `pointer-events: none`，任何情况下都不得阻断用户输入。
- 宿主内部必须是 **closed** shadow root。
- 样式逐属性赋值，动画一律走 `element.animate()`；**不得**使用 `<style>` 标签或 `@keyframes`（严格 CSP 页面会挡）。所有 `animate()` 调用前做 `typeof el.animate === 'function'` 能力检测，jsdom 下静默跳过。
- 状态条文案由侧边栏本地化后随消息下发；content script 内**不得** import `lib/i18n` 字典（见 `entrypoints/content.ts:88-91`）。
- 主色 `#4f46e5`；现有高亮框的 `#3b82f6` 统一改为 `#4f46e5`。
- 光标缓动时长 **250ms**，注入函数 `await` 时长同为 **250ms**，两处各自内联、必须同步。
- 看门狗超时 **15000ms**。
- 遮罩只在写操作获批后出现，只读回合不出现。
- 代码注释与提交信息用中文。

## 与 spec 的一处偏差（已确认）

spec §5.2 写的是「新页面的 content script 初始化时自查 session 标记并重建遮罩」。实现上不可行：MV3 的 `browser.storage.session` 默认只对扩展内可信上下文开放，content script 读不到（需要显式 `setAccessLevel`，等于把会话态暴露给每个页面的隔离世界，不划算）。

改为**由 background 在 `tabs.onUpdated` 的 `status === 'complete'` 时查标记并重新下发** `SET_AGENT_OVERLAY`。结果等价，且不需要放宽存储访问级别。见 Task 5。

---

### Task 1: 遮罩宿主、状态条与看门狗

**Files:**
- Create: `lib/agent/agent-overlay.ts`
- Test: `lib/agent/agent-overlay.dom.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `OVERLAY_HOST_ID: string`（值 `'runi-agent-overlay'`）
  - `OVERLAY_WATCHDOG_MS: number`（值 `15000`）
  - `mountOverlay(label: string): void` — 幂等，重复调用只更新文案
  - `updateOverlayLabel(label: string): void`
  - `unmountOverlay(): void`
  - `renewOverlayWatchdog(): void`
  - `getOverlayState(): { mounted: boolean; label: string }`

**测试说明：** shadow root 是 closed，测试拿不到内部节点，所以断言分两路——「确实是 closed」用 `host.shadowRoot === null` 验证，「文案是什么」用 `getOverlayState().label` 验证。状态条文字实际渲染进 DOM 的效果由手动验证清单覆盖，这是 closed shadow root 的必然代价，不是遗漏。

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/agent-overlay.dom.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project dom lib/agent/agent-overlay.dom.test.ts`
Expected: FAIL，报 `Failed to resolve import "./agent-overlay"`。

- [ ] **Step 3: 写实现**

创建 `lib/agent/agent-overlay.ts`：

```ts
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

const ACCENT = '#4f46e5';

interface OverlayRefs {
  host: HTMLElement;
  shadow: ShadowRoot;
  label: HTMLElement;
}

let refs: OverlayRefs | null = null;
let currentLabel = '';
let watchdog: ReturnType<typeof setTimeout> | undefined;

export function getOverlayState(): { mounted: boolean; label: string } {
  return { mounted: refs !== null, label: currentLabel };
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

  return { host, shadow, label };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project dom lib/agent/agent-overlay.dom.test.ts`
Expected: PASS，14 条全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/agent-overlay.ts lib/agent/agent-overlay.dom.test.ts
git commit -m "$(cat <<'EOF'
feat: 加执行期遮罩的宿主、状态条与看门狗

遮罩本体不压暗页面，只在视口四边做内嵌光晕，页面内容完全不遮挡。
全程 pointer-events:none：侧边栏形态下用户随时接管是正常预期。

看门狗是这里唯一的强健性要求。侧边栏被关掉、或 MV3 service worker 被驱逐时，
没有任何人再发 hide，遮罩就会永久挂在用户页面上。所以每次收到活动信号把倒计时
推回 15s，上游一断心跳最多 15s 后页面自动干净——「撤下」因此从必须送达的消息
降级成兜底即可的消息。

动画走 element.animate() 而不是 @keyframes：严格 CSP 的页面会挡 <style> 标签，
而银行、政务这类最需要代填表单的站点恰恰 CSP 最严。jsdom 没有该 API，做能力
检测静默降级。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 模拟光标

**Files:**
- Modify: `lib/agent/agent-overlay.ts`
- Test: `lib/agent/agent-overlay.dom.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `mountOverlay` / `unmountOverlay` / `renewOverlayWatchdog` 与模块内 `refs`
- Produces:
  - `CURSOR_MOVE_MS: number`（值 `250`）
  - `moveOverlayCursor(x: number, y: number): void` — 未挂载时空操作
  - `clampCursorPosition(x: number, y: number, viewport: { width: number; height: number }): { x: number; y: number }`
  - `getOverlayState()` 返回值扩展为 `{ mounted: boolean; label: string; cursor: { x: number; y: number } | null }`

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/agent-overlay.dom.test.ts` 的 import 里加上 `CURSOR_MOVE_MS, clampCursorPosition, moveOverlayCursor`，并追加：

```ts
describe('clampCursorPosition', () => {
  const viewport = { width: 1000, height: 800 };

  it('视口内的坐标原样返回', () => {
    expect(clampCursorPosition(300, 400, viewport)).toEqual({ x: 300, y: 400 });
  });

  it('钳制超出右下边界的坐标', () => {
    expect(clampCursorPosition(9999, 9999, viewport)).toEqual({ x: 1000, y: 800 });
  });

  it('钳制负坐标到原点', () => {
    expect(clampCursorPosition(-50, -10, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('视口尺寸为 0 时不产生 NaN', () => {
    expect(clampCursorPosition(100, 100, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('moveOverlayCursor', () => {
  it('未挂载时是空操作', () => {
    expect(() => moveOverlayCursor(10, 20)).not.toThrow();
    expect(getOverlayState().cursor).toBeNull();
  });

  it('记录钳制后的坐标', () => {
    mountOverlay('x');
    moveOverlayCursor(120, 240);
    expect(getOverlayState().cursor).toEqual({ x: 120, y: 240 });
  });

  it('撤下遮罩后光标坐标复位', () => {
    mountOverlay('x');
    moveOverlayCursor(120, 240);
    unmountOverlay();
    expect(getOverlayState().cursor).toBeNull();
  });

  it('移动光标也算一次看门狗续期', () => {
    mountOverlay('x');
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    moveOverlayCursor(10, 10);
    vi.advanceTimersByTime(OVERLAY_WATCHDOG_MS - 1);
    expect(document.getElementById(OVERLAY_HOST_ID)).not.toBeNull();
  });
});
```

同时把 Task 1 里两处 `expect(getOverlayState()).toEqual({ mounted: ..., label: ... })` 改为带 `cursor` 字段：

```ts
expect(getOverlayState()).toEqual({ mounted: true, label: '正在操作此页面', cursor: null });
// 以及
expect(getOverlayState()).toEqual({ mounted: false, label: '', cursor: null });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project dom lib/agent/agent-overlay.dom.test.ts`
Expected: FAIL，报 `clampCursorPosition is not a function` 及 `cursor` 字段不匹配。

- [ ] **Step 3: 写实现**

在 `lib/agent/agent-overlay.ts` 中：`OverlayRefs` 加 `cursor: HTMLElement`，模块级加 `let cursorPos: { x: number; y: number } | null = null;`，并加入以下内容。

顶部常量区补：

```ts
/**
 * 光标缓动时长。
 * ⚠️ 同一个数字在 lib/agent/form-dom.ts 的注入函数里还有一份（那里 await 这么久再派发点击）。
 * 注入函数被 executeScript 序列化，引用不到这里的常量，只能各自内联——改这里必须同步改那边。
 * 若注入函数等得比动画短，就会在光标还没停稳时派发点击，正是本功能要消除的那种错位。
 */
export const CURSOR_MOVE_MS = 250;
```

`getOverlayState` 改为：

```ts
export function getOverlayState(): {
  mounted: boolean;
  label: string;
  cursor: { x: number; y: number } | null;
} {
  return { mounted: refs !== null, label: currentLabel, cursor: cursorPos };
}
```

`unmountOverlay` 里补一行 `cursorPos = null;`。

新增：

```ts
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
```

`createOverlay()` 里在 `label` 之后、`appendChild(host)` 之前插入光标：

```ts
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
```

并把 `return { host, shadow, label };` 改为 `return { host, shadow, label, cursor };`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project dom lib/agent/agent-overlay.dom.test.ts`
Expected: PASS，全部通过。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/agent-overlay.ts lib/agent/agent-overlay.dom.test.ts
git commit -m "$(cat <<'EOF'
feat: 给执行期遮罩加模拟光标

24px 内联 SVG 箭头，品牌色填充 + 白描边，深浅背景上都可辨，因此不做 page-agent
那套页面背景色检测。遮罩起来时从视口右下角滑入，暗示「来自侧边栏那一侧」。

坐标按视口钳制：目标贴边时不做钳制光标会画到视口外，等于没有。

CURSOR_MOVE_MS 这个 250 在 form-dom.ts 的注入函数里还要再写一份（注入函数被
序列化、引用不到模块常量），两处都留了必须同步的注释。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 消息协议与按标签页的遮罩状态

**Files:**
- Modify: `lib/messaging.ts:4-28`（`MessageType` 联合）、末尾追加接口
- Create: `lib/agent/tab-overlay-state.ts`
- Test: `lib/agent/tab-overlay-state.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `MessageType` 新增成员 `'SET_AGENT_OVERLAY'`
  - `interface SetAgentOverlayPayload { active: boolean; label?: string }`
  - `interface SetAgentOverlayResult { active: boolean }`
  - `getOverlayForTab(tabId: number): Promise<{ label: string } | undefined>`
  - `setOverlayForTab(tabId: number, label: string): Promise<void>`
  - `clearOverlayForTab(tabId: number): Promise<void>`

- [ ] **Step 1: 写失败的测试**

创建 `lib/agent/tab-overlay-state.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOverlayForTab, getOverlayForTab, setOverlayForTab } from './tab-overlay-state';

const store = new Map<string, unknown>();
const get = vi.fn(async (key: string) => {
  const value = store.get(key);
  return value === undefined ? {} : { [key]: value };
});
const set = vi.fn(async (items: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(items)) store.set(key, value);
});
const remove = vi.fn(async (key: string) => {
  store.delete(key);
});

(globalThis as any).browser = { storage: { session: { get, set, remove } } };

beforeEach(() => {
  store.clear();
  get.mockClear();
  set.mockClear();
  remove.mockClear();
});

describe('tab-overlay-state', () => {
  it('没写过时返回 undefined', async () => {
    await expect(getOverlayForTab(7)).resolves.toBeUndefined();
  });

  it('写入后能按同一个 tabId 读回', async () => {
    await setOverlayForTab(7, '正在点击「登录」');
    await expect(getOverlayForTab(7)).resolves.toEqual({ label: '正在点击「登录」' });
  });

  it('按标签页隔离', async () => {
    await setOverlayForTab(7, 'A');
    await expect(getOverlayForTab(8)).resolves.toBeUndefined();
  });

  it('清除后读不到', async () => {
    await setOverlayForTab(7, 'A');
    await clearOverlayForTab(7);
    await expect(getOverlayForTab(7)).resolves.toBeUndefined();
  });

  it('写入失败时静默降级，不抛给调用方', async () => {
    set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(setOverlayForTab(7, 'A')).resolves.toBeUndefined();
  });

  it('清除失败时同样静默降级', async () => {
    remove.mockRejectedValueOnce(new Error('boom'));
    await expect(clearOverlayForTab(7)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit lib/agent/tab-overlay-state.test.ts`
Expected: FAIL，报 `Failed to resolve import "./tab-overlay-state"`。

- [ ] **Step 3: 写实现**

创建 `lib/agent/tab-overlay-state.ts`：

```ts
// 记录每个标签页当前是否处在「执行期遮罩生效中」，以及状态条该显示哪句话。
// 用 browser.storage.session 而非模块级变量：MV3 service worker 会被回收，
// 模块级变量活不过这次回收。写法仿 lib/agent/tab-form-fields.ts。
//
// 注意：storage.session 默认只对扩展内可信上下文开放，content script 读不到。
// 因此跳转后的重建不是由 content script 自查，而是由 background 在 tabs.onUpdated
// 里查这张表并重新下发（ref: 2026-08-25-execution-overlay-design.md 的偏差说明）。

export interface TabOverlayState {
  label: string;
}

function storageKey(tabId: number): string {
  return `runi:tab-overlay:${tabId}`;
}

export async function getOverlayForTab(tabId: number): Promise<TabOverlayState | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as TabOverlayState | undefined;
}

/** 写入失败（如配额超限）时静默降级：遮罩是纯视觉功能，不值得让一次写入失败中断整个回合。 */
export async function setOverlayForTab(tabId: number, label: string): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: { label } satisfies TabOverlayState });
  } catch {
    // 忽略
  }
}

export async function clearOverlayForTab(tabId: number): Promise<void> {
  try {
    await browser.storage.session.remove(storageKey(tabId));
  } catch {
    // 忽略
  }
}
```

在 `lib/messaging.ts` 的 `MessageType` 联合里，`| 'SET_STORAGE'` 之后插入一行：

```ts
  | 'SET_AGENT_OVERLAY'
```

并在文件末尾（`SetStorageResult` 之后）追加：

```ts
/**
 * 执行期遮罩的开关。label 必须由侧边栏本地化好再传下来——内容脚本跑在每个页面里，
 * 不能为几句文案把完整 i18n 字典打进产物（同 entrypoints/content.ts 顶部的说明）。
 */
export interface SetAgentOverlayPayload {
  active: boolean;
  label?: string;
}

export interface SetAgentOverlayResult {
  active: boolean;
}
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm vitest run --project unit lib/agent/tab-overlay-state.test.ts && pnpm compile`
Expected: 测试 PASS（6 条），`pnpm compile` 无输出（无类型错误）。

- [ ] **Step 5: 提交**

```bash
git add lib/messaging.ts lib/agent/tab-overlay-state.ts lib/agent/tab-overlay-state.test.ts
git commit -m "$(cat <<'EOF'
feat: 加 SET_AGENT_OVERLAY 协议与按标签页的遮罩状态表

状态表存 storage.session 而非模块级变量，理由同 tab-form-fields：MV3 的 service
worker 会被回收，模块级变量活不过这次回收。写入失败静默降级——遮罩是纯视觉功能，
不值得让一次配额失败中断整个回合。

payload 里的 label 由侧边栏本地化好再下发，内容脚本不 import i18n 字典。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: content script 接线

**Files:**
- Modify: `entrypoints/content.ts:22-33`（消息监听 switch）、`:36`（`main()` 末尾）

**Interfaces:**
- Consumes: Task 1/2 的 `mountOverlay` / `unmountOverlay` / `moveOverlayCursor`；Task 3 的 `SetAgentOverlayPayload` / `SetAgentOverlayResult`
- Produces: 页面事件契约 `runi:cursor-move`，`detail: { x: number; y: number }`（Task 7 的注入函数派发这个事件）

**测试说明：** `entrypoints/**/*.test.ts` 没有对应的 vitest project（见 CLAUDE.md），本任务是纯接线，逻辑已在 Task 1/2 测过。验收靠 `pnpm compile` 与手动清单。

- [ ] **Step 1: 加消息与事件接线**

在 `entrypoints/content.ts` 顶部 import 区追加：

```ts
import { mountOverlay, moveOverlayCursor, unmountOverlay } from '@/lib/agent/agent-overlay';
import type { SetAgentOverlayPayload, SetAgentOverlayResult } from '@/lib/messaging';
```

在消息监听的 `if (message.type === 'GET_SELECTION') {...}` 之后插入：

```ts
        if (message.type === 'SET_AGENT_OVERLAY') {
          const payload = message.payload as SetAgentOverlayPayload;
          respond(message.id, sendResponse, (): SetAgentOverlayResult => {
            if (payload.active) {
              mountOverlay(payload.label ?? '');
            } else {
              unmountOverlay();
            }
            return { active: payload.active };
          });
          return true;
        }
```

在 `main()` 里 `initSelectionAskBubble();` 之后追加：

```ts
    initAgentCursorBridge();
```

并在文件末尾追加：

```ts
// ---- 模拟光标的跨 world 桥 ----
// 点击是在 MAIN world 的注入函数里派发的，光标却由这个 ISOLATED world 的内容脚本持有。
// 让注入函数自己算完 rect 后直接派发事件、再 await 250ms，好处是光标停的位置与事件
// 派发的位置必然是同一个值；若改成 background 两段式（先探针取 rect、再下发移动、
// 再注入点击），目标要解析两次，两次之间元素可能已经变了——光标指着 A、实际点了 B，
// 这个功能就从建立信任变成破坏信任（ref: 2026-08-25-execution-overlay-design.md §3.4）。
function initAgentCursorBridge(): void {
  window.addEventListener('runi:cursor-move', (event) => {
    const detail = (event as CustomEvent<{ x?: unknown; y?: unknown }>).detail;
    const x = Number(detail?.x);
    const y = Number(detail?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    moveOverlayCursor(x, y);
  });
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm compile`
Expected: 无输出。

- [ ] **Step 3: 构建确认内容脚本产物没有意外膨胀**

Run: `pnpm build`
Expected: 构建成功。检查 `.output/chrome-mv3/content-scripts/content.js` 体积相比改动前增加在 3KB 量级以内——若明显更大，说明误把 i18n 字典或 React 运行时拖进来了，需回头查 import。

- [ ] **Step 4: 提交**

```bash
git add entrypoints/content.ts
git commit -m "$(cat <<'EOF'
feat: content script 接上遮罩开关与光标事件桥

光标事件让 MAIN world 的注入函数自己算完 rect 直接派发，而不是走 background
两段式（探针取 rect → 下发移动 → 注入点击）。后者目标要解析两次，两次之间元素
可能已经变了，光标指着 A、实际点了 B——这个功能就从建立信任变成破坏信任。

detail 做了有限数字校验：跨 world 传过来的值不可信，NaN 会让 transform 整个失效。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: background 转发、跳转重建与截图复原

**Files:**
- Modify: `entrypoints/background.ts:82`（`MessageType` 分派处附近的 case 列表）、`:236`（`CAPTURE_SCREENSHOT` case）、末尾追加函数与 `tabs.onUpdated` 监听

**Interfaces:**
- Consumes: Task 3 的 `getOverlayForTab` / `setOverlayForTab` / `clearOverlayForTab`、`SetAgentOverlayPayload`；既有的 `sendToContentScript`（`lib/agent/content-script-messaging.ts`）
- Produces: `SET_AGENT_OVERLAY` 的 background 处理器；截图前后自动撤/复原遮罩的行为

**测试说明：** `entrypoints/background.ts` 同样没有 vitest project 覆盖，纯 I/O 编排；可测逻辑已在 Task 3 覆盖。验收靠 `pnpm compile` 与手动清单。

- [ ] **Step 1: 加消息分派**

在 `handleMessage` 的 switch 里，`case 'SET_STORAGE':` 之后插入：

```ts
    case 'SET_AGENT_OVERLAY':
      return setAgentOverlay(message.payload as SetAgentOverlayPayload, requireTabId(message));
```

并在 background.ts 的 import 区补：

```ts
import { clearOverlayForTab, getOverlayForTab, setOverlayForTab } from '@/lib/agent/tab-overlay-state';
```

以及在 `lib/messaging` 的 type import 里补 `SetAgentOverlayPayload`、`SetAgentOverlayResult`。

- [ ] **Step 2: 写处理器与跳转重建**

在 `entrypoints/background.ts` 末尾追加：

```ts
async function setAgentOverlay(
  payload: SetAgentOverlayPayload,
  tabId: number,
): Promise<MessageResponse<SetAgentOverlayResult>> {
  if (payload.active) {
    await setOverlayForTab(tabId, payload.label ?? '');
  } else {
    await clearOverlayForTab(tabId);
  }
  await pushOverlayToTab(tabId, payload);
  return { id: '', ok: true, data: { active: payload.active } };
}

/**
 * 下发失败一律吞掉：页面可能是 chrome:// 这类注入不进去的地址，也可能正在卸载。
 * 遮罩是纯视觉功能，绝不能让它的失败把一次真正的写操作变成失败。
 */
async function pushOverlayToTab(tabId: number, payload: SetAgentOverlayPayload): Promise<void> {
  try {
    await sendToContentScript(tabId, {
      id: newMessageId(),
      type: 'SET_AGENT_OVERLAY',
      payload,
    });
  } catch {
    // 忽略
  }
}

// 跳转后重建遮罩。
// 注意这里由 background 而非 content script 自查：storage.session 默认只对扩展内可信
// 上下文开放，content script 读不到，放宽访问级别等于把会话态暴露给每个页面的隔离世界。
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const state = await getOverlayForTab(tabId);
    if (!state) return;
    await pushOverlayToTab(tabId, { active: true, label: state.label });
  })();
});

// 标签页关掉后清掉它的遮罩状态，避免 tabId 被复用时错误重建。
browser.tabs.onRemoved.addListener((tabId) => {
  void clearOverlayForTab(tabId);
});
```

`newMessageId` 已由 `lib/messaging.ts:405` 导出，`sendToContentScript` 来自 `lib/agent/content-script-messaging.ts`；两者都要确认在 background.ts 的 import 里。

- [ ] **Step 3: 截图前后撤/复原遮罩**

把 `CAPTURE_SCREENSHOT` 的 case 改为调用一个包装函数，在 background.ts 末尾追加：

```ts
/**
 * 截图前先撤遮罩、拍完再恢复。
 * browser_screenshot 是只读工具，但遮罩起来之后模型照样能截图，会把光晕和光标一起
 * 拍进去当成页面内容——模型会据此推断页面上有个它没见过的紫色边框和箭头。
 */
async function captureScreenshotWithoutOverlay(
  payload: CaptureScreenshotPayload,
  tabId: number,
): Promise<MessageResponse<CaptureScreenshotResult>> {
  const state = await getOverlayForTab(tabId);
  if (!state) return captureScreenshot(payload, tabId);

  await pushOverlayToTab(tabId, { active: false });
  try {
    return await captureScreenshot(payload, tabId);
  } finally {
    await pushOverlayToTab(tabId, { active: true, label: state.label });
  }
}
```

并把 case 改为：

```ts
    case 'CAPTURE_SCREENSHOT':
      return captureScreenshotWithoutOverlay(message.payload as CaptureScreenshotPayload, requireTabId(message));
```

- [ ] **Step 4: 类型检查与全量测试**

Run: `pnpm compile && pnpm test`
Expected: `pnpm compile` 无输出；`pnpm test` 全绿（本任务不应影响任何既有测试）。

- [ ] **Step 5: 提交**

```bash
git add entrypoints/background.ts
git commit -m "$(cat <<'EOF'
feat: background 转发遮罩消息、跳转后重建、截图时撤下

跳转重建由 background 查 session 表后重新下发，而不是 content script 自查：
storage.session 默认只对扩展内可信上下文开放，content script 读不到，放宽访问
级别等于把会话态暴露给每个页面的隔离世界，不划算。这一条与 spec §5.2 的描述
不同，结果等价。

截图前先撤遮罩：browser_screenshot 是只读工具，但遮罩起来后模型照样能截图，
会把光晕和光标当成页面内容读进去。

所有下发失败一律吞掉——页面可能是 chrome:// 这类注入不进去的地址，遮罩是纯视觉
功能，不能让它的失败把一次真正的写操作变成失败。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 回合生命周期接线

**Files:**
- Modify: `lib/agent/agent.ts:147-149`（写获批处）
- Modify: `entrypoints/sidepanel/store.ts:1202-1212`（回合结束的 finally）
- Test: `lib/agent/agent.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `SetAgentOverlayPayload`、既有 `sendMessage`
- Produces: `BrowserAgentOptions` 新增可选字段 `onOverlay?: (payload: SetAgentOverlayPayload) => void`

**设计说明：** 不在 `agent.ts` 里直接 `sendMessage`，而是回调出去。`agent.ts` 已有 `onConfirm` / `onAskUser` 两个同形状的回调，跟着走一致；也让这条路径在 `agent.test.ts` 里可断言，无需 mock 消息层。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/agent.test.ts` 追加：

```ts
describe('执行期遮罩', () => {
  const overlayOptions = (onOverlay: () => void, approve: boolean) =>
    createBrowserAgentOptions({
      provider: baseProvider,
      tabId: 1,
      steer: () => {},
      onConfirm: async () => approve,
      onOverlay,
    });

  it('写工具获批时通知一次遮罩打开', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#a', index: 0 }), undefined);

    expect(onOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, label: expect.any(String) }),
    );
  });

  it('只读工具不触发遮罩', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, true);

    await options.beforeToolCall!(beforeContext('browser_read_page', {}), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });

  it('用户拒绝确认时不打开遮罩', async () => {
    const onOverlay = vi.fn();
    const options = overlayOptions(onOverlay, false);

    await options.beforeToolCall!(beforeContext('browser_click', { selector: '#a', index: 0 }), undefined);

    expect(onOverlay).not.toHaveBeenCalled();
  });
});
```

`baseProvider`（`lib/agent/agent.test.ts:14`）与 `beforeContext(name, args)`（`:23`）都是该文件已有的夹具，直接用，不要另起。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit lib/agent/agent.test.ts`
Expected: FAIL，`onOverlay` 未被调用（新增的三条里前一条失败，后两条会误通过——这正常，它们防的是回归）。

- [ ] **Step 3: 写实现**

在 `lib/agent/agent.ts` 的 `BrowserAgentOptions` 接口里追加：

```ts
  /**
   * 写操作获批时通知外层打开执行期遮罩。回调而非直接 sendMessage：
   * 与 onConfirm / onAskUser 保持同一形状，也让这条路径在单测里可断言。
   */
  onOverlay?: (payload: SetAgentOverlayPayload) => void;
```

并在 import 区补 `type SetAgentOverlayPayload`（来自 `@/lib/messaging`）与 `describeToolActivity`（来自 `./activity-description`）。注意它的签名是三参数：`describeToolActivity(toolName: string, args: unknown, status: ActivityStatus)`（`lib/agent/activity-description.ts:27`），这里传 `'running'`。

把 `agent.ts:147-149` 的写获批分支改为：

```ts
      const alwaysApproved = confirmGateState.alwaysApprovedCallIds.has(context.toolCall.id);
      if (isConfirmTool && (confirmGateState.decision === 'approved' || alwaysApproved)) {
        policy.approveWrite();
        options.onOverlay?.({
          active: true,
          label: describeToolActivity(context.toolCall.name, context.toolCall.arguments, 'running'),
        });
      }
```

在 `entrypoints/sidepanel/store.ts:1082` 的 `createBrowserAgent({...})` 里，`onAskUser,` 之后补上：

```ts
    onOverlay: (payload) => {
      void sendMessage('SET_AGENT_OVERLAY', payload, tabId).catch(() => undefined);
    },
```

（`tabId` 就是同一个调用里 `:1067` 已经传给 agent 的那个变量，无需另取。）

并在 `store.ts:1202` 的 `finally` 块里，`set({ busy: false, activitySteps: [] });` 之后补一行（`tabId` 在同一函数作用域内可见）：

```ts
      // 回合结束就撤遮罩。正常完成、模型出错、用户中止三条路径都汇到这个 finally
      // （见下方注释），所以这一处就够。送不到也不要紧——content script 侧有 15s 看门狗兜底。
      void sendMessage('SET_AGENT_OVERLAY', { active: false }, tabId).catch(() => undefined);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project unit lib/agent/agent.test.ts && pnpm compile`
Expected: 测试 PASS；`pnpm compile` 无输出。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/agent.ts lib/agent/agent.test.ts entrypoints/sidepanel/store.ts
git commit -m "$(cat <<'EOF'
feat: 把执行期遮罩接到回合生命周期上

起点是 policy.approveWrite()——用户已在确认卡上点了允许，对「页面要被改」已有
预期，遮罩此时出现正好接上；只读回合完全不出现，用户只想总结本页时不该被打扰。

终点放在 store.ts 回合结束的 finally 里，正常完成 / 模型出错 / 用户中止三条路径
都汇到那儿。送不到也不要紧，content script 侧有 15s 看门狗兜底。

agent.ts 用回调而不是直接 sendMessage：与 onConfirm / onAskUser 同形状，也让这
条路径在单测里可断言，不用 mock 消息层。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 注入函数派发光标事件

**Files:**
- Modify: `lib/agent/form-dom.ts:480-491`（`applyFormFill` 的 submit 分支）、`:586-621`（`clickElementInPage`）、`:731-741`（`selectOptionInPage`）
- Modify: `entrypoints/background.ts:687-700`（`executeInTab` 的 func 类型）
- Test: `lib/agent/form-dom.dom.test.ts`、`lib/agent/legacy-write-tools.dom.test.ts`

**Interfaces:**
- Consumes: Task 4 定义的页面事件契约 `runi:cursor-move`，`detail: { x, y }`
- Produces: 三个注入函数由同步改为 `async`——
  - `clickElementInPage(input): Promise<LegacyWriteStatus>`
  - `selectOptionInPage(input): Promise<LegacyWriteStatus>`
  - `applyFormFill(input: ApplyFillInput): Promise<ApplyFillOutput>`

  返回值本身不变，只是包进 Promise。

**为什么 select 也在内：** spec §4.4 的表格里 `browser_select` 是走光标的。`selectOptionInPage`（`form-dom.ts:711`）有独立的第三处高亮框（`:731-741`），配色同样要统一，也同样要在写入前把光标送到位。漏掉它会造成「点击有光标、选下拉没有」的不一致。

**注意：** 这两个函数当前是同步的，加 250ms 等待必须让它们变成 `async`。`browser.scripting.executeScript` 会等待注入函数返回的 Promise 并把解析值放进 `frame.result`，运行时没问题；但 `executeInTab` 的类型签名要放宽，否则 `TResult` 会被推成 `Promise<X>` 而 `frame.result as TResult` 这个断言就说了谎。

- [ ] **Step 1: 写失败的测试**

在 `lib/agent/legacy-write-tools.dom.test.ts` 追加：

```ts
describe('clickElementInPage 的光标事件', () => {
  it('派发 runi:cursor-move，坐标为目标中心', async () => {
    document.body.innerHTML = '<button id="b">点我</button>';
    const button = document.getElementById('b')!;
    button.getBoundingClientRect = () =>
      ({ left: 100, top: 40, width: 60, height: 20, right: 160, bottom: 60, x: 100, y: 40, toJSON: () => ({}) }) as DOMRect;
    document.elementFromPoint = () => button;

    const seen: { x: number; y: number }[] = [];
    window.addEventListener('runi:cursor-move', (e) => {
      seen.push((e as CustomEvent<{ x: number; y: number }>).detail);
    });

    await clickElementInPage({ selector: '#b', index: 0 });

    expect(seen).toEqual([{ x: 130, y: 50 }]);
  });

  it('目标不存在时不派发事件', async () => {
    document.body.innerHTML = '';
    const seen: unknown[] = [];
    window.addEventListener('runi:cursor-move', () => seen.push(1));

    const result = await clickElementInPage({ selector: '#missing', index: 0 });

    expect(result.status).toBe('not_found');
    expect(seen).toHaveLength(0);
  });

  it('光标事件在点击事件之前派发', async () => {
    document.body.innerHTML = '<button id="b">点我</button>';
    const button = document.getElementById('b')!;
    button.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.elementFromPoint = () => button;

    const order: string[] = [];
    window.addEventListener('runi:cursor-move', () => order.push('cursor'));
    button.addEventListener('click', () => order.push('click'));

    await clickElementInPage({ selector: '#b', index: 0 });

    expect(order).toEqual(['cursor', 'click']);
  });
});
```

再追加一条覆盖 select：

```ts
describe('selectOptionInPage 的光标事件', () => {
  it('写入前派发 runi:cursor-move，坐标为 select 中心', async () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option><option value="b">B</option></select>';
    const select = document.getElementById('s')!;
    select.getBoundingClientRect = () =>
      ({ left: 20, top: 60, width: 80, height: 24, right: 100, bottom: 84, x: 20, y: 60, toJSON: () => ({}) }) as DOMRect;

    const seen: { x: number; y: number }[] = [];
    window.addEventListener('runi:cursor-move', (e) => {
      seen.push((e as CustomEvent<{ x: number; y: number }>).detail);
    });

    const result = await selectOptionInPage({ selector: '#s', index: 0, value: 'b' });

    expect(result.status).toBe('ok');
    expect(seen).toEqual([{ x: 60, y: 72 }]);
  });

  it('选项不存在时不派发事件', async () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>';
    const seen: unknown[] = [];
    window.addEventListener('runi:cursor-move', () => seen.push(1));

    const result = await selectOptionInPage({ selector: '#s', index: 0, value: '不存在' });

    expect(result.status).toBe('invalid_value');
    expect(seen).toHaveLength(0);
  });
});
```

改完实现后，这两个测试文件里所有既有的 `clickElementInPage(...)`、`selectOptionInPage(...)`、`applyFormFill(...)` 调用点都要加上 `await`，其 `it(...)` 回调相应改为 `async`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project dom`
Expected: FAIL，新增的三条里第一、三条失败（没有事件派发）。

- [ ] **Step 3: 写实现**

在 `lib/agent/form-dom.ts` 中，把 `clickElementInPage` 的签名改为：

```ts
export async function clickElementInPage(input: { selector: string; index: number }): Promise<LegacyWriteStatus> {
```

并把 `:610-621` 的高亮框段落替换为（`applyFormFill` 的 submit 分支 `:480-491` 做同样替换，变量名 `target` 换成 `button`）：

```ts
  // ⚠️ 与 applyFormFill 的 submit 分支重复：两处都是被 executeScript 序列化注入页面的独立函数，
  // 不能引用模块作用域的共享 helper，只能各自内联。
  const highlight = document.createElement('div');
  highlight.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
    'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
  document.body.appendChild(highlight);
  setTimeout(() => {
    highlight.style.opacity = '0';
    setTimeout(() => highlight.remove(), 300);
  }, 250);

  // 先让模拟光标滑到落点，停稳后再派发点击。
  // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致。本函数被
  // executeScript 序列化注入页面，引用不到那个常量，只能内联——改一处必须同步另一处。
  // 等得比动画短，就会在光标还没停稳时派发点击，正是这个功能要消除的那种错位。
  window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x: centerX, y: centerY } }));
  await new Promise((resolve) => setTimeout(resolve, 250));
```

`applyFormFill` 的签名同样改为 `export async function applyFormFill(input: ApplyFillInput): Promise<ApplyFillOutput>`（`form-dom.ts:278`，注意实际类型名是 `ApplyFillInput` / `ApplyFillOutput`）。

`selectOptionInPage` 改为 `export async function selectOptionInPage(input: { selector: string; index: number; value: string }): Promise<LegacyWriteStatus>`，并把 `:731-741` 的高亮框段落同样把 `#3b82f6` → `#4f46e5`、`rgba(59,130,246,0.35)` → `rgba(79,70,229,0.35)`，然后在 `select.value = option.value;` 之前插入：

```ts
  // 先让模拟光标滑到落点，停稳后再写入。
  // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致（同上，注入函数
  // 被序列化，引用不到那个常量，只能内联）。
  window.dispatchEvent(
    new CustomEvent('runi:cursor-move', {
      detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
```

在 `entrypoints/background.ts` 把 `executeInTab` 的 func 参数类型放宽：

```ts
async function executeInTab<TInput, TResult>(
  tabId: number,
  input: TInput,
  func: (input: TInput) => TResult | Promise<TResult>,
): Promise<TResult> {
```

（函数体不变。`executeScript` 会等待注入函数返回的 Promise，`frame.result` 拿到的是解析后的值，所以 `as TResult` 这时才成立。）

- [ ] **Step 4: 跑全量测试与类型检查**

Run: `pnpm test && pnpm compile`
Expected: 全绿，`pnpm compile` 无输出。若 `form-dom.dom.test.ts` / `legacy-write-tools.dom.test.ts` 里还有漏加 `await` 的调用点，这一步会以「收到 Promise 而非对象」的断言失败暴露出来，补上即可。

- [ ] **Step 5: 提交**

```bash
git add lib/agent/form-dom.ts lib/agent/form-dom.dom.test.ts lib/agent/legacy-write-tools.dom.test.ts entrypoints/background.ts
git commit -m "$(cat <<'EOF'
feat: 点击/选择前派发光标事件并等光标停稳

注入函数自己算完 rect 后直接派发 runi:cursor-move，再 await 250ms 才派发点击。
rect 只解析一次，光标停的位置与事件派发的位置必然是同一个值。

覆盖 clickElementInPage、selectOptionInPage 与 applyFormFill 的 submit 分支三处
（三处各有一份内联高亮框，注入函数不能共用 helper）。漏掉 select 会造成「点击有
光标、选下拉没有」的不一致。

为此这三个函数从同步改成 async，executeInTab 的 func 类型相应放宽成
TResult | Promise<TResult>——executeScript 本来就会等待注入函数返回的 Promise，
但原签名下 frame.result as TResult 这个断言是说了谎的。

高亮框配色从 #3b82f6 统一到遮罩的 #4f46e5。时序上正好吻合：光标滑到目标后停
250ms，高亮框就在这 250ms 内亮着，然后一起收。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## 手动验证清单

代码全部完成后，`pnpm build` 并从 `chrome://extensions` 加载 `.output/chrome-mv3`，逐条验证：

- [ ] **只读回合不出现遮罩** —— 在任意页面问「总结一下这页」，页面上不应出现任何光晕或光标。
- [ ] **写操作获批后出现遮罩** —— 让 agent 点击页面上某个按钮，在确认卡点允许后，视口四边出现紫色内嵌光晕并呼吸，顶部出现状态条。
- [ ] **光标先到位再点击** —— 光标从右下角滑入，停在目标中心，高亮框同时亮起，之后才发生点击。
- [ ] **不阻断输入** —— 遮罩显示期间，用户仍能正常点击、选中、滚动页面。
- [ ] **回合结束遮罩消失** —— agent 回答完毕后光晕与状态条立即撤下。
- [ ] **用户中止也撤下** —— 回合进行中点停止，遮罩立即撤下。
- [ ] **跳转后重建** —— 让 agent 执行一次 `browser_navigate`，新页面加载完成后遮罩重新出现。
- [ ] **看门狗兜底** —— 回合进行中直接关掉侧边栏，页面遮罩应在 15s 内自行消失。
- [ ] **截图不含遮罩** —— 遮罩显示期间让 agent 截图，返回的图里不应有紫色边框和箭头。
- [ ] **严格 CSP 页面** —— 在一个 `Content-Security-Policy` 含 `style-src 'self'` 的站点（如 GitHub）上重复上述前四条，动画仍在，DevTools console 无 CSP 报错。
- [ ] **不污染表单采集** —— 遮罩显示期间调用 `browser_get_form`，返回的字段列表里不应出现遮罩宿主，`unreachable.closedShadowRoots` 不应因遮罩而增加。
