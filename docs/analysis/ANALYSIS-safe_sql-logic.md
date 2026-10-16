# `safe_sql.py` 关键逻辑解析（源码 + 逐行）

> 配套文档：`ANNOTATED-safe_sql.md`（全文 1036 行逐段注解）。
> 本文只讲**关键逻辑主干**，不贴 680 行白名单数据。
> 文件：`reference-projects/postgres-mcp/src/postgres_mcp/sql/safe_sql.py`

---

## 一、总入口：`_validate`（L948–979）

### 源码

```python
def _validate(self, query: str) -> None:
    try:
        parsed = pglast.parse_sql(query)          # ① 真解析器
        try:
            for stmt in parsed:                    # ② 遍历每一条语句
                if isinstance(stmt, RawStmt):
                    if not isinstance(stmt.stmt, tuple(self.ALLOWED_STMT_TYPES)):
                        raise ValueError("Only SELECT, ANALYZE, VACUUM, EXPLAIN, SHOW ... Received raw statement: " + str(stmt.stmt))
                else:
                    if not isinstance(stmt, tuple(self.ALLOWED_STMT_TYPES)):
                        raise ValueError("... Received: " + str(stmt))
                self._validate_node(stmt)          # ③ 对整棵子树递归
        except Exception as e:
            raise ValueError(f"Error validating query: {query}") from e
    except pglast.parser.ParseError as e:
        raise ValueError("Failed to parse SQL statement") from e   # ④ fail-closed
```

### 逐行解析

**① `pglast.parse_sql(query)`**
`pglast` 是 PostgreSQL 官方解析器 `libpg_query` 的 Python 绑定。**这是整个护栏的地基**：解析结果与数据库本身**同源**，不存在"我的解析器和数据库理解不一致"的偏差窗口（对比 `sqlglot` 这类独立实现）。

**② `for stmt in parsed` — 逐条语句校验**
`parse_sql` 返回**语句列表**。作者没假设"只有一个语句"，而是**循环每一条**。

> **防的攻击：多语句走私。**
> 输入 `SELECT 1; DROP TABLE users;`
> → 第 1 条是 `SelectStmt`，过；第 2 条是 `DropStmt`，**不在 `ALLOWED_STMT_TYPES`** → 抛异常，整体拒绝。
>
> 注意：**它没有用分号正则**。靠"解析器切分 + 逐条判类型"。这正是它比 `sql.count(';')` 式实现健壮的原因——分号可以藏在字符串里（`SELECT ';'`），正则会被骗，解析器不会。

**③ `self._validate_node(stmt)` — 进入递归**
语句类型过了不等于安全（`SELECT` 里可以藏 `pg_read_file()`）。所以还要对**整棵语法树**递归检查。

**④ `except pglast.parser.ParseError → raise ValueError`**
**解析失败 → 拒绝**，而不是"解析不了就放过"。

> **防的攻击：用畸形语法绕过解析器。**
> 很多失败的护栏是 `try: parse() except: pass` —— 那等于"只要让解析器报错就能绕过所有白名单"。这里是 **fail-closed（失败即关闭）**，正确。

---

## 二、递归核心：`_validate_node`（L878–947）

该方法有 6 个检查 + 1 段递归。

### 检查 1：节点类型白名单（L880–882）

```python
if not isinstance(node, tuple(self.ALLOWED_NODE_TYPES)):
    raise ValueError(f"Node type {type(node)} is not allowed")
```

把 `ALLOWED_NODE_TYPES`（59 项）转 tuple 传给 `isinstance`；**不在白名单的节点类型一律拒绝**。

> 这是"**默认拒绝**"（deny-by-default）的骨架。攻击面被结构性关闭：
> `DoStmt`（`DO $$ ... $$`）、`CallStmt`、`CreateFunctionStmt`、`InsertStmt`、`LockStmt`、`TransactionStmt`…… 都**不在**白名单。
>
> 典型攻击：`WITH x AS (SELECT 1) DELETE FROM users`
> 在 PG 里这条**解析为 `DeleteStmt`**（不是 SelectStmt），第一层就被拒；即便换个变体让顶层是 Select，内层写节点也过不了这一层。

### 检查 2：LIKE 校验（L884–893）—— 🔴 空实现

```python
if isinstance(node, A_Expr) and node.kind in (A_Expr_Kind.AEXPR_LIKE, A_Expr_Kind.AEXPR_ILIKE):
    if isinstance(node.rexpr, A_Const) and node.rexpr.val is not None and hasattr(node.rexpr.val, "sval") and node.rexpr.val.sval is not None:
        # Nothing to do for now          ← 什么都不做
        pass
    else:
        raise ValueError("LIKE pattern must be a constant string")
```

