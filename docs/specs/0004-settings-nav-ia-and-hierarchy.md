# Spec-0004：设置页导航信息架构重排 + 视觉层级修复

- 状态：草稿 Draft
- 日期：2026-08-03
- 关联：`components/SettingsShell.tsx`、`entrypoints/options/App.tsx`、`entrypoints/sidepanel/icons.tsx`（图标风格参照）、`docs/superpowers/brainstorm/`（可视化过程存档）

## 背景

用户反馈设置页（`entrypoints/options/`）存在三个问题：

1. 一级目录（`PREFERENCES` / `AI & TOOLS` / `SAFETY` 组标题）与二级目录（`Appearance` / `Language`
   等具体项）视觉区分度太弱——组标题是 `text-xs uppercase font-semibold text-neutral-500`，二级项是
   `text-sm text-neutral-600`，字号、颜色都很接近。
2. 子菜单顺序不合理：`Shortcuts`（通用交互偏好）被归到 `AI & TOOLS` 组下不准确；`About`（版本/元信息）
   被归到 `SAFETY` 组下也不准确；三个一级分组本身的先后顺序（Preferences → AI & Tools → Safety）
   没有体现「先配置好模型才能用插件」这一使用前提。
3. 移动端（窄屏水平滚动导航）里组标题是 `sr-only`（完全隐藏），分组信息在移动端直接丢失，不只是
   对比度弱的问题。

审计过程中额外发现一个未在原始反馈中提到、但影响相同区域的缺陷：`entrypoints/options/App.tsx` 的
六个设置面板（Appearance/Language/Providers/Shortcuts/Privacy/About）都在内容区重复渲染了一次和
左侧导航高亮项完全相同的标题文字（例如选中 `Appearance` 后，内容区又渲染一个 `<h2>Appearance</h2>`），
没有提供新信息。

经过 `superpowers:brainstorming` + 可视化 companion 的三轮 mockup 迭代（存档于
`.superpowers/brainstorm/395-1785726526/content/`），最终方向确定为：**去掉一级文字组标题，改用
图标 + 分隔线传达分组**（对应 mockup 里的「方案 C」），复用项目里 `entrypoints/sidepanel/icons.tsx`
已有的手绘线性图标风格（`viewBox 24x24`、`stroke-width 1.8`、`stroke="currentColor"`），不引入新的
图标库依赖。

## 目标（Goals）

- 重排设置项分组归属与顺序：`Model providers` 独立置顶；`Shortcuts` 并入通用偏好组；`About` 从
  `Safety` 组摘出，改为侧栏底部的独立「页脚」项。
- 用图标 + 分隔线替代当前弱对比度的文字组标题，从根源上解决「一级/二级区分度不足」的问题，同时
  保留分组的无障碍语义（`aria-label`，屏幕阅读器可读）。
- 移动端水平导航条改用分隔线（竖线）传达分组，而不是完全隐藏组信息。
- 默认落地 section 从 `appearance` 改为 `providers`，与新的列表顺序保持一致。
- 顺手修掉六个设置面板内容区重复渲染标题的问题。

## 非目标（Non-Goals）

- 不引入第三方图标库（`lucide-react`/`heroicons` 等）——现有手绘 SVG 图标风格已经够用且更轻量。
- 不改变各设置面板（`AppearanceSettings`/`ProviderSettings`/…）内部的功能与交互，只改导航壳
  （`SettingsShell`）和 `entrypoints/options/App.tsx` 里的分组/顺序/标题渲染逻辑。
- 不改变 `SettingsSection` 联合类型的取值（仍是 `appearance | language | providers | shortcuts |
  privacy | about`），不新增/删除设置项。
- 不涉及侧边栏内嵌设置视图（经确认 `SettingsShell` 仅被 `entrypoints/options/App.tsx` 使用一处，
  侧边栏复用的是 `ProviderSettings`/`ShortcutSettings` 等表单组件本身，不经过这层导航壳）。

## 用户故事 / 用例

- 作为第一次打开设置页的用户，我希望一眼能分辨"这是一组的标题"还是"这是可点击的具体项"，而不是
  靠猜测字号/颜色的细微差异。
