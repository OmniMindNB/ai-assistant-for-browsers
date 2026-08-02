# 当前仓库隐私政策 GitHub Pages 迁移设计

## 背景

Runi 当前仓库已经公开，并且 `docs/privacy-policy.en.md` 与
`docs/privacy-policy.md` 已是最新的英文、简体中文隐私政策正文。对外发布仍依赖独立仓库
`OmniMindNB/aluminum-legal`，Chrome Web Store 材料、发布指南和自动测试也仍引用该仓库的
GitHub Pages 地址。独立站点使用旧品牌 Aluminum，正文也落后于当前 Runi 行为。

本次迁移把隐私政策的内容维护和 Pages 发布都收敛到当前仓库
`OmniMindNB/ai-assistant-for-browsers`。旧站点直接弃用，不提供重定向，也不再作为任何
发布文档或测试的合法 URL。

## 目标

- 以当前仓库中的英文和简体中文 Markdown 隐私政策作为唯一正文来源。
- 通过当前仓库的 GitHub Pages 提供可公开访问的静态 HTML 页面。
- 使用明确的隐私政策子路径：
  - 英文：`https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/`
  - 简体中文：`https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/zh-CN/`
- 两个页面均提供正确的语言切换链接，并适合桌面和移动端阅读。
- 所有当前维护的 Chrome Web Store 材料、发布说明和自动测试只引用新地址。
- 在推送到 `main` 后由 GitHub Actions 构建和部署 Pages。

## 非目标

- 不删除、归档或修改 `OmniMindNB/aluminum-legal` 仓库。
- 不为旧 Pages 地址增加重定向或兼容页面。
- 不建设完整的产品官网、营销首页或 JavaScript 单页应用。
- 不改变隐私政策的实质正文；本次只增加发布元数据和展示层。
- 不引入自定义域名。

## 方案选择

### 采用：Jekyll + GitHub Pages 官方 Actions

现有两份 Markdown 继续作为唯一正文来源。给它们增加 Jekyll front matter，指定布局、语言、
固定路由和对应语言页面。自定义布局负责 HTML 外壳、响应式样式、深浅色配色和语言导航。
GitHub Pages 官方 Actions 在部署时从 `docs/` 构建静态站点并上传 Pages artifact。

该方案不复制政策正文，不需要为两份 HTML 手工同步内容，也不需要引入 React/Vite 等应用层。

### 未采用：提交独立静态 HTML

静态 HTML 可以直接发布，但会让 HTML 与 Markdown 同时成为正文副本。以后更新政策时容易只改
其中一份，重现当前两个仓库内容漂移的问题。

### 未采用：独立 Vite/React 法律站点

应用框架可以提供更复杂的交互和视觉效果，但两份法律文档只需要可靠的静态展示。额外的依赖、
构建配置和客户端 JavaScript 没有带来相称收益。

## 架构

### 内容层

- `docs/privacy-policy.en.md`：英文政策唯一正文来源，固定发布到 `/privacy-policy/`。
- `docs/privacy-policy.md`：简体中文政策唯一正文来源，固定发布到
  `/privacy-policy/zh-CN/`。
- 两份文件的 front matter 明确记录 `layout`、`title`、`lang`、`permalink`、语言导航标签和
  对应页面路径。
- 正文有效日期和政策内容继续由现有测试约束，不因展示层产生第二份副本。

### 展示层

- `docs/_layouts/privacy-policy.html` 提供语义化 HTML 页面骨架。
- 布局从 front matter 读取页面标题、语言和对应语言链接，不根据文件名推断路由。
- 语言链接通过 Jekyll `relative_url` 过滤器生成，使项目站点的
  `/ai-assistant-for-browsers` base path 被正确保留。
- 样式内联在布局中，覆盖清晰的正文宽度、标题层级、表格横向滚动、代码样式、链接、深色模式
  和移动端间距，不加载第三方字体、脚本、分析或远程资源。
- 不要求仓库 Pages 根路径展示隐私政策；稳定的公开入口是两个明确的政策子路径。

### 构建与部署层

- `docs/_config.yml` 保存站点名称和 Jekyll 的最小配置，并排除不需要发布的内部规划目录和商店
  图片等内容，减少 artifact 范围。
- `.github/workflows/deploy-pages.yml` 使用 GitHub 官方 Pages Actions：
  `configure-pages`、`jekyll-build-pages`、`upload-pages-artifact` 和 `deploy-pages`。
