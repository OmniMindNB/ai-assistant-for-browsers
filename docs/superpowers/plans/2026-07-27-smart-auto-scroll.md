# 流式输出智能跟随滚动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 流式回复过程中，用户向上滚动查看历史内容后不再被强制拉回底部；提供「回到底部」入口一键恢复跟随。

**Architecture:** 新增一个纯函数 `isNearBottom`（`lib/scroll.ts`）判断滚动容器是否处于底部附近；`entrypoints/sidepanel/App.tsx` 用一个 ref（`atBottomRef`）记录跟随状态、一个 `scroll` 监听器更新它、一个 state（`showJumpToBottom`）驱动悬浮按钮，并把原有的无条件自动滚动 effect 改为只在仍处于跟随状态时触发。

**Tech Stack:** React 18（函数组件 + hooks）、TypeScript、Vitest（仅覆盖 `lib/**`）、Tailwind CSS。

## Global Constraints

- 阈值常量：`BOTTOM_THRESHOLD_PX = 48`（判定「近似在底部」的像素容差）。
- `entrypoints/` 目录无测试基建（`vitest.config.ts` 的 `include` 仅为 `lib/**/*.test.ts`），App.tsx 内的改动只能靠 `pnpm compile` + 手动验证，不写组件测试。
- 不改变现有的消息渲染、虚拟滚动、Provider/主题等无关逻辑。
- 中文注释与现有代码风格保持一致（仅在必要处解释「为什么」）。

---

### Task 1: `isNearBottom` 纯函数

**Files:**
- Create: `lib/scroll.ts`
- Test: `lib/scroll.test.ts`

**Interfaces:**
- Produces: `BOTTOM_THRESHOLD_PX: number`、`isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, thresholdPx?: number): boolean` — Task 2 会从 `@/lib/scroll` 导入两者。

- [ ] **Step 1: 写失败的测试**

创建 `lib/scroll.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { BOTTOM_THRESHOLD_PX, isNearBottom } from './scroll';

describe('isNearBottom', () => {
  it('returns true when scrolled exactly to the bottom', () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 })).toBe(true);
  });

  it('returns true when the gap is within the threshold', () => {
    const gap = BOTTOM_THRESHOLD_PX - 1;
    expect(
      isNearBottom({ scrollTop: 600 - 200 - gap, scrollHeight: 600, clientHeight: 200 }),
    ).toBe(true);
  });

  it('returns false when the gap exceeds the threshold', () => {
    const gap = BOTTOM_THRESHOLD_PX + 1;
    expect(
      isNearBottom({ scrollTop: 600 - 200 - gap, scrollHeight: 600, clientHeight: 200 }),
    ).toBe(false);
  });

  it('returns true when content is shorter than the viewport (nothing to scroll)', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 200 }, 100)).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 200 }, 50)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run lib/scroll.test.ts`
Expected: FAIL — `Cannot find module './scroll'` (或等价的模块未找到错误)。

- [ ] **Step 3: 实现最小实现**

创建 `lib/scroll.ts`：

```ts
export const BOTTOM_THRESHOLD_PX = 48;

/** 滚动容器是否已（近似）处于底部，容忍亚像素/滚动吸附造成的误差 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx: number = BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run lib/scroll.test.ts`
Expected: PASS — 5 个测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add lib/scroll.ts lib/scroll.test.ts
git commit -m "feat: add isNearBottom helper for scroll-following logic"
```

---

### Task 2: `App.tsx` 智能跟随滚动接线

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx:81`（新增 refs/state）
- Modify: `entrypoints/sidepanel/App.tsx:99-101`（conversationId effect）
- Modify: `entrypoints/sidepanel/App.tsx:103-110`（`submitEdit`）
- Modify: `entrypoints/sidepanel/App.tsx:112-114`（自动滚动 effect）
- Modify: `entrypoints/sidepanel/App.tsx:116-121`（`onKeyDown` / 新增 `submitMessage`）
- Modify: `entrypoints/sidepanel/App.tsx:191`、`237-252`（`main` 包裹层、按钮、Composer 接线）

