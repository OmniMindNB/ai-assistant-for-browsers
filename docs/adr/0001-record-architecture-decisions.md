# ADR-0001：采用文档驱动开发并记录架构决策

- 状态：已接受 Accepted
- 日期：2026-06-07
- 决策者：项目维护者
- 相关：[docs/README.md](../README.md)

## 背景（Context）

项目处于早期，需求与技术方案仍在演进。为保证决策可追溯、降低返工、便于（人与 AI）协作，需要一套轻量但规范的文档机制。

## 决策（Decision）

采用 **文档驱动开发（Documentation-Driven Development）**：

1. 新功能先写 Spec（`docs/specs/`），重大技术/架构决策写 ADR（`docs/adr/`）。
2. 使用 **ADR（Architecture Decision Records）** 记录所有重要决策，编号不可重用，历史不可篡改。
3. [PROGRESS.md](../PROGRESS.md) 作为进度看板，随开发持续更新。
4. 代码改动须同步更新相关文档。

## 备选方案（Alternatives）

- **仅用 README + Issue**：轻量但决策散落、难追溯。
- **Wiki**：与代码仓库分离，易过期。
- **ADR + Spec（采用）**：与代码同仓、随 PR 演进，可追溯性最佳。

## 影响（Consequences）

- 正面：决策透明可追溯；新人/AI 可快速理解上下文；减少重复讨论。
- 代价：需要额外维护文档的纪律。
- 行动项：所有后续 PR 模板中加入"是否更新文档"检查项。
