# 设计：「添加 Provider」表单的自定义厂商入口

- 状态：已批准 Approved
- 日期：2026-07-26
- 关联：`components/ProviderSettings.tsx`、`lib/settings.ts`、`docs/specs/0003-provider-settings-form-fixes.md`

## 背景

「添加 Provider」表单的所有厂商字段（名称 / Base URL / 模型 / 其他可用模型 / API Key）本来就是自由文本，
配置任意第三方厂商或中转站在功能上早已可行。缺的只是**入口可见性**：「快速预设」下拉里只有六个内置
厂商，没有任何一项告诉用户「可以不选预设、直接手填」。用户看到一个下拉，默认会以为必须从中选一个。

本设计只补这个入口，不扩展 `ProviderConfig` 数据结构。

## 目标

- 在「快速预设」下拉中提供一个显式的「自定义（手动填写）」选项。
- 选中它时把厂商相关字段回到干净的手填状态，并给出与厂商无关的通用 placeholder 示例。
- 编辑已有 Provider 时，该选项不得清空已保存的值。

## 非目标

- 不支持把自定义厂商沉淀为可复用的预设（用户明确表示当前不需要）。
- 不新增 `ProviderConfig` 字段（自定义 header、URL 路径、超时等一律不做）。
- 不做预设的导入 / 导出 / 跨设备同步。
- 下拉**不**在用户手改字段后自动跳回「自定义」——下拉只是一个执行填充动作的控件，
  只反映用户最后一次的主动选择，不承担状态显示职责。

## 设计

### 核心：「自定义」是一个空预设

把「自定义」建模为 `{ name: '', baseURL: '', model: '' }`，直接喂给现有的 `applyPresetToDraft`。
该函数已有的两分支语义（ref: Spec-0003 §A）恰好产出正确行为，无需修改一行：

| 场景 | `applyPresetToDraft` 现有语义 | 选中「自定义」的结果 |
| --- | --- | --- |
| 添加新 Provider（`!isEditing`） | 预设值整体覆盖草稿 | 三个字段被清空 —— 目标行为 |
| 编辑已有 Provider（`isEditing`） | `draft.x \|\| preset.x`，非空不覆盖 | 已保存的值不被误清，仅切换选中项 |

**刻意的取舍**：编辑态选中「自定义」在视觉上「什么都没发生」。这是 Spec-0003 定下的防误触语义——
清空一条已保存 Provider 的 Base URL 不可撤销，代价远高于「选项看起来没反应」。不为自定义开特例。

### `lib/settings.ts` 新增

```ts
/** 「自定义」在快速预设下拉中的哨兵值；__ 前缀确保不与任何 PROVIDER_PRESETS.name 冲突 */
export const CUSTOM_PRESET_VALUE = '__custom__';

/** 空预设：语义上等价于「不套用任何厂商」 */
export const CUSTOM_PRESET: Omit<ProviderConfig, 'id' | 'apiKey'> = {
  name: '', baseURL: '', model: '',
};

/** 下拉值 → 预设；返回 undefined 表示占位符态（不做任何填充） */
export function resolvePresetSelection(
  value: string,
): Omit<ProviderConfig, 'id' | 'apiKey'> | undefined;

/** 下拉值 → 四个输入框的 placeholder 文案 */
export function draftPlaceholders(
  value: string,
): { name: string; baseURL: string; model: string; extras: string };
```

`resolvePresetSelection`：哨兵值返回 `CUSTOM_PRESET`，否则按名称在 `PROVIDER_PRESETS` 中查找，
未命中（含空串占位符）返回 `undefined`。

`draftPlaceholders` 三个分支：

- 自定义态 → 与厂商无关的通用示例（如「例如 我的中转站」/「https://your-host/v1」/「例如 gpt-4o」）。
- 命中某预设 → 以该预设自身的 `name`/`baseURL`/`model` 为示例，`extras` 取该预设 `models` 中除默认模型外的项。
- 占位符态 → 维持现状的 DeepSeek 风格示例。