- 右侧是**常量字符串** → `pass`（放行，无额外检查）。
- 右侧**不是常量**（`col LIKE other_col`）→ 拒绝。

> **这是"意图在、实现没做完"的死代码。** 文件开头还定义了 `LIKE_PATTERN = re.compile(r"^[^%]+%$")`（L100）——**全文从未使用**。
> 从正则形状（"必须以 % 结尾，且不能同时以 % 开头"）看，原意是校验**前导通配符**（`LIKE '%foo'` 无法走索引→全表扫描）。**该保护不存在。**
> 📌 审计含义：看到 `pass` + 未使用常量，应判定"这块保护=0"。

### 检查 3：函数名白名单 + schema 规范化（L895–902）

```python
if isinstance(node, FuncCall):
    func_name = ".".join([str(n.sval) for n in node.funcname]).lower() if node.funcname else ""
    match = self.PG_CATALOG_PATTERN.match(func_name)          # ^pg_catalog\.(.+)$
    unqualified_name = match.group(1) if match else func_name
    if unqualified_name not in self.ALLOWED_FUNCTIONS:
        raise ValueError(f"Function {func_name} is not allowed")
```

- `node.funcname` 是名字片段列表（`["pg_catalog","sum"]`），join 后 `lower()`（大小写无关）。
- 剥掉 `pg_catalog.` 前缀 → `"sum"`，再查白名单。

> 为什么剥前缀？`pg_catalog` 在默认 search_path 里，`sum(x)` 与 `pg_catalog.sum(x)` **语义完全相同**。不剥的话，攻击者写全限定名就能绕过。
>
> 防的攻击：`SELECT pg_read_file('/etc/passwd')` → 不在 494 项白名单 → 拒绝。同理 `pg_sleep`、`pg_ls_dir`、`pg_terminate_backend`、`lo_import` 全不在。
>
> ⚠️ 局限：白名单**只到函数名，不到签名**。作者对 `age` 写了注释 *"When used with timestamp arguments (not transaction IDs)"*——知道 `age(txid)` 与 `age(timestamp)` 语义不同，但**代码并未区分**。

### 检查 4：禁止行锁（L904–906）

```python
if isinstance(node, SelectStmt) and getattr(node, "lockingClause", None):
    raise ValueError("Locking clause on select is prohibited")
```

`SelectStmt.lockingClause` 对应 `FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE`。

> 防的**不是数据安全，是可用性安全**。
> `SELECT * FROM orders WHERE id=1 FOR UPDATE` 会给行加排他锁；事务不提交会**阻塞生产写入**，一条"只读"查询即可引发事故。最容易被漏掉的一类风险。✅ 值得抄。

### 检查 5：禁止 `EXPLAIN ANALYZE`（L908–913）★★

```python
if isinstance(node, ExplainStmt):
    for option in node.options or []:
        if isinstance(option, DefElem) and option.defname == "analyze":
            raise ValueError("EXPLAIN ANALYZE is not supported")
```

`EXPLAIN` 的选项是 `DefElem` 列表，检查是否有 `defname == "analyze"`。

> **全文最"细思极恐"的点**：`EXPLAIN ANALYZE SELECT ...` 会**真正执行**查询！
> 若实现只判"首关键字是 EXPLAIN 就放行"，攻击者可用
> `EXPLAIN ANALYZE DELETE FROM users` —— 看似"只读 EXPLAIN"，实际**真删**。
> 作者用 `DefElem.defname` 精确挡住。✅ **必须抄。**

### 检查 6：扩展白名单（L915–917）

```python
if isinstance(node, CreateExtensionStmt):
    if node.extname not in self.ALLOWED_EXTENSIONS:
        raise ValueError(f"CREATE EXTENSION {node.extname} is not supported")
```

`CREATE EXTENSION` 在语句白名单里（L105），用 `ALLOWED_EXTENSIONS`（109 项）二次收窄。

> 风险：`CREATE EXTENSION` 会**执行扩展安装脚本**。白名单含 `dblink`/`postgres_fdw`/`pg_net`/`aws_s3`（**数据外泄面**）与 `plpython3u`/`plperl`（**任意代码执行面**）。
> ⚠️ 对"DBA 工具"合理，对"只读分析 copilot"**必须裁剪**。

### 递归：用 `__slots__` 反射遍历子节点（L919–946）

```python
for attr_name in node.__slots__:
    if attr_name.startswith("_"):
        continue
    try:
        attr = getattr(node, attr_name)
    except AttributeError:
        continue
    if isinstance(attr, list):
        for item in attr:
            if isinstance(item, Node): self._validate_node(item)
    elif isinstance(attr, tuple):
        for item in attr:
            if isinstance(item, Node): self._validate_node(item)
    elif isinstance(attr, Node):
        self._validate_node(attr)
```

