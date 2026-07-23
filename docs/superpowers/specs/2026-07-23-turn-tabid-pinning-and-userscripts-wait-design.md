# 设计：回合级固定 tabId + `browser_inject_script` 开关等待重试

日期：2026-07-23

## 背景

按 `docs/chrome-store-submission-guide.md` 的"提交前必须先做的一件事"人工验证 Spec-0002 时发现：
`browser_inject_script` 遇到「允许用户脚本」（Allow User Scripts）开关关闭时，只会一次性报错并结束
本轮工具调用（`entrypoints/background.ts` 的 `injectScript()` 捕获 `userScripts.execute()` 异常后
包一层提示文案再 throw），并不会真正"停下来等用户去开关"。此前
[2026-07-23-inject-script-permission-blocked-notice-design.md](2026-07-23-inject-script-permission-blocked-notice-design.md)
已经解决了"报错发生后展示得不够显眼"的问题（新增 `UserScriptsBlockedNotice` 卡片），但那份设计
明确"不做提前检测/等待，沿用被动报错原则"——本设计在此基础上更进一步：报错后不再直接结束，
而是主动等待用户开启开关并自动重试。

推进这个设计时发现一个必须先解决的前置问题：引导用户去 `chrome://extensions` 开开关需要新开一个
标签页，这会改变浏览器的"当前激活标签页"。而 `entrypoints/background.ts` 里几乎所有工具处理函数
（约 19 处）都是靠 `browser.tabs.query({ active: true, currentWindow: true })` **临时查询**目标
标签页，而不是在回合开始时固定下来。如果不修，任何"等待期间打开过其他标签页"的重试都会打错 tab。
经确认，这个问题范围更广——回合内任意时刻用户手动切换 tab，后续工具调用都会跟错目标——因此这次
一并修复为回合级别的固定 tabId，而不是只在等待重试这条路径上打补丁。

## 决策

### 1. 回合级固定 tabId

- `entrypoints/sidepanel/store.ts` 的 `send()` 在创建 `Agent` **之前**，先发一次
  `GET_ACTIVE_TAB`（已有消息类型，`background.ts` 的 `getActiveTab()`）拿到这一回合的 `tabId`，
  传给 `createBrowserTools({ tabId })` / `createBrowserAgent({ tabId, ... })`。
- `lib/messaging.ts` 里所有会作用于某个标签页的 Payload 接口（`QueryDomPayload`、
  `GetHtmlPayload`、`GetScriptsPayload`、`GetStylesheetsPayload`、`GetComputedStylePayload`、
  `CaptureScreenshotPayload`、`InjectScriptPayload`、`SetStylePayload`、`ModifyDomPayload`、
  `ClickElementPayload`、`TypeTextPayload`、`SelectOptionPayload`、`ScrollPagePayload`、
  `NavigateTabPayload`、`SetStoragePayload`，以及 `EXTRACT_PAGE`/`GET_SELECTION` 两个无 payload
  的消息类型改为携带 `{ tabId }`）新增 `tabId: number` 字段。
- `lib/agent/tools.ts` 里每个 `AgentTool.execute()` 在构造 payload 时都带上创建时传入的
  回合 `tabId`（闭包捕获，不是每次现查）。
- `entrypoints/background.ts` 里对应的约 19 处 `browser.tabs.query({ active: true, currentWindow:
  true })` 全部改为直接使用 payload 传入的 `tabId`，用 `browser.tabs.get(tabId)` 校验该标签页
  是否仍存在；不存在时报错文案从"未找到活动标签页"改为"目标标签页已关闭"（语义更准确——已经不是
  "找不到活动标签页"，而是"回合绑定的那个标签页没了"）。
- **例外**：`browser_get_active_tab` 工具（对应 `GET_ACTIVE_TAB` 消息、`getActiveTab()` 函数）
  保留"实时查询当前激活标签页"的语义不变。它的用途是让模型了解"用户现在焦点在哪"，这是一个和
  "本回合操作目标"正交的问题，不应被固定住。
- `RESET_TURN_SNAPSHOT`、`REVERT_CHANGES` 等操作依旧按 tabId 索引（`lib/agent/turn-snapshot.ts`
  本身已经是按 tabId 存储，不用改），语义上和"回合固定的 tabId"自然对齐。

### 2. `browser_inject_script` 开关等待重试

- `execute()` 是在**侧边栏（sidepanel）页面上下文里运行**，不是 background service worker——
  确认过 `tools.ts` 由 `store.ts` 在 sidepanel 里调用，因此等待循环可以直接用普通
  `setTimeout`/`setInterval`，不受 MV3 service worker 30 秒空闲终止的影响，也不需要新增
  `chrome.alarms` 权限（避免在 Chrome Web Store 提交材料刚准备完的节点上引入新权限、
  再次触发人工深度审核）。