- 工作流在推送到 `main` 时自动执行，也支持手动触发。
- 构建 job 使用仓库锁定的 pnpm 版本安装依赖并运行完整项目测试；测试通过后才构建 Pages
  artifact。
- 工作流使用 Pages 所需的最小权限：读取仓库内容、写入 Pages、获取 OIDC token。
- 部署 job 使用 `github-pages` environment 和并发控制，避免多个旧部署并行覆盖。
- 构建或测试失败时不执行部署，因此线上保留上一份成功 artifact。

## URL 与文档迁移

以下维护面中的旧 `aluminum-legal` URL 全部替换为新路由：

- `docs/chrome-store-listing.en.md`
- `docs/chrome-store-listing.zh-CN.md`
- `docs/chrome-store-permission-justifications.md`
- `docs/chrome-store-submission-guide.md`
- `docs/chrome-store-release-checklist-1.1.md`
- 约束这些发布面的品牌与最终审查测试

历史设计与实施计划是不可变的历史记录，不批量改写其中的旧仓库地址。测试只约束当前维护面，
不把历史文档误判为现行发布配置。

## 测试与验证

### 自动测试

- 增加 Pages 发布契约测试，验证两份 Markdown 的 permalink、语言、布局和对应语言路径。
- 验证布局使用 `relative_url`，包含语言导航、响应式 viewport、表格滚动和深色模式支持。
- 验证 Pages 工作流只从 `main` 部署、使用官方构建/上传/部署 Actions，并声明必要的最小权限。
- 更新品牌与发布面测试，要求现行文档包含两个准确的新 URL，并拒绝旧
  `aluminum-legal` URL。
- 保留现有隐私正文日期、双语一致性和行为声明测试。

### 本地构建验证

- 运行项目定向测试及完整 `pnpm test`。
- 运行 `pnpm compile`，确认测试与配置改动不破坏 TypeScript 编译。
- 使用与工作流等价的 Jekyll Pages 构建检查 artifact 中存在：
  - `_site/privacy-policy/index.html`
  - `_site/privacy-policy/zh-CN/index.html`
- 对构建产物检查 Runi 标题、核心政策段落和双向语言链接。

### 发布后验证

- 将仓库 Pages 的发布源设置为 GitHub Actions。
- 推送工作流后等待 `github-pages` deployment 成功。
- 分别请求英文和简体中文 HTTPS URL，要求返回 HTTP 200、Runi 品牌、当前生效日期和正确语言
  导航。
- 旧 URL 不作为验收项，也不要求继续可用。

## 错误处理与运维

- Jekyll 构建、项目测试或 Pages artifact 上传任一步失败时，部署 job 失败并停止发布。
- Pages 部署采用并发组；新提交可以取消仍在排队的旧构建，但不会中断正在发布的部署。
- 若仓库尚未启用 Pages，先把 source 设置为 GitHub Actions，再重新运行工作流；不切换到分支目录
  发布模式。
- 若线上页面返回 404，依次检查 Pages environment、最近一次工作流结果、artifact 路径和 front
  matter permalink，不通过复制 HTML 到其他路径规避配置错误。
- 后续政策更新只修改两份 Markdown；布局和工作流无需随正文同步修改。

## 安全与隐私

- 发布页面只包含仓库中已公开的隐私政策内容和支持邮箱。
- 页面不加载第三方 JavaScript、分析 SDK、远程字体、Cookie 或追踪像素。
- GitHub Actions 不使用仓库自定义 secret；部署通过 GitHub Pages 官方权限与 OIDC 完成。
- 工作流权限保持在 Pages 部署所需的最小集合，不授予仓库内容写权限。

## 验收标准

1. 当前仓库包含政策内容、Jekyll 布局、配置和 Pages 工作流。
2. 英文与简体中文政策分别从约定的新 URL 公开返回 HTTP 200。
3. 两个页面正文来自现有 Markdown，品牌为 Runi，生效日期为 `2026-08-02`。
4. 两个页面能够互相切换语言，链接保留项目站点 base path。
5. 当前维护的 Chrome Web Store 文档和测试不再引用 `aluminum-legal` URL。
6. 定向测试、完整测试、TypeScript 编译和 Pages 构建全部通过。
7. 旧仓库不被修改，旧 URL 不提供兼容或重定向。