pglast 的 AST 节点用 `__slots__` 声明字段；遍历**每个字段**，遇到 `Node` / `list[Node]` / `tuple[Node]` 就递归。

> ✅ **优点**：**不硬编码子字段名**（不写 `node.where`、`node.targetList`…）。上游 pglast 升级、新增子节点字段时递归**自动覆盖**，不会因"忘了加字段"而漏检。
>
> ⚠️ **盲点**：只处理 `Node`/`list`/`tuple`。若某字段是 `dict` 或其它容器且内含 Node，会被**静默跳过**。这是递归覆盖面里唯一依赖上游数据结构的假设——审计时应用 pglast 节点清单做一次"字段容器类型"普查。
>
> ⚠️ 递归无深度上限，极深嵌套可能触发 `RecursionError`（被 `_validate` 捕获 → fail-closed，可接受）。

---

## 三、执行层：`execute_query`（L980–1013）

### 源码

```python
async def execute_query(self, query, params=None,
                        force_readonly: bool = True,   # do not use value passed in
) -> Optional[list[SqlDriver.RowResult]]:
    self._validate(query)                              # ① 先校验，无旁路

    # NOTE: Always force readonly=True in SafeSqlDriver regardless of what was passed
    if self.timeout:
        try:
            async with asyncio.timeout(self.timeout):  # ② 执行超时
                return await self.sql_driver.execute_query(
                    f"/* crystaldba */ {query}", params=params, force_readonly=True)
        except asyncio.TimeoutError as e:
            ...
            raise ValueError(f"... timed out after {self.timeout} seconds in restricted mode ...") from e
    else:
        return await self.sql_driver.execute_query(
            f"/* crystaldba */ {query}", params=params, force_readonly=True)   # ③ 仍强制只读
```

### 逐行解析

**① `self._validate(query)` 在最前** —— 验证先于执行；这是**唯一有护栏的执行出口**（除旁路，见第五节）。

**② 默认 `force_readonly: bool = True` + 注释 `# do not use value passed in`** —— 作者明知形参可被传成 `False`，故声明**形参只是占位**。

**③ 两条分支都硬编码 `force_readonly=True`** —— 无论走哪条分支，传下去都是 `True`。

> 防的攻击：**上层错误/恶意地传 `force_readonly=False`**。
> 常见写法是 `... force_readonly=force_readonly`——把安全开关交给调用方。**这里没有。** ✅ "永不信任调用方"的标准写法。
>
> 补充：`f"/* crystaldba */ {query}"` 把来源标记打进 SQL，便于在 `pg_stat_statements` 识别"MCP 发出的查询"。

---

## 四、引擎级兜底：`sql_driver._execute_with_connection`

```python
async with connection.cursor(row_factory=dict_row) as cursor:
    if force_readonly:
        await cursor.execute("BEGIN TRANSACTION READ ONLY")     # 只读事务
        transaction_started = True
    ...
    while cursor.nextset():      # 处理多结果集（说明驱动允许一次跑多条语句）
        pass
    ...
    if not force_readonly:
        await cursor.execute("COMMIT")
    elif transaction_started:
        await cursor.execute("ROLLBACK")                        # 读完即回滚
        transaction_started = False
```

- `BEGIN TRANSACTION READ ONLY`：PostgreSQL **只读事务**。其中任何写操作（INSERT/UPDATE/DELETE/DDL）都会报 `cannot execute ... in a read-only transaction`。
- 结束一律 `ROLLBACK`（读操作无需提交），**绝不留可写事务**。
- `while cursor.nextset()`：证明**底层驱动允许一次执行多条语句**（重要副作用）。

> ✅ **引擎级**强制，不依赖解析器。即使白名单被绕过，写操作也会在数据库层被拒。
> 🟠 **但它引出隐式契约**：安全依赖"**pglast 切分语句**"与"**psycopg 执行多条语句**"方式完全一致。`_validate` 逐条校验、驱动允许多条，两者若在某字面量语法（`$$`、`E''`、`U&''`）上理解不同，就出现窗口。
> 📌 **修法**：上层加 `assert len(parsed) == 1`，把"逐条校验"退化为"只允许一条"，假设即消失。

---

## 五、旁路漏洞：`execute_param_query`（L1029–1036）🔴

### 源码

