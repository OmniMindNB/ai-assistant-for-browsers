# 提交前核验的三类误导信号 — 设计文档

- 日期：2026-11-08
- 状态：已评审（随轨迹分析确认，问题清单第 ② 项）
- 来源轨迹：`runi-请答题-20261108-1734.md`（v1.9.1，wj.qq.com 文学常识问卷，步骤 5–7）

## 1. 背景

填完 25 个字段之后、点提交之前，模型想做一次提交前核验（核验已填答案确实在页面上），
连续三次调用都没拿到真实信号，还各吃了一次误导：

| 步骤 | 调用 | 结果 | 实际含义 |
|---|---|---|---|
| 5 | `browser_get_form {"selector":"form"}` | 「共 0 个表单、0 个可交互元素」 | 页面是 React SPA，根本没有 `<form>`——选择器落空，不是「页面没有字段」（3 步前它刚看到 120 个） |
| 6 | `browser_find_text "自京赴奉先县咏怀五百字"` | 「命中 0 个」 | 已填进 `<input>/<textarea>` 的值不是文本节点，find_text 结构性看不见——0 命中 ≠ 没填上 |
| 7 | `browser_find_text "狂人日记"` | 3 个命中 | 其中 t3 是**题目正文**里的同字样——作为「我的答案已记录」的证据是噪音 |

三次全部花在预算上（3 次模型往返），核验却一次都没做成。

## 2. 问题拆解

### 坑 1：get_form 的 selector 落空静默返回 0

`collectFormFields`（form-dom.ts）里：`const scope = input.selector ? document.querySelector(input.selector) : document.body; if (scope) walk(scope);`
——selector 命不中容器时 walk 根本不跑，返回值里没有任何「选择器没找到」的信号。
结果渲染为「共 0 个表单、0 个可交互元素」，模型无法区分：

- 选择器写错了 / 页面没有该结构（本例）；
- 容器存在但里面确实没有可交互字段（完全不同的结论）。

而「先 get_form 全量 → selector 收窄」是正常工作流（预算提示里也这么教），
<truncated 时系统提示甚至主动让模型「用 selector 参数缩小范围」——落空必须可分辨。

### 坑 2：find_text 看不见输入框里的值

`find_text`/`find-text-dom` 只匹配渲染在页面上的文本（displayable text），输入框里的值是
元素属性不是文本节点。这是**刻意设计**：find_text 的结果会整段进模型上下文，若允许搜
input 值，用户手输的密码、卡号会以命中结果的形式外泄（redaction 是文本规则匹配，
对正则漏网的敏感值无兜底）。所以行为不能改，但模型不知道——它把 0 命中读成了「没填上」。

### 坑 3：find_text 的命中可以是正文里的同字样

坑 2 的反面：模型改用「搜答案选项的字样」核验时，命中可能来自题目/正文文本
（t3 是题干），不是它填的那个控件。命中≠答案已记录，但结果没有提示这一层歧义。

## 3. 方案

原则：**核验的正确路径已经存在**——`browser_get_form` 会回读字段当前值
（非敏感字段渲染 `value="…"`、勾选态 `checked`，敏感字段只显示 `filled/empty`，
ref: form-schema.ts / form-render.ts）。所以坑 2、坑 3 的修法是把「怎么核验」指到
这条路上，而不是发明新能力；坑 1 是补一个缺失的硬信号。

### 3.1 坑 1：selector 落空信号（结构层，链路贯通）

- `form-dom.ts`（注入函数，自包含）：`CollectFormOutput` 增加 `selectorMatched?: boolean`
  ——传了 `selector` 时记录 `document.querySelector` 是否命中；不传 selector 时缺省。
- `frame-merge.ts`：`MergedCollection` 增加 `selectorMatched?: boolean`，
  合并时取**主框架**的值（selector 读取本来就只采主帧，ref: background.ts snapshotFields）。
- `messaging.ts`：`GetFormResult` 增加 `selectorMatched?: boolean`。
- `background.ts` `getForm`：透传。
- `form-render.ts` `renderNotes`：`selectorMatched === false` 时追加一句
  「选择器未匹配到任何元素——上面的 0 是容器没找到，不是页面没有可交互元素。
  页面可能没有该结构（如无 `<form>` 的单页应用）；省略 selector 可读取整个页面。」
- `tools.ts` `selector` 参数描述补一句「匹配不到时结果会明说」。

边界：容器命中但里面 0 字段（`selectorMatched: true`）不加提示——那是诚实结果；
主框架脚本没跑（main 缺席）时 `selectorMatched` 缺省，维持旧行为（不误报）。

### 3.2 坑 2 + 坑 3：find_text 描述与 form_workflow 指路（提示层）

- `tools.ts` `browser_find_text` 描述补一句：只匹配页面上渲染的文本——输入框里
  已填的值对它不可见，命中也可能只是题目/正文里的同样字样；核验已填的值用
  `browser_get_form`（回读字段当前值，敏感字段只显示 filled/empty）。
- `system-prompt.ts` `FORM_WORKFLOW` 增加第 12 条：提交前核验填写结果用 get_form 回读，
  不要用 find_text（两个误导各说一句：0 命中 ≠ 没填上；命中 ≠ 答案已记录）。

## 4. 测试

- `form-dom.dom.test.ts`：selector 命中 → `selectorMatched: true`；落空 → `false` 且 0 字段；
  不传 → 缺省。
- `frame-merge.test.ts`：合并透传主帧 `selectorMatched`；主帧缺席时缺省。
- `form-render.test.ts`：落空时结果含提示句；命中/缺省时不含。
- `system-prompt.test.ts`：新第 12 条的关键句。

## 5. 非目标（记录不做的）

- **find_text 支持搜输入框值**：见 §2 坑 2，会外泄用户手输的敏感值，刻意不做。
- **get_form 语义识别「form 落空常见于 SPA」以外的建议**：提示只陈述事实（可能没有该结构），
  不替模型猜页面框架。
- 提交后验证（原问题 ③）、[跳转后页面] 文案（原问题 ④）：另行处理。
