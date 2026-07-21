# Spec-0003：「添加 Provider」表单缺陷修复与体验优化

- 状态：草稿 Draft
- 日期：2026-07-21
- 关联：`components/ProviderSettings.tsx`、`lib/settings.ts`、CLAUDE.md（Storage 章节）

## 背景

审计 `components/ProviderSettings.tsx`（Provider 配置表单，供 options 页与侧边栏内嵌设置视图复用）
发现 4 个数据正确性缺陷与 6 项可用性优化点：

1. **trim 校验但不 trim 存储**：`saveDraft` 校验 `draft.name.trim()` 等，但实际保存的是未 trim
   的原始值。粘贴带首尾空格/换行的 Base URL 或 API Key 会静默保存，导致后续请求失败且难以定位。
2. **预设覆盖不一致**：`applyPreset` 中 `name`/`model` 仅在当前字段为空时才填充
   （`d.name || preset.name`），但 `baseURL` 无条件覆盖，编辑已有 Provider 时误触预设下拉会
   静默丢失自定义 Base URL。
3. **预设 `models` 数组被丢弃**：`PROVIDER_PRESETS` 中 DeepSeek 预设含两个模型，但 `applyPreset`
   从未回填 `extrasText`，导致选择该预设时只能拿到默认模型。
4. **多上下文无同步**：options 页与侧边栏设置视图各自独立 `loadSettings()` 一次，无
   `browser.storage.onChanged` 监听。两处同时打开并编辑/删除时，后写入者静默覆盖前者的改动。

以及 6 项优化：删除无二次确认、保存按钮无防抖/禁用导致的竞态风险、必填项无视觉标记、
回车无法提交、同名 Provider 无提示、API Key 无显隐切换。

## 目标（Goals）

- 修复上述 4 个数据正确性缺陷，保证表单校验与实际存储行为一致。
- 让预设填充逻辑对所有字段（`name`/`baseURL`/`model`/`models`）保持统一的「非空不覆盖」语义。
- 表单在检测到 `chrome.storage` 中 Provider 数据被其他上下文改动时，安全地刷新列表，且不破坏
  用户正在进行中的编辑。
- 补齐 6 项列出的可用性优化，降低误删、重复提交、脏数据输入的风险。

## 非目标（Non-Goals）

- 不引入「测试连接」/校验 baseURL 可达性的功能（需要真实网络请求，超出本次审计范围）。
- 不改变 Provider 数据结构（`ProviderConfig`/`Settings` 类型不变），不做迁移脚本。
- 不将同名 Provider 检测做成阻断性校验——只做提示，允许用户保留重名（无下游逻辑依赖名称唯一）。
- 不引入弹窗/Modal 组件库；删除确认沿用现有极简风格（内联按钮态切换），不使用 `window.confirm()`。

## 设计方案

### A. 数据正确性修复

- `saveDraft`：在校验前对 `draft.name`/`draft.baseURL`/`draft.model`/`draft.apiKey` 统一 trim，
  校验与存储都使用 trim 后的值（`extrasText` 中各模型名同样在 `withExtras` 内 trim，此逻辑已存在）。
- `applyPreset`：`baseURL` 改为 `d.baseURL || preset.baseURL`，与 `name`/`model` 语义一致。
- `applyPreset`：当 `extrasText` 当前为空时，用 `(preset.models ?? []).filter(m => m !== preset.model)`
  回填 `extrasText`（沿用 `extrasOf` 的展示格式，逗号分隔）。

### B. 跨上下文同步

- 在 `ProviderSettings` 内新增 `useEffect`，注册 `browser.storage.onChanged` 监听：当
  `aluminum:settings` 键变化且新值来自其他上下文时，用新的 `providers`/`activeProviderId` 更新
  `settings` state（列表与激活态实时刷新）。
- 草稿保护：若当前 `isEditing` 且正在编辑的 Provider（`draft.id`）在新数据中已不存在（被其他上下文
  删除），不静默清空表单——改为在表单顶部显示一条内联提示（例如「此 Provider 已在别处被删除」），
  草稿保留只读展示，用户可选择放弃编辑（点「取消」清空）。若正在编辑的 Provider 仍存在但字段被
  其他上下文改动，不强制刷新草稿（避免打断用户输入），仅刷新未在编辑中的列表项。
