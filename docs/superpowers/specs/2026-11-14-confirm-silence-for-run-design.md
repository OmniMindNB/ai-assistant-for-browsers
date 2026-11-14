# 确认卡的「本次任务内不再询问」(confirm silence for run)

- 日期：2026-11-14
- 状态：已评审（UI 走查 P1-2：确认疲劳）
- 来源：UI/UX 走查结论——结构化检测到的提交逐次确认是正确的安全底线，但一个多步任务
  连续提交几个表单时，用户会进入「扫一眼→点确认」的自动化状态，此时确认卡反而失去
  保护作用（alert fatigue：第 4 张卡之后的确认已经不构成有效的知情同意）。
- 依赖：无新增权限、无新增工具、无持久化。

## 1. 目标与非目标

**目标**：给 submit / commit 两类确认卡一个可选勾选「本次任务内不再询问此类操作」。
勾选后无论批准还是拒绝，本次运行内**同 kind** 的后续确认直接沿用该决定，不再弹卡。

**非目标**：

- 不做跨 run 记忆（新任务必须从头问起——不持久化到 storage，也不做「本站点永久放行」）；
- 不做按站点 / 表单粒度的记忆（kind 是唯一粒度）；
- 不改 Spec-0005 的检测边界（哪些点击算提交，一字不动）；
- takeover 卡永远不显示该勾选（「人插手了还要不要继续」没有可以沿用的答案，
  每一次都必须本人回答）。

## 2. 设计

### 2.1 作用域 = run，粒度 = kind，方向对称

- **作用域是 run**：记忆落在 `ConfirmGateState`，而它随每轮 `createBrowserAgent` 重建
  （agent.ts 每次开 run 都 `createConfirmGateState()`），新任务自然重置。不持久化：
  worker 被逐的 run 本来就不可恢复（run-state-storage 的孤儿扫描），记忆没有载体。
- **粒度是 kind**：`silencedKinds: Map<'submit' | 'commit', boolean>`。submit 与 commit
  各自独立——放行一次「疑似提交点击」不该连带放行「结构检测出的提交」。
- **方向对称**：勾选 + 拒绝 = 本 run 内同类提交一律自动拒绝。用户说「这类别做」与
  「这类放行」同样有效；agent 后续的提交尝试会按固定文案被 block，由预算机制自然收尾。
- **与 per-turn 缓存刻意不同**：缓存是隐式的、目标 tab 切换即作废；这是显式知情授权，
  用户勾的就是「本次任务」，**跨 tab 不作废**（任务在多个标签页间编排时，逐 tab 重问
  恰恰是被投诉的疲劳来源）。

### 2.2 协议与数据流

```
面板 ConfirmationCard 勾选 ──respondConfirm{approved, silenceForRun}──▶ run-registry.respondConfirm
  └─ kind !== 'takeover' 时 resolve({approved, silenceForRun}) ──▶ ConfirmFn 返回 ConfirmResult
       └─ resolveConfirmGate(always 路径) 写入 state.silencedKinds
            └─ 同 kind 的后续 always 调用：查表直接放行(记 alwaysApprovedCallIds) / 按固定文案拒绝
```

- `ConfirmFn` 的返回类型从 `Promise<boolean>` 扩为 `Promise<ConfirmResult>`
  （`boolean | { approved, silenceForRun? }`），布尔形态语义不变（只回答这一次）。
- `RespondConfirmMessage` 增加可选 `silenceForRun`；`respondConfirm` 对 takeover 防御性
  忽略（UI 不显示勾选，这里再挡一层）。
- 自动放行的调用仍记入 `alwaysApprovedCallIds`（与手动批准的 confirm_always 调用同账）；
  自动拒绝用固定文案 block，模型能读出「这是用户的选择，不是故障」。

### 2.3 UI

- 卡片按钮行下方、提示语上方加一行复选框（仅 `!takeover`）；琥珀色跟随卡片语义。
- 换卡（同 run 内连着来第二张确认卡）时勾选状态归位——不能把上一张卡的授权悄悄带到
  一张用户还没看过的新卡上。
- Esc 语义不变：拒绝，且**不带**静默（安全侧不携带授权）。

## 3. 不变量（测试要钉住的）

1. 勾选批准后，同 kind 后续提交不再调 `onConfirm`，直接放行并记 `alwaysApprovedCallIds`；
2. 勾选拒绝后，同 kind 后续提交不再调 `onConfirm`，按固定文案拒绝；
3. kind 隔离：commit 的静默不影响 submit；
4. 静默跨目标 tab 不作废（对照 per-turn 缓存的 Important #2）；
5. 未勾选的普通答复不产生静默（既有逐次询问语义不变）；
6. 静默不写回、也不读取 per-turn 缓存（`decision` 仍为 unset）。
