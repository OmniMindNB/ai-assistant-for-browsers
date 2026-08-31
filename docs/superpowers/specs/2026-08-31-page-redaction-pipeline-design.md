# 页面内容脱敏管线设计

- 日期：2026-08-31
- 来源：`docs/superpowers/specs/2026-08-31-page-agent-benchmark.md` §3.3（对标 alibaba/page-agent 的 `transformPageContent` 配置项）
- 状态：待实现

## 1. 问题

Runi 当前对"provider 配置永不云同步"做了明确的隐私承诺（`lib/settings.ts`），表单层也已经对 password/payment 等敏感字段做到不回读、不写入（`lib/agent/form-schema.ts`）。但**页面正文本身零脱敏**：`browser_read_page`/`browser_inspect_page_implementation` 读到的页面正文、`browser_get_form` 读到的字段 label/value/上下文文本，只要出现手机号、邮箱、身份证号、银行卡号这类 PII，会原样进入发给模型 provider 的请求里。

对标对象 page-agent 把 `transformPageContent(content)` 做成一等公民配置项，官网文档直接给出上述四类的脱敏正则。这是一个明显缺口，本设计补齐它。

## 2. 目标 / 非目标

**目标：**
- 页面正文与表单渲染输出在离开扩展、进入模型请求之前，经过一道可配置的脱敏管线。
- 默认开启（用户可关闭），内置手机号/邮箱/身份证号/银行卡号四类正则，用户可在设置页逐条禁用、并新增自定义正则规则。
- 命中的敏感信息替换为完全占位符（如 `[手机号已脱敏]`），不保留任何原始字符。

**非目标（v1 明确不做，超出后续再评估）：**
- 不覆盖 `browser_get_html`/`browser_query_dom` 返回的原始 HTML、`browser_get_computed_style`、`browser_screenshot`（图片，正则脱敏不适用）、`GET_SELECTION`（用户主动选中的文本，暴露面本就窄得多）。
- 不做按域名的规则覆盖（"这个网站不脱敏"之类）——留给 3.4 提到的按域名黑白名单机制，是另一个独立功能。
- 不做部分遮码（保留首尾几位）——只做完全占位符替换。

## 3. 数据模型与存储

新增 `lib/redaction.ts`（与 `lib/settings.ts`/`lib/shortcuts.ts` 同级、同构：`chrome.storage.local`，存储 key `runi:redaction`，不同步到云端）：

```ts
export interface RedactionRule {
  id: string;        // 'phone' | 'email' | 'idcard' | 'bankcard'，或自定义规则的生成 id
  label: string;      // 展示名，同时是占位符文案来源（如 "手机号" -> "[手机号已脱敏]"）
  pattern: string;    // 正则表达式源（不含 flags），运行时以 'g' 编译
  enabled: boolean;
  builtin: boolean;   // true = 内置四类，不可删除，可禁用；false = 用户自定义，可删除可编辑
}

export interface RedactionSettings {
  enabled: boolean;   // 总开关，默认 true
  rules: RedactionRule[];
}
```

内置规则（顺序即应用顺序；身份证号排在银行卡号之前，让 18 位数字优先匹配到更具体的"身份证号"标签——两者都会命中 18 位数字串，谁在前谁的 label 生效，属于已知的简化取舍，不影响脱敏结果本身的正确性，只影响标签措辞）：