- 组件卸载时移除监听（`useEffect` 清理函数）。

### C. 删除二次确认

- `remove(id)` 触发前，按钮进入「待确认」态：本地 state 记录 `confirmingDeleteId`，点击「删除」后
  按钮文案变为「确认删除？」并变红；3 秒内再次点击才真正调用 `remove`；超时或点击其他区域自动回退
  为「删除」（用 `setTimeout` + 清理，参考现有 `flash` 的 toast 计时器写法）。
- 每次只允许一个条目处于确认态（切换到另一条目的删除会重置前一个）。

### D. 保存防抖 / 竞态防护

- 新增 `saving` boolean state；`saveDraft` 执行期间禁用 Add/Save 按钮（`disabled={saving}`），
  完成后（含出错）重置。
- `persist`/`saveDraft` 中涉及 `providers` 数组的读取，改为基于 `setSettings` 的函数式更新
  （`setSettings(prev => ...)`）而非闭包中的 `settings` 变量，避免快速连续点击时读到过期数组。

### E. 可用性优化

- 名称/Base URL/模型（默认）三个必填 `Field` 标签追加视觉标记（如尾随 `*`，沿用现有文字颜色体系，
  不新增颜色语义）。
- 用 `<form onSubmit={...}>` 包裹表单字段，`saveDraft` 改由 `onSubmit` 触发（并 `preventDefault`），
  使输入框内回车可提交；Add/Save 按钮 `type="submit"`，取消按钮 `type="button"`。
- `saveDraft` 校验通过后，若存在其他 Provider 的 trim 后 `name` 与当前相同（大小写敏感，按现状
  精确匹配即可），仍正常保存，但额外 `flash('已保存（存在同名 Provider）')` 提示，不阻断。
- API Key 输入框旁新增一个显隐切换按钮（图标或文字「显示/隐藏」），本地 state 控制
  `type="password" | "text"`，不影响存储值。

### 边界与异常

- `storage.onChanged` 回调需过滤非 `local` area 的变更（`areaName === 'local'`）及非目标 key。
- 删除确认的 3 秒计时器需在组件卸载或用户手动取消时清理，避免内存泄漏 / 状态更新到已卸载组件。
- trim 后若必填字段变为空字符串（例如输入全是空格），校验按「未填写」处理，提示文案不变。

## 安全与隐私

- 本次改动不涉及新增权限、不涉及页面内容或网络请求，风险面与现状一致。
- API Key 显隐切换仅影响本地 DOM 渲染，不改变 API Key 的存储或传输方式，仍只存在
  `chrome.storage.local`（不同步云端）。

## 验收标准（Acceptance Criteria）

- [ ] 保存时对 name/baseURL/model/apiKey 前后空白被去除，存储值与展示值均为 trim 后结果。
- [ ] 编辑已有 Provider 时选择预设，若已填写 baseURL，则不被覆盖；未填写时正确填充。
- [ ] 选择 DeepSeek 预设后，「其他可用模型」输入框自动填充 `deepseek-v4-flash`（当该字段原本为空时）。
- [ ] 同时打开 options 页与侧边栏设置视图，在一处新增/编辑/删除 Provider，另一处的列表在合理时间内
      自动反映变更，且不清空对方正在编辑中的草稿（除非该草稿对应的 Provider 已被删除，此时显示提示
      而非静默清空）。
- [ ] 点击「删除」需二次确认（3 秒内再次点击）才会真正删除；超时后恢复原按钮状态。
- [ ] 保存过程中 Add/Save 按钮禁用，连续快速点击不会产生重复/丢失的 Provider 记录。
- [ ] 必填字段有视觉标记；在任意表单输入框中按 Enter 可触发保存。
- [ ] 保存同名 Provider 时给出非阻断提示，Provider 仍成功保存。
- [ ] API Key 输入框可切换明文/密文显示。
- [ ] `pnpm compile` 与 `pnpm test` 通过。

## 开放问题（Open Questions）

- 无。
