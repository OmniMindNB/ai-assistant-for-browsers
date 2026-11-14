# 输入框底栏的页面上下文徽章（composer page-context badge）

- 日期：2026-11-14
- 状态：已评审（UI 走查 P1-4：页面上下文缺少正向指示）
- 来源：Composer 此前只在 `pageContext.status === 'error'` 时提示（带重试的提示条），
  正常附加页面时无任何可见状态——用户在会话中无法回答"这条消息带没带当前页面"，
  恰好是这个产品最核心的差异化能力。
- 依赖：无协议改动、无 store 改动，只渲染既有的 `pageContext`。

## 1. 设计

- **位置**：输入框底栏（`+` 按钮、模型选择器之后），一枚常驻小徽章。
- **语义锚点**：徽章说的是 `withoutBrowserTools` 的取反——`resolvePageAttached`
  决定下一条消息带不带页面工具，徽章把同一份事实画出来，两边永不各说各话。
- **状态映射**（`PageContextState` 四态只画两个稳定态）：
  - `available`：淡绿徽章「已带上当前页面」，`title` 悬停给页面标题 + URL；
  - `restricted`：中性徽章「当前页面不可用」，`title` 解释"这类页面读不了、
    本轮对话不使用页面内容"——此前 restricted 态在 composer 里完全无提示，是本设计
    补上的真正缺口；
  - `loading`：不画（一闪而过，避免面板每次挂载都闪一下）；
  - `error`：不画（已有带重试的提示条，两处重复同一状态只会漂移）。
- **无障碍**：徽章是纯状态不是控件，不进 tab 序列、不用 role="status"（每次导航
  播报一遍只会变噪音——沿用 ActivityStepList 不做 live region 的既有取舍）；通过
  `aria-describedby` 挂到输入框上，读屏聚焦输入框时能听到"带没带页面"。

## 2. 非目标

- 不做点击交互（点击刷新/移除会把它变成控件，语义混进操作区）；
- 不在徽章里放 favicon 或页面标题（与模型选择器抢宽度，标题退到 `title` 悬停）；
- 不改 `pageContext` 的刷新时机（store 已监听面板 tab 的导航）。
