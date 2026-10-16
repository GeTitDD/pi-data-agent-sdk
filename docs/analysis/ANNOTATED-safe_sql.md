# `safe_sql.py` 全文逐段注解（1036 行）

> 文件：`reference-projects/postgres-mcp/src/postgres_mcp/sql/safe_sql.py`
> 角色：**L1 安全护栏**的唯一实现。所有 SQL 在真正执行前都要过这一关。
> 全文 1036 行，结构上 **680 行是"白名单数据"**，只有约 **150 行是逻辑**。这个比例本身就是重要信息：**它的强度来自"枚举式白名单"，而不是来自算法。**

---

## 目录（按行号）

| 行号区间 | 内容 | 类型 |
|---|---|---|
| 1–83 | 导入区 | 依赖声明 |
| 85 | logger | 基础设施 |
| 88–96 | 类与 docstring | 契约声明 |
| 98–100 | 两个正则常量 | 配置 |
| 102–121 | `ALLOWED_STMT_TYPES`（9 项） | **数据·白名单** |
| 122–664 | `ALLOWED_FUNCTIONS`（**494 项**） | **数据·白名单** |
| 665–745 | `ALLOWED_NODE_TYPES`（59 项，含 3 处重复） | **数据·白名单** |
| 746–867 | `ALLOWED_EXTENSIONS`（**109 项**） | **数据·白名单** |
| 868–877 | `__init__` | 逻辑 |
| 878–947 | `_validate_node` | **逻辑·核心** |
| 948–979 | `_validate` | **逻辑·核心** |
| 980–1013 | `execute_query` | **逻辑·执行** |
| 1014–1018 | `sql_to_query` | 逻辑·工具 |
| 1019–1028 | `param_sql_to_query` | 逻辑·工具 |
| 1029–1036 | `execute_param_query` | 逻辑·可疑入口 |

---

## 1. 导入区（L1–83）

```python
from __future__ import annotations          # L1  延迟注解求值，允许前向引用
import asyncio, logging, re                 # L3-5
from typing import Any, ClassVar, Optional  # L6-8

import pglast                               # L10 ★ 用 PostgreSQL 官方语法解析器（libpg_query 绑定）
from pglast.ast import (…约60个 AST 节点类…)
from pglast.enums import A_Expr_Kind        # L77  运算符枚举（LIKE / ILIKE 判定用）
from psycopg.sql import SQL, Composable, Literal   # L78-80 参数安全内联
from typing_extensions import LiteralString # L81  ★ PEP 675，静态类型层面的"非插值字符串"
from .sql_driver import SqlDriver           # L83  被包装的底层驱动
```

**注解要点**：

- **`pglast` 是这份文件的核心资产**。它是 `libpg_query`（Postgres 真实解析器）的绑定，所以解析结果与**数据库本身**一致——这是它相对 `sqlglot` 的最大优势（不会出现"解析器能过、数据库也能过，但语义不同"的偏差）。
- 60 个显式 AST import 不是装饰：**每个 import 都对应白名单里的一个节点类型**。因此"新增一种允许的语法"必然伴随一次显式 import —— 这是一种**刻意的昂贵**（提高改动门槛）。
- **`LiteralString`（L81）是常被忽略的亮点**：`query: LiteralString` 让 mypy/ruff 拒绝把 f-string 拼接的字符串传进来，把 **SQL 注入风险左移到类型检查阶段**。这是"用类型系统做安全"的范例。

---

## 2. logger（L85）

```python
logger = logging.getLogger(__name__)
```
只做日志。注意：**它记录了被拒绝的 SQL 原文**（见 L1008 `logger.error(f"Error executing query: {e}")`）——日志里可能含敏感字面量，属治理面需注意项。

---

## 3. 类与 docstring（L88–96）

```python
class SafeSqlDriver(SqlDriver):
    """A wrapper around any SqlDriver that only allows SELECT, ANALYZE, VACUUM, EXPLAIN SELECT, and
    SHOW queries. ... Performs deep validation of the query tree to prevent unsafe operations."""
```

**注解要点**：

- 采用**装饰器模式（Wrapper）**：`SafeSqlDriver(SqlDriver)`，构造时注入一个底层驱动。上层只依赖 `SqlDriver` 接口，安全策略是**可叠加的一层**——这正是"端口 + 适配器"的落地。
- ⚠️ **docstring 与实际白名单不一致**：docstring 声称只允许 `SELECT/ANALYZE/VACUUM/EXPLAIN SELECT/SHOW`，但 `ALLOWED_STMT_TYPES` 实际还允许 `CREATE EXTENSION / PREPARE / DEALLOCATE / DECLARE CURSOR / CLOSE / FETCH`。**文档落后于代码**，是安全模块里最危险的一类不一致（审计者会按 docstring 评估风险）。
- "deep validation of the query tree" 是准确的——它不是只看首关键字。

