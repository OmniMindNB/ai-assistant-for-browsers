# 字段句柄稳定性设计：写操作之后 fieldId 还指不指得着原来那个元素

- 日期：2026-09-08
- 来源：用户报告"用插件做网页答题，尤其是单选题，分析出答案后点击大概率失败，提示 field 过期"
- 状态：已实现
- 依赖：无新增权限，无新增工具

## 1. 现象与排查

报告的现象只有一句："点击时大概率失败，提示类似 field 过期"。用 jsdom 复刻 `background.ts` 的完整链路（发号 → 存句柄表 → `applyFormFill` 注入点击）后，实测出的行为比报告的更糟：

```
读表单时：  f1=q1/A  f2=q1/B  f3=q2/A  f4=q2/B     ← 模型记下「第2题B」= f4
写入后重采：f1=q1/A  f2=q1/B  f3=button/收起解析  f4=q2/A  f5=q2/B
用旧 id f4 点击 → status: ok，页面实际选中 = 第2题 A
```

即：一次点击落在**隔壁选项**上，工具却回报 `ok`，模型和用户都看不出选错了。报错版本（"field 过期"）只是同一个偏移恰好跨到了别的题（`name` 不同）或句柄表变短时的表现。

## 2. 根因

三条独立机制，答题页恰好把三条全踩中。

### 2.1 每次成功写操作都会把整张句柄表推倒重编号

`fieldId` 是 `f${index + 1}`——按文档序的位置编号。而 `clickElement` / `fillForm` / `typeText` / `pressKey` 成功后都会调 `collectNewFieldsAfterWrite` → `snapshotFields` 整表覆写。

答题页选中一个选项后最常见的反应——冒出"解析"、"下一题"按钮、正误图标——都会在文档序里插入新的可交互元素，后面所有元素的号码集体后移。

**为什么写入前的结构校验没能拦住**：`planFieldClick` 的 `path` 与 `expect` 都取自刷新后的**同一张表**，两者永远自洽；同一道单选题的几个选项 `tag/type/name` 又完全相同，`matchesExpect` 因此看不出任何差别。`background.ts` 里"号码变了也没关系，动手前会比对 expect"那句注释是错的，本次排查将其推翻。

### 2.2 `browser_find_text` 的 `t*` 句柄会被任意一次写操作抹掉

`snapshotFields` 重建的句柄表只装 `f*`/`s*`，`t*` 一个不留；而 `mergeFindTextHandles` 是特意保留 `f*`/`s*` 的——两边不对称。

```
find_text 后句柄表 = [ t1, t2 ]
一次成功点击后    = [ f1, f2 ]
再点 t2 → { ok: false, reason: 'unknown_field' }
```

原设计里"`browser_get_form` 整表覆写含 `t*`"是有意的语义，但那指的是**模型主动重新采集**；`collectNewFieldsAfterWrite` 是一次模型根本不知道发生过的内部刷新，顺手销毁了模型手里的句柄。

### 2.3 选项是 `<div>` 时，通用配额被答题卡吃光

通用可点击元素（链接 / role / tabindex / cursor 命中）的配额是 `maxFields/2`，且按文档序先到先得。答题页侧边那张几十格的答题卡排在正文前面：

```
侧边 70 个题号 + 4 个选项 div → 采到 60 个，其中题目选项 0 个，truncated = true
```

选项拿不到 `fieldId`，且**重调 `browser_get_form` 结果相同**，于是变成反复失败。`<input type=radio>` 是标准字段不受此限，所以这条只在选项做成 div/li 的站点上出现。

## 3. 改动

按性价比排序实施，四条全部落地。

### 3.1 `fieldId` 按元素身份继承，不再按文档序重编（`lib/agent/field-id-allocation.ts`）

