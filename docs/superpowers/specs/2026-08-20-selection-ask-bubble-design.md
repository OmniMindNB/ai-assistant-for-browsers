# 设计：划词提问悬浮气泡

- 状态：已批准 Approved
- 日期：2026-08-20
- 关联：`lib/messaging.ts`、`entrypoints/content.ts`、`entrypoints/background.ts`、
  `entrypoints/sidepanel/store.ts`、`entrypoints/sidepanel/components/WorkbenchComposer.tsx`、
  `components/ShortcutSettings.tsx`、`lib/agent/tab-conversation.ts`（复用其存储模式）

## 背景

目前"针对选中文字做点什么"只有一条路径：`lib/shortcuts.ts` 里 `scope: 'selection'`
的内置/自定义快捷指令（解释划词、翻译划词等）。这条路径的语义是**固定 prompt
+ 自动发送**——`buildShortcutExecution` 把选区文字和快捷指令的固定 prompt 拼在
一起，点击 chip 后立即触发一次完整的 agent 回合，用户不参与编辑最终发送的内容。

用户想要的"对选中文字提问"是不同的交互：问题本身是**自由输入**的，且触发入口
希望是网页上跟随选区出现的悬浮气泡，而不是必须先手动打开侧边栏、再从工具栏点
chip。这意味着新增一个此前不存在的能力面——`entrypoints/content.ts` 目前只是
一个无 UI 的消息处理器（只响应 `EXTRACT_PAGE`/`GET_SELECTION`），从未在页面里
渲染过可见元素，也从未主动向 background 发送过消息（现有消息流始终是
侧边栏/background 发起请求、content script 被动应答）。

## 目标

- 用户在任意网页选中文字后，出现一个悬浮气泡；点击后打开（或激活）该 tab 绑定的
  侧边栏，并把选中文字以引用格式预填进现有聊天输入框、聚焦光标，用户接着输入
  具体问题、回车发送，走完整的现有 agent 对话流程。
- 提供一个全局开关（默认开启），可在设置页关闭这个气泡。
- 气泡本身用 Shadow DOM 隔离，不与宿主页面样式互相污染；不尝试检测或规避宿主
  页面自带的划词 UI（两者可能同时出现，属于可接受的共存现象，不是本设计要解决
  的问题）。

## 非目标

- 不做气泡内联输入或内联流式回答——问题的输入和回答的展示始终在侧边栏里完成，
  完全复用现有聊天流水线（流式输出、工具调用确认、会话历史等）。
- 不新增独立的"划词问答"agent 工具或消息通道用于获取回答——选区文字进入的是
  用户自己审阅、可编辑的输入框，作为一条普通用户消息发送，不走
  `buildShortcutExecution` 那套"未信任内容自动拼接"的路径。
- 不做按站点单独开关，只有一个全局开关。
- 不处理宿主页面主动拦截选区事件（如捕获阶段 `stopImmediatePropagation`）的极端
  对抗场景——出现时表现为气泡偶尔不出现，不做特殊兼容。

## 设计

### 1. 消息协议：`lib/messaging.ts`

新增一个 `MessageType`：

```ts
export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'ASK_SELECTION'   // 新增
  | ...
```

新增 payload 类型：

```ts
/** ASK_SELECTION：content script 主动上报"用户点击了划词提问气泡" */
export interface AskSelectionPayload {
  text: string;
}
```

这是现有消息流里**第一次由 content script 主动发起**的消息（此前 content
script 只被动响应 `EXTRACT_PAGE`/`GET_SELECTION`）。复用现有 `sendMessage()`
辅助函数即可（它只是对 `browser.runtime.sendMessage` 的类型化包装，任何上下文
都能调用），不需要新的发送机制：

```ts
// entrypoints/content.ts 内
await sendMessage('ASK_SELECTION', { text: selectionText } satisfies AskSelectionPayload);
```

该消息**不携带 `tabId`**（这是它和其它所有工具消息的关键区别）：其它消息类型
的 `tabId` 语义是"侧边栏在回合开始时解析并透传的操作目标"，而 `ASK_SELECTION`
天然知道自己所在的 tab（就是 `sender.tab.id`），不需要、也不应该走那套"回合固定
目标"的透传逻辑。

### 2. `entrypoints/background.ts`

`browser.runtime.onMessage.addListener` 的回调签名里 `sender` 目前被忽略
（`_sender`）；改为把 `sender` 传给 `handleMessage`：

```ts
browser.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (r: MessageResponse) => void) => {
    handleMessage(message, sender)
      .then((data) => sendResponse({ id: message.id, ok: true, data }))
      .catch(/* 不变 */);
    return true;
  },
);
```

`handleMessage` 新增分支（`sender` 参数其余分支不使用，签名加 `sender?:
Runtime.MessageSender`）：