---

## 4. 正则常量（L98–100）

```python
PG_CATALOG_PATTERN = re.compile(r"^pg_catalog\.(.+)$")   # L98
LIKE_PATTERN       = re.compile(r"^[^%]+%$")             # L100
```

**注解要点**：

- `PG_CATALOG_PATTERN`：用于把函数名 `pg_catalog.sum` **规范化**为 `sum` 再去比白名单。设计意图正确（`pg_catalog.` 是默认搜索路径，不剥就会误拒）。
  - 局限：**只剥离 `pg_catalog.`**。`public.sum(...)` 会命中 `"public.sum" not in ALLOWED_FUNCTIONS` → 被拒（安全，但可能误拒）。
- 🔴 **`LIKE_PATTERN`（L100）定义后从未被使用**（全文再无引用）。同时 `_validate_node` 里的 LIKE 校验分支写着 `# Nothing to do for now`（L887）——**这是一处"意图存在、实现缺席"的死代码**。它暗示作者原计划校验 LIKE 通配模式（防止 `%` 开头的低效/全表扫描模式），但没做完。**审计时应把它标为 TODO，而不是以为已有保护。**

---

## 5. `ALLOWED_STMT_TYPES`（L102–121）★ 第一层白名单

```python
ALLOWED_STMT_TYPES = {
    SelectStmt,          # L103
    ExplainStmt,         # L104
    CreateExtensionStmt, # L105  ← ⚠️ 见下
    VariableShowStmt,    # L106  SHOW
    VacuumStmt,          # L107  ← ⚠️ 见下
    PrepareStmt,         # L108  ← ⚠️ 见下
    # ExecuteStmt,       # L109  ← 被注释掉
    DeallocateStmt,      # L110  ← ⚠️ 见下
    # CopyStmt,          # L111  被注释
    # DiscardStmt,       # L112
    DeclareCursorStmt,   # L113
    ClosePortalStmt,     # L114
    FetchStmt,           # L115
    # CheckPointStmt, ListenStmt, UnlistenStmt, VariableSetStmt  # L116-119 全部注释掉
}
```

**注解要点（含 4 个真实风险）**：

1. **只允许 9 类语句**，其余（INSERT/UPDATE/DELETE/DDL/TRUNCATE/GRANT/DO/CALL…）在**类型层面**就被拒——这是整个护栏的**第一道也是最粗的网**。
2. 🔴 **`CreateExtensionStmt`（L105）**：`CREATE EXTENSION` 会**执行扩展的安装脚本**（可执行 SQL/代码），权限极大。它靠 `ALLOWED_EXTENSIONS` 缩小到 109 个已知扩展，但白名单里有 `dblink`、`postgres_fdw`、`mysql_fdw`、`oracle_fdw`、`mongo_fdw`、`tds_fdw`、`aws_s3`、`pg_net` —— **这些都能发起外部连接**，等于打开了**数据外泄通道**。对"只读分析"场景，这些应被剔除。
3. 🔴 **`VacuumStmt`（L107）**：`VACUUM` / `ANALYZE` **会修改物理存储与统计信息**，严格讲不是"只读"。它被允许是因为对本项目（索引调优 DBA 场景）有用——**这是"面向 DBA 工具"与"面向只读分析"两种定位的差异**。我们做 read-only copilot 时应移除。
4. 🔴 **`PrepareStmt`/`DeallocateStmt`（L108/L110）**：这是**会话状态的写操作**（创建/删除预备语句）。更微妙的是 L109 把 `ExecuteStmt` 注释掉了——于是出现"**能 PREPARE 但不能 EXECUTE**"的半套能力，prepared 路径实际不可用，白名单里留着却无收益，只增加了面积。
5. ✅ **被注释掉的项体现了作者的克制**：`CopyStmt`（防止 `COPY FROM`）、`DiscardStmt`、`ListenStmt`/`UnlistenStmt`、`VariableSetStmt`（SET）、`CheckPointStmt` 都被主动排除。**注释本身就是安全设计文档**，值得学习这种写法。
6. ⚠️ **`DeclareCursorStmt`/`ClosePortalStmt`/`FetchStmt`（L113–115）**：游标族允许"打开游标后多次 FETCH"，等同于**分页读取**——这会绕过"一次性行数限制"的直觉预期。若上层按单次查询计费/计时，游标是绕过点。

---

## 6. `ALLOWED_FUNCTIONS`（L122–664）★ 第二层白名单，494 项

这是一份**按功能分类手工枚举**的函数白名单，分类注释即目录：