| id | label | pattern（不含 flags） |
|----|-------|----------------------|
| phone | 手机号 | `(?<!\d)1[3-9]\d{9}(?!\d)` |
| email | 邮箱 | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` |
| idcard | 身份证号 | `(?<!\d)\d{17}[\dXx](?!\d)` |
| bankcard | 银行卡号 | `(?<!\d)\d{16,19}(?!\d)` |

均以 `enabled: true`、`builtin: true` 作为默认值写入 `DEFAULT_REDACTION_SETTINGS`。四类规则的 `label` 是固定中文字符串，不随 UI locale 变化（理由见 §5 最后一段）。

`loadRedactionSettings()` / `saveRedactionSettings()` 镜像 `lib/shortcuts.ts` 的 `loadShortcutConfigs`/`updateShortcutConfigs` 形状：读取时缺失或损坏都回退到默认值，不抛错阻塞调用方。自定义规则的 `id` 生成沿用 `newShortcutId()`/`newProviderId()` 的既有模式（`redaction-${Date.now()}-${随机后缀}`），内置四类的 `id` 固定为 `phone`/`email`/`idcard`/`bankcard`。

## 4. 脱敏函数

纯函数，与存储解耦，可独立单测：

```ts
export function redactText(text: string, settings: RedactionSettings): string {
  if (!settings.enabled || !text) return text;
  let result = text;
  for (const rule of settings.rules) {
    if (!rule.enabled) continue;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'g');
    } catch {
      continue; // 用户写坏的自定义正则：静默跳过，不影响其余规则或整体调用方
    }
    result = result.replace(regex, `[${rule.label}已脱敏]`);
  }
  return result;
}
```

无效正则（如括号不匹配）不抛出、不阻塞页面读取整体流程——一条坏规则不该让 `browser_read_page` 直接报错。

## 5. 管线接入点

选择依据不是"文档字面提到哪个文件"，而是**每种输出实际的汇聚点在哪里**——追踪代码后发现 `EXTRACT_PAGE` 消息在 `lib/agent/tools.ts` 里有两个独立调用方（`browser_read_page` 和 `browser_inspect_page_implementation` 的正文摘录），而 `renderFormResultForModel` 只有一个调用方。因此两个接入点分别选在各自唯一的汇聚点：

1. **`entrypoints/background.ts` 的 `extractActivePage()`**——`EXTRACT_PAGE` 消息类型的唯一处理函数，覆盖它的全部现有消费方和未来新增的消费方。拿到内容脚本返回的 `PageContent` 后：
   ```ts
   const redacted = redactText(data.text, await loadRedactionSettings());
   return { ...data, text: redacted };
   ```
   只处理 `.text`（正文），不处理 `title`/`url`/`lang`。这仍然是纯 I/O 编排（读配置 → 调纯函数 → 返回），与 `background.ts` 现有"只做 I/O 编排，逻辑下沉到 lib/"的既定分工一致。

2. **`lib/agent/tools.ts` 的 `browser_get_form` execute**——`renderFormResultForModel` 唯一的调用方：
   ```ts
   const redactionSettings = await loadRedactionSettings();
   return textResult(
     redactText(renderFormResultForModel(response.data), redactionSettings),
     response.data as unknown as Record<string, unknown>,
   );
   ```
   `includeText` 选项拼进同一个渲染字符串的正文片段（`precedingText`/`trailingText`）会随整体字符串一起被覆盖，不需要额外接线。

两处都在每次调用时现读配置（`await loadRedactionSettings()`），不做缓存——单次 `chrome.storage.local` 读取是亚毫秒级操作，代价可忽略，换来的是用户中途在设置页切换开关后立即生效，不需要重启会话。

`browser_inspect_page_implementation` 聚合的 HTML/脚本/样式表部分保持不脱敏（§2 非目标）；它的正文摘录因为复用同一个 `extractActivePage()` 汇聚点，自动获得脱敏，不需要单独接线。

## 6. 设置页 UI

复用已有的 Privacy 分区（`entrypoints/options/App.tsx` 的 `groupSafety` 分组、`settings.navPrivacy`，当前是三张静态说明卡片）。新增 `components/RedactionSettings.tsx`，挂载在现有说明卡片下方，结构镜像 `components/ShortcutSettings.tsx` 已经验证过的形态（列表 + 内联增改表单 + 校验 + `browser.storage.onChanged` 实时同步）：

- **总开关**复选框——"启用页面内容脱敏"，绑定 `RedactionSettings.enabled`，默认勾选。
- **统一规则列表**——内置与自定义规则同一个列表渲染：单独的启用复选框 + label + pattern。内置行的 pattern 只读展示（可禁用，不可删除/编辑）；自定义行完整可编辑、可删除（删除走 `window.confirm`，与 `ShortcutSettings.remove` 一致）。
- **"添加自定义规则"表单**——label + pattern 两个文本输入，镜像 `ShortcutSettings` 的增改草稿表单。保存前用 `new RegExp(pattern)` 做 try/catch 校验，非法正则内联报错、不允许保存——不能把一条注定失效的规则悄悄存进去。

新增 i18n 键统一放在 `privacy.redaction.*` 命名空间下，`zh.ts`/`en.ts` 两份都要补全（沿用现有约定：`TranslationKey = keyof typeof zh`，两份缺一个键会直接编译失败）。四条内置规则的 `label` 字段本身不走 i18n——它是拼进模型可见占位符文本（如 `[手机号已脱敏]`）的数据，不是 UI 文案。这与 `system-prompt.ts` 的既有约定一致：系统提示词主体固定用中文，只有面向用户的 UI 外壳（这里是设置页的按钮/标题/复选框标签）随 locale 切换。

## 7. 测试计划

- `lib/redaction.test.ts`（新文件，`unit` vitest project）：
  - `redactText` 对四类内置规则各自的命中/不误伤边界用例（如手机号相邻数字不应被截断匹配、银行卡号与身份证号的 18 位重叠场景、总开关关闭时原样返回、单条规则禁用时不生效）。
  - 无效自定义正则不抛出、不影响其余规则。
  - `loadRedactionSettings`/`saveRedactionSettings` 的默认值与持久化往返（mock `browser.storage.local`，参照 `lib/shortcuts.ts` 现有测试的 mock 方式）。
- `entrypoints/background.ts` 目前没有对应的 vitest project（`fill-form-request.ts` 已经是"逻辑下沉以便测试"的先例），`extractActivePage` 的改动本身只是"读配置 + 调用已测试过的纯函数"，不单独补测试，与现有 `getActiveTab` 等函数的测试覆盖水平一致。
- `lib/agent/tools.test.ts`（或等价的 form-tools 测试文件，视现有测试文件组织而定）：`browser_get_form` 在脱敏开启/关闭下的输出差异。
- `components/RedactionSettings.test.tsx`（`ui` vitest project，jsdom）：增删改规则、总开关、非法正则报错阻止保存、`storage.onChanged` 触发的实时刷新——参照 `ShortcutSettings` 是否已有对应的组件测试文件决定具体粒度。

## 8. 已知取舍 / 后续可能的跟进

- 身份证号与银行卡号的 18 位数字重叠，标签取决于规则顺序（见 §3），不是精确的分类，但脱敏结果本身正确。
- 不做部分遮码：换来实现简单、隐私更彻底，代价是模型完全看不到"这里有个以 1234 结尾的号码"这类结构信息；如果后续发现这类信息对任务确实有价值，可以再加一个"部分遮码"模式的开关，但不在 v1 范围内。
- `docs/privacy-policy.md` 目前没有提到这道脱敏管线；功能落地后可以考虑补一句披露，但不属于本次实现范围（不属于"P0 三个功能"本身）。
- 内置正则存在已知的误判：漏检方面，带分隔符的号码（如 `138-1234-5678`、带空格的银行卡号）和带 `+86` 国际区号前缀的手机号都不会被匹配到；误伤方面，一些通用的长数字串（订单号、时间戳、SKU 等）可能被误标成身份证号/银行卡号，个别文件名（如 `logo@2x.png`）可能被误标成邮箱。这是 v1 接受的取舍，后续如有需要可以再打磨正则本身。
- `title`/`url` 在 v1 中刻意完全不做脱敏（范围仅限 `.text`，见 §5），但 URL 的查询参数里常常带有 PII；这是一个残留的覆盖缺口，后续迭代可以重新评估是否需要覆盖。