- `fieldIdentity(raw)`：只取重采之间不漂移的属性。勾选类字段用 `name + value`（value 是静态属性；标签文案在选中后经常被页面改写成"✓ 已选"），其余字段用标签文案。文本框的 `value` 是用户实时输入，绝不进身份。
- `allocateFieldIds(raws, previous, currentUrl)`：地址相同即按身份继承上一张表的号码；同一身份出现多次时按出现次序对齐。
- **号码只增不复用**：元素消失后它的号码就此作废。模型可能还攥着那个号，复用等于把"指向邻居"换个形式再犯一遍。代价是长会话里号码会变稀疏（f5、f9、f14），这是有意的取舍。
- 旧表没有 `identity`（升级前存下的）时整体退回文档序编号。

### 3.2 内部重采保留 `t*`（`keepFindTextHandles`）

`snapshotFields` 新增 `keepTextHandles` 参数：`collectNewFieldsAfterWrite` 传 `true`（模型不知道这次重采发生过），模型主动调用 `browser_get_form` 时传 `false`（原有语义不变）。

### 3.3 写入校验补上内容判别位（`fieldExpectation`）

`expect` 从 `tag/type/name/label/href` 扩展出两项：勾选类字段的静态 `value`，以及元素自身的可见文案 `text`（压空白、截断到 `MAX_EXPECT_TEXT_CHARS`）。`matchesExpect` 在句柄记下它们时才校验，`t*` 句柄没有这两项因此不受影响。

这是第二道防线：号码稳定是第一道，内容比对负责把任何漏网的漂移从"静默点错"降级成一次明确的 `mismatch`。

### 3.4 通用配额改为视口优先

配额满时，视口内的元素可以顶掉一个视口外的；两边都在视口外就照旧丢弃。agent 正在看的那一屏就是它要操作的地方。标准表单字段不占通用配额，不受影响。

### 3.5 配套

- `system-prompt.ts` 规则 5 原本要求"不要继续使用写操作之前拿到的旧 fieldId"——号码稳定之后这条已经过时，且会让模型为每一次点击多花一轮 `browser_get_form`。改为"同一页面上旧 fieldId 依然有效，只有工具结果明确说失效或页面已导航时才需要重读"。
- `background.ts` `snapshotFields` 那段错误的安全性论断已就地更正并注明推翻日期。

## 4. 已知代价

**文案会自己变的元素会多报一次 mismatch。** 验证码"重新发送(59)"这类倒计时、"购物车(3)"这类计数，在读表单与点击之间跳了一格就会比对不上。那是一次可恢复的显式失败——工具结果会告诉模型重新 `browser_get_form` 再点，代价是一轮往返；而放行它换来的是一次点在隔壁选项上、却带着 `ok` 返回的静默错误。按 Spec-0005"写入没落地就报失败，绝不假成功"的取向，这笔交换是划算的。

**被顶替的通用元素仍留在 `collectedElements` 里**，它那些仅靠 cursor 命中的后代因此继续被抑制。保守但安全：放开抑制会让一张卡片被顶掉后，它内部十几个 span 反过来涌进配额。

**`s*`（可滚动容器）仍是位置编号。** 数量少、生命周期短，未纳入本次改动。

## 5. 测试

- `lib/agent/field-id-allocation.test.ts`：发号与身份的单元测试（11 条）。
- `lib/agent/find-text.test.ts`：`keepFindTextHandles` 的四条对称性用例。
- `lib/agent/form-schema.test.ts`：`fieldExpectation` 六条。
- `lib/agent/form-dom.dom.test.ts`：`matchesExpect` 的 text/value 比对、未提供时不约束、视口优先顶替及其护栏。
- `lib/agent/field-handle-lifecycle.dom.test.ts`：端到端回归。`background.ts` 的 `snapshotFields` 没有任何 vitest project 覆盖，该文件按它的接线顺序组合三个纯函数再接上真正注入页面的 `applyFormFill`，把本文第 1 节那个现场固化下来——两条核心用例在关掉修复后确实失败，已实测确认。
