# 设计：去掉聊天界面的手动页面附加开关，只保留受限页面自动降级

- 状态：已批准 Approved
- 日期：2026-07-31
- 关联：`entrypoints/sidepanel/App.tsx`、
  `entrypoints/sidepanel/components/{PageContextBar,WorkbenchComposer}.tsx`、
  `lib/workbench/presentation.ts`、`lib/workbench/preferences.ts`、
  `components/GeneralSettings.tsx`、`lib/i18n/locales/{zh,en}.ts`
- 相关背景：`docs/superpowers/specs/2026-07-31-remove-ask-agent-mode-design.md`（去掉了
  `ModeSwitch`，确认 `pageAttached` 是唯一真正生效的开关）

## 背景

`pageAttached` 决定 agent 本轮是否拥有 `browser_*` 工具（`store.ts` 里
`tools: options.withoutBrowserTools ? [] : undefined`，`withoutBrowserTools = !pageAttached`）。
目前它是 `App.tsx` 里的手动状态，且有两处重复的交互入口：

- `PageContextBar`：常驻横幅，铺满侧边栏顶部宽度，四种状态（loading/error/restricted/
  available）都会渲染一整条。
- `WorkbenchComposer`：工具栏里的 pill 按钮，同样展示页面标题 + 附加状态，点击也能切换。

两处控件展示的是同一个状态、做的是同一件事，多数会话里用户从未主动切换过（默认就是
附加）。`restricted` 状态（如 `chrome://` 页面）目前也不是全自动降级——`PageContextBar`
会显示「不使用页面上下文继续」按钮，需要用户手动点一下 `pageAttached` 才会变 `false`；
在此之前，agent 仍然带着一整套无法生效的浏览器工具运行。

## 目标

- `pageAttached` 从手动状态改成纯派生值：受限/读取出错的页面自动、无需点击地不带浏览器
  工具；其余情况跟随设置页里的全局默认值 `attachPageByDefault`。
- 删除聊天界面里所有交互式的附加/分离开关（`PageContextBar` 整体删除，`WorkbenchComposer`
  的 pill 改为不可点击的状态提示，且只在 restricted/error 时渲染）。
- 设置页 `GeneralSettings` 的 `attachPageByDefault` 保持唯一一个能控制默认附加行为的入口。

## 非目标

- 不改变 `withoutBrowserTools` 传导到 `store.ts`/`createBrowserAgent` 之后的行为，也不改变
  `lib/agent/permissions.ts` 的确认门/权限分类逻辑。
- 不引入"每轮临时覆盖全局默认值"的新机制。回归影响明确接受：以后想临时改变某一轮是否
  附加页面，只能去设置页改 `attachPageByDefault`，聊天界面不再提供逐轮覆盖能力。
- 不改变 `pageContext` 的抓取时机、`EXTRACT_PAGE` 消息协议或 `refreshPageContext` 的重试
  机制本身，只改变它被如何展示、以及从它派生 `attached` 的规则。
- `loading` 状态不特殊处理，等价于 `available`（跟随全局默认值），不强制 `false`，也不
  展示任何提示——这个状态通常一闪而过，没必要让 composer 出现闪烁的横幅。

## 设计

### 1. 派生函数（`lib/workbench/presentation.ts`）

新增一个纯函数，和该文件里现有的 `filterShortcutCommands` 等纯函数放在一起：

```ts
export function resolvePageAttached(
  status: PageContextState['status'],
  attachPageByDefault: boolean,
): boolean {
  if (status === 'restricted' || status === 'error') return false;
  return attachPageByDefault;
}
```

`PageContextState['status']` 类型定义在 `entrypoints/sidepanel/store.ts`，直接复用，不重复
定义。

### 2. `App.tsx`

- 删除 `const [pageAttached, setPageAttached] = useState(true)`。
- 改为渲染时计算：
  `const pageAttached = resolvePageAttached(pageContext.status, workbenchPreferences.attachPageByDefault)`。
- 删除 `onToggleAttached`/`onTogglePageAttached` 两个 handler。
- 不再渲染 `<PageContextBar />`。
- `WorkbenchComposer` 不再需要 `pageAttached`/`onTogglePageAttached` 这两个 prop，只保留
  `pageContext`。
- `submitMessage` 里 `send(undefined, { withoutBrowserTools: !pageAttached })` 调用不变，
  只是 `pageAttached` 的来源变了。

### 3. 删除 `PageContextBar.tsx`

组件整体删除，无替代组件——它承担的四种状态展示，`available`/`loading` 不再展示任何东西，
`restricted`/`error` 的提示下沉到 composer（见下一节）。

### 4. `WorkbenchComposer.tsx`

