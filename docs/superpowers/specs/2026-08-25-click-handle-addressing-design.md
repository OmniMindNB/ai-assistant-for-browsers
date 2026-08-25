# 设计：通用元素句柄寻址（把 fieldId 从表单扩展到 browser_click）

- 状态：已接受 Accepted（设计已评审通过，待写实现计划）
- 日期：2026-08-25
- 关联：ADR-0003（Agent 循环与工具调用）、Spec-0005（表单填写可靠性 v1，历史文档已于 2026-08-22 归档删除，可用 `git show 5803986^:docs/specs/0005-form-fill-reliability.md` 查看）

## 背景

`lib/agent/tools.ts` 里的 `browser_click`/`browser_type`/`browser_select`/`browser_set_style` 目前都要求模型自己写 CSS 选择器去定位元素，只有表单字段（`browser_get_form` + `browser_fill_form`）走了 Spec-0005 引入的「稳定句柄 `fieldId` + 结构指纹校验 + 写入前后回读」这套更可靠的寻址模式。选择器猜错——尤其是导航链接、无表单归属的按钮、卡片点击区、`role="button"` 的自定义组件——是 `browser_click` 失败的常见根源。

调研 Alibaba 的 `page-agent`（一个 in-page 脚本形态的浏览器 agent，同源自 browser-use）发现它对所有可交互元素都走「DOM 抽取成带编号的 `FlatDomTree` → 按编号解析回活元素引用」的寻址方式，从不要求模型现写选择器。但它的执行模型是一个**常驻页面的脚本实例**，可以在内存里维护一张跨调用存活的 `Map<index, Element>`；Runi 的写工具是通过 `browser.scripting.executeScript` **每次现序列化、现执行、执行完即销毁**的一次性注入函数，天然没有跨调用的页面内存状态。因此不能照搬 page-agent 的活对象索引表，而应该复用 Runi 自己已经在 Spec-0005 里验证过的「可重新求值路径」模型（`FormFieldPathStep`：selector 步进 + 穿透 open shadow root，每次调用重新解析）。

`FormFieldDescriptor`/`FormFieldKind` 已经把 `button`/`submit`/`checkbox`/`radio` 建模为 `clickable`，说明这套结构本来就不是「只为表单设计」，只是采集范围目前限定在表单控件上。

## 目标（Goals）

1. `browser_click` 能接受 `browser_get_form` 发放的 `fieldId`，不再强制要求选择器。
2. `browser_get_form` 的采集范围从「表单控件」扩展到「表单控件 + 页面上的通用可交互元素」（链接、无表单归属的按钮、`role` 或 `tabindex` 表明可交互的自定义组件），复用同一张句柄表、同一套 path 解析与结构指纹校验。
3. 保留选择器寻址作为兜底路径，供 `browser_get_form` 采集不到的元素使用（例如 iframe 内、closed shadow root 内）。

## 非目标（Non-Goals）

延续 Spec-0005 的谨慎范围原则，这次明确不做：

- **不做 iframe 穿透**。继续沿用现有 `unreachable.iframes` 计数上报，不引入 `frameId` 维度——那是一次独立规模的改动，需要重新论证跨 origin 安全边界。
- **不改 `browser_type`/`browser_select`**。它们的目标本来就是表单类输入控件，天然落在 `browser_get_form` 现有采集范围内；文档里"仅用于 one-off 编辑"的措辞已经覆盖了这个场景，没有必要再加一条平行的句柄路径。
- **不做事件监听器级别的"真·可点击"检测**。只用标签/`role`/`tabindex` 白名单和可见性判断，不读 JS 事件监听器（对 React 等框架的合成事件本来就不可观测），也不用 `cursor: pointer` 这类样式启发式。宁可漏检，不引入噪声。
- **不改 `tool-policy.ts` 的预算数字或 `permissions.ts` 的权限分级**。`browser_click` 依然是 `CONFIRM_TOOL_NAMES`，这次只新增一种寻址方式，不改变信任分级。
- **不做概念重命名**。`form-schema.ts`/`form-dom.ts`/`tab-form-fields.ts`/`FormFieldDescriptor`/`GetFormPayload` 等命名全部保留，只扩展采集逻辑——重命名没有功能收益，且和 CLAUDE.md 里"不做超出任务范围的重构"的项目原则相悖。

## 用户故事 / 用例

