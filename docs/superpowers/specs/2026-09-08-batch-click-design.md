# 批量点击设计：browser_click 的 fieldIds 入口

- 日期：2026-09-08
- 来源：用户追问"答题有单选和多选两种，还需要优化吗"。句柄稳定性修完之后（ref: 2026-09-08-field-handle-stability-design.md），多选题剩下的问题不在正确性而在轮数
- 状态：已实现
- 依赖：无新增权限，无新增工具，注入函数不变

## 1. 问题

多选题要点若干个选项。分两种：

- **真 checkbox**：`browser_fill_form` 已经能一次批量勾完，一轮搞定。没有问题。
- **div / li 做的选项**：`kind` 是 `button`，不在 `fill_form` 的可写类型里，只能 `browser_click` 一次点一个。**5 个选项 = 5 轮完整的模型往返。**

按侧边栏耗时实测，LLM 往返占总耗时 96%，减少轮数是唯一有效的提速杠杆。单选题只点一次感觉不到，多选题每多一个选项就多一轮。

## 2. 方案

`browser_click` 增加可选参数 `fieldIds: string[]`，与 `fieldId`/`selector` 互斥，上限 10 个（`MAX_CLICK_TARGETS_PER_CALL`）。

不新开 `browser_click_many` 工具：工具表每多一条都要占系统提示和模型的注意力预算，而批量只是同一个动作的复数形式。

**关键取舍——贵的是模型往返，不是 `executeScript`。** 因此 background 侧逐个复用现有的单目标注入（`applyFormFill` 的 submit 分支），循环 N 次，**不改任何注入函数**。改注入函数要连带处理它那套"不得引用模块作用域"的约束和全部 dom 测试，换来的只是省掉几毫秒的进程间调用，不划算。副作用是每个目标各自沿用 250ms 的光标动画与高亮，4 个选项约 1 秒——这反而是想要的：用户能逐个看清点了哪几项。

## 3. 语义

**失败处理：继续点完，逐个回报**（用户拍板）。每个选项是独立动作，后面的没理由被前面的连累；模型拿到"2 成功 1 失败"后只补那一个，仍然省下大部分往返。与 `browser_fill_form`"一个字段失败不影响其余字段"保持一致。

**中途导航则停**：某个目标点完后页面导航了（`applyFormFill` 回报 `fieldsTableStale`），剩余目标全部标记 `skipped_stale` 且不再尝试——它们的句柄对着旧页面，继续点会点到新页面上去。

**重复的 fieldId 只点第一次**，其余回报 `duplicate`。勾选类元素点两次等于没点，模型多半是把同一个选项写了两遍。

**结果**：`ClickElementResult.outcomes[]`，顺序与请求一致，每条带 `status` / `detail` / `label` / `opensNewTab`。文案由 `describeBatchClickResult` 生成，计数放第一行（"成功 2 个，失败 1 个"），模型不必自己数，也就不会把部分成功当成整批失败重来。工具层只在**一个都没点成**时才抛错。

## 4. 安全边界

一条都不放松：

- 整批仍走一次 `beforeToolCall`——权限分级、只读标签页（`tab-access.ts`）、用户接管（`takeover-gate.ts`）都在链上，`browser_click` 的 tier 不变。
- **只要有一个目标被判定为表单提交，整批拒绝、一个都不点。** 确认卡片是"一次提交一次确认"的语义（ref: `confirm-gate.ts`），把提交混进批量会让用户在一张卡片上看不清究竟在提交什么。注意这是**拒绝**而不是确认，比闸门更强：批量路径下提交根本走不到，一次批准也无法放行它。探测复用已有的 `probeSubmitIntent`，逐个目标探，在任何一次点击发生**之前**完成。
- 上限 10：多选题最多也就 5-8 个选项，再多说明模型不是在答题而是在乱点；上限同时限住了单次调用能对页面产生的动作量。

## 5. 可观测性

`activity-description.ts` 把批量目标列进步骤时间线（`Clicking "f3、f4、f5"`）。面板是用户唯一能看见 agent 动了哪些元素的地方，一次点 5 个却只显示"点击"等于把这一步藏起来。

整批结束后只调**一次** `collectNewFieldsAfterWrite`，而不是每点一个重采一次。

## 6. 测试

- `lib/agent/fill-form-request.test.ts`：`planFieldClicks` 的顺序、逐条失败、`wrong_kind`、`duplicate`、`no_table`。
- `lib/agent/action-result-text.test.ts`：`describeBatchClickResult` 的计数行、逐条列表、全成功文案、新标签页警告。
- `lib/agent/form-tools.test.ts`：工具层的参数互斥、空数组、上限 10、部分失败不抛错、全失败抛错、表失效要求重读。
- `lib/agent/activity-description.test.ts`：时间线文案。
- `lib/agent/field-handle-lifecycle.dom.test.ts`：三个 div 选项一次点完、中间一个失效其余照点、重复只点一次。

⚠️ `background.ts` 的 `clickElementsByFieldIds` 本身没有测试覆盖（没有 vitest project 匹配 `entrypoints/**/*.test.ts`），dom 测试里的循环是照它复刻的。改那个函数时不要以为有测试守着。