- 作为想先配置模型再看别的设置的用户，我希望打开设置页时默认就停在 `Model providers`，而不是先看到
  一个我还用不上的 `Appearance` 面板。
- 作为移动端用户，我希望横向滚动导航条里依然能感知到"这几个是一类，那几个是另一类"，而不是所有项
  连成一条看不出分组的横条。

## 设计方案

### A. 最终导航内容与顺序

```
Model providers                    ← 独立分组（原 AI & TOOLS，只剩这一项）
──────────────────────
Appearance                         ← 通用偏好组（原 PREFERENCES + Shortcuts 并入）
Language
Shortcuts
──────────────────────
Privacy & permissions              ← 原 SAFETY，只剩这一项
──────────────────────
About · v1.2.0                     ← 页脚项，muted 样式，行内附版本号
```

默认打开的 section 由 `appearance` 改为 `providers`。

### B. `components/SettingsShell.tsx` 改动

**类型变化：**

```ts
export interface SettingsSectionDescriptor {
  id: SettingsSection;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
}

export interface SettingsSectionGroup {
  label: string;              // 不再可见渲染，仅作为该组 wrapper 的 aria-label
  sections: SettingsSectionDescriptor[];
}

export interface SettingsShellProps {
  groups: SettingsSectionGroup[];
  footerSections?: SettingsSectionDescriptor[];   // 新增：About 等页脚项
  activeSection: SettingsSection;
  onSelect(section: SettingsSection): void;
  navigationLabel: string;
  children: ReactNode;
}
```

**渲染变化：**

- 去掉现有的 `<p className="sr-only ... md:not-sr-only ...">{group.label}</p>`；每个 group 用
  `<div role="group" aria-label={group.label}>` 包裹（无可见文字，仅供屏幕阅读器识别分组边界）。
- 相邻 group 之间插入分隔线：桌面端（`md:` 及以上，纵向排列）用 `<hr aria-hidden />` 横线；移动端
  （横向滚动排列）用一段 `w-px self-stretch bg-neutral-300 dark:bg-neutral-700` 竖线。同一个分隔线
  元素通过 Tailwind 响应式类控制方向（复用现有 nav 容器已有的 `md:block` / `flex` 断点切换逻辑），
  不需要维护两套 DOM。
- `footerSections`（即 `about`）在最后一个 group 之后、同一个分隔线之后渲染，样式上文字颜色更淡
  （`text-neutral-500`/`text-neutral-400`，不随 hover 加深到和普通项一样深），但仍是同样的
  `<button>` 结构，保持可点击、可键盘聚焦。
- 每个导航按钮内新增图标：`<Icon className="h-4 w-4 flex-shrink-0" aria-hidden />` + 文字，
  `flex items-center gap-2`。
- 键盘导航（`moveSelection`）使用的 `sections = groups.flatMap(...)` 改为同时纳入
  `footerSections`，保证 Tab/方向键能到达 `About`，行为不倒退。

### C. 新增图标模块 `components/settings-icons.tsx`

沿用 `entrypoints/sidepanel/icons.tsx` 的手绘线性图标写法（`viewBox="0 0 24 24"`、
`stroke="currentColor"`、`strokeWidth={1.8}`、`strokeLinecap/Linejoin="round"`），新增：

```ts
export function IconModelProviders({ className }: IconProps) { /* 圆角方框 + 内嵌方块 */ }
export function IconAppearance({ className }: IconProps)      { /* 圆 + 放射状短线，代表主题/显示 */ }
export function IconLanguage({ className }: IconProps)        { /* 圆 + 经纬线，代表语言/地区 */ }
export function IconShortcuts({ className }: IconProps)       { /* 圆角矩形键盘轮廓 + 按键点 */ }
export function IconPrivacy({ className }: IconProps)         { /* 盾牌轮廓 */ }
export function IconAbout({ className }: IconProps)           { /* 圆 + 感叹号/信息点 */ }
```

（具体路径已在可视化 companion 的 `c-refined.html` / `order-and-mobile.html` mockup 中画出并经用户
确认，实现时直接迁移那两个文件里对应 `<svg>` 的 `<path>`/`<circle>` 定义即可，不需要重新设计。）