| 行号 | 分类 | 代表 |
|---|---|---|
| 123 | Aggregate | `sum/avg/count/array_agg/jsonb_agg/percentile_cont/mode` |
| 141 | Mathematical | `abs/ceil/floor/log/power/round/factorial/width_bucket` |
| 176/193 | Trigonometric / Hyperbolic | `sin/cos/atan2/…` |
| 200 | Array | `array_agg/unnest/array_position/cardinality/any` |
| 223 | String | `concat/substring/regexp_*/to_char/to_date/to_timestamp` |
| 274 | Pattern matching | `regexp_match/regexp_replace/…` |
| 284 | Type casting | `regclass/to_number/…` |
| 290 | Information | `current_user/current_schema/version/pg_backend_pid` |
| 312 | DB object info | `pg_relation_size/pg_total_relation_size/pg_table_size` |
| 326 | Privilege checks | `has_table_privilege/pg_has_role/row_security_active` |
| 342 | JSON | `jsonb_*/json_*`（含 `jsonb_set` 等） |
| 401 | Object info | `pg_get_expr/pg_get_indexdef/…` |
| 458 | Date/Time | `date_trunc/date_part/extract/make_*/now` |
| 482 | Type conversion | `cast/text/int4/numeric/timestamp` |
| 502 | System/Config info | `pg_tablespace_location/pg_settings_get_flags` |
| 507–536 | 事务/WAL/控制/WAL/网络/临时schema/通知/服务状态 | `pg_current_xact_id/pg_control_*/pg_available_wal_summaries/inet_client_addr/…` |
| 536 | **Hypopg** | `hypopg_create_index/hypopg_reset/…`（索引调优必需） |
| 544 | XML | `xpath/xmltable/…` |
| 560 | Network/IP | `host/masklen/network/…` |
| 575 | Full-text | `to_tsvector/ts_rank/websearch_to_tsquery/…` |
| 599–618 | Range/Geometry/UUID/Enum | `range_merge/area/gen_random_uuid/enum_range` |
| 620+ | Sequence / pg_trgm / pgcrypto / earthdistance / fuzzystrmatch | `currval/similarity/digest/levenshtein` |
| — | Window | `row_number/rank/lag/lead/nth_value` |

**注解要点**：

- **设计哲学：白名单而非黑名单**。函数名是 SQL 里"可执行语义"的最小单元，枚举它是**唯一能挡住"用函数做副作用"的办法**（例如若允许 `pg_read_file()` 就能读服务器文件，允许 `lo_import` 就能读文件系统）。
- ✅ **明确未收录的高危函数**（这是它的价值证明）：`pg_sleep`、`pg_read_file`、`pg_read_binary_file`、`pg_ls_dir`、`pg_terminate_backend`、`pg_cancel_backend`、`pg_reload_conf`、`lo_import`、`lo_export`、`dblink` 函数族 —— **全部不在白名单**。检索全文件确认无这些名字。
- ⚠️ **`"any"`（L222）**：`any` 在 PG 里是聚合函数，但 SQL 里 `= ANY(...)` 会被 pglast 解析为 `SubLink`/`ScalarArrayOpExpr` 而非 `FuncCall`，所以这条大概率**永远不会命中**——属于"保险起见塞进去"的冗余项。
- ⚠️ **允许了 `random`/`setseed`（L~160）**：`setseed` 会修改会话随机状态（轻微会话写）。
- ⚠️ **允许了 `pg_current_xact_id`/`pg_current_snapshot` 等事务视图函数**：读操作，但会暴露并发事务细节，属**信息面**而非完整性面。
- ⚠️ **规模本身是维护负担**：494 项 + 109 项扩展，**没有生成器、没有来源注释、没有版本标记**。Postgres 每发一版新函数，这份清单就落后一版（表现为"合法但被拒"）。**建议我们做 SDK 时改为"从 pg_catalog 自动生成 + 人工排除表"**，把"枚举"变成"规则 + 例外"。
- `"age"` 附带注释 *"When used with timestamp arguments (not transaction IDs)"*（L~460）——说明作者意识到**同名函数不同语义**的问题，但这只是注释提醒，**代码并未真正区分参数类型**。这是白名单方案的固有局限：**粒度到函数名，不到函数签名**。

---

## 7. `ALLOWED_NODE_TYPES`（L665–745）★ 第三层白名单，59 项

```python
ALLOWED_NODE_TYPES = ALLOWED_STMT_TYPES | {
    ResTarget, ColumnRef, A_Star, A_Const, A_Expr, BoolExpr, BooleanTest, NullTest,
    RangeVar, JoinExpr, FromExpr, WithClause, CommonTableExpr,
    SubLink, MinMaxExpr, RowExpr,
    DefElem,                    # ← 出现两次（L671 与 L707）
    SortBy, SortGroupClause,
    Integer, Float, String, BitString, Boolean, RawStmt, ParamRef, SQLValueFunction,
    FuncCall, TypeCast, TypeName, Alias, CaseExpr, CaseWhen, RangeSubselect,
    CoalesceExpr, NamedArgExpr, RangeFunction, A_ArrayExpr,
    WindowFunc, WindowDef, WindowClause,
    TableFunc, RangeTableFunc, RangeTableFuncCol,
    A_Indirection, A_Indices,
    GroupingSet, GroupingFunc,
    RangeTableSample, TableSampleClause,
    RowCompareExpr, CollateClause, TargetEntry, ScalarArrayOpExpr,
    NotifyStmt,                 # L743 ← ⚠️ 见下
}
```

