# Pi Data Agent SDK

在 [Pi Coding Agent](https://pi.dev) 之上构建的**只读数据分析智能体 SDK**。

**当前状态**：设计冻结，进入 M0（迁移与重构）。**尚无 SDK 代码。**

## 目标

让 agent 能对关系型数据库做「自然语言 → SQL → 可信答案」，并满足四条硬要求：

1. **只读由构造保证**（引擎级，不靠 SQL 语句）
2. **默认拒绝 + 解析失败即拒绝**（fail-closed）
3. **唯一执行出口**（无旁路）
4. **凡数字，必来自真实执行结果**（可溯源）

## 非目标（v1 明确不做）

完整语义层 · 向量 RAG · Python 执行 · 容器沙箱 · 多源适配工厂 · 鉴权/多租户 · 仪表盘 · Golden SQL 库 · 插件系统

> 复杂度预算：**核心模块 ≤ 8 个、≤ 800 行、零第三方依赖**。超出即视为过度设计。

## 目录结构

```
docs/
  SDK-SPEC-v1.md          设计规格（冻结版）：接口、不变量、M0 验收、里程碑
  M0-MIGRATION-PLAN.md    M0 迁移方案：从现有实现切分而非从零写
  analysis/               9 个开源 Data Agent 项目的源码研读笔记
    MANIFEST.md             参考项目清单与分层对照
    STUDY-NOTES.md          逐层学习笔记（L0→L5）
    ANNOTATED-safe_sql.md   postgres-mcp 护栏全文逐段注解
    ANALYSIS-safe_sql-logic.md   护栏关键逻辑（源码+解析）
    ANALYSIS-sql_driver-logic.md 驱动关键逻辑（源码+解析）
legacy/
  data-copilot-index.ts   迁移基线：现有 Pi 扩展（含工具/命令/事件）
  data-copilot-runner.mjs 迁移基线：只读子进程 runner（护栏+行限+超时）
data-demo/
  seed.mjs                确定性测试数据生成（300 客户/1200 订单/2974 明细）
  test-runner.mjs         runner 现存测试（M0 将扩到 15 项契约测试）
```

`reference-projects/` 存放 9 个第三方开源项目（676 MB），**仅本地学习用，已 gitignore**。

## 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0** | atoms + ports + guard + adapters/sqlite（**无 LLM**） | 15 项契约测试全绿 |
| **M1** | catalog + metrics + cells + ask + Stub Model | 离线确定性跑通全链 |
| **M2** | 真模型 + HITL 澄清 + Pi 扩展面 | 真实问题可答 |

## 设计要点

- **L0/L1/L2 分层**，依赖严格单向：`ask → cells → ports ← adapters`
- **护栏强度与引擎保证互补**：SQLite 有连接级只读 → 护栏可轻量；Postgres 无 → 那时才升级为 AST 白名单
- **不重造轮子**：`node:sqlite`、`node:child_process`、`node:test`（全内置）+ Pi 的 `withFileMutationQueue`

## 关键决策溯源

采纳 `postgres-mcp`（护栏设计）、`WrenAI`（语义层思路）、`shopkeeper-agent`（流水线骨架、值域检索）、`vanna`（结果分离）、`DB-GPT`（失败分类）、`SQLBot`（表名校验）**的设计**，同时修正其缺陷（`fetchall` 无上限、`BEGIN...READ ONLY` 在 psycopg3 下可能失效、`execute_param_query` 旁路）。详见 `docs/analysis/`。