**Interfaces:**
- Consumes: `isNearBottom`、`BOTTOM_THRESHOLD_PX` from `@/lib/scroll`（Task 1）；`IconChevronDown` 已在 `entrypoints/sidepanel/icons.tsx` 存在并已被 `App.tsx` 导入（`App.tsx:18`）。
- Produces: 无对外接口——本任务的改动只在 `App.tsx` 组件内部生效。

- [ ] **Step 1: 导入 `isNearBottom`**

在 `App.tsx` 顶部导入区（紧邻现有的 `@/lib/chat/messages` 导入，`App.tsx:12` 附近）新增：

```ts
import { isNearBottom } from '@/lib/scroll';
```

- [ ] **Step 2: 新增 refs 与 state**

将 `App.tsx:81` 的

```ts
  const scrollRef = useRef<HTMLDivElement>(null);
```

替换为：

```ts
  const scrollRef = useRef<HTMLDivElement>(null);
  // 是否仍处于“跟随最新内容”状态；用户向上滚动后置 false，直到手动回到底部或发起新一轮。
  const atBottomRef = useRef(true);
  const busyRef = useRef(busy);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
```

- [ ] **Step 3: 同步 `busyRef`，新增滚动监听 effect**

在 `App.tsx:96` 现有的 resize effect 之后（`window.addEventListener('resize', ...)` 那个 effect 的 `}, []);` 之后）新增两个 effect：

```ts
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isNearBottom(el);
      atBottomRef.current = atBottom;
      setShowJumpToBottom(!atBottom && busyRef.current);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
```

- [ ] **Step 4: 新增 `resetToFollowing` / `jumpToBottom` 辅助函数**

在 `App.tsx` 中 `onKeyDown` 函数定义之前（`App.tsx:116` 之前）新增：

```ts
  function resetToFollowing() {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  function jumpToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  function submitMessage() {
    resetToFollowing();
    send();
  }
```

- [ ] **Step 5: 收窄自动滚动 effect**

将 `App.tsx:112-114` 的

```ts
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, toolActivities]);
```

替换为：

```ts
  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages, toolActivities]);
```

- [ ] **Step 6: `onKeyDown` 改用 `submitMessage`**

将 `App.tsx:116-121` 的

```ts
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
```

替换为：

```ts
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  }
```

- [ ] **Step 7: 切换会话时重置跟随状态**

将 `App.tsx:99-101` 的

```ts
  // 切换会话 / 新建会话 / 删除当前会话时，关闭尚未提交的编辑框。
  useEffect(() => {
    setEditingId(null);
  }, [conversationId]);
```

替换为：

```ts
  // 切换会话 / 新建会话 / 删除当前会话时，关闭尚未提交的编辑框，并回到“跟随最新内容”状态。
  useEffect(() => {
    setEditingId(null);
    resetToFollowing();
  }, [conversationId]);
```

（`resetToFollowing` 是函数声明，JS 中会被提升到作用域顶部，此处引用先于其源码位置声明没有问题。）

- [ ] **Step 8: 编辑历史消息重新生成时重置跟随状态**

将 `App.tsx:103-110` 的

```ts
  async function submitEdit(id: string, content: string) {
    // 只有 editMessage 真正成功发起（截断+提交）才关闭编辑框；busy / id 未命中 /
    // 不可编辑 / 空内容 / Provider 未配置 / API Key 缺失 / 标签页解析失败等前置失败
    // 都会返回 false，此时编辑框保持打开、用户刚敲的内容原样保留，页面上方的
    // error 提示负责说明失败原因，不在编辑框里再加一套错误 UI。
    const ok = await editMessage(id, content);
    if (ok) setEditingId(null);
  }
```

替换为：

```ts
  async function submitEdit(id: string, content: string) {
    // 只有 editMessage 真正成功发起（截断+提交）才关闭编辑框；busy / id 未命中 /
    // 不可编辑 / 空内容 / Provider 未配置 / API Key 缺失 / 标签页解析失败等前置失败
    // 都会返回 false，此时编辑框保持打开、用户刚敲的内容原样保留，页面上方的
    // error 提示负责说明失败原因，不在编辑框里再加一套错误 UI。
    resetToFollowing();
    const ok = await editMessage(id, content);
    if (ok) setEditingId(null);
  }
```

- [ ] **Step 9: `main` 包一层定位容器，加入「回到底部」按钮**

