# 设计：去掉 ask/agent 模式切换，合并为单一体验

- 状态：已批准 Approved
- 日期：2026-07-31
- 关联：`lib/workbench/preferences.ts`、`entrypoints/sidepanel/App.tsx`、
  `entrypoints/sidepanel/components/{ModeSwitch,WorkbenchComposer,WorkbenchEmptyState}.tsx`、
  `components/GeneralSettings.tsx`、`lib/i18n/locales/{zh,en}.ts`
- 取代：`docs/superpowers/plans/2026-07-30-sidepanel-context-workbench-redesign.md` 中引入的
  `WorkbenchMode`/`ModeSwitch` 设计（该计划已实现落地，本文档是对其中这一部分的修正）

## 背景

当前侧边栏顶部有一个 `ModeSwitch`（`ask` / `agent`），并且 composer 里还有一个独立的
「页面上下文」附加开关（`pageAttached`）。经排查（见对话记录），这两个控件看起来都像是在
控制“agent 能不能操作页面”，但实际上只有 `pageAttached` 是真正生效的：

- `mode` 只改变 UI 文案——composer 的 placeholder（`workbench.composerAskPlaceholder` /
  `composerAgentPlaceholder`）和空状态标题/描述（`workbench.emptyAskTitle` 等）。
  `App.tsx` 里的 `submitMessage` 调用 `send(undefined, { withoutBrowserTools: !pageAttached })`
  时完全没有读取 `mode`。
- 真正决定 agent 是否拥有浏览器工具（`browser_*`）的是 `pageAttached`，一路传导到
  `store.ts` 的 `tools: options.withoutBrowserTools ? [] : undefined`。写操作仍然逐次经过
  `lib/agent/permissions.ts` 的 Deny-First 确认门。

两个控件、只有一个生效，这是新用户上手时的困惑来源：切换到「Agent 任务」模式会让人误以为
现在才能执行浏览器操作，但其实无论哪个模式，只要页面已附加，agent 一直都能发起操作（并在
写入前弹确认）。

## 目标

- 去掉 `ModeSwitch` 和 `WorkbenchMode` 相关的所有状态、UI、设置项、i18n key。
- Composer 变成单一输入框：用户不需要先选择「我是要问问题还是要它做事」，直接输入，
  agent 根据内容自行判断是回答还是发起工具调用（工具调用仍然是既有的确认流程）。
- 空状态文案和 composer placeholder 统一成一套，同时覆盖「问答」与「执行任务」两种意图。
- 设置页只保留一个真正有效的开关：默认是否附加当前页面（`attachPageByDefault`）。

## 非目标

- 不改变 `pageAttached` / `withoutBrowserTools` / 确认门（confirm-gate）/ 权限分类
  （`lib/agent/permissions.ts`）的任何行为——这套机制本身没问题，只是不应该被一个不生效的
  模式切换挡在前面制造误解。
- 不改变 Agent Timeline（工具活动聚合卡片）逻辑，它不依赖 `mode`。
- 不新增“智能判断问答 vs 任务”的分类逻辑——这本来就是 agent 循环自身该做的事，不需要在
  UI 层预判。
- 不做已存储的 `defaultMode` 偏好的数据迁移；旧值直接忽略即可（见下）。

## 设计

### 1. `lib/workbench/preferences.ts`

删除 `WorkbenchMode` 类型和 `WorkbenchPreferences.defaultMode` 字段：

```ts
export interface WorkbenchPreferences {
  attachPageByDefault: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  attachPageByDefault: true,
};
```

`loadWorkbenchPreferences` 的校验逻辑相应收窄为只检查 `attachPageByDefault`。已经写入
`chrome.storage.local` 的旧对象里若还带着 `defaultMode` 字段，校验时不再读取/依赖它，
返回值里那个多余字段随读随弃（不做显式迁移/清理，属于无害的死数据）。

### 2. 删除 `ModeSwitch.tsx`

组件整体移除，`App.tsx` 中不再渲染。

### 3. `App.tsx`

- 移除 `const [mode, setMode] = useState<WorkbenchMode>('ask')` 及所有 `setMode(...)` 调用
  （包括随 `workbenchPreferences.defaultMode` 同步的几处 effect）。
- 移除 `<ModeSwitch mode={mode} onChange={setMode} />` 及其外层容器 div。
- `WorkbenchEmptyState` / `WorkbenchComposer` 不再传 `mode` prop。

### 4. `WorkbenchEmptyState.tsx`

`mode` prop 删除，标题/描述改为一套同时覆盖问答与任务的文案（对应新 i18n key
`workbench.emptyTitle` / `workbench.emptyDescription`）。建议文案（供实现时校对）：

- 标题：`可以开始了`
- 描述：`问我关于当前页面的问题，或者描述一个想让我在浏览器里完成的任务。`

