# 「页面新出现 N 个元素」的误导措辞 — 设计文档

- 日期：2026-11-08
- 状态：已评审（随轨迹分析确认，问题清单第 ④ 项）
- 来源轨迹：`runi-请答题-20261108-1734.md`（v1.9.1，wj.qq.com，步骤 3/4 与步骤 8 的 resultDetail）

## 1. 背景

写操作成功后，background 会整表重采一次字段（`collectNewFieldsAfterWrite`），把与上次读取
指纹不一致的字段标为 `isNew`，经 `describeNewFields` 渲染成：

> 页面新出现 56 个可交互元素：f121「A. 施耐庵」（radio）、f122「B. 罗贯中」（radio）…
> 可直接用 browser_click 的 fieldId 参数操作它们。

wj.qq.com 的实际现场：React 重渲染后同一批题目选项的 `name`/`value` 被重新生成，指纹
（tag|type|name|label）全部漂移，于是被标成 56 个「新出现」——而模型刚刚就在点这些
一模一样标签的元素。「新出现」是一个我们**并不知道**的断言：结构上只能知道「这些元素
与上次读取时的指纹不一致」，既可能是真新增（下拉建议、展开菜单——机制设计的初衷），
也可能是原有元素被重新渲染换了一层属性。

误导后果：模型读成「页面上冒出了一批全新的东西」。轨迹里它没直接受害（转去 find_text
核验了），但「56 个新 radio 选项」看起来和『问卷翻到了下一页新题目』一模一样——完全
可能诱发重复作答。

## 2. 结构上可算的两个事实

`findNewFieldIds` 走的是指纹预算配对（含重复计数）：当前字段逐个消耗上一张表的指纹
配额。这一趟walk 里天然还有第二个数字：

- **newIds**（现有输出）：当前字段里没有任何旧指纹可匹配的——「与上次读取时不同」；
- **vanished**（可加算，零成本）：上一张表的指纹配额没被消耗完的条数——「之前的元素
  已不在页面上」，它们的旧 fieldId 从此点空（号码只发不复用，ref:
  field-id-allocation.ts）。

wj.qq.com 这次 vanished=0（120 个旧指纹全被消耗，56 个是净增的 DOM 节点——React
重渲染换了属性但旧节点仍在/或标签重复出现）；**整页重挂载**的常见情形则是
vanished≈newIds（旧的全消失、新的全陌生）——那正是现在最误导的场合：模型手里的
fieldId 全部悄悄失效，而结果只字不提。

## 3. 方案

### 3.1 `form-schema.ts`：`findNewFieldIds` 补 vanished

返回值从 `Set<string>` 改为 `{ newIds: Set<string>; vanished: number }`
（`previousFingerprints` 为 undefined 时 vanished=0，保持「首次读取不标新」的语义）。
唯一生产调用方是 background 的 `snapshotFields`。

### 3.2 `snapshotFields` / `collectNewFieldsAfterWrite`：穿出 vanished

- `FieldSnapshot` += `vanishedFieldCount: number`；
- `collectNewFieldsAfterWrite` 返回消息形状的 `{ newFields?; vanishedFields? }`
  （恒定义、异常时空对象），调用点一律展开（`...await collectNewFieldsAfterWrite(tabId)`）。

### 3.3 `messaging.ts`：带 `newFields` 的四个结果类型 += `vanishedFields?: number`

ClickElementResult / TypeTextResult / FillFormResult / SelectOptionResult。

### 3.4 `action-result-text.ts`：`describeNewFields` 文案改造

- 主句不再断言「新出现」：改为「页面有 N 个与上次读取时不同的可交互元素（可能是新增
  控件，也可能是原有元素被重新渲染）：…」。行动指引不变（新 fieldId 直接可用）。
- vanished > 0 时追加：「另有 M 个之前读取到的元素已不在页面上，它们对应的旧
  fieldId 已失效。」

### 3.5 `system-prompt.ts` FORM_WORKFLOW 第 5 条同步

「自动回报页面新出现的可交互元素」→「自动回报与上次读取相比新增或变化的可交互元素」。

## 4. 测试

- `form-schema.test.ts`：`findNewFieldIds` 返回形状（newIds + vanished 的配对算术，
  含重复指纹、全消失、净新增三态）。
- `action-result-text.test.ts`：新文案正反用例（vanished=0 不提旧元素；>0 时明说失效）。
- `agent.test.ts` / 相关 hooks 测试里钉了旧文案「页面新出现」的断言一并更新。

## 5. 非目标（记录不做的）

- **判断「是不是同一批元素被重渲染」**：需要标签相似度这类启发式，违反 Spec-0005
  「只认结构/行为信号」的边界。文案只说我们知道的两个数。
- **vanished-only（只消失无新增）时的主动播报**：本次结果不携带任何 newFields 的既有
  门控保持不变；旧 fieldId 点空会有既有的 not_found/mismatch 验证兜底，不为此扩通道。
- **`describeLandingFields`（[跳转后页面]）**：跳转场景「跳转后新出现」的措辞是准确的
  （页面确实换了主内容），不动。
- **根治 React 重渲染换 name/value 导致的号码不继承**：那是站点 DOM 的现实，身份判别位
  （tag/type/name/value/href/formIndex）已经是最小稳定集，无法再收窄。