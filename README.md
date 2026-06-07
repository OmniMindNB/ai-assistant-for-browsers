# Aluminum

> Chromium 系浏览器的 AI 助手扩展 —— 以**侧边栏对话框**为核心，借助大模型帮你总结、理解、改造与自动化当前网页。

## 核心功能

- 📄 **页面总结**：一键提炼当前页面要点
- 💡 **理解辅助**：解释名词、翻译、基于页面上下文问答
- 🛠️ **脚本注入**：由 AI 生成脚本改造页面（去广告、阅读模式、改样式等），执行前需人工确认
- ⚡ **Skill 体系**：把常用操作固化为可复用 Skill 并集中管理
- 🤖 **轻量自动化**：批量抓取页面数据 / 图片 / 视频

## 技术栈

| 维度 | 选型 |
|------|------|
| 扩展框架 | [WXT](https://wxt.dev/)（Manifest V3） |
| UI | React 18 + TypeScript + Tailwind CSS |
| 状态 | Zustand |
| 存储 | Dexie（IndexedDB） + `chrome.storage` |
| 包管理 | pnpm |

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发（自动加载扩展并热更新）
pnpm dev

# 生产构建，产物在 .output/chrome-mv3
pnpm build

# 类型检查
pnpm compile
```

> 本机若未安装 Google Chrome，可在 [web-ext.config.ts](web-ext.config.ts) 中将浏览器二进制指向 Microsoft Edge 等 Chromium 内核浏览器。

加载未打包扩展：浏览器进入 `扩展` → 开启`开发者模式` → `加载解压缩的扩展` → 选择 `.output/chrome-mv3`。

## 项目结构

```
entrypoints/        # 扩展入口
  background.ts     # Service Worker：消息路由中心
  content.ts        # Content Script：页面提取/交互
  sidepanel/        # 侧边栏 React 应用
  options/          # 设置 / Skill 管理页
lib/                # 共享库
  messaging.ts      # 统一消息协议
  db.ts             # IndexedDB（Dexie）
  settings.ts       # 配置存储封装
docs/               # 文档（文档驱动开发）
```

## 文档

本项目采用**文档驱动开发**。先文档后代码，文档为单一事实来源。

- [文档体系说明](docs/README.md)
- [产品需求](docs/plan.md)
- [技术规划](docs/technical-plan.md)
- [进度看板](docs/PROGRESS.md)
- [架构决策记录 (ADR)](docs/adr/)

## 开发状态

🚧 早期开发中 —— Phase 0（脚手架与三端通信）已完成，详见[进度看板](docs/PROGRESS.md)。
