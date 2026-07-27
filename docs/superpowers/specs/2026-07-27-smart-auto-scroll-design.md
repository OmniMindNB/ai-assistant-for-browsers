# 设计：流式输出时的智能跟随滚动

- 状态：已批准 Approved
- 日期：2026-07-27
- 关联：`entrypoints/sidepanel/App.tsx`、`lib/scroll.ts`（新增）

## 背景

侧边栏聊天区（`App.tsx:191` 的 `<main ref={scrollRef}>`）的滚动完全由一个无条件 effect 驱动：

```ts
useEffect(() => {
  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
}, [messages, toolActivities]);
```

流式回复的每一个 token 都通过 `text_delta` → `replaceLastAssistant` 更新 `messages`
（`store.ts:480-483`），因此这个 effect 在一次回复过程中会触发几十上百次。只要用户在
回复进行中向上滚动查看之前的内容，下一个 token 到达时就会被强制拉回底部——完全没有
「用户是否还想跟随」的判断，阅读体验被打断。

## 目标

- 流式输出/工具运行期间，若用户已主动滚离底部，新增内容不再把视图拉回去。
- 用户仍停留在底部附近时，保持现状：新增内容持续自动跟随到底部。
- 用户滚离底部后，提供一个可发现的「回到底部」入口，点击后一键恢复跟随。
- 发送新消息、切换/新建会话等场景，行为与现状一致（跳到底部）。

## 非目标

- 不做「未读消息数」之类的计数提示，只做有/无。
- 不改变消息渲染、虚拟滚动等其他 UI 逻辑。
- 回复结束后不追加任何强制滚动或提示：按钮只在 `busy` 期间出现，回复结束的瞬间即消失，
  即使用户仍未回到底部（用户选择，见设计对话）。

## 用户故事

- 作为用户，我在等待较长回复时想往上翻看之前的对话，不希望内容不断把我拉回底部。
- 作为用户，翻看完想追回最新内容时，我希望有一个明显的入口一键跳回底部，而不必手动滚动。

## 设计

### 1. 判断「是否在底部」：`lib/scroll.ts`（新增）

```ts
export const BOTTOM_THRESHOLD_PX = 48;

/** 滚动容器是否已（近似）处于底部 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx: number = BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}
```

阈值容忍亚像素/浏览器滚动吸附造成的误差。这是本设计里唯一有意义的纯逻辑，单独抽出到
`lib/`，可以被 `vitest`（`include: ['lib/**/*.test.ts']`）覆盖到——`entrypoints/` 目前无
测试基建，其余部分（事件绑定、effect 时机）只能手动验证。

### 2. `App.tsx` 内的状态

- `atBottomRef = useRef(true)`：当前是否应视为「在底部」，直接决定新内容到达时是否自动
  滚动。用 ref 而非 state，避免它自身的变化触发额外渲染。
- `const [showJumpToBottom, setShowJumpToBottom] = useState(false)`：驱动按钮渲染的
  state，只在需要重绘按钮时才 set。

### 3. 滚动事件监听

在挂载 `scrollRef` 的 effect 中给 `main` 加一个 `passive: true` 的 `scroll` 监听：

