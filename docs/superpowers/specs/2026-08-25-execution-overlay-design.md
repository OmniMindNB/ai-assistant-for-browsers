# 执行期遮罩与模拟光标 · 设计说明

- 日期：2026-08-25
- 来源：对标 `alibaba/page-agent` 的 `SimulatorMask`（`packages/page-controller/src/mask/`）与 `movePointerToElement`（`packages/page-controller/src/utils/index.ts:60-72`）
- 状态：已评审，待实现

## 1. 问题

Runi 的 agent 跑在侧边栏里，页面上目前唯一的执行反馈，是 `lib/agent/form-dom.ts:482` 与 `:612` 两处重复的一次性高亮框——点击/选择前闪 250ms 就没了。用户在被操作的页面上看不到任何持续信号：分不清"agent 正在动这一页"和"页面自己在变"，也无法在一次不可逆的提交发生前反应过来。

page-agent 的解法是全屏遮罩加模拟光标。但它是 in-page 库，agent 与用户共处一个页面，遮罩必须**阻断**输入才能防止互相抢焦点。Runi 是侧边栏扩展，用户随时想接管是正常预期，照搬阻断反而是反功能。

## 2. 目标与非目标

**目标**

- 写操作获批后，被操作的页面上有持续、明确、不遮挡内容的"agent 正在操作"信号。
- 每一次点击前，用户看得见指针将落在哪个元素上，并有约 250ms 的反应窗口。
- 任何异常路径（侧边栏关闭、service worker 驱逐、页面跳转）下，遮罩都不会永久残留在用户页面上。

**非目标（明确不做）**

| 不做 | 理由 |
|------|------|
| 阻断用户输入 | 侧边栏形态下用户随时接管是正常预期；且 agent 卡住时会把页面锁死 |
| 接管检测状态机 | 不阻断就不需要 |
| 页面深色模式检测（对标 `checkDarkMode.ts`） | 品牌色 + 白描边在深浅背景上均可辨，YAGNI |
| 逐字段移动光标 | 填 8 个字段就是 2s+ 纯表演开销，且会把"一次调用写完整个表单"的批量优势拆成串行 |
| 只读回合显示遮罩 | 用户只想总结本页时，页面上突然罩一层东西是纯打扰 |

## 3. 关键决策

### 3.1 纯视觉，不阻断

遮罩全程 `pointer-events: none`。这一条顺带消解了三个隐患：它永远不是 `elementFromPoint` 的命中目标；不抢焦点；agent 卡在长请求上也锁不死页面。

### 3.2 显示时机：写操作获批 → 回合结束

起点是 `lib/agent/agent.ts:148-149` 的 `policy.approveWrite()`——即用户已在确认卡上点了允许，对"页面要被改"已有预期。终点是回合结束（正常完成、出错、用户停止）。只读回合（问答、总结）完全不出现。

### 3.3 归属：content script 持有遮罩，`lib/` 持有逻辑

写工具是一次性的 MAIN world 注入（`entrypoints/background.ts:687` 的 `executeInTab`），函数被序列化、不能引用模块作用域，因此不可能持有跨调用的状态——`form-dom.ts:506` 那句"两处都是被序列化注入的独立函数，不能共用 helper"就是这个约束的既有代价。遮罩必须由常驻的 content script 持有。

宿主结构沿用划词气泡已验证的形状（`entrypoints/content.ts:154-176`）：`position: fixed` 的宿主 div 挂到 `document.documentElement`，内部是 **closed shadow root**。收益有三：

1. 页面 JS 摸不到内部结构。
2. `collectFormFields` 的 `querySelectorAll('*')` 看不进 closed root（`lib/agent/form-dom.ts:200-216`），只看得见一个无语义的裸 div——宿主是普通 `<div>`、标签名不含 `-`，也不会被计入 `unreachable.closedShadowRoots`。
3. 样式与页面完全隔离。

代码分层按项目既有惯例（`entrypoints/` 下没有 vitest project 覆盖，参见 `lib/agent/fill-form-request.ts` 的抽取理由）：

- `lib/agent/agent-overlay.ts`：建/拆宿主、光标缓动、状态条渲染、看门狗。纯 DOM 函数，可测。
- `entrypoints/content.ts`：只做消息监听与转发的接线。

### 3.4 光标时序：MAIN world 发事件（方案 B）

