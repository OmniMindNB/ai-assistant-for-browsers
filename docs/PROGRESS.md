# 项目进度看板（PROGRESS）

> 持续更新。每完成一项，勾选并补充链接到对应 Spec/ADR/PR。

## 阶段总览

| 阶段 | 目标 | 状态 |
|------|------|------|
| Phase 0 | 脚手架与三端通信 | ✅ 完成 |
| Phase 1 | MVP 对话（总结/问答/划词） | ⬜ 未开始 |
| Phase 2 | 脚本生成与注入 | ⬜ 未开始 |
| Phase 3 | Skill 体系 | ⬜ 未开始 |
| Phase 4 | 自动化抓取 | ⬜ 未开始 |
| Phase 5 | 增强与发布 | ⬜ 未开始 |

图例：⬜ 未开始 · 🚧 进行中 · ✅ 完成

## Phase 0 — 脚手架（基础设施）

参考：[ADR-0002 技术栈与脚手架](adr/0002-tech-stack-and-scaffold.md)

- [x] 初始化 WXT + React + TS 项目（pnpm）
- [x] 接入 Tailwind CSS（v4 + @tailwindcss/vite）
- [x] 配置 MV3 manifest：Side Panel / Service Worker / Content Script
- [x] 打通三端消息通信（统一消息协议 `lib/messaging.ts`）
- [x] 本地存储封装（`lib/db.ts` Dexie、`lib/settings.ts`）
- [x] 跑通 `pnpm build`，manifest 含 side_panel/权限校验通过

> 入口：`entrypoints/{background,content,sidepanel,options}`；侧边栏自检按钮可验证三端通信。
> 在浏览器手动加载：`pnpm dev`，或加载 `.output/chrome-mv3` 未打包扩展。

## 变更日志

| 日期 | 内容 | 关联 |
|------|------|------|
| 2026-06-07 | 整合 plan/technical-plan 进 docs/，新增根 README | docs/README |
| 2026-06-07 | 建立文档驱动开发机制；完成 Phase 0 脚手架 | ADR-0001, ADR-0002 |