**注解要点**：

- 这一层解决的是**"语句类型合法，但内部藏了坏东西"**的问题。因为 `_validate_node` 对**每个子节点**都做类型检查，任何未列入的节点类型都会导致整条 SQL 被拒。
- ✅ **它的"排除"比"包含"更说明问题**。以下**不在**白名单，因而被结构性拒绝：
  `DoStmt`（匿名块 `DO $$…$$`）、`CallStmt`、`CreateFunctionStmt`、`InsertStmt`、
  `LockStmt`、`CopyStmt`、`TransactionStmt`、`VariableSetStmt`、`AlterTableStmt` 等。
  → **这是"注意不到的写操作"被挡住的关键**：即使用 `WITH x AS (...) DELETE` 这种 CTE 写，也因内含非白名单节点而被拒。
- 🔴 **`NotifyStmt`（L743）自相矛盾**。`NOTIFY` 是**向其它会话广播事件**的副作用操作（虽不改数据，但改系统状态、可被外部监听者感知）。把它放进"只读"白名单，与文件整体的完整性目标不一致。注释 `# NOTIFY command` 只描述了它是什么，没解释为什么允许。
- ⚠️ **3 处重复项**：`A_Expr`、`BoolExpr`、`DefElem` 各出现两次。`set` 语义下无功能影响，但**说明清单是手工维护且缺少去重检查**——是"清单会漂移"的直接证据。
- ⚠️ **粒度到"节点类型"，不到"字段约束"**。例如 `RangeTableSample`（TABLESAMPLE）被允许，意味着可以写 `SELECT * FROM huge TABLESAMPLE SYSTEM (100)` 扫全表；`RangeFunction` 允许 `generate_series(1, 1e12)` 直接制造巨量行。**节点白名单无法表达这类"语义强度"约束**——必须靠行数上限 + 超时（见 L980）。

---

## 8. `ALLOWED_EXTENSIONS`（L746–867）★ 第四层白名单，109 项

按来源分组：核心扩展（`hypopg/pg_stat_statements/pg_trgm/pgcrypto/hstore/ltree/tablefunc/unaccent`）、常用（`bloom/citext/pg_buffercache/pg_prewarm/pgstattuple/amcheck`）、**FDW 族**（`postgres_fdw/dblink/mysql_fdw/mongo_fdw/tds_fdw/oracle_fdw`）、流行（`postgis/timescaledb/pg_partman/pgaudit/pg_cron/pgvector/rum/zhparser`）、**编程语言族**（`plperl/plperlu/plpython3u/plpython/pltcl/pltclu/pljava/plrust`）、云厂商（`aws_commons/aws_s3`、Supabase 的 `pg_graphql/pg_net/pgjwt`）、分布式（`citus`）等。

**注解要点**：

- 🔴 **最危险的一组是"编程语言扩展"**：`plpython3u`、`plperlu`、`pljava`、`plrust`、`plv8`。安装它们意味着数据库内**具备执行任意宿主语言代码的能力**——虽然白名单只是"允许安装"，不等于"允许调用"，但**安装打开了能力面**。对一个只读分析工具，这些应当一律拒绝。
- 🔴 **FDW 族允许外部数据落地**：`postgres_fdw`/`dblink` 可在查询中连接**任意可达的数据库**；`aws_s3`/`pg_net` 可发起 HTTP/S3 请求。**这是数据外泄（exfiltration）的主要面**。审计时这是第一优先排查对象。
- ⚠️ `pg_cron`（定时任务）、`pgaudit`、`pglogical`（逻辑复制，会写）也在此列——再次印证：**这份白名单服务的是"DBA 运维工具"，不是"只读分析 copilot"**。
- ✅ 值得学的形式：**按来源分组 + 行内注释标明用途**（如 `"pg_tablespace_location", # Exposes filesystem paths`）。虽然结论可疑，但**注释把"这条为什么在这里"写清楚了**，便于后人裁决。

---

## 9. `__init__`（L868–877）

```python
def __init__(self, sql_driver: SqlDriver, timeout: float | None = None):
    self.sql_driver = sql_driver
    self.timeout = timeout
```
**注解**：把超时做成**可选的构造参数**（而非硬编码），默认 `None`=不限时。⚠️ **默认不限时**意味着"如果调用方忘了传 timeout，就没有执行时间上限"——安全的默认值应当是"有限"，这是**fail-open 的默认值**问题。

