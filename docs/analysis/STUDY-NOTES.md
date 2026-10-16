# Data Agent 逐层学习笔记（L0 → L5）

> 基于 `reference-projects/` 中 9 个开源项目的**源码实读**。按 `MANIFEST.md` 的阅读顺序组织。
> 分层纪律：**每层只依赖下一层**。笔记中每条结论都标注了来源文件路径，便于回查。

---

## 总览：先记住这条主线

成熟项目在**同一件事**上有三种不同做法，这正是我们最该学的分歧点：

| 分歧点 | 做法 A | 做法 B | 做法 C |
|---|---|---|---|
| **SQL 安全校验** | **AST 白名单**（postgres-mcp / pglast） | **AST 黑名单 + 子查询遍历**（pandas-ai、SQLBot / sqlglot） | **数据库干跑**（shopkeeper-agent / `EXPLAIN`） |
| **上下文来源** | **语义层**（WrenAI MDL） | **混合检索**（shopkeeper：向量+全文+结构化） | **RAG 训练集**（vanna） |
| **代码执行** | **容器沙箱**（DB-GPT、data-formulator） | 进程内（pandas-ai 默认可本地） | 无 |

---

## L0 原子（Atoms）—— 纯数据与纯函数

**这一层是什么**：不依赖任何 IO 的值类型与纯函数。各项目虽语言不同，但原子几乎一致：

| 原子 | 来源 | 形状 |
|---|---|---|
| `RowResult` | `postgres-mcp/.../sql/sql_driver.py` | `@dataclass class RowResult: cells: Dict[str, Any]` |
| `ToolCall` / `ToolResult` | `vanna/src/vanna/core/tool/models.py` | Pydantic：`ToolCall{id,name,arguments}`、`ToolResult{success,result_for_llm,ui_component,error}` |
| `User` | `vanna/src/vanna/core/user/models.py` | `{id,username,email,metadata,group_memberships}` |
| `ExecutionResult` | `DB-GPT/.../dbgpt-sandbox/.../execution_layer/base.py` | `{status,output,error,execution_time,memory_usage,exit_code}` |
| `column` / `measure` / `cubeDimension` | `WrenAI/core/wren-mdl/mdl.schema.json` | 语义层原子（见 L1） |
| `DataAgentState` | `shopkeeper-agent/app/agent/state.py` | 流水线共享状态（见 L2） |

**要点**：
- `ToolResult` 把「给模型的文本（`result_for_llm`）」与「给 UI 的组件（`ui_component`）」**分开**——这是我们 SDK 该抄的第一个设计。
- `ExecutionResult.status` 用**枚举**区分 `success/error/timeout/resource_limit`——失败要分类，不能只有 bool。

**不变量**：无 IO、无状态、可单测（我们在 M0 应先写这一层）。

---

## L1 分子（Molecules）—— 单职责能力 + 端口

### 1.A SQL 护栏：三种策略的实证对比（★最重要）

#### 策略 A：AST 白名单（postgres-mcp，最严格）

`postgres-mcp/src/postgres_mcp/sql/safe_sql.py`

```python
ALLOWED_STMT_TYPES = { SelectStmt, ExplainStmt, CreateExtensionStmt, VariableShowStmt,
                       VacuumStmt, PrepareStmt, DeallocateStmt, DeclareCursorStmt,
                       ClosePortalStmt, FetchStmt }      # 白名单，其余一律拒绝
ALLOWED_FUNCTIONS  = { "count","sum","avg",... }          # 函数也白名单
ALLOWED_NODE_TYPES = ALLOWED_STMT_TYPES | { ... }         # 节点级白名单
```

关键实现细节（都值得抄）：

```python
# 1) 递归校验整棵 AST（不是只看首关键字）
def _validate_node(self, node):
    if not isinstance(node, tuple(self.ALLOWED_NODE_TYPES)):
        raise ValueError(f"Node type {type(node)} is not allowed")

    if isinstance(node, FuncCall):                       # 2) 函数白名单
        func_name = ".".join(n.sval for n in node.funcname).lower()
        unqualified = strip_pg_catalog(func_name)
        if unqualified not in self.ALLOWED_FUNCTIONS:
            raise ValueError(f"Function {func_name} is not allowed")

    if isinstance(node, SelectStmt) and node.lockingClause:   # 3) 禁止 SELECT ... FOR UPDATE
        raise ValueError("Locking clause on select is prohibited")

    if isinstance(node, ExplainStmt) and any(o.defname == "analyze" for o in node.options or []):
        raise ValueError("EXPLAIN ANALYZE is not supported")  # 4) 禁止 EXPLAIN ANALYZE（它会真执行）

    for attr in node.__slots__:                          # 5) 递归所有子节点
        ...
```

