# 设计：`browser_inject_script` 权限受阻时的显眼提示

日期：2026-07-23

## 背景

`browser_inject_script` 依赖 Chrome 138+ 的「允许用户脚本」（Allow User Scripts）开关。开关关闭时，
`entrypoints/background.ts` 的 `injectScript()` 会捕获 `browser.userScripts.execute()` 抛出的异常，
包装成一句中文提示（含"请在 chrome://extensions 打开本扩展详情页，开启「允许用户脚本」…"）后
再次抛出，经 `tools.ts:520` 转成 Agent 工具调用的错误结果。

手动验证 Spec-0002 时发现：这条报错文案本身完全正确、清晰，但只会出现在侧边栏里默认折叠的
"Agent 工具调用"面板（`entrypoints/sidepanel/App.tsx` 的 `ToolActivityList`）里，且以压缩 JSON
形式展示。更关键的是，当 `browser_inject_script` 失败后，Agent 往往会自动改用别的结构化工具
（如连续调用 `browser_set_style`）把用户的请求"绕过去"完成，最终对话看起来完全成功——用户
根本不会去展开那个折叠面板，永远不知道有一项更强的能力（任意脚本注入）被 Chrome 挡住了。

已确认无法绕开的约束：
- **不能自动开启该开关**——`chrome.userScripts` 是"安装时声明"权限，不支持
  `chrome.permissions.request()` 之类的运行时授权 API；官方文档明确"用户必须通过
  `chrome://extensions/` 界面手动开启"。这是 Chrome 刻意的安全设计（防止扩展绕过用户同意
  自行解锁"在任意页面执行任意脚本"的能力），扩展没有任何编程手段可以替用户点这个开关。
- **不做提前检测 + 主动横幅**——`docs/specs/0002-chrome-web-store-remote-code-compliance.md`
  已确认的方案是被动报错（失败后才提示），本设计不改变这一点，只解决"报错发生后展示得不够
  显眼"的问题。

## 决策

1. **触发范围**：只要 `browser_inject_script` 因为这个开关失败，就一律显眼展示——哪怕 Agent
   随后用别的工具把任务完成了。理由：用户应该知道有一项更强的页面改造能力当前不可用，以便
   未来遇到 `browser_set_style`/`browser_modify_dom` 搞不定的复杂改造时，理解为什么会失败或
   降级。
2. **检测方式**：字符串标记匹配，不改协议。`entrypoints/background.ts` 里那句提示文案已经是
   固定措辞（含"允许用户脚本"四个字）。侧边栏 `store.ts` 处理 `tool_execution_end` 事件时，
   判断：
   ```
   event.toolName === 'browser_inject_script'
   && event.isError
   && String(event.result 对应的错误文本).includes('允许用户脚本')
   ```
   不引入结构化错误码（如 `{ code: 'user_scripts_disabled' }`）——目前只有这一种失败场景需要
   特殊处理，加一层端到端的错误码字段（改 `lib/messaging.ts` 的结果类型 + `tools.ts` 的
   throw + `store.ts` 的处理）对单一场景而言是过度设计。代价：以后如果修改那句中文文案的措辞，
   需要同步记得改这里的字符串匹配——只有这一处，风险可控。
3. **UI 呈现**：新增一个与 `ConfirmationCard`/`UndoBar`同级的卡片组件（沿用 amber 警示色系），
   渲染在消息列表里，不塞进折叠的 `ToolActivityList`：
   ```
   ⚠️ 有一项更强的页面改造能力被挡住了
   注入脚本需要先在本扩展详情页开启「允许用户脚本」开关。
   [ 🔧 前往开启 ]
   ```
   "前往开启"按钮调用 `browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` })`
   跳转到扩展自己的详情页——这只是导航，用户仍需自己手动点开关，不违反"不能代替用户操作"的
   限制。
4. **生命周期**：新状态（如 `blockedCapabilityNotice: { message: string } | null`）跟现有
   `toolActivities` 完全同步重置——`sendMessage`（发起新一轮提问）、`clear`（新对话）、
   切换/删除会话时都清空。每一轮内只要触发就显示，换新一轮或新对话即消失，不做跨会话持久提醒。

## 影响范围

- `entrypoints/sidepanel/store.ts`：`tool_execution_end` 处理逻辑新增检测分支 + 新状态字段 +
  相应的重置点（与 `toolActivities: []` 出现的每一处保持一致）。
- `entrypoints/sidepanel/App.tsx`：新增一个展示组件（放在 `ToolActivityList` 与
  `ConfirmationCard`/`UndoBar` 之间的消息流里），接一个"前往开启"按钮。
- 不改动 `entrypoints/background.ts`、`lib/messaging.ts`、`lib/agent/tools.ts`、
  `lib/agent/permissions.ts`——现有报错文案和协议保持不变。

## 测试计划

项目当前 vitest 覆盖范围只到 `lib/**/*.test.ts`（`entrypoints/`、`components/` 没有测试基建，
见 CLAUDE.md）。本设计涉及的改动全部在 `entrypoints/sidepanel/`，属于纯 UI 状态/组件逻辑：

- 给 `store.ts` 里新增的检测分支补一个轻量单测（构造一个 `tool_execution_end` 事件，断言
  `blockedCapabilityNotice` 状态按预期更新/重置）——如果测试文件要放在 `entrypoints/` 下，
  需要先确认 `vitest.config.ts` 的 `include` 范围是否需要扩展到 `entrypoints/**/*.test.ts`
  （目前只包含 `lib/**/*.test.ts`），这个决定留给实现阶段。
- 不新增 React 组件渲染测试（项目里目前没有这类测试基建，超出本次改动范围）。
- 手动验证：复现 Spec-0002 手动测试步骤（开关关闭 → 触发 `browser_inject_script` → Agent
  fallback 到 `browser_set_style` 完成任务），确认新卡片正确出现且"前往开启"按钮能跳转到
  正确的详情页 URL。

## 不做的事

- 不自动开启「允许用户脚本」开关（技术上不可行，且违反 Chrome 的权限设计意图）。
- 不做"提前检测开关状态、AI 动手前主动展示引导横幅"的方案（沿用 Spec-0002 已确认的被动报错
  原则）。
- 不引入结构化错误码字段（YAGNI，目前只有一种需要特殊处理的失败场景）。
- 不改动其余工具的错误展示方式（`ToolActivityList` 折叠面板本身保持现状，只是新增一个不会被
  折叠遮住的提示）。