`components/SettingsShell.tsx` 不直接内联图标 SVG，只从这个新模块 import，保持导航壳组件聚焦于布局。

### D. `entrypoints/options/App.tsx` 改动

- `groups` 重排为三组，`sections` 内每项补上对应 icon：
  1. `{ label: t('settings.groupAiTools'), sections: [providers] }`
  2. `{ label: t('settings.groupPreferences'), sections: [appearance, language, shortcuts] }`
  3. `{ label: t('settings.groupSafety'), sections: [privacy] }`
- 新增 `footerSections={[about]}` 传给 `SettingsShell`，`about` 的 `label` 沿用
  `t('settings.navAbout')`；版本号（`browser.runtime.getManifest().version`）从 `AboutSection`
  内部读取上提一层，与 `About` 一起以 `About · v{version}` 形式展示在页脚项里（`AboutSection` 面板
  内容本身不变，仍展示完整版本信息）。
- `useState<SettingsSection>('appearance')` → `useState<SettingsSection>('providers')`。
- 六个面板统一去掉重复的 `<h2>` 标题渲染：
  - `SettingsPanel` 组件去掉 `title` prop 与其渲染的 `<h2>`（四个复用它的面板：Appearance/
    Language/Providers/Shortcuts 相应地不再传 `title`）。
  - `PrivacySection`/`AboutSection` 内联的 `<h2 id="...">{t(...)}</h2>` 一并删除。
  - 顶部页头（`<h1>{t('settings.pageTitle')}</h1>`）保留不变——它是整个设置页的标题，和「当前选中
    哪个子项」不是同一层信息，不重复。

### 边界与异常

- `footerSections` 为空数组或未传时，`SettingsShell` 不渲染页脚分隔线/区域（当前唯一使用方始终会
  传 `[about]`，但组件层面仍需处理空值，避免多余的空 `<hr>`）。
- 图标组件均标记 `aria-hidden="true"`，导航语义仍完全由按钮的可见文字 + `aria-current` 承担，不
  依赖图标本身传达信息（避免图标语义不明确时造成无障碍问题）。
- 现有 `components/settings-components.test.tsx` 覆盖了导航分组渲染与键盘方向键切换；这两处行为
  在实现阶段需要同步更新断言（组标题不再可见渲染、`about` 从 `groups` 移到 `footerSections`、
  默认 section 由 `appearance` 改为 `providers`），但不改变测试覆盖的意图（分组语义 + 键盘可达性
  仍需保持通过）。

## 安全与隐私

- 纯前端展示层改动，不涉及新增权限、网络请求或数据存储变化，风险面与现状一致。

## 验收标准（Acceptance Criteria）

- [ ] 设置页导航不再渲染可见的一级文字组标题；分组信息通过 `role="group"` + `aria-label` 对屏幕
      阅读器保留。
- [ ] 桌面端相邻分组之间有横向分隔线；移动端横向滚动导航条里，相邻分组之间有竖向分隔线（组信息
      不再完全丢失）。
- [ ] 导航顺序为：`Model providers` →（分隔线）→ `Appearance`/`Language`/`Shortcuts` →（分隔线）→
      `Privacy & permissions` →（分隔线）→ `About · v{version}`（页脚样式）。
- [ ] 每个导航项左侧有对应图标，图标风格（描边粗细、`viewBox`、`currentColor`）与
      `entrypoints/sidepanel/icons.tsx` 一致。
- [ ] 打开设置页默认展示 `Model providers` 面板，导航高亮与之对应。
- [ ] 六个设置面板内容区不再重复渲染与导航选中项相同的标题文字。
- [ ] 键盘方向键（`ArrowUp/Down/Left/Right`）导航路径包含 `About`，且 Tab 顺序/焦点管理不回退。
- [ ] `About` 导航项可点击进入，`AboutSection` 面板内仍完整展示版本号等信息。
- [ ] `components/settings-components.test.tsx` 更新后与新结构一致，`pnpm compile` 与 `pnpm test`
      通过。

## 开放问题（Open Questions）

- 无。
