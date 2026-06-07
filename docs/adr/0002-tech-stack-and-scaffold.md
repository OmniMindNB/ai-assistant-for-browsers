# ADR-0002：技术栈与脚手架选型（Phase 0）

- 状态：已接受 Accepted
- 日期：2026-06-07
- 决策者：项目维护者
- 相关：[technical-plan.md](../technical-plan.md) 第 2 章、[PROGRESS.md](../PROGRESS.md)

## 背景（Context）

需要为 Chromium MV3 扩展搭建可长期演进的工程脚手架，支持侧边栏（Side Panel）、Service Worker、Content Script、Options 多入口，并具备良好的 DX（HMR、类型安全）。

## 决策（Decision）

| 维度 | 选型 |
|------|------|
| 扩展框架 | **WXT**（MV3 多入口、HMR、跨浏览器） |
| UI | **React 18 + TypeScript** |
| 样式 | **Tailwind CSS** |
| 状态管理 | **Zustand** |
| 本地存储 | **Dexie.js（IndexedDB）** + `chrome.storage` |
| 包管理器 | **pnpm** |
| 构建 | WXT 内置（基于 Vite） |

入口规划：`entrypoints/background`、`entrypoints/sidepanel`、`entrypoints/content`、`entrypoints/options`。

## 备选方案（Alternatives）

- **CRXJS + 手写 Vite 配置**：灵活但需自行维护多入口与 manifest，成本高。
- **Plasmo**：功能完善，但约定较强、定制性略低。
- **WXT（采用）**：约定优于配置，原生支持 Side Panel 与多浏览器，社区活跃。

## 影响（Consequences）

- 正面：快速搭建、统一构建、跨浏览器发布成本低。
- 代价：受 WXT 约定约束；需跟随其版本升级。
- 行动项：用 `pnpm dlx wxt@latest init` 初始化，模板选 React + TS，随后接入 Tailwind 与目录结构。