快捷指令建议区（`suggestions`）逻辑不变，继续沿用现有 `shortcuts` 过滤。

### 5. `WorkbenchComposer.tsx`

`mode` prop 删除，placeholder 改为统一的一条（新 key `workbench.composerPlaceholder`）：

- 中文：`输入你的问题，或描述要执行的浏览器任务… Enter 发送，Shift+Enter 换行`
- 英文：`Ask a question, or describe a browser task… Enter to send, Shift+Enter for a new line`

页面上下文附加 chip（`pageAttached`/`onTogglePageAttached`）保持不变，是唯一一个「附加/不
附加当前页面」的开关。

### 6. `components/GeneralSettings.tsx`

删除「默认工作模式」`fieldset`（含两个 `Radio`）及 `updateMode` 函数、`Radio` 子组件如果
不再被其他地方使用则一并删除。保留「默认附加当前网页」`checkbox`。

### 7. i18n（`lib/i18n/locales/zh.ts` / `en.ts`）

删除的 key：`settings.defaultMode`、`settings.modeAsk`、`settings.modeAgent`、
`workbench.modeSwitch`、`workbench.modeAsk`、`workbench.modeAgent`、
`workbench.composerAskPlaceholder`、`workbench.composerAgentPlaceholder`、
`workbench.emptyAskTitle`、`workbench.emptyAskDescription`、`workbench.emptyAgentTitle`、
`workbench.emptyAgentDescription`。

新增的 key：`workbench.composerPlaceholder`、`workbench.emptyTitle`、
`workbench.emptyDescription`（中英各一份，文案见第 4、5 节）。

`lib/i18n/i18n.test.ts` 中若有对 key 集合一致性（中英文 key 集合相同）的校验，会自然覆盖
新旧 key 是否成对增删，无需额外新增校验。

## 边界与异常

- **已有用户升级后**：`chrome.storage.local` 里可能残留 `{ defaultMode: 'agent', ... }`。
  新的 `loadWorkbenchPreferences` 不会因为多出的字段报错（校验只看
  `attachPageByDefault`），直接忽略，用户体验上等同于该字段从未存在过。
- **正在进行中的对话**：这是纯前端展示层改动，不涉及会话数据结构（Dexie
  `lib/db.ts`），不影响历史消息回放。

## 安全与隐私

不涉及。改动范围是 UI 文案与状态管理，不改变工具权限模型、确认门逻辑或数据访问路径。

## 测试

- 更新 `lib/workbench/preferences.test.ts`：移除对 `defaultMode` 校验的用例，补充「存储对象
  带多余 `defaultMode` 字段时仍能正常加载」的用例。
- 更新 `entrypoints/sidepanel/components/workbench-components.test.tsx`：移除
  `changes empty suggestions between ask and agent modes` 等按 mode 分支断言的用例，替换为
  「空状态展示统一文案」的用例；移除对 `ModeSwitch` 的测试（如有）。
- 更新 `components/settings-components.test.tsx`：移除对「默认工作模式」radio 组的断言
  （如 `click(screen.getByRole('radio', { name: 'Agent tasks' }))`）。
- `lib/final-review.test.ts` 中对 `store.ts` 源码字符串的断言（`withoutBrowserTools` 相关）
  不受影响，保持不变。
- 手动验证（`pnpm dev` 加载解包扩展）：
  - 侧边栏顶部不再出现模式切换；空状态与 composer 展示统一文案。
  - 关闭「附加页面」后发消息，agent 不应发起任何 `browser_*` 工具调用；重新打开后可以。
  - 设置页「通用」分组下只剩「默认附加当前网页」一项。
  - 升级场景：手动往 `chrome.storage.local` 写入带 `defaultMode` 的旧格式对象，刷新侧边栏
    确认不报错、设置页正常加载。

## 验收标准

- [ ] `ModeSwitch.tsx` 已删除，`App.tsx`/`WorkbenchComposer.tsx`/`WorkbenchEmptyState.tsx`
      中不再有 `mode` 相关 state/prop。
- [ ] `WorkbenchMode` 类型和 `WorkbenchPreferences.defaultMode` 字段已从
      `lib/workbench/preferences.ts` 移除；`loadWorkbenchPreferences` 对携带旧
      `defaultMode` 字段的存储对象不报错。
- [ ] `GeneralSettings.tsx` 只保留「默认附加当前网页」一项。
- [ ] i18n 中旧的 ask/agent 相关 key 已移除，新的统一 key 中英文均已补齐。
- [ ] `pageAttached` / `withoutBrowserTools` / 确认门行为与改动前完全一致（回归验证）。
- [ ] `pnpm compile` 与 `pnpm test` 通过。

## 开放问题

- 无。