光标必须在点击**之前**到位，而点击在 MAIN world 的注入函数里派发。两条路：

- **A｜background 两段式**：注入探针取 rect → 发 `MOVE_CURSOR` 并 await → 再注入点击。目标要解析两次，两次之间元素可能已变。
- **B｜MAIN world 发事件**：注入的点击函数照旧自己算 rect，先 `window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x, y } }))`，`await` 250ms，再派发点击。content script 在 ISOLATED world 监听同一个 window 事件。

**采用 B。** 决定性理由：光标停的位置和事件派发的位置必须是同一个坐标，否则光标指着 A、实际点了 B，这个功能就从建立信任变成破坏信任。B 下 rect 只解析一次，不存在漂移。

**250ms 这个时长要在两处各写一遍**：content script 里的缓动时长，和注入函数里 `await` 的时长。注入函数被序列化、不能引用模块常量（同 `form-dom.ts:506` 记录的约束），所以无法共用一个常量。两处都要写明"改动时必须同步另一处"的注释——若注入函数等得比动画短，就会在光标还没停稳时派发点击，正是本功能要消除的那种错位。

B 的已知风险是跨 world 的 `CustomEvent.detail` 读取。Chrome MV3 下 content script 可直接读页面派发的 CustomEvent detail；Firefox 的 Xray 包装可能读不到，届时退回「在宿主元素上写 `data-runi-cursor="x,y"` 属性 + MutationObserver」的兜底。以 Chrome 为准先行验证。

### 3.5 文案由侧边栏下发

`entrypoints/content.ts:88-91` 已明确记录：内容脚本跑在每个页面里，不能为几句文案把完整 i18n 字典和 React 运行时打进产物。因此状态条文案必须在侧边栏侧本地化好再传下来：

```ts
SET_AGENT_OVERLAY { active: true, label: string }   // label 已本地化
```

顺带可复用 `lib/agent/activity-description.ts` 已有的步骤文案，页面状态条与侧边栏时间线说的是同一句话。

### 3.6 动画走 Web Animations API

严格 CSP 的页面会挡掉 `<style>` 标签与 style 属性字符串。呼吸动画和 ripple 若写成 `@keyframes` 就必须有 `<style>` 标签，在这类页面上会静默失效——而银行、政务这类最需要代填表单的站点恰恰 CSP 最严。

因此：**样式逐属性赋值，动画一律走 `element.animate()`**（纯 JS 调用，不受页面 CSP 约束）。

代价是 jsdom 不实现 `element.animate()`。`agent-overlay.ts` 做能力检测，缺失时静默跳过动画；测试只断结构与状态，不断动画。

## 4. 视觉与行为规格

### 4.1 遮罩本体

不压暗页面——压暗等于变相干扰阅读，与"纯视觉不阻断"的定位冲突。改为内嵌边框光晕：

- 全屏 `inset: 0`，`pointer-events: none`，`z-index: 2147483647`（与划词气泡同级）。
- `box-shadow: inset 0 0 0 2px #4f46e5, inset 0 0 24px rgba(79, 70, 229, .28)`。
- 呼吸动画：2s `ease-in-out` 无限交替，透明度 0.6 ↔ 1。

### 4.2 顶部状态条

居中胶囊，`top: 12px`，显示当前动作文案（由 3.5 下发）。随工具切换更新。

### 4.3 光标

- 24px 内联 SVG 箭头，`#4f46e5` 填充 + 白色描边（深浅背景均可辨）。
- 缓动 250ms `cubic-bezier(.22, 1, .36, 1)`，只动 `transform: translate3d`，不触发布局。
- 落点后 `scale(.85)` 按下反馈 + 一圈扩散 ripple。
- 遮罩起来时从视口右下角滑入，暗示"来自侧边栏那一侧"。
- 坐标需按视口边界钳制，避免目标贴边时光标画到视口外。

### 4.4 哪些工具驱动光标

| 工具 | 遮罩 | 状态条 | 光标 |
|------|------|--------|------|
| `browser_click` | ✓ | ✓ | ✓ |
| `browser_select` | ✓ | ✓ | ✓ |
| `browser_fill_form` | ✓ | ✓ | 仅 submit 那一下 |
| `browser_type` | ✓ | ✓ | ✗ |
| `browser_scroll` | ✓ | ✓ | ✗ |
| `browser_set_style` / `browser_modify_dom` / `browser_navigate` / `browser_set_storage` | ✓ | ✓ | ✗ |