---

## 10. `_validate_node`（L878–947）★★ 全文逻辑核心

```python
def _validate_node(self, node: Node) -> None:
    # ① 节点类型必须白名单（递归的第一道闸）
    if not isinstance(node, tuple(self.ALLOWED_NODE_TYPES)):
        raise ValueError(f"Node type {type(node)} is not allowed")

    # ② LIKE 校验 —— ⚠️ 空实现
    if isinstance(node, A_Expr) and node.kind in (A_Expr_Kind.AEXPR_LIKE, A_Expr_Kind.AEXPR_ILIKE):
        if isinstance(node.rexpr, A_Const) and node.rexpr.val and hasattr(node.rexpr.val,"sval") and node.rexpr.val.sval is not None:
            pass                      # ← “Nothing to do for now”
        else:
            raise ValueError("LIKE pattern must be a constant string")

    # ③ 函数名必须在 ALLOWED_FUNCTIONS（剥 pg_catalog 前缀后比对）
    if isinstance(node, FuncCall):
        func_name = ".".join(str(n.sval) for n in node.funcname).lower()
        m = self.PG_CATALOG_PATTERN.match(func_name)
        if (m.group(1) if m else func_name) not in self.ALLOWED_FUNCTIONS:
            raise ValueError(f"Function {func_name} is not allowed")

    # ④ 禁止 SELECT ... FOR UPDATE/SHARE
    if isinstance(node, SelectStmt) and getattr(node,"lockingClause",None):
        raise ValueError("Locking clause on select is prohibited")

    # ⑤ 禁止 EXPLAIN ANALYZE（因为它会真的执行查询）
    if isinstance(node, ExplainStmt):
        for option in node.options or []:
            if isinstance(option, DefElem) and option.defname == "analyze":
                raise ValueError("EXPLAIN ANALYZE is not supported")

    # ⑥ CREATE EXTENSION 只允许白名单扩展
    if isinstance(node, CreateExtensionStmt) and node.extname not in self.ALLOWED_EXTENSIONS:
        raise ValueError(f"CREATE EXTENSION {node.extname} is not supported")

    # ⑦ 遍历 __slots__ 递归所有子节点
    for attr_name in node.__slots__:
        if attr_name.startswith("_"): continue
        try: attr = getattr(node, attr_name)
        except AttributeError: continue
        if isinstance(attr, list):
            for item in attr:
                if isinstance(item, Node): self._validate_node(item)
        elif isinstance(attr, tuple):
            for item in attr:
                if isinstance(item, Node): self._validate_node(item)
        elif isinstance(attr, Node):
            self._validate_node(attr)
```

**逐条注解**：

- **①（L880–882）"默认拒绝"的正确姿势**：先判定类型是否允许，**不允许就抛**。这是"白名单优先"的骨架。递归意味着安全检查覆盖**整棵树**，而非顶层。
- **②（L884–893）空实现 + 死规则**：`pass` 分支等于没有任何校验。所谓校验只拒绝"LIKE 右侧不是常量字符串"的情况（例如 `a LIKE b`）——**这条更像解析健壮性检查，不是安全控制**。配合未使用的 `LIKE_PATTERN`，可判定：**LIKE 相关保护=未完成**。
- **③（L895–902）函数白名单，含 schema 规范化**。**只在 `FuncCall` 层查**——但注意：某些"函数式语法"并不产生 `FuncCall`（如 `CAST(x AS t)` 是 `TypeCast`、`EXTRACT(...)` 是 `SQLValueFunction`），所以函数白名单**并非完全覆盖**；它覆盖的是普通函数调用。这是白名单粒度问题的第二个例证（第一个是 L460 `age`）。
- **④（L904–906）禁止行锁**：`SELECT ... FOR UPDATE/SHARE` 会**加锁并可能阻塞生产事务**——这是"可用性（availability）"维度的保护，非常必要且容易被漏掉。✅ 值得抄。
- **⑤（L908–913）禁止 `EXPLAIN ANALYZE`**：这是一个**细思极恐**的点——`EXPLAIN ANALYZE` 会**真正执行**语句。作者用一个 `DefElem.defname == "analyze"` 的精确判定挡住了它。✅ **如果只做"首关键字=EXPLAIN 就放行"的实现，这里就是漏洞**。这是本文最值得抄的一条。
- **⑥（L915–917）扩展白名单**（配合第 8 节的风险分析）。
- **⑦（L919–946）通用递归**：用 `node.__slots__` 反射遍历属性。
  - ✅ 优点：**不依赖硬编码的子节点字段名**，因此 pglast 升级新增字段时仍能覆盖（减少"漏掉某个新子树"的风险）。
  - ⚠️ 风险：**只遍历"直接是 `Node`/`list[Node]`/`tuple[Node]`"的属性**。若某个字段是不可迭代的容器（如 `dict` 或自定义结构）内含节点，**会被静默跳过**。这是一个**覆盖面依赖上游数据结构**的隐含假设——审计时值得用 pglast 的节点清单做一次"属性容器类型"普查。
  - ⚠️ 递归是**深度优先、无显式栈**：极深嵌套 SQL 可能触发 Python 递归上限（`RecursionError`）——会被 `_validate` 捕获并变成 ValueError（fail-closed，可接受）。

