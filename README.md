# pi_project

本仓库有三个部分：**SDK 包**、**研究笔记**、**迁移基线**。SDK 已独立成包，代码与文档都在 `data-agent-sdk/`。

## 目录

```
data-agent-sdk/            只读数据分析 SDK（独立包，自述见包内 README）
  src/                     L0 atoms → L1 ports → L1 能力 → L2 cells/ask
  test/                    39 项契约测试（M0 24 + M1 15）
  demo/                    seed.mjs 重建 demo.db
  docs/
    M1-DESIGN.md           A2 设计说明（入库）
    METHODOLOGY.md         方法论：信任阶梯、不变量分级（本地，不入库）
    CASE-PI.md             Pi 宿主解剖（工具/命令/事件面）（本地，不入库）
    analysis/              9 个开源 Data Agent 项目的研读笔记（本地，不入库）
      MANIFEST.md            参考项目清单与分层对照
      STUDY-NOTES.md         逐层学习笔记（L0→L5）
      ANNOTATED-safe_sql.md  postgres-mcp 护栏全文逐段注解
      ANALYSIS-safe_sql-logic.md   护栏关键逻辑（源码+解析）
      ANALYSIS-sql_driver-logic.md 驱动关键逻辑（源码+解析）
  SDK-SPEC-v1.md           冻结版规格
  M0-MIGRATION-PLAN.md     M0 迁移方案
legacy/
  data-copilot-index.ts    迁移基线：旧 Pi 扩展（含工具/命令/事件）
  data-copilot-runner.mjs  迁移基线：只读子进程 runner（护栏+行限+超时）
tools/
  publish.mjs              用 GitHub Git Data API 代替 git push
```

标了"本地，不入库"的三份研究材料由 `data-agent-sdk/.gitignore` 排除，只存在于本地磁盘。它们内部的 `reference-projects/...` 写法相对仓库根。

`reference-projects/` 存放 9 个第三方开源项目（676 MB），**仅本地学习用，已 gitignore**。`pstack_learning/`、`rea/`、`architect-arena/` 等为并行的学习与练习目录，与 SDK 无关。

## SDK 四条硬要求

1. **只读由构造保证**（引擎级，不靠 SQL 语句）
2. **默认拒绝 + 解析失败即拒绝**（fail-closed）
3. **唯一执行出口**（无旁路）
4. **凡数字，必来自真实执行结果**（可溯源）

非目标（v1 不做）：完整语义层 · 向量 RAG · Python 执行 · 容器沙箱 · 多源适配工厂 · 鉴权/多租户 · 仪表盘 · Golden SQL 库 · 插件系统。

复杂度预算：核心模块 ≤ 8 个、≤ 800 行、零运行期第三方依赖。超出即视为过度设计。

## 里程碑

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **S0** | 版本控制 + 远端仓库 | 基线提交可 diff / 可回滚 | ✅ 完成 |
| **S1** | atoms + ports + guard + adapters/sqlite（无 LLM） | 17 项契约测试全绿 | ✅ 完成 |
| **S2** | guard 补 ANALYZE 禁项 + 表名白名单；runner 加 `status` 协议 | 24 项契约测试全绿 | ✅ 完成 |
| **M1** | catalog + metrics + cells + ask + Stub Model | 离线确定性跑通全链 | ✅ 完成（39 项测试）|
| **M2** | 真模型 + HITL 澄清 + Pi 扩展面 | 真实问题可答 | 待开始 |

M0（A0/A1）与 M1（A2）已冻结，接口与行为由 39 项契约测试固定。

```bash
cd data-agent-sdk
npm test           # 39 项契约测试
npm run typecheck  # tsc --noEmit（strict）
```

## 设计要点

- **L0/L1/L2 分层**，依赖严格单向：`ask → cells → ports ← adapters`
- **护栏强度与引擎保证互补**：SQLite 有连接级只读，护栏可轻量；Postgres 无，那时才升级为 AST 白名单
- **不重造轮子**：`node:sqlite`、`node:child_process`、`node:test`（全内置）+ Pi 的 `withFileMutationQueue`

## 关键决策溯源

采纳 `postgres-mcp`（护栏设计）、`WrenAI`（语义层思路）、`shopkeeper-agent`（流水线骨架、值域检索）、`vanna`（结果分离）、`DB-GPT`（失败分类）、`SQLBot`（表名校验）**的设计**，同时修正其缺陷（`fetchall` 无上限、`BEGIN...READ ONLY` 在 psycopg3 下可能失效、`execute_param_query` 旁路）。详见 `data-agent-sdk/docs/analysis/`（本地，不入库）。

## 发布（本环境的 `git push` 不可用）

本环境 **`git push` 无法连通 `github.com:443`**（WSL git 的 gnutls 报 TLS 错误；Windows git 亦连接失败），但 **`api.github.com` 可达**。因此推送改走 **Git Data API**：

```bash
GH_TOKEN=$(gh auth token --user GeTitDD) node tools/publish.mjs
```

`tools/publish.mjs` 按本地 `HEAD` 重建 blob/tree/commit 并强制更新远端 ref；在元数据（tree、含末尾换行的 message、带时区偏移的 author/committer）完全一致时，**远端提交 sha 与本地 HEAD 相同**（已实测：`cfefb986`）。

其他环境约束（实测结论，供排查参考）：

- WSL 的 `~/.gitconfig` 有 `url."https://gitclone.com/github.com/".insteadOf = https://github.com/` 改写，会把 GitHub 请求劫持到不可用的镜像。本仓库所有 git 命令均以 `GIT_CONFIG_GLOBAL=/dev/null` 运行以绕开它。
- 仓库目录属主与 WSL 用户不同，需 `-c safe.directory=<repo>`。
- 调用 `cmd.exe` 会破坏同一脚本后续的 stdout，Windows 侧命令必须放在独立的一次调用里。