`browser_fill_form` 填字段阶段不走光标：字段本来就会逐个亮起、文本直接出现，已经看得见；把注意力精准放在唯一不可逆的那一下（提交）上。

### 4.5 与现有高亮框的关系

保留 `form-dom.ts:482` / `:612` 的高亮框，配色统一到同一个蓝。时序天然吻合：光标滑到目标后停 250ms，高亮框正好在这 250ms 内亮着，然后一起收。

不去收敛那两处重复代码——CLAUDE.md 记录的注入函数约束摆在那儿，无法共用 helper。

## 5. 生命周期与失败模式

### 5.1 正常流

```
sidepanel (agent.ts:148 policy.approveWrite())
   → SET_AGENT_OVERLAY { active: true, label } → background → tabs.sendMessage → content script
   ↓ 回合结束 / 出错 / 用户停止
   → SET_AGENT_OVERLAY { active: false }
```

### 5.2 跳转后重建

`browser_navigate` 后页面卸载，遮罩随之消失。background 把"该 tab 遮罩生效中"写入 `browser.storage.session`（按 tab 键控，与 `lib/agent/tab-form-fields.ts` 同一手法）；新页面的 content script 初始化时自查该标记并重建遮罩。

### 5.3 看门狗：遮罩不得永久残留

侧边栏被关闭、或 MV3 service worker 被驱逐时，没有任何人再发 hide，遮罩会永久挂在用户页面上。本项目已栽过一次 SW 驱逐的跟头（revert 快照缺陷），因此不能只依赖"发一条 hide 消息"。

content script 侧维护一个滚动续期的 deadline：**收到任一 `SET_AGENT_OVERLAY { active: true }`（含仅更新 label 的那些），或收到一次 `runi:cursor-move` 事件**，即重置到 15s 后；超时无声自撤。侧边栏活着时心跳自然不断（每次工具调用都会带来其中之一），侧边栏一死最多 15s 后页面自动干净。

这条设计把"撤下"从**必须送达的消息**降级为**兜底即可的消息**，是整个方案唯一的强健性要求。

### 5.4 截图污染

`browser_screenshot` 是只读工具，但遮罩起来后模型仍可截图，会把光晕与光标一起拍进去当作页面内容。background 的截图处理器需在捕获前撤遮罩、捕获后恢复。

### 5.5 多标签页

遮罩按 tab 生效。回合的目标 tab 已由既有的 turn-tabid-pinning 固定，沿用即可。

## 6. 测试

`lib/agent/agent-overlay.dom.test.ts`（走 `vitest.config.ts` 的 `dom` project，jsdom）覆盖：

- 宿主创建与销毁
- shadow root 确实为 closed
- 宿主 `pointer-events: none`
- 光标坐标计算与视口边界钳制
- 看门狗到期自撤
- 重复 show 不产生第二个宿主

消息协议的类型收敛由 `pnpm compile` 保证。

**自动测不了、需手动验证的清单：**

1. 普通页面上的动画观感
2. 严格 CSP 页面（动画仍在、无 console 报错）
3. `browser_navigate` 跳转后遮罩重建
4. 关闭侧边栏后 15s 内遮罩自撤
5. 截图结果中不含遮罩与光标

## 7. 影响面

| 文件 | 改动 |
|------|------|
| `lib/agent/agent-overlay.ts` | 新增：宿主、光标、状态条、看门狗 |
| `lib/agent/agent-overlay.dom.test.ts` | 新增：单测 |
| `lib/messaging.ts` | 新增 `SET_AGENT_OVERLAY` 消息类型与 payload |
| `entrypoints/content.ts` | 新增消息监听、`runi:cursor-move` 事件监听、初始化自查 |
| `entrypoints/background.ts` | 转发遮罩消息、session 标记读写、截图前后撤/复原 |
| `lib/agent/agent.ts` | `approveWrite()` 处发起 show |
| `entrypoints/sidepanel/store.ts` | 回合结束/出错/停止处发起 hide |
| `lib/agent/form-dom.ts` | 点击/选择注入函数派发 `runi:cursor-move` 并 await 250ms；高亮框配色统一 |