```ts
case 'ASK_SELECTION': {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return;
  const { text } = message.payload as AskSelectionPayload;
  if (!text?.trim()) return;
  // 两次 sidePanel 调用必须在这个消息回调体内同步发起、不经过任何 await/.then 链，
  // 否则 Chrome 会认为已经脱离了触发本次消息的用户手势，
  // 抛出 "sidePanel.open() may only be called in response to a user gesture."
  // ——与 action.onClicked 监听器里（第 91-100 行）的既有写法保持一致。
  // setPendingAskForTab 的 await 因此排在这两次调用之后：写入比 sidePanel.open()
  // 晚几十毫秒完成没有副作用（侧边栏消费 pending 数据前本来就要等自己 mount 完成）。
  browser.sidePanel
    ?.setOptions?.({ tabId, path: 'sidepanel.html', enabled: true })
    .catch((err: unknown) => console.error('[Runi] sidePanel setOptions (ask-selection):', err));
  browser.sidePanel
    ?.open?.({ tabId })
    .catch((err: unknown) => console.error('[Runi] sidePanel open (ask-selection):', err));
  await setPendingAskForTab(tabId, text);
  return;
}
```

`browser.tabs.onRemoved` 现有清理逻辑里追加一行，清掉这个新 key（与
`clearConversationIdForTab` 并列调用）。

### 3. `lib/agent/tab-pending-ask.ts`（新文件）

完全仿照 `lib/agent/tab-conversation.ts` 的模式（`storage.session`，按 tabId
隔离，写入失败静默降级）：

```ts
function storageKey(tabId: number): string {
  return `runi:tab-pending-ask:${tabId}`;
}

export async function getPendingAskForTab(tabId: number): Promise<string | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as string | undefined;
}

export async function setPendingAskForTab(tabId: number, text: string): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: text });
  } catch {
    // 静默降级：写入失败时这次气泡点击不会预填成功，用户仍可手动输入
  }
}

export async function clearPendingAskForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
```

### 4. `lib/selection-ask.ts`（新文件，纯逻辑，供 content script 和 sidepanel 共用）

```ts
import type { Translate } from './i18n';
import { MAX_SHORTCUT_SELECTION_CHARS } from './chat/shortcut-prompts';

export const SELECTION_ASK_ENABLED_KEY = 'runi:selection-ask-enabled';

export async function loadSelectionAskEnabled(): Promise<boolean> {
  const res = await browser.storage.local.get(SELECTION_ASK_ENABLED_KEY);
  return (res[SELECTION_ASK_ENABLED_KEY] as boolean | undefined) ?? true;
}

export async function saveSelectionAskEnabled(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [SELECTION_ASK_ENABLED_KEY]: enabled });
}

/** 供侧边栏把 pending 选区文字拼成预填到输入框的引用文本。 */
export function buildSelectionAskTemplate(text: string, translate: Translate): string {
  const truncated = text.trim().slice(0, MAX_SHORTCUT_SELECTION_CHARS);
  return translate('store.selectionAskTemplate', { selection: truncated });
}

/** 供 content script 计算气泡定位：以选区 Range 的 bounding rect 为基准，
 *  裁剪到视口内，避免气泡跑出屏幕。 */
export function clampBubblePosition(
  rect: { top: number; left: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  bubbleSize: { width: number; height: number },
): { top: number; left: number } {
  const rawTop = rect.top - bubbleSize.height - 8;
  const rawLeft = rect.left + (rect.right - rect.left) / 2 - bubbleSize.width / 2;
  return {
    top: Math.max(4, rawTop < 0 ? rect.bottom + 8 : rawTop),
    left: Math.min(Math.max(4, rawLeft), viewport.width - bubbleSize.width - 4),
  };
}
```

（`clampBubblePosition` 的具体裁剪策略是实现细节，写计划/编码阶段可以按气泡
真实尺寸微调，这里给出的是形状而非精确像素规则。）

新增 i18n key（`lib/i18n/locales/{zh,en}.ts`）：

- `store.selectionAskTemplate`：
  - zh: `引用选中内容：\n> {selection}\n\n我的问题：`
  - en: `Regarding the selected text:\n> {selection}\n\nMy question: `
- `shortcut.selectionAskBubbleLabel`（气泡按钮文案）：
  - zh: `问 Runi`
  - en: `Ask Runi`
- `settings.selectionAskToggleLabel`（设置页开关文案）：
  - zh: `启用划词提问气泡`
  - en: `Enable selection-ask bubble`

### 5. `entrypoints/content.ts`

新增气泡子系统，`main()` 里先读一次 `loadSelectionAskEnabled()`；为 `true` 时
才注册以下监听器，并额外监听 `browser.storage.onChanged`（`local` 区、
`SELECTION_ASK_ENABLED_KEY`）以支持不刷新页面就能热开关：