---

## 11. `_validate`（L948–979）★★ 入口与失败语义

```python
def _validate(self, query: str) -> None:
    try:
        parsed = pglast.parse_sql(query)          # L950 ★ 真解析器
        try:
            for stmt in parsed:                   # ★ 遍历【每一条】语句
                if isinstance(stmt, RawStmt):
                    if not isinstance(stmt.stmt, tuple(self.ALLOWED_STMT_TYPES)):
                        raise ValueError("Only SELECT, ANALYZE, VACUUM, EXPLAIN, SHOW and other read-only statements are allowed. …")
                else:
                    if not isinstance(stmt, tuple(self.ALLOWED_STMT_TYPES)):
                        raise ValueError("... Received: " + str(stmt))
                self._validate_node(stmt)         # ★ 再对整棵子树递归
        except Exception as e:
            raise ValueError(f"Error validating query: {query}") from e   # 错误信息回原始异常
    except pglast.parser.ParseError as e:
        raise ValueError("Failed to parse SQL statement") from e           # ★ fail-closed
```

**注解要点**：

- ✅ **逐条语句校验**：`pglast.parse_sql` 返回语句列表，循环检查**每一条**。因此 `SELECT 1; DROP TABLE users;` 会在第二条被拒。**这从机制上解决了"多语句走私"** —— 不需要额外的分号正则。这是我们当前实现最该升级的点。
- ✅ **fail-closed**：解析失败 → 抛 `ValueError("Failed to parse SQL statement")`，**不会"解析不了就放过"**。这是安全模块的正确默认。
- ⚠️ **两层 try/except 的信息折叠**：内层把"哪个节点被拒"的具体原因 re-raise 成 `ValueError(f"Error validating query: {query}")`，**具体原因只保留在 `__cause__`**。对外部调用者而言，错误信息不含 SQL 原文以外的诊断；对本项目可接受，但**对调试与审计不够友好**（无法从消息直接知道是函数被拒还是节点被拒）。
- 🔴 **依赖"解析器逐语句"与"驱动执行多语句"的语义一致**：`_validate` 逐条校验，而底层 `SqlDriver._execute_with_connection` 用 `while cursor.nextset(): pass` **明确处理了多结果集**——也就是说**驱动是允许一次执行多条语句的**。安全性完全建立在"pglast 切分语句的方式与 psycopg 完全一致"这一假设上。**这是一个跨组件的隐式契约**：任何一方的解析语义变化（如对 `$$`、`E''`、`U&''` 等字面量语法的处理差异）都可能产生**绕过窗口**。**建议：在上层显式拒绝多语句（如断言 `len(parsed)==1`）**，把"逐条校验"退化为"只许一条"，消除该假设。
- ⚠️ **`_validate` 不在超时保护内**：`execute_query` 的 `asyncio.timeout` 只包住执行（L991），**解析与递归遍历是同步、无上限的**。超长/超深 SQL 可造成额外 CPU 消耗（轻量 DoS 面）。

---

## 12. `execute_query`（L980–1013）★ 执行与强制只读

```python
async def execute_query(self, query, params=None,
                        force_readonly: bool = True,   # L983  ← “do not use value passed in”
) -> Optional[list[SqlDriver.RowResult]]:
    self._validate(query)                               # L985 ★ 先校验
    # NOTE: Always force readonly=True regardless of what was passed
    if self.timeout:
        try:
            async with asyncio.timeout(self.timeout):   # L991 ★ 超时只包执行
                return await self.sql_driver.execute_query(
                    f"/* crystaldba */ {query}", params=params, force_readonly=True)   # L993-995
        except asyncio.TimeoutError as e:
            logger.warning(...); raise ValueError(f"... timed out after {self.timeout} seconds in restricted mode ...") from e
        except Exception as e:
            logger.error(f"Error executing query: {e}"); raise
    else:
        return await self.sql_driver.execute_query(
            f"/* crystaldba */ {query}", params=params, force_readonly=True)           # L1008-1012
```

**注解要点**：