该函数同时吸收组件内现有的 `extrasPlaceholder`。理由：自定义态必须换掉那句写死的
`例如 deepseek-v4-flash`，与其在组件里散布三元表达式，不如合并成一个可测的纯函数。

`applyPresetToDraft`、`ProviderConfig`、`Settings`、`PROVIDER_PRESETS` 均不改动。

### `components/ProviderSettings.tsx` 改动

下拉末尾追加分隔项与自定义项：

```tsx
<option value="">选择以填充 Base URL / 模型…</option>
{PROVIDER_PRESETS.map(/* 不变 */)}
<option disabled>──────────</option>
<option value={CUSTOM_PRESET_VALUE}>自定义（手动填写）</option>
```

用 `<option disabled>` 而非 `<hr>` 作分隔：`<hr>` 在 `<select>` 内仅较新 Chromium 支持，
而项目同时构建 Firefox（`pnpm dev:firefox`）。

`applyPreset` 中 `PROVIDER_PRESETS.find(...)` 换为 `resolvePresetSelection(name)`，
其余逻辑（含 `undefined` 时的早返回）保持不变。

三处写死的字段 placeholder 与 `extrasPlaceholder` 调用，统一改为读取 `draftPlaceholders(selectedPreset)`。

### 不受影响的字段

API Key、协议类型、「其他可用模型」不受任何预设影响（含「自定义」），维持现状。
协议类型此前也不被任何预设覆盖（`PROVIDER_PRESETS` 无 `api` 字段），行为一致。

## 边界与异常

- 哨兵值 `__custom__` 与厂商名同处一个字符串空间。`__` 前缀 + `resolvePresetSelection` 中
  哨兵优先判断，保证即使将来出现名为 `__custom__` 的预设也不会被误解析。
- 添加态下重复选中「自定义」：`<select>` 值未变则不触发 `onChange`，字段保持已清空状态，
  与预期一致（无需重复清空）。
- 从「自定义」切回某个具体预设：走原有路径，字段被该预设整体覆盖，无特殊处理。

## 安全与隐私

不涉及新增权限、网络请求或页面内容访问；不改变 API Key 的存储与传输方式（仍仅存
`chrome.storage.local`，不同步云端）。风险面与现状一致。

## 测试

新增用例写入 `lib/settings.test.ts`（沿用现有 `describe` 风格）：

- `resolvePresetSelection`：哨兵值 → `CUSTOM_PRESET`；已知厂商名 → 对应预设；`''` 与未知值 → `undefined`。
- `applyPresetToDraft(CUSTOM_PRESET, isEditing=false)`：`name`/`baseURL`/`model` 被清空，
  且 `apiKey`、`api`、`extrasText` 不受影响。
- `applyPresetToDraft(CUSTOM_PRESET, isEditing=true)`：已填的 `name`/`baseURL`/`model` 不被清空
  （对应上文取舍的回归防线）。
- `draftPlaceholders`：自定义 / 具体厂商 / 占位符三个分支各一条。

不新增组件测试：`vitest.config.ts` 的 `include` 仅覆盖 `lib/**`，无 `components/` 测试基建，
本设计已将全部可测逻辑下沉到 `lib/settings.ts`。

## 验收标准

- [ ] 「快速预设」下拉末尾出现「自定义（手动填写）」，其上有一条不可选的分隔项。
- [ ] 添加新 Provider 时，先选 DeepSeek 再选「自定义」，名称 / Base URL / 模型（默认）被清空；
      API Key、协议类型、「其他可用模型」保持不变。
- [ ] 选中「自定义」后，三个必填框的 placeholder 变为与厂商无关的通用示例，
      「其他可用模型」的 placeholder 不再是 DeepSeek 专属文案。
- [ ] 编辑一条已保存的 Provider 时选中「自定义」，已填字段不被清空。
- [ ] 手动修改字段后，下拉仍显示上一次选中的预设名（不自动跳回「自定义」）。
- [ ] `pnpm compile` 与 `pnpm test` 通过。

## 开放问题

- 无。
