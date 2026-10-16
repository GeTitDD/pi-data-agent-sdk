# Data Agent 参考项目库（reference-projects）

为自制 Data Agent SDK 收集的开源参考实现。**本目录仅作学习参考，不含我们的 SDK 代码。**

## 获取方式与说明

- **下载方式**：GitHub API tarball 快照（`https://api.github.com/repos/<owner>/<repo>/tarball`）。
  原因：本环境 `git clone` 直连 GitHub 出现 `GnuTLS recv error (-110)`，且全局 git 配置把 github.com 改写到了 `gitclone.com` 镜像（返回 504）；而 `api.github.com` / `codeload.github.com` 可达。
- **因此每个目录是「源码快照」，不含 `.git`**。若需历史/更新，需恢复 git 通道或重新拉取 tarball。
- **下载时间**：2026-10-16。**总体积**：约 676 MB。

## 清单与溯源

| 目录 | 仓库 | License | Stars | 分支 | 最近推送 | 体积 |
|---|---|---|---|---|---|---|
| `vanna` | vanna-ai/vanna | MIT | 23,816 | main | 2026-02-02 | 6.5M |
| `WrenAI` | Canner/WrenAI | NOASSERTION(AGPL/Apache 双) | 17,876 | main | 2026-10-16 | 20M |
| `postgres-mcp` | crystaldba/postgres-mcp | MIT | 3,401 | main | 2026-08-17 | 980K |
| `shopkeeper-agent` | didilili/shopkeeper-agent | MIT | 463 | main | 2026-10-14 | 5.4M |
| `SQLBot` | dataease/SQLBot | NOASSERTION | 6,920 | main | 2026-10-12 | 37M |
| `Dataherald` | Dataherald/dataherald | Apache-2.0 | 3,646 | main | 2024-07-24 | 4.4M |
| `DB-GPT` | eosphoros-ai/DB-GPT | MIT | 20,150 | main | 2026-10-11 | 544M |
| `pandas-ai` | sinaptik-ai/pandas-ai | NOASSERTION | 23,879 | main | 2025-10-28 | 31M |
| `data-formulator` | microsoft/data-formulator | MIT | 17,566 | main | 2026-10-13 | 28M |

> 未纳入（体积/相关性）：`microsoft/lida`(498MB)、`tencentmusic/supersonic`(89MB)。

## 分层对照：每层该读谁的哪个模块

分层定义（自下而上，每层只依赖下一层）：
**L0 原子** 纯数据/纯函数 → **L1 分子** 单职责能力+端口 → **L2 细胞** 单职责变换 → **L3 器官** 端到端工作流 → **L4 个体** 宿主集成与治理 → **L5 评测**。

### L1 分子（执行 / 护栏 / 语义 / 端口）—— 最优先

| 目标 | 位置 |
|---|---|
| **只读 SQL 护栏（真解析器）** | `postgres-mcp/src/postgres_mcp/sql/safe_sql.py` |
| 连接器实现 | `postgres-mcp/src/postgres_mcp/sql/sql_driver.py`、`bind_params.py` |
| 语义层（MDL） | `WrenAI/core/wren-mdl/` |
| 执行引擎（DataFusion） | `WrenAI/core/wren-core/`（Rust）、`wren-core-base/`、`wren-core-py/`、`wren-core-wasm/` |
| 模型端口 | `vanna/src/vanna/core/llm/`；`pandas-ai/pandasai/llm/`；`DB-GPT/packages/dbgpt-ext/`（LLM adapters） |
| SQL 运行器端口 | `vanna/src/vanna/capabilities/sql_runner/` |
| 数据源适配（多源） | `DB-GPT/packages/dbgpt-ext/`（datasources/vector stores/RAG） |
| 元数据/检索存储 | `shopkeeper-agent/app/repositories/{qdrant,es,mysql}/`；`Dataherald/services/engine/dataherald/context_store/`、`vector_store/` |
| 数据加载（文件/表） | `pandas-ai/pandasai/data_loader/`；`data-formulator/py-src/data_formulator/data_loader/` |

### L2 细胞（检索 → 生成 → 校验 → 执行 → 验证 → 作答）