- `lib/agent/tools.ts` 的 `browserInjectScriptTool.execute()` 改造：
  1. 先发一次 `INJECT_SCRIPT`（带回合固定的 `tabId`）。
  2. 若失败且命中 `isUserScriptsToggleBlocked`（已有工具函数，字符串标记匹配，见
     `lib/agent/inject-script-blocked.ts`）→ 不立刻抛错，进入等待循环：每 **2.5 秒**重发同一个
     `INJECT_SCRIPT`（同一 `tabId`、同一段代码），直到成功、超时（**3 分钟**）或被取消。
  3. 若失败但不是开关问题（语法错误等）→ 维持现状，立刻抛错，不进入等待循环。
  4. 每次重试通过 `execute()` 的 `onUpdate(partialResult)` 回调推送进度快照（等待秒数、重试
     次数），驱动现有的 `tool_execution_update` 事件，让侧边栏提示条实时刷新，而不是一句
     静态文案。
  5. 取消复用现有基础设施：`execute(toolCallId, params, signal, onUpdate)` 的 `signal` 已经和
     "停止"按钮的 `activeAgent.abort()` 绑定；等待循环监听这个 `signal`，中止时立刻结束等待并
     以"用户取消"为由抛错。提示条上新增的「取消等待」按钮只是调用同一个 `activeAgent?.abort()`，
     不新造一套取消通道。
  6. 等待期间检测到目标标签页已关闭（`browser.tabs.get` 抛错）→ 立刻结束等待并报错，不用等到
     3 分钟超时。
  7. 一旦重试成功 → 循环结束，正常把结果返回给 Agent，本回合无缝继续；工具结果文案里附一句
     "（等待用户开启「允许用户脚本」开关后完成注入）"给模型一点上下文，但不需要模型做任何特殊
     处理。
  8. 超时或取消 → 抛出清晰区分"用户取消等待"和"等待开关超时（3 分钟）"两种文案的错误，走现有的
     工具调用失败展示路径。
- `entrypoints/sidepanel/store.ts`：`userScriptsBlockedNotice: boolean` 升级为一个状态对象
  （例如 `{ waiting: boolean; elapsedSeconds: number; attempts: number } | null`），由
  `tool_execution_update`/`tool_execution_end` 事件驱动更新；新一轮对话/新会话按现有规则整体
  重置（与 `toolActivities: []` 出现的每一处保持一致）。
- `entrypoints/sidepanel/App.tsx`：`UserScriptsBlockedNotice` 组件增加等待中状态的展示
  （"⏳ 等待中…已重试 N 次"）和「取消等待」按钮；成功/取消/超时后自动切换文案或收起。

## 边界情况

- **等待期间用户关闭目标标签页**：`browser.tabs.get(tabId)` 抛错 → 立刻终止等待并报错（见决策
  2.6）。
- **等待期间用户在原标签页里跳转了页面**：仍对同一 `tabId` 重试注入——把"目标"理解为"这个标签页"
  而不是"这个标签页当时的那份 DOM"，与撤销机制（`turn-snapshot.ts` 按 tabId 索引）的语义一致；
  跳转后脚本语义可能对不上是已知边界情况，不在本次修复范围内。
- **同一回合内多次调用 `browser_inject_script`**：每次调用各自独立走等待循环，但都用同一个回合级
  `tabId`，行为一致。
- **等待到一半用户发了新一轮对话**：`store.ts` 会创建新的 `Agent` 实例；需要确认这条路径会让旧
  回合的 `signal` 被 abort（从而终止旧的等待循环），避免出现"孤儿轮询"在后台空转到超时——实现
  阶段需专门补一个测试验证这一点。

## 测试计划

- `lib/agent/inject-script-blocked.ts` 已有的 `isUserScriptsToggleBlocked` 单测保留不变。
- 新增 `tools.ts` 等待/重试/取消/超时逻辑的单测：用 vitest fake timers 模拟时间流逝，mock
  `sendMessage` 依次返回"开关未开"→"开关未开"→"成功"，断言重试次数、轮询间隔与最终结果；
  分别测试取消路径（触发 `signal.abort()`）和超时路径（推进到 3 分钟）。
- `background.ts` 改查询为透传 `tabId` 的回归测试：构造"当前激活标签页是 A，但 payload.tabId 指向
  标签页 B"的场景，断言实际操作作用在 B 上而不是 A 上（覆盖第一部分改动的核心行为）。
- 新一轮对话打断旧回合等待循环的测试（对应"边界情况"最后一条）。
- 上述测试全部落在 `lib/**/*.test.ts`，符合现有 `vitest.config.ts` 覆盖范围，不需要新增测试
  基建。
- 实现完成后，回到 `docs/chrome-store-submission-guide.md` 的"提交前必须先做的一件事"重新走一遍
  人工验证：开关关闭时触发 `browser_inject_script`，确认侧边栏正确进入等待态、开启开关后自动
  完成注入且可撤销、取消等待和超时两条路径也表现正常。

## 不做的事

- 不做"提前检测开关状态、AI 动手前主动展示引导横幅"——沿用 Spec-0002 与上一份设计已确认的被动
  报错原则，仍是先尝试一次失败后才进入等待，不在调用前预判。
- 不引入 `chrome.alarms` 或其他需要新增 manifest 权限的机制——等待循环运行在 sidepanel 页面
  上下文，用普通定时器即可，避免在商店提交节点新增权限触发再次深度审核。
- 不做跨会话/跨浏览器重启的等待持久化——等待循环的生命周期绑定当前这一次 `Agent` 实例（内存态），
  侧边栏关闭或页面刷新即视为放弃等待，与现有"停止"按钮、确认闸门的生命周期一致，不做更强的持久化
  保证。
- 不改变"回合固定 tabId"里 `browser_get_active_tab` 的实时查询语义（见决策 1 的例外）。
- 不引入结构化错误码字段——继续用字符串标记匹配识别"开关未开"这一种场景，与上一份设计的判断
  一致（YAGNI，只有这一种失败场景需要特殊处理）。