以及**永不信任调用方**：

```python
async def execute_query(self, query, params=None,
                        force_readonly: bool = True):   # do not use value passed in
    ...
    return await self.sql_driver.execute_query(query, params=params,
                                               force_readonly=True)   # 强制 True
```

底层用只读事务兜底（`sql_driver.py`）：

```python
if force_readonly: await cursor.execute("BEGIN TRANSACTION READ ONLY")
...
elif transaction_started: await cursor.execute("ROLLBACK")   # 读完即回滚，绝不留写事务
```

#### 策略 B：AST 黑名单 + 子查询遍历（pandas-ai / sqlglot）

`pandas-ai/pandasai/helpers/sql_sanitizer.py`

```python
def is_sql_query_safe(query: str, dialect: str = "postgres") -> bool:
    try:
        parsed = sqlglot.parse_one(temp_query, dialect=dialect)
        if parsed.key.upper() != "SELECT":          # 主语句必须是 SELECT
            return False
        if any(re.search(k, query, re.I) for k in infected_keywords):   # 黑名单
            return False
        for subquery in parsed.find_all(sqlglot.exp.Subquery):          # ★ 子查询也要查
            if any(re.search(k, subquery.sql(), re.I) for k in infected_keywords):
                return False
        return True
    except sqlglot.errors.ParseError:
        return False                                 # ★ fail-closed：解析失败即拒绝
```

#### 策略 C：数据库干跑（shopkeeper-agent）

`shopkeeper-agent/app/agent/nodes/validate_sql.py`

```python
# validate 内部使用 explain <sql>，只关心数据库能否成功解析这条 SQL
await dw_mysql_repository.validate(sql)     # 失败不抛异常，写入 state["error"]
return {"error": None}                       # 由 graph 的条件边决定 走 run_sql 还是 correct_sql
```

SQLBot 则用 sqlglot 做**表名安全**（`SQLBot/backend/apps/chat/task/llm.py`）：
> 「表名安全检查：用 sqlglot 解析真实 SQL，**不信任 AI 返回的 tables**」，并 `get_sqlglot_dialect(ds_type)` 按数据源切方言。

**L1 结论**：
- 只做「首关键字判断 + 正则黑名单」是**不够的**（我们当前实现就在这一档）。
- 若要接近生产级：**AST 白名单（语句+节点+函数）+ 只读事务 + 解析失败即拒绝**，三者叠加。
- `EXPLAIN` 干跑是很好的**补充**（能发现列名错、类型错），但它**不提供安全**（`EXPLAIN DELETE` 也合法）——两者要一起用。

### 1.B 语义层（WrenAI MDL）—— 把"口径"变成 schema

`WrenAI/core/wren-mdl/mdl.schema.json`（621 行 JSON Schema）

顶层：`catalog, schema, description, models[], relationships[], cubes[], views[], enumDefinitions[]`

```jsonc
// $defs/measure —— Cube 内的命名聚合
{ "name": "...", "expression": "SUM(...)", "type": "...",
  "description": "human-readable description of the measure (indexed for agent comprehension)" }

// $defs/cubeDimension —— 分组维度
{ "name":"...", "expression":"...", "type":"...", "description":"..." }

// $defs/column —— 含计算列与【列级权限】
{ "name":"...", "type":"...", "relationship":"...",
  "isCalculated": true, "expression": "...",
  "columnLevelAccessControl": { "name":"...","operator":"...","requiredProperties":[...],"threshold":... } }
```

**要点**：`description` 明确写着 *indexed for agent comprehension*——**description 是给检索/模型用的**，不是给人看的注释。这解释了他们为什么把语义层设计成"可被 RAG 索引的字段"。

### 1.C 端口（Ports）—— 上层只依赖接口

- **模型端口**：`vanna/src/vanna/core/llm/base.py`（`LlmService` ABC）
- **SQL 执行端口**：`vanna/src/vanna/capabilities/sql_runner/base.py`
  ```python
  class SqlRunner(ABC):
      @abstractmethod
      async def run_sql(self, args: RunSqlToolArgs, context: ToolContext) -> pd.DataFrame: ...
  ```