```python
@staticmethod
async def execute_param_query(sql_driver: SqlDriver, query: LiteralString,
                              params: list[Any] | None = None) -> list[SqlDriver.RowResult] | None:
    """Execute a query after validating it is safe"""      # 文档说"已校验"
    if params:
        query_params = SafeSqlDriver.param_sql_to_query(query, params)
        return await sql_driver.execute_query(query_params)   # 🔴 没有任何 _validate
    else:
        return await sql_driver.execute_query(query)          # 🔴 同样没有
```

### 逐行解析

**① docstring 写 "after validating it is safe"，函数体无任何 `_validate`。** 文档与实现直接矛盾。

**② 接收 `sql_driver: SqlDriver`（底层驱动），不是 `SafeSqlDriver`。** 天生是"绕过安全层"的通道。

**③ 直接 `return await sql_driver.execute_query(...)`** —— 护栏（白名单 + 强制只读）**全部失效**。

> 🔴 **全文最该修的一处。** 同一个类里存在**两种安全等级的执行路径**：
> - `execute_query`（实例方法）：校验 + 强制只读 ✅
> - `execute_param_query`（静态方法）：**两者皆无** ❌
>
> 安全系统铁律：**整体强度等于最弱路径**。
> `param_sql_to_query` 用 psycopg `Literal` 转义参数，只防**参数注入**，**防不了"传入一条语义危险的常量 SQL"**（`LiteralString` 允许字面量 `"DROP TABLE users"`）。
>
> 📌 正确写法：(a) 参数类型改成 `SafeSqlDriver`；(b) 内部先 `_validate`；(c) 或删掉该静态方法，只留实例方法。

---

## 六、攻击 → 拦截点对照表

| 攻击输入 | 被哪一层拦下 | 机制 |
|---|---|---|
| `SELECT 1; DROP TABLE users;` | `_validate` 的 `for stmt in parsed` | 逐条语句类型检查（第 2 条非白名单类型） |
| `WITH x AS (SELECT 1) DELETE FROM users` | `ALLOWED_STMT_TYPES` | `DeleteStmt` 不在白名单 |
| `SELECT * FROM t FOR UPDATE` | `_validate_node` 检查 4 | `lockingClause` 非空 |
| `EXPLAIN ANALYZE DELETE FROM users` | `_validate_node` 检查 5 | `DefElem.defname == "analyze"` |
| `SELECT pg_read_file('/etc/passwd')` | `_validate_node` 检查 3 | 函数不在 494 项白名单 |
| `SELECT pg_catalog.pg_sleep(600)` | 检查 3（剥前缀后） | 规范化后仍不在白名单 |
| `DO $$ BEGIN ... END $$` | `ALLOWED_STMT_TYPES` | `DoStmt` 不在白名单 |
| 畸形 SQL（故意让解析器报错） | `_validate` ④ | `ParseError` → 拒绝（fail-closed） |
| 上层传 `force_readonly=False` | `execute_query` ③ + 驱动 | 硬编码 `True` + `BEGIN TRANSACTION READ ONLY` |
| **`execute_param_query("DROP TABLE users")`** | **无** 🔴 | **旁路，护栏失效** |

---

## 七、逻辑总览

```
外部输入
  │
  ├─ ① pglast.parse_sql          ← 数据库同源解析器；解析失败=拒绝
  │
  ├─ ② 逐条语句 → ALLOWED_STMT_TYPES(9)     ← 挡多语句走私、DDL/DML
  │
  ├─ ③ 整树递归 → ALLOWED_NODE_TYPES(59)    ← 挡藏在 SELECT 里的危险节点
  │        ├─ FuncCall → ALLOWED_FUNCTIONS(494)   ← 危险函数（含 pg_catalog 规范化）
  │        ├─ lockingClause  → 禁行锁             ← 保护可用性
  │        ├─ EXPLAIN.analyze → 禁 EXPLAIN ANALYZE ← 它会真执行
  │        └─ CreateExtension → ALLOWED_EXTENSIONS(109)
  │
  ├─ ④ 硬编码 force_readonly=True            ← 永不信任调用方
  │
  └─ ⑤ BEGIN TRANSACTION READ ONLY + ROLLBACK ← 引擎级兜底
```

**设计精髓**：四层枚举白名单 + 一次整树递归 + 真解析器 + 强制只读 + 引擎兜底，用"层层收窄 + 默认拒绝 + 失败即关闭"换来安全。

**三个缺口（我们要补）**：
1. 🔴 `execute_param_query` 旁路（最弱路径决定整体强度）
2. 🟠 无行数上限（`fetchall()` 一次拉全量）+ 超时默认 `None`
3. 🟠 白名单是"DBA 工具"取向（FDW / pl* / NOTIFY / VACUUM / PREPARE 需按只读分析场景裁剪）
