# 项目进度看板（PROGRESS）

> 持续更新。每完成一项，勾选并补充链接到对应 Spec/ADR/PR。

## 阶段总览

| 阶段 | 目标 | 状态 |
|------|------|------|
| Phase 0 | 脚手架与三端通信 | ✅ 完成 |
| Phase 1 | MVP 对话（总结/问答/划词） | 🚧 进行中 |
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

## Phase 1 — MVP 对话（功能 1、2）

参考：[technical-plan.md §4.1、§5](technical-plan.md)

- [x] OpenAI 兼容的流式对话客户端（`lib/llm.ts`，SSE 逐 token 输出）
- [x] Provider / API Key 配置：「设置」页表单 + 预设（`entrypoints/options`、`lib/settings.ts`）
- [x] 开发测试快捷配置：`lib/dev-config.ts` 填入测试 Key 自动注入 Provider
- [x] Readability 正文提取（`entrypoints/content.ts`）
- [x] 侧边栏对话 UI：流式渲染 / 停止 / 清空（`entrypoints/sidepanel`）
- [x] 总结本页、解释划词（页面提取 + 选区）
- [x] 对话历史持久化（IndexedDB / Dexie）
- [ ] Markdown 渲染、历史会话列表 UI（待增强）
- [ ] 长页面 Map-Reduce / RAG（待增强）

> 测试：在 `lib/dev-config.ts` 中填入 DeepSeek 等测试 Key 并将 `enabled` 改为 true，
> 或者运行 `pnpm dev` 后在「设置」页填入。

## 变更日志

| 日期 | 内容 | 关联 |
|------|------|------|
| 2026-06-08 | Phase 1 MVP 对话：OpenAI 兼容流式对话、设置页、总结/划词、历史持久化 | technical-plan §4.1/§5 |
| 2026-06-07 | 整合 plan/technical-plan 进 docs/，新增根 README | docs/README |
| 2026-06-07 | 建立文档驱动开发机制；完成 Phase 0 脚手架 | ADR-0001, ADR-0002 |