将 `App.tsx:191` 至 `App.tsx:252` 的

```tsx
          <main ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-4 py-6">
              {messages.length === 0 ? (
```

开头改为（`main` 的 `className` 从 `flex-1 overflow-y-auto` 改为 `h-full overflow-y-auto`，外面新增一层 `relative flex-1 overflow-hidden` 容器）：

```tsx
          <div className="relative flex-1 overflow-hidden">
            <main ref={scrollRef} className="h-full overflow-y-auto">
              <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-4 py-6">
                {messages.length === 0 ? (
```

对应地，`App.tsx:237` 原本的

```tsx
            </div>
          </main>

          <Composer
```

改为（`main` 内层多缩进一级，新增按钮，闭合新增的外层 `div`）：

```tsx
              </div>
            </main>
            {busy && showJumpToBottom && (
              <button
                type="button"
                onClick={jumpToBottom}
                className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-lg transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <IconChevronDown className="h-3.5 w-3.5" />
                回到底部
              </button>
            )}
          </div>

          <Composer
```

（注意：`main` 与其内部 `<div className="mx-auto ...">` 之间原有的缩进层级都要整体多缩进一级，因为最外层多了一层 `<div>` 包裹——这是一次整体缩进调整，不是新增逻辑，改完后用 Step 11 的 `pnpm compile` 校验 JSX 是否配对正确。）

- [ ] **Step 10: `Composer` 的 `onSend` 改用 `submitMessage`**

将 `App.tsx:247` 的

```tsx
            onSend={() => send()}
```

替换为：

```tsx
            onSend={() => submitMessage()}
```

- [ ] **Step 11: 类型检查**

Run: `pnpm compile`
Expected: 无错误退出（exit code 0）。若 JSX 缩进/闭合标签不匹配，`tsc` 会在此处报错，回到 Step 9 核对。

- [ ] **Step 12: 手动验证**

Run: `pnpm dev`，在 `chrome://extensions` 加载 `.output/chrome-mv3`（若已加载过，点击「重新加载」）。打开一个页面的侧边栏，依次验证：

1. 触发一个较长的流式回复（例如让 agent 总结一个长网页），流式过程中向上滚动：内容不再被拉回底部，且出现「回到底部」按钮。
2. 点击「回到底部」按钮：平滑滚回底部，按钮消失，后续 token 恢复自动跟随。
3. 保持在底部不动，观察流式过程：与当前行为一致，持续跟随到底部。
4. 在滚离状态下发送新消息（Enter 或点击发送按钮）：视图立即跳到底部。
5. 编辑一条历史用户消息并重新提交：视图立即跳到底部。
6. 切换到另一个历史会话、或新建会话：视图跳到底部，不残留上一次的按钮状态。
7. 回复结束（转圈/停止按钮消失）时仍处于滚离状态：按钮消失，视图不被强制滚动。
8. 切换到浅色/深色主题，确认按钮在两种主题下都清晰可辨。

Expected: 以上 8 项全部符合预期。

- [ ] **Step 13: 运行完整测试套件**

Run: `pnpm test`
Expected: 全部通过（含 Task 1 新增的 `lib/scroll.test.ts`）。

- [ ] **Step 14: 提交**

```bash
git add entrypoints/sidepanel/App.tsx
git commit -m "feat: stop auto-scroll from yanking users back during streaming"
```

---

## Self-Review Notes

- **Spec 覆盖**：设计文档「设计」章节 1-6 点分别对应 Task 1（第 1 点）与 Task 2 的 Step 2-10（第 2-6 点）；「验收标准」逐条对应 Task 2 Step 12 的手动验证清单；「测试」章节的 `isNearBottom` 用例对应 Task 1 Step 1。
- **占位符扫描**：无 TBD / 「类似 Task N」等占位表述，Step 9 的缩进调整说明是唯一的非逐字复制之处，已明确指出改动范围与校验方式（`pnpm compile`）。
- **类型一致性**：`isNearBottom` 的参数类型在 Task 1（定义）与 Task 2 Step 1（导入使用）之间一致；`atBottomRef` / `busyRef` / `showJumpToBottom` / `resetToFollowing` / `jumpToBottom` / `submitMessage` 在 Task 2 内各步骤间命名一致，无歧义。