- `WorkbenchComposerProps` 删除 `pageAttached`、`onTogglePageAttached` 两个字段。
- 原来那个可点击的 pill（第 234-247 行）替换为一行**只读**提示，插入在工具栏 row（`/` 按钮
  那一行）**上方**，只在以下条件渲染：
  - `pageContext.status === 'restricted'`：纯文字提示，复用 `workbench.restrictedPage` 文案，
    不带任何按钮。
  - `pageContext.status === 'error'`：文字提示（复用 `workbench.pageContextUnavailable`）+
    一个内联的「重试」文字按钮，`onClick` 调用透传下来的 `onRetry`（即原来
    `refreshPageContext`，需要新增一个 `onRetry` prop 传给 `WorkbenchComposer`，从
    `App.tsx` 传入 `refreshPageContext`）。
  - `available`/`loading`：不渲染任何东西。

### 5. `GeneralSettings.tsx` / `preferences.ts`

不变。`attachPageByDefault` 仍是唯一的全局默认值开关。

### 6. i18n（`lib/i18n/locales/zh.ts` / `en.ts`）

删除（只被交互 pill/横幅使用，且新提示不再需要）：
`workbench.pageContext`、`workbench.pageContextAttached`、`workbench.pageContextDetached`、
`workbench.addPageContext`、`workbench.removePageContext`、
`workbench.continueWithoutPageContext`、`workbench.pageContextLoading`。

保留：`workbench.restrictedPage`、`workbench.pageContextUnavailable`、
`workbench.retryPageContext`（复用在新的 composer 内联提示里）。

不新增 key。

## 边界与异常

- **`error` → 重试后恢复 `available`**：`onRetry` 触发 `refreshPageContext`，成功后
  `pageContext.status` 变 `available`，composer 的提示行自动消失，`resolvePageAttached`
  自动跟随全局默认值——不需要额外状态同步。
- **`restricted` 页面没有重试入口**：这是内容脚本本来就无法注入的页面（如
  `chrome://`），重试没有意义，保持无按钮的纯提示。
- **旧版存储里没有需要迁移的字段**：`pageAttached` 从未持久化过（一直是组件内状态），这次
  改动不涉及 `chrome.storage.local` 数据结构变化。

## 安全与隐私

`resolvePageAttached` 让「受限/异常页面」的降级从「用户可能忘记点」变成「强制生效」，是
对现状的加固而非削弱：以前用户如果没注意到 `restricted` 横幅、直接发消息，agent 会带着一
整套实际上会失败的浏览器工具运行（无实质安全影响，但行为不一致）；改动后这条路径不再依赖
用户操作。不改变工具权限模型或数据访问路径。

## 测试

- 新增 `lib/workbench/presentation.test.ts`（或在现有文件追加）覆盖
  `resolvePageAttached`：`available`/`loading` 各自跟随 `attachPageByDefault` 为
  `true`/`false` 两种取值；`restricted`、`error` 无论 `attachPageByDefault` 是什么都返回
  `false`。
- 更新 `entrypoints/sidepanel/components/workbench-components.test.tsx`：
  - 删除针对 `PageContextBar` 的渲染/点击测试（如有）。
  - 删除 composer pill 点击触发 `onTogglePageAttached`/切换 `withoutBrowserTools` 的用例。
  - 新增：`status: 'restricted'` 时 composer 渲染只读提示、无可点击元素；`status: 'error'`
    时提示 + 「重试」按钮点击调用 `onRetry`；`status: 'available'`/`'loading'` 时提示行不
    渲染。
  - 更新原先断言 `chatStore.send` 被 `withoutBrowserTools: true` 调用的用例，确认新的触发
    路径是"页面 restricted/error 状态"而不是"点击切换"。
- `pnpm compile`、`pnpm test`、`pnpm build` 收尾验证。
- 手动验证（`pnpm dev` 加载解包扩展）：
  - 打开普通网页：composer 无任何附加状态提示，agent 正常使用 `browser_*` 工具（默认值为
    附加时）。
  - 打开 `chrome://extensions`：composer 自动出现"本页面无法读取"提示，无需点击，agent
    本轮直接以无浏览器工具模式回答。
  - 设置页关闭「默认附加当前网页」后回到普通网页：composer 无提示，但发消息后 agent 不
    应发起 `browser_*` 调用（因为默认值已关闭）。

## 验收标准

- [ ] `PageContextBar.tsx` 已删除，`App.tsx` 中不再渲染。
- [ ] `App.tsx` 中 `pageAttached` 不再是组件状态，改为基于 `resolvePageAttached` 的派生值；
      `onToggleAttached`/`onTogglePageAttached` 相关代码已全部移除。
- [ ] `WorkbenchComposer.tsx` 不再有可点击的附加/分离开关；`restricted`/`error` 状态展示只
      读提示，`error` 状态附带可用的「重试」按钮。
- [ ] 相关 i18n key 已按上文清单增删，中英文成对。
- [ ] `resolvePageAttached` 单测覆盖四种状态 × 默认值组合。
- [ ] `pnpm compile`、`pnpm test`、`pnpm build` 通过。

## 开放问题

- 无。