- `mouseup`：取 `window.getSelection()`，非空文本时用 `clampBubblePosition`
  算出位置，挂载/更新一个 Shadow DOM host（`attachShadow({ mode: 'closed' })`
  挂在一个 append 到 `document.documentElement` 的 `<div>` 上），shadow root
  内一个纯内联样式的按钮，文案取 `shortcut.selectionAskBubbleLabel`。
- 隐藏气泡的时机（对应移除该 host 元素）：capture 阶段的外部 `mousedown`、
  capture 阶段的 `scroll`、`Escape` keydown、选区被清空。
- 按钮 `click`：读取当前选区文本（气泡存在期间选区不会变，直接用挂载时记下的
  文本即可，不必重新查询），调用 `sendMessage('ASK_SELECTION', { text })`，
  然后立即移除气泡。

`getSelection()`（既有的 `GET_SELECTION` 处理函数）不受影响、不复用——气泡
挂载时机已经拿到了文本，没有必要再走一次消息往返。

### 6. `entrypoints/sidepanel/store.ts`

面板初始化解析出自身 tabId 之后（复用现有解析当前 tab 的逻辑），追加一步：

```ts
const pending = await getPendingAskForTab(tabId);
if (pending) {
  await clearPendingAskForTab(tabId);
  set({ input: buildSelectionAskTemplate(pending, t), pendingFocusToken: Date.now() });
}
```

`pendingFocusToken` 是新增的 store 字段（初值 `0`），`WorkbenchComposer` 新增
一个 `useEffect`，监听这个 token 变化时调用 `textareaRef.current?.focus()`
并把光标移到末尾（`setSelectionRange(value.length, value.length)`）——面板
刚被 `sidePanel.open()` 打开时浏览器不会自动把焦点放进 textarea，需要这一步
显式聚焦，让用户能直接开始打字问题。

这一步**不**经过 `buildShortcutExecution`：预填的文本就是普通的 `input`
状态，用户可以自由编辑、删除引用、追加问题，按现有 `send()` 路径发送即可，
天然落在"用户消息"的既有信任边界内，不需要额外的"未信任页面内容"包装
（对比 `buildShortcutExecution` 里 selection scope 因为是自动发送、用户看不到
最终 prompt，才需要 `JSON.stringify`+显式提示语包裹）。

### 7. 设置开关：`components/ShortcutSettings.tsx`

顶部新增一个 checkbox（复用组件里已有的开关样式，若有的话），文案取
`settings.selectionAskToggleLabel`，状态来自 `loadSelectionAskEnabled()` /
`saveSelectionAskEnabled()`。放在这个已有的"划词快捷指令"设置区块里，而不是
新开一个 `SettingsSection`——语义上同属"选区能触发什么"。

## 测试

- `lib/selection-ask.ts`：`buildSelectionAskTemplate` 截断/拼接、
  `clampBubblePosition` 边界裁剪、`loadSelectionAskEnabled`/
  `saveSelectionAskEnabled` 读写（mock `browser.storage.local`）。
- `lib/agent/tab-pending-ask.ts`：get/set/clear 往返、写入失败静默降级，仿
  `lib/agent/tab-conversation.ts` 若已有对应测试文件的写法。
- `entrypoints/content.ts` 里的气泡挂载/定位/事件绑定不写测试，沿用项目现状
  （`entrypoints/` 无测试基础设施，只有 `lib/` 被 `vitest.config.ts` 的
  `include` 覆盖）。
- `entrypoints/sidepanel/store.ts` 里消费 pending ask 的逻辑：若已有面板初始化
  相关的 store 测试，按同样方式补一条"存在 pending ask 时预填 input 并推进
  focus token"的用例；没有则跳过（不为此单独新建 store 测试基建）。

收尾：`pnpm compile`、`pnpm test`、`pnpm build`。

## 验收标准

- [ ] `lib/messaging.ts` 新增 `ASK_SELECTION` 类型与 `AskSelectionPayload`。
- [ ] `entrypoints/background.ts` 的消息监听器把 `sender` 传给 `handleMessage`，
      新增 `ASK_SELECTION` 分支，两次 `sidePanel` 调用同步发起；
      `tabs.onRemoved` 清理逻辑覆盖新 storage key。
- [ ] 新增 `lib/agent/tab-pending-ask.ts` 及其单测。
- [ ] 新增 `lib/selection-ask.ts`（模板拼装、定位裁剪、开关读写）及其单测。
- [ ] `entrypoints/content.ts` 新增气泡子系统，受开关控制、支持热开关。
- [ ] `entrypoints/sidepanel/store.ts` 消费 pending ask，预填 `input` 并驱动
      `WorkbenchComposer` 聚焦。
- [ ] `components/ShortcutSettings.tsx` 新增全局开关。
- [ ] `en.ts`/`zh.ts` 成对新增三个 i18n key。
- [ ] `pnpm compile`、`pnpm test`、`pnpm build` 通过。

## 开放问题

- 无。