- 作为用户，我让 AI 点击页面导航栏里的"设置"链接，它先 `browser_get_form` 拿到这个链接的 `fieldId`，再用 `fieldId` 点击，而不是自己拼一个脆弱的 `nav a:nth-child(3)` 选择器。
- 作为用户，AI 要点一个用 `<div role="button">` 实现的自定义下拉触发器，能通过 `browser_get_form` 发现它并用 `fieldId` 精确点中，即使它既不在 `<form>` 里也不是原生 `<button>`。
- 作为用户，我看到确认卡片上写的是"点击链接「登录」"而不是一串 CSS 选择器。
- 作为开发者，`resolveFieldKind`/`pickFieldLabel`/`CLICKABLE_KINDS` 这些新增判定逻辑是纯函数，能在 node 环境单测；DOM 采集/点击派发逻辑在 jsdom 环境单测，不需要真机。

## 设计方案

### 数据模型改动

`FormFieldKind`（`lib/messaging.ts`）新增 `'link'`，专指 `<a href>`；`role`/`tabindex` 表明可交互的通用元素（`role="button"`、`role="tab"` 等、无表单归属的原生 `<button>`）仍归入既有的 `'button'` 桶，不再细分角色。`CLICKABLE_KINDS`（`form-schema.ts`）加入 `'link'`。

`FormFieldDescriptor` 新增可选字段 `href`：仅 `kind === 'link'` 时有值，给模型判断"这是不是我要的那个链接"，也给确认卡片文案用。

### 采集谓词扩展（`form-dom.ts`）

`isFieldTag` 目前只认 `input|textarea|select|button` 或 `isContentEditable`。扩展为再认：

- `<a>` 且带 `href` 属性（排除没有 `href` 的锚点，如纯 `<a name=...>` 占位符）；
- `role` 属性命中固定白名单：`button|link|tab|menuitem|checkbox|radio|switch`；
- `[tabindex]` 属性存在且解析为 `>= 0`（显式声明可聚焦，常见于自定义可交互组件）。

`resolveFieldKind`（`form-schema.ts`）新增分支：`tag === 'a' && href` → `link`；命中上述 role/tabindex 但非原生表单标签 → `button`。

### 修复一个被本次范围放大的既有缺口

`pickFieldLabel` 当前的候选链（`forLabelText → ancestorLabelText → ariaLabel → labelledByText → placeholder → name`）里没有"元素自身文本"这一项。表单输入场景里这不常触发，但通用按钮/链接的标签主要来源就是可见文本——一个没写 `aria-label` 的 `<button>下单</button>` 今天采集出来 `label` 是 `undefined`。

修复：对 `kind` 为 `link`/`button`/`submit` 的候选，在候选链末尾追加 `textOf(element)`（裁到既有的 `MAX_LABEL_CHARS`）。这个改动只让原本 `undefined` 的情况变得有文本，不改变任何已经非空的标签，风险低、且对现存表单按钮同样是修复而非回归。

### browser_click 工具签名（`tools.ts`）

```ts
parameters: Type.Object({
  fieldId: Type.Optional(Type.String({ description: 'Field id from browser_get_form. Prefer this over selector whenever the target was already listed there.' })),
  selector: Type.Optional(Type.String({ description: 'CSS selector fallback — only for elements browser_get_form did not return (e.g. inside an iframe).' })),
  index: Type.Optional(Type.Number({ description: 'Which matched element to click when using selector, 0-based. Defaults to 0.' })),
})
```

运行时要求 `fieldId` 与 `selector` 恰好给一个，否则抛出清晰错误（"必须提供 fieldId 或 selector 之一"）。工具描述文案更新为优先引导使用 `fieldId`。

### 执行路径与复用（`messaging.ts` / `background.ts` / `fill-form-request.ts`）

`ClickElementPayload` 新增可选 `fieldId`。`CLICK_ELEMENT` handler 分两条路：

- **有 `fieldId`**：查 `getFormFieldsForTab(tabId)`；表不存在或 URL 不匹配 → 返回 `fieldsTableStale: true`（复用 `FILL_FORM` 已有的语义与提示文案："字段表已失效，请重新调用 browser_get_form"）；命中则比对 `expect` 结构指纹，不符 → `mismatch`。这段查表/校验的分支逻辑写成纯函数放进 `fill-form-request.ts`（仿 `planFormFill`的既有模式），保持 `background.ts` 只做 I/O 编排，不在 handler 里内联判断分支。
- **有 `selector`**：走现有逻辑，不变。