- **连接器**：`postgres-mcp/.../sql/sql_driver.py`（`SqlDriver` / `DbConnPool`），并有 `obfuscate_password()` 在日志里脱敏凭据——**小细节但必须抄**。

**L1 不变量**：L1 之上不得再出现 SQL 解析、连接创建、模型 HTTP。

---

## L2 细胞（Cells）—— 一次问答的变换链

### shopkeeper-agent：完整可读的参考实现

`shopkeeper-agent/app/agent/graph.py`（LangGraph 编排）

```
START → extract_keywords → ┌─ recall_column ┐
                           ├─ recall_value  ├→ merge_retrieved_info → ┌ filter_table ┐
                           └─ recall_metric ┘                           └ filter_metric┘
                                    → add_extra_context → generate_sql → validate_sql
                                                                           │
                                        error is None ──→ run_sql ──→ END
                                        error != None ──→ correct_sql ──→ run_sql
```

关键代码（条件边的写法）：

```python
graph_builder.add_conditional_edges(
    source="validate_sql",
    path=lambda state: "run_sql" if state["error"] is None else "correct_sql",
    path_map={"run_sql": "run_sql", "correct_sql": "correct_sql"},
)
```

**三类召回的分工**（这是他们最核心的设计）：

| 召回 | 存储 | 目的 | 文件 |
|---|---|---|---|
| 字段 | Qdrant（向量） | 语义召回字段 | `app/repositories/qdrant/column_qdrant_repository.py` |
| 指标 | Qdrant（向量） | 召回业务口径 | `app/repositories/qdrant/metric_qdrant_repository.py` |
| **取值** | Elasticsearch（全文） | **值域匹配**（"华北" 到底是哪个枚举） | `app/repositories/es/value_es_repository.py` |
| 权威元数据 | MySQL | 表/字段/指标的结构化真相 | `app/repositories/mysql/meta/meta_mysql_repository.py` |

**SQL 生成**（`generate_sql.py`）：

```python
prompt = PromptTemplate(template=load_prompt("generate_sql"),
                        input_variables=["table_infos","metric_infos","date_info","db_info","query"])
chain = prompt | llm | StrOutputParser()          # ★ 只要纯 SQL，不要 JSON/Markdown
result = await chain.ainvoke({
    "table_infos": yaml.dump(table_infos, allow_unicode=True, sort_keys=False),  # ★ YAML 更适合进提示词
    ...})
```

**状态契约**（`app/agent/state.py`）：`query, keywords, retrieved_*_infos, table_infos, metric_infos, date_info, db_info, sql, error`

**要点**：
- **`date_info` + `db_info`（方言/版本）也进上下文**——时间相对词（"上周"）和方言差异是常见错因，很多实现漏掉。
- **`examples`（字段真实样例值）挂在字段上**，直接喂给模型辅助 `WHERE` 取值。
- 用**条件边 + error 字段**做修复循环，而不是抛异常中断。

---

## L3 器官（Organs）—— 端到端流程与沙箱

### 3.A 沙箱抽象（三家对比）

**data-formulator**（`py-src/data_formulator/sandbox/base.py`）——契约最干净：

```python
class Sandbox(ABC):
    @abstractmethod
    def run_python_code(self, code: str, workspace, output_variable: str) -> dict:
        """返回 {'status':'ok','content': DataFrame} 或 {'status':'error','content': str}"""
```
实现：`docker_sandbox.py` / `local_sandbox.py` / `not_a_sandbox.py`（三级降级）。

**pandas-ai**（`pandasai/sandbox/sandbox.py`）：

```python
class Sandbox:
    def start(self); def stop(self); def execute(self, code, environment) -> dict
    def transfer_file(self, csv_data, filename="file.csv")
    def _extract_sql_queries_from_code(self, code) -> list[str]   # ★ ast 解析出 SQL 做审计
```

**DB-GPT**（`dbgpt-sandbox/.../execution_layer/base.py`）——最工程化：

```python
class ExecutionStatus(Enum): SUCCESS/ERROR/TIMEOUT/RESOURCE_LIMIT

@dataclass
class SessionConfig:
    timeout: int = 30
    max_memory: int = 256*1024*1024
    max_cpus: int = 1
    working_dir: str = "/workspace"
    network_disabled: bool = False          # ★ 可断网
    validate_code: bool = True              # ★ 代码校验开关
```
运行时工厂：`runtime_factory.py` + `docker_runtime.py` / `podman_runtime.py` / `nerdctl_runtime.py` / `local_runtime.py`。