| 目标 | 位置 |
|---|---|
| 多阶段问数节点 | `shopkeeper-agent/app/agent/nodes/` |
| SQL 生成 | `Dataherald/services/engine/dataherald/sql_generator/`；`vanna/src/vanna/core/enhancer/`（检索增强） |
| 干跑校验 / 行限 | `WrenAI` 治理原语（见 `docs/`、`sdk/`） |
| EXPLAIN / 计划分析 | `postgres-mcp/src/postgres_mcp/explain/explain_plan.py` |
| 代码执行沙箱 | `pandas-ai/pandasai/core/code_execution/`、`sandbox/`；`data-formulator/py-src/data_formulator/sandbox/`；`DB-GPT/packages/dbgpt-sandbox/` |
| 作答/富组件 | `vanna/src/vanna/components/{rich,simple}/` |
| 用户感知工具（RLS） | `vanna/src/vanna/core/user/`、`core/tool/` |
| 缓存 | `Dataherald/services/engine/dataherald/smart_cache/` |
| Prompt 模板 | `shopkeeper-agent/app/prompt/`；`pandas-ai/pandasai/core/prompts/` |

### L3 器官（端到端工作流）

| 目标 | 位置 |
|---|---|
| 问数主流程 | `shopkeeper-agent/app/services/`、`app/agent/` |
| 索引调优工作流 | `postgres-mcp/src/postgres_mcp/index/{dta_calc,llm_opt}.py` |
| 数据库健康巡检 | `postgres-mcp/src/postgres_mcp/database_health/` |
| Agent 能力/记忆 | `vanna/src/vanna/capabilities/{agent_memory,file_system}/`、`agents/` |
| 分析式工作流 | `data-formulator/py-src/data_formulator/workflows/`、`agents/`、`analyst/skills/` |
| DB-GPT 应用层 | `DB-GPT/packages/dbgpt-app/`、`dbgpt-core/`（AWEL） |

### L4 个体（交付 / 身份 / 治理）

| 目标 | 位置 |
|---|---|
| MCP 交付 | `postgres-mcp/src/postgres_mcp/server.py` |
| HTTP/SSE 交付 | `vanna/src/vanna/servers/`（FastAPI routes）；`shopkeeper-agent/app/api/` |
| 身份与组织 | `Dataherald/services/enterprise/`；`data-formulator/py-src/data_formulator/auth/` |
| 前端/工作台 | `SQLBot/frontend/`、`DB-GPT/pilot/`、`data-formulator/src/` |
| SDK 层 | `WrenAI/sdk/`（`wren-langchain`、`wren-pydantic`）；`DB-GPT/packages/dbgpt-client/` |
| 安全/隐私 | `data-formulator/py-src/data_formulator/security/`；`SQLBot/backend/apps/datasource/embedding/` |

### 横切（可观测 / 审计 / 恢复 / 生命周期）

| 目标 | 位置 |
|---|---|
| 审计与观测 | `vanna/src/vanna/core/{audit,observability}/` |
| 生命周期/中间件 | `vanna/src/vanna/core/{lifecycle,middleware,recovery}/` |
| 存储抽象 | `vanna/src/vanna/core/storage/` |

### L5 评测

| 目标 | 位置 |
|---|---|
| 内置评测集 | `vanna/src/evals/`（benchmarks/datasets） |
| 引擎评测 | `Dataherald/services/engine/dataherald/eval/` |
| Wren 评测 | `WrenAI/evals/` |
| 外部基准 | Spider / BIRD-Bench / Spider2.0（需另行获取） |

## 建议的阅读顺序（对应分层）

1. `postgres-mcp`：先读 `sql/safe_sql.py` + `README` 的 *Protected SQL Execution* / *Technical Notes*（L1 护栏与性能）。
2. `WrenAI`：读 `core/wren-mdl/` + `docs/`（L1 语义层），理解"指标即定义"。
3. `shopkeeper-agent`：读 `app/agent/nodes/` + `app/repositories/`（L2 检索+生成+校验的执行链）。
4. `vanna`：读 `core/`（Agent/Tool/User 抽象）与 `components/`（作答交付）。
5. `DB-GPT`：读 `packages/dbgpt-core/`（AWEL）、`dbgpt-sandbox/`（沙箱）、`dbgpt-ext/`（多源适配）。
6. `pandas-ai` / `data-formulator`：读代码执行沙箱与**迭代式**分析（本地/文件场景）。
7. `SQLBot` / `Dataherald`：读交付形态、权限隔离、Engine/Enterprise 分层。

---

*清单由本次会话生成；目录内所有代码版权归各自仓库所有，请遵守其 License（注意 `WrenAI`/`SQLBot`/`pandas-ai` 的 NOASSERTION 项需逐一确认）。*
