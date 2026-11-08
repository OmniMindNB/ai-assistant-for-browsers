# 实现计划：提交前核验的三类误导信号

Spec：`docs/superpowers/specs/2026-11-08-pre-submit-verification-hints-design.md`

- [x] 1. `lib/agent/form-dom.ts`：`CollectFormOutput` += `selectorMatched?: boolean`；
       `collectFormFields` 里 selector 存在时记录 `querySelector` 是否命中（注入函数自包含，
       不新增自由标识符）。`form-dom.dom.test.ts` 三个用例（命中 / 落空 / 缺省）。
- [x] 2. `lib/agent/frame-merge.ts`：`MergedCollection` += `selectorMatched?`，合并取主帧值；
       `frame-merge.test.ts` 透传与主帧缺席两用例。
- [x] 3. `lib/messaging.ts`：`GetFormResult` += `selectorMatched?`；`entrypoints/background.ts`
       `getForm` 透传。
- [x] 4. `lib/agent/form-render.ts` `renderNotes`：落空提示句；`form-render.test.ts` 正反用例。
       `lib/agent/tools.ts` get_form `selector` 参数描述补「匹配不到时结果会明说」。
- [x] 5. `lib/agent/tools.ts` find_text 描述补核验指路；`lib/agent/system-prompt.ts`
       `FORM_WORKFLOW` 第 12 条；`system-prompt.test.ts` 钉关键句。
- [x] 6. `pnpm compile` + `pnpm test`，直接在 main 上提交（中文提交信息）。