**L3 要点**：沙箱接口应该是 `(code, workspace, outputVar) -> Result`，且 **Result 要带 `timeout`/`resource_limit` 分类**；运行时（docker/podman/local）走工厂，便于降级。

### 3.B 其它器官

| 器官 | 位置 | 要点 |
|---|---|---|
| 索引调优 | `postgres-mcp/src/postgres_mcp/index/{dta_calc,llm_opt}.py` | 用 `pg_stat_statements` 找慢查询；`hypopg` 做 what-if |
| 健康巡检 | `postgres-mcp/src/postgres_mcp/database_health/` | 每类健康一个 `*_calc.py`（index/vacuum/buffer/connection/replication/sequence/constraint） |
| 分析工作流 | `data-formulator/py-src/data_formulator/workflows/`、`agents/`、`analyst/skills/` | **迭代式**：人改一次 → agent 再算一次 |
| 记忆能力 | `vanna/src/vanna/capabilities/agent_memory/` | 记忆是可插拔 capability |

---

## L4 个体（Organism）—— 身份、权限、交付

### 4.A 身份与工具级权限（vanna）

```python
# core/tool/base.py
class Tool(ABC, Generic[T]):
    @property def name(self) -> str
    @property def description(self) -> str
    @property def access_groups(self) -> List[str]: return []     # ★ 允许访问的用户组
    @abstractmethod def get_args_schema(self) -> Type[T]
    @abstractmethod async def execute(self, context: ToolContext, args: T) -> ToolResult

# core/user/models.py
class User(BaseModel):
    id: str; username: Optional[str]; email: Optional[str]
    metadata: Dict[str, Any]
    group_memberships: List[str]                                   # ★ 与 access_groups 对应

# core/tool/models.py
class ToolContext(BaseModel):
    user: User; conversation_id: str; request_id: str
    agent_memory: AgentMemory; metadata: Dict[str, Any]
    observability_provider: Optional[ObservabilityProvider]        # ★ 可观测性从上下文注入
```

**要点**：**权限是"工具 × 用户组"两维**，且 `ToolContext` 天然携带 user + request_id + 可观测性——这就是"交付层注入、下层不感知"的端口注入模式。

### 4.B 列级权限（WrenAI）

`mdl.schema.json` 的 `columnLevelAccessControl: {name, operator, requiredProperties, threshold}`——把权限**写进语义层**，与指标定义同源。

### 4.C 交付形态

| 形态 | 位置 |
|---|---|
| MCP server | `postgres-mcp/src/postgres_mcp/server.py` |
| FastAPI + SSE 流式组件 | `vanna/src/vanna/servers/`（`register_chat_routes`）+ `components/{rich,simple}/` |
| Web 组件 `<vanna-chat>` | `vanna/frontends/` |
| 引擎/企业分层 | `Dataherald/services/{engine,enterprise,admin-console,slackbot}/` |
| 组织/鉴权 | `Dataherald/services/enterprise/modules/auth/` |
| 工作空间隔离 | `SQLBot/backend/apps/*`（workspace + 细粒度数据权限） |
| SDK 层 | `WrenAI/sdk/`（langchain/pydantic）、`DB-GPT/packages/dbgpt-client/` |

### 4.D 少样本沉淀（"越问越准"的机制）

- `Dataherald/services/enterprise/modules/golden_sql/`（`controller/models/repository/service`）——**Golden SQL**：经确认的「问题→SQL」对，作为 few-shot 检索。
- `Dataherald/services/engine/dataherald/context_store/`（`default.py`）+ `vector_store/`。
- `Dataherald/services/engine/dataherald/smart_cache/`——查询结果/生成结果缓存。

---

## L5 评测（Evaluation）

| 位置 | 做法 |
|---|---|
| `WrenAI/evals/spodbtify_ab/` | **模型/agent 无关**的 A/B 评测：`run_eval.py` 只做「校验 spec → 生成隔离 prompt → 跑外部 agent 命令 → 汇总 0/1/2 打分」；维度 `correct_table / correct_sql / correct_answer`；工作流 `schema_only` vs `dbt_integrated` |
| `Dataherald/services/engine/dataherald/eval/` | `eval_agent.py` + `simple_evaluator.py` |
| `vanna/src/evals/` | `benchmarks/` + `datasets/sql_generation/` |
| 外部基准 | Spider / BIRD-Bench / Spider2.0 |