- ✅ **`force_readonly=True` 硬编码 + 注释显式声明"忽略传入值"**（L983）。这是**"永不信任调用方"**的教科书写法：即使上层错误地传了 `False`，也只读。**必须抄。**
- ✅ **校验先于执行**（L985），且**无旁路**（唯一路径都先 `_validate`）。
- ✅ **`/* crystaldba */` 前缀注入**：把来源标记打进 SQL 文本，使 `pg_stat_statements` 能识别"这是 MCP 发出的查询"。**运营/审计上有用**（可统计 agent 产生的负载）。副作用是每个查询都会被视作**文本不同**的语句，可能影响 PG 的语句归一化统计——权衡取舍。
- ⚠️ **超时只覆盖执行**：`asyncio.timeout` 从 L991 开始，L985 的校验在外。且**超时不包含队列等待**（连接池取连接的时间在 `sql_driver` 内部，但那也在同一个 `await` 里，所以实际覆盖了）。总体可接受，但注意**"校验阶段无时限"**。
- ⚠️ **无行数限制**：本层不做 `LIMIT` 注入、不做行数截断。`SELECT * FROM huge` 在超时前会把**全量结果**拉进内存（`cursor.fetchall()` 在底层）。**这是"完整性/机密性"之外的"可用性"风险**：一个查询就可能打爆进程内存。**必须在上层加行数上限**（我们的 `Data Copilot` 已有 `maxRows`，这里缺失）。
- ⚠️ **超时错误被包装成 `ValueError`**：调用方无法用类型区分"超时"与"校验失败"。建议用专门的异常类型（我们 SDK 的 `ExecResult.status` 分类正是为了这个）。

---

## 13. `sql_to_query`（L1014–1018）

```python
@staticmethod
def sql_to_query(sql: Composable) -> str:
    return sql.as_string()
```
**注解**：把 psycopg 的 `Composable` 渲染为字符串。`as_string()` **不绑定参数**（不适用真实连接），仅用于调试/日志/传给解析器。属于工具方法。

---

## 14. `param_sql_to_query`（L1019–1028）

```python
@staticmethod
def param_sql_to_query(query: str, params: list[Any]) -> str:
    sql_params = [p if isinstance(p, Composable) else Literal(p) for p in params]  # ★ 参数用 Literal 转义
    return SafeSqlDriver.sql_to_query(SQL(query).format(*sql_params))              # ★ 内联进 SQL 文本
```

**注解要点**：

- ✅ **用 psycopg 的 `Literal` 做参数转义**：即使参数来自模型输出，也会被正确加引号/转义，**不会造成参数注入**。这是"把参数变成 SQL 字面量"的安全做法。
- ⚠️ **参数被"内联"而非"绑定"**：结果是**拼接后的完整 SQL 字符串**。若这个字符串随后经过 `_validate`，安全；**但若被直接执行（见下节），则完全绕过白名单**。
- ⚠️ 内联会**丢失绑定参数带来的计划缓存收益**（每次 SQL 文本不同 → 无法复用 prepared plan），对高并发场景有性能影响。

---

## 15. `execute_param_query`（L1029–1036）🔴 **全文最可疑的入口**

```python
@staticmethod
async def execute_param_query(sql_driver: SqlDriver, query: LiteralString,
                              params: list[Any] | None = None) -> list[SqlDriver.RowResult] | None:
    """Execute a query after validating it is safe"""
    if params:
        query_params = SafeSqlDriver.param_sql_to_query(query, params)
        return await sql_driver.execute_query(query_params)     # 🔴 直接调用底层驱动，未走 _validate
    else:
        return await sql_driver.execute_query(query)            # 🔴 同样未校验
```

**注解要点**：

- 🔴 **docstring 声称 "after validating it is safe"，但函数体内没有任何 `_validate` 调用。** 它接收的是**底层 `SqlDriver`**（不是 `SafeSqlDriver`），因此**完全绕过了白名单**。
- 🔴 这是**一个可被误用的"旁路入口"**：任何调用方只要用它，护栏即失效。安全的写法应是：(a) 接收 `SafeSqlDriver`；(b) 内部先 `_validate`；(c) 或干脆删除该静态方法，只保留实例方法。
- ✅ 唯一的缓解是签名上的 `query: LiteralString`（防 f-string 注入）——但**它不防"传入一条语义危险的常量 SQL"**（例如 `LiteralString` 允许字面量 `"DROP TABLE users"`）。
- **审计结论：这是本文件最应被修正的一处。** 对比 `execute_query`（先校验 + 强制只读）与 `execute_param_query`（两者皆无），**同一个类里存在两种安全等级的执行路径**，是典型的"安全下界取决于最弱路径"。

---

## 全文设计模式总结