`applyFormFill` 里给 submit 按钮做的"解析 path → 比对 expect → 派发点击"这段注入函数逻辑，抽成一个独立导出的自包含函数 `applyElementClick(path, expect)`（`form-dom.ts`），`FILL_FORM` 的 submit 步骤和新的 `fieldId` 路径 `CLICK_ELEMENT` 都调用它，避免两处维护同一段点击派发代码（disabled/不可见/被遮挡判断、点击后回读）。

### 确认闸门（`permissions.ts`）

不做结构性改动。`resolveSubmitIntent`/`form-submit.ts` 的"是否构成表单提交"判定基于**解析出的真实 DOM 元素的结构属性**（是否在 `<form>` 内、`type=submit`），和"这次是靠 selector 还是 fieldId 找到它"无关。实现阶段会用真实页面验证这个假设（确认 `fieldId` 路径下 `resolveSubmitIntent` 依然被正确调用），如果发现假设有误再回来改设计，不预先加防御代码。

### 确认卡片文案（`confirm-summary.ts`）

`fieldId` 路径下的点击展示改用 `label`/`href` 渲染（如"点击链接「登录」"、"点击按钮「下单」"），替代原来的 `已点击匹配 "{selector}" 的第 N 个元素`；`selector` 路径不变。脱敏规则复用既有的敏感字段判断逻辑，保持路径一致。

## 测试策略

- **`form-schema.test.ts`**（unit/node）：`resolveFieldKind` 覆盖 `<a href>` → `link`、`role="button"` → `button`、`[tabindex="0"]` 的 div → `button`、无 `href` 的 `<a>` → 不识别；`pickFieldLabel` 在无 aria-label/placeholder/name 时回退元素自身文本；`CLICKABLE_KINDS` 含 `'link'`。
- **`form-dom.dom.test.ts`**（jsdom）：`collectFormFields` 能采到"表单外的按钮/链接/`role=button` 的 div"；`applyElementClick` 抽出后验证它能被 submit-click 和新 `fieldId`-click 两条路径复用、指纹不符返回 `mismatch`、disabled 元素返回 `not_writable` 而非假成功。
- **`fill-form-request.ts` 新增的纯函数**（unit/node）：覆盖表不存在、URL 不匹配（stale）、`expect` 指纹不符（mismatch）三种分支。
- **`permissions.test.ts`**：补一个用例确认 `fieldId` 寻址的点击依然会触发 `resolveSubmitIntent`（stub 依赖，不需要真实 DOM），既有 selector 路径用例不受影响。
- **真机验收**（人工，不写自动化）：`browser_get_form` 能列出导航栏链接、一个自定义 `role="button"` 的下拉触发器、一个无 `aria-label` 的原生 `<button>下单</button>`；分别用 `fieldId` 点击并观察确认卡片文案；刷新页面后重放旧 `fieldId`，确认报错文案引导重新调用 `browser_get_form`。

`tools.ts` 目前完全没有测试文件，这是既有缺口，不在本次范围内一并补齐。

## 验收标准

1. 对一个不在任何 `<form>` 内的原生 `<button>`、一个 `role="button"` 的自定义 div、一个 `<a href>` 链接，`browser_get_form` 均能返回带 `fieldId` 的条目，`label` 非空。
2. `browser_click({ fieldId })` 对上述三种元素都能正确点击，点击前后结构指纹校验生效（页面变化后旧 `fieldId` 返回 `mismatch` 或 `fieldsTableStale`，而不是误点到别的元素）。
3. `browser_click` 仍支持纯 `selector` 路径，行为与改动前一致。
4. 确认卡片对 `fieldId` 路径展示可读的元素标签，而不是原始选择器字符串。
5. iframe 内元素继续只如实上报 `unreachable.iframes` 计数，不做穿透（本次不引入回归也不引入新能力）。

## 开放问题

- `role`/`tabindex` 白名单是否需要根据真实网站验收结果调整（过窄漏检 / 过宽噪声太多），留到实现阶段用真实页面跑几轮再定，不在这版 spec 里锁死具体清单之外的边界情况。
- 是否要把 `browser_query_dom`/`browser_set_style` 等其它 selector-only 工具也接入 `fieldId`——本次明确不做（见非目标），如果这次上线后效果好，可以作为后续独立 spec 讨论。