**要点**：WrenAI 的评测**把 agent 当黑盒**（用命令模板驱动），因此可评测任意实现——**这正是我们 SDK 该支持的**：评测器与 agent 解耦，接口就是"给 prompt，收输出"。

---

## 跨层对照总表

| 维度 | postgres-mcp | WrenAI | shopkeeper | vanna | DB-GPT | pandas-ai | data-formulator | Dataherald | SQLBot |
|---|---|---|---|---|---|---|---|---|---|
| L1 护栏 | **pglast 白名单** | row limit/dry-plan | `EXPLAIN` 干跑 | 工具级 | sqlparse | **sqlglot 黑名单** | — | sqlparse | **sqlglot 表名** |
| L1 语义层 | — | **MDL** | 指标元数据 | — | — | semantic_layer_schema | knowledge/ | instruction | 术语库 |
| L1 端口 | SqlDriver | wren-core | Repository | **Tool/SqlRunner/LLM** | dbgpt-core | — | Sandbox | — | — |
| L2 检索 | schema | LanceDB | **Qdrant+ES+MySQL** | enhancer | RAG | vectorstores | — | context_store | embedding |
| L2 校验 | AST | dry-plan | **EXPLAIN** | — | verify_sql | sqlglot | — | — | sqlglot |
| L3 沙箱 | — | — | — | — | **多运行时** | **有** | **三级降级** | — | — |
| L4 权限 | access-mode | 列级 ACL | (待扩展) | **组×工具** | — | — | auth/ | **org/auth** | **工作空间** |
| L5 评测 | — | **A/B harness** | — | benchmarks | — | tests | — | **eval** | — |

---

## 对我们 SDK 的落地清单（仍不写代码，只定契约）

### L0（先写这些）
```ts
type Value = null | number | string | boolean;
type Row = Record<string, Value>;
interface ResultSet { columns: string[]; rows: Row[]; truncated: boolean; elapsedMs: number }
type ExecStatus = "ok" | "error" | "timeout" | "resource_limit";   // 抄 DB-GPT
interface ExecResult { status: ExecStatus; output?: ResultSet; error?: string }
```

### L1（三件套 + 端口）
```ts
interface Connector { execute(sql: string, o: { maxRows: number; timeoutMs: number }): Promise<ExecResult> }
interface Guard { check(sql: string): { allowed: boolean; kind: string; reason?: string } }  // 需 AST 级
interface SchemaCatalog { tables(): Promise<Table[]>; describe(t): Promise<TableDetail>; }
interface SemanticsStore { metrics(): Promise<Metric[]>; relationships(): Promise<Rel[]> }
interface ModelPort { complete(prompt: string): Promise<string> }
```
**硬性要求**：`Connector` 强制只读（不信调用方）；`Guard` 解析失败即拒绝；凭据日志脱敏。

### L2（流水线，对齐 shopkeeper）
`ContextBuilder → SqlGenerator → Validator(exPLAIN) → Executor → Verifier → AnswerComposer`，
外加 `Clarifier`（HITL）。**上下文必须含 date/dialect/value-examples。**

### L3
`Sandbox { run(code, workspace, outVar): Promise<ExecResult> }` + 运行时可降级。

### L4
`User{id, groups}` + `Tool.accessGroups` + `ToolContext{user, requestId, observability}` + 交付适配（CLI/MCP/HTTP）。

### L5
评测器与 agent 解耦：`RunAgent(prompt) -> output` 作为唯一接口，维度 `correctTable/correctSql/correctAnswer`。

---

## 下一步建议

1. **M0**：落 L0 + L1（`Connector`/`Guard`/`SchemaCatalog`），**Guard 升级到 AST 级**（Node 侧可用 `node-sql-parser` 或调用 sqlglot），并写契约测试（多语句/写/DDL/CTE+写/注释绕过/解析失败）。
2. **M1**：L2 + Stub Model 离线跑通；把 `EXPLAIN` 干跑接入 `Validator`。
3. 之后再按 `MANIFEST.md` 顺序补 L3 沙箱与 L4 交付。

> 本笔记所有结论均来自 `reference-projects/` 下的源码实读，引用路径可直接回查。