```ts
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

`busyRef`（同步镜像 `busy` 的 ref）用于在不重新绑定监听器的前提下，让滚动回调读到最新的
`busy` 值。监听器只装卸一次；程序化 `scrollTo` 触发的 `scroll` 事件重新计算后
`atBottom` 会是 `true`，不会引入抖动。

### 4. 自动跟随 effect 改造

原有的无条件滚动 effect 收窄为「只在仍处于跟随状态时才滚」：

```ts
useEffect(() => {
  if (atBottomRef.current) {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }
}, [messages, toolActivities]);
```

不在底部时，这个 effect 什么也不做——按钮的显示已经由滚动监听器在用户滚离的那一刻处理了，
不需要在这里重复判断 `busy`。

### 5. 「回到底部」按钮

- 位置：`main` 所在的 `relative flex ... flex-col` 容器（`App.tsx:180`）内，绝对定位于
  底部居中，`main` 的 `Composer` 输入框上方，`z-index` 高于消息内容。样式随主题（light/dark）。
- 渲染条件：`busy && showJumpToBottom`。
- 点击行为：

```ts
function jumpToBottom() {
  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  atBottomRef.current = true;
  setShowJumpToBottom(false);
}
```

用 `smooth` 是因为这是一次用户主动触发的跳转，与逐 token 的静默跟随（无动画，避免抖动）
体验上应有区分。

### 6. 新一轮开始时强制回到跟随状态

用户发起新一轮对话时，无论之前滚到哪里，都应该看到自己刚发的消息和即将到来的回复
——这与「不要打断阅读」并不冲突，因为这是用户自己的主动操作。做法：在触发新一轮的入口处
直接调用一个小 helper 重置状态，而不是依赖 effect 去推断「这是新一轮」：

```ts
function resetToFollowing() {
  atBottomRef.current = true;
  setShowJumpToBottom(false);
}
```

调用点：

- `onKeyDown` 里 Enter 触发 `send()` 之前、Composer 的发送按钮 `onSend` 之前。
- `submitEdit`（编辑历史消息重新生成）调用 `editMessage` 之前。
- 已有的 `useEffect(() => { setEditingId(null); }, [conversationId])`（`App.tsx:99-101`）
  中一并调用——覆盖切换会话、新建会话（`newChat`）、删除当前会话后落到的新会话。

调用后，第 4 步的自动跟随 effect 会在 `messages` 更新时按正常路径滚到底部，不需要额外
手动 `scrollTo`。

## 边界与异常

- **消息很少、内容高度小于容器高度**：`scrollHeight - clientHeight` 本就接近 0，
  `isNearBottom` 天然判 `true`，跟随逻辑退化为现状，无需特殊处理。
- **首字到达前的等待/纯工具调用阶段**：`busy` 已为 `true`，用户此时滚离一样会触发按钮
  显示，不依赖是否已经产生过文本 delta。
- **`pendingConfirmation` / `turnHasChanges` / `error` 变化不触发自动滚动**：这是现状行为
  （原 effect 依赖数组就是 `[messages, toolActivities]`），本设计不扩大依赖范围。
- **窗口 resize（如收起/展开侧栏）**：不改变判定语义，沿用同一阈值，不需要专门处理；
  下一次 `scroll` 或内容变化事件会自然重新计算。

## 安全与隐私

不涉及。纯前端滚动交互，不新增权限、网络请求或数据存取路径。

## 测试

新增 `lib/scroll.test.ts`：

- `isNearBottom`：`scrollTop` 使内容正好在底部 → `true`；差值小于阈值 → `true`；
  差值大于阈值 → `false`；内容总高度小于等于容器高度（几乎无滚动空间）→ `true`。

`App.tsx` 内的状态/事件绑定逻辑无法被现有 vitest 配置覆盖（`entrypoints/` 无测试基建），
计划手动验证：

- `pnpm dev` 加载解包扩展，触发一个较长的流式回复。
- 流式过程中向上滚动：确认视图不再被拉回，且出现「回到底部」按钮。
- 点击按钮：确认平滑滚回底部，按钮消失，后续 token 恢复自动跟随。
- 保持在底部不动，观察流式过程：确认与当前行为一致，持续跟随到底部。
- 在滚离状态下发送新消息：确认视图立即跳到底部（新一轮开始）。
- 编辑历史消息重新生成：同上验证。
- 切换会话 / 新建会话：确认跳到底部且不残留按钮。
- 回复结束（`busy` 变为 `false`）时仍处于滚离状态：确认按钮消失，视图不被强制滚动。

## 验收标准

- [ ] 流式输出过程中向上滚动，新增内容不再强制拉回底部。
- [ ] 滚离底部且 `busy` 为真时，出现「回到底部」悬浮按钮；点击后平滑滚到底部并恢复自动跟随。
- [ ] 保持在底部附近时，流式输出持续自动跟随，行为与当前一致。
- [ ] 回复结束（`busy` 变为 `false`）后，按钮消失；即使用户仍未回到底部，也不发生强制滚动。
- [ ] 在滚离状态下发送新消息或编辑历史消息重新生成，视图立即跳回底部并重新进入跟随状态。
- [ ] 切换会话、新建会话时视图跳到底部，不残留上一次的按钮状态。
- [ ] `pnpm compile` 与 `pnpm test` 通过。

## 开放问题

- 无。