```
调用方
  └─ SafeSqlDriver.execute_query(query)               ← 唯一有护栏的入口
       ├─ _validate(query)
       │    ├─ pglast.parse_sql(query)                ← 真解析器（与 PG 同源）
       │    ├─ for stmt in parsed:                     ← 逐条语句
       │    │     ├─ ALLOWED_STMT_TYPES?               ← 第1层：语句类型白名单(9)
       │    │     └─ _validate_node(stmt)              ← 递归整棵树
       │    │           ├─ ALLOWED_NODE_TYPES?         ← 第2层：节点类型白名单(59)
       │    │           ├─ LIKE/负例、FuncCall→ALLOWED_FUNCTIONS(494)   ← 第3层
       │    │           ├─ SelectStmt.lockingClause?   ← 禁行锁
       │    │           ├─ ExplainStmt.analyze?        ← 禁 EXPLAIN ANALYZE
       │    │           └─ CreateExtensionStmt→ALLOWED_EXTENSIONS(109)  ← 第4层
       │    └─ ParseError → 拒绝（fail-closed）
       └─ sql_driver.execute_query(query, force_readonly=True)   ← 强制只读
            └─ BEGIN TRANSACTION READ ONLY … ROLLBACK            ← 引擎级兜底
```

**一句话概括**：**四层枚举白名单 + 一次整树递归 + 真解析器 + 强制只读事务 + 执行超时**，而 Docstring/注释负责声明意图。

---

## 缺陷与风险清单（按严重度）

| 级别 | 问题 | 位置 |
|---|---|---|
| 🔴 高 | `execute_param_query` **完全绕过白名单**（docstring 却称已校验） | L1029–1036 |
| 🔴 高 | `CREATE EXTENSION` 白名单含 **FDW/plpython/plperl/pg_net** 等可外连或执行代码的扩展 | L746–867 |
| 🔴 高 | docstring 与实际白名单**不一致**（声称仅 SELECT/ANALYZE/VACUUM/EXPLAIN/SHOW） | L88–96 vs L102 |
| 🟠 中 | **依赖"pglast 逐句切分"与"psycopg 多语句执行"语义一致**，无显式单语句断言 | L948 / sql_driver L224+ |
| 🟠 中 | **无行数上限**，`fetchall()` 可一次拉全量 | L980–1013 |
| 🟠 中 | `timeout` 默认为 `None`（fail-open 的默认值） | L868 |
| 🟠 中 | 允许 `NotifyStmt`（有副作用），与"只读"定位冲突 | L743 |
| 🟠 中 | 允许 `VacuumStmt`/`PrepareStmt`/`DeallocateStmt`（写存储/写会话状态） | L107–110 |
| 🟡 低 | `LIKE_PATTERN` 定义未用；LIKE 校验为空实现（`pass`） | L100 / L887 |
| 🟡 低 | `ALLOWED_NODE_TYPES` 有 3 处重复项（无去重校验） | L665–745 |
| 🟡 低 | 白名单**无生成机制**，494+109 项纯手工，Postgres 版本升级即漂移 | L122/L746 |
| 🟡 低 | 函数名粒度不区分签名（`age` 的事务ID vs 时间戳） | L~460 |
| 🟡 低 | 校验阶段不在超时内，且递归可能触发 `RecursionError` | L948 |
| 🟡 低 | 异常类型单一（超时/校验失败都是 `ValueError`） | L996/L1008 |

---

## 我们 SDK 的可移植结论

**直接照抄（高价值）**
1. **用真解析器**（Node 侧：`node-sql-parser`，或子进程调 sqlglot/pglast）；**解析失败即拒绝**。
2. **逐条语句校验**（并进一步：**只允许一条**，消除解析语义差异假设）。
3. **三层白名单**：语句类型 → 节点类型（递归整树）→ 函数名；扩展/函数清单**自动生成 + 人工排除**。
4. **拒绝 `EXPLAIN ANALYZE`**（它会真执行）与 **`SELECT ... FOR UPDATE`**（会锁表）。
5. **`force_readonly` 永不信任调用方** + 引擎级只读事务 + `ROLLBACK`。
6. **`LiteralString`/类型层防注入**；参数用驱动自带的 `Literal` 转义。
7. **唯一执行入口**，禁止任何未校验的旁路（用 lint/测试断言"只有一个出口"）。

**必须补上（原文的缺口）**
8. **行数上限 + `LIMIT` 注入**（防内存打爆）。
9. **超时默认有限**，且覆盖校验阶段。
10. **扩展/函数白名单按"只读分析"重新裁剪**：剔除 FDW、`pl*` 语言扩展、`NotifyStmt`、`VacuumStmt`、`Prepare/Deallocate`。
11. **失败分类**（`ok/error/timeout/denied`）而非单一异常类型。
12. **白名单覆盖率测试**：遍历 pglast 全部节点类型，断言"未列入白名单的节点数"符合预期（防止上游升级引入新节点后被静默放过）。

---

*本注解基于 `safe_sql.py` 1036 行全文实读；行号与原文一一对应，可直接回查。*
