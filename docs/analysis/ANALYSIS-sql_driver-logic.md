# `sql_driver.py` 关键逻辑解析（源码 + 逐行）

> 文件：`reference-projects/postgres-mcp/src/postgres_mcp/sql/sql_driver.py`（**272 行**）
> 角色：**L1 的"唯一 IO 层"** —— 连接池、执行、事务、凭据脱敏。`SafeSqlDriver` 是它的装饰器（包装它并加白名单）。
> 配套：`ANNOTATED-safe_sql.md`、`ANALYSIS-safe_sql-logic.md`

---

## 目录（按行号，已核对源码）

| 行号 | 内容 | 类型 |
|---|---|---|
| 1–14 | 模块 docstring / 导入 / logger | 声明 |
| 20–59 | `obfuscate_password()` | **工具·凭据脱敏** |
| 62–136 | `class DbConnPool` | **逻辑·连接池** |
| 65–68 | `__init__` | |
| 71–114 | `pool_connect()` | **逻辑·建池** |
| 116–127 | `close()` | 逻辑·释放 |
| 129–136 | `is_valid` / `last_error` 属性 | 状态暴露 |
| 139–272 | `class SqlDriver` | **逻辑·执行器** |
| 142–146 | `RowResult` dataclass | L0 原子 |
| 148–170 | `__init__` | |
| 172–180 | `connect()` | 懒连接 |
| 182–222 | `execute_query()` | **逻辑·路由** |
| 224–272 | `_execute_with_connection()` | **逻辑·核心执行** |

---

## 一、`obfuscate_password()`（L20–59）—— 凭据脱敏

### 源码

```python
def obfuscate_password(text: str | None) -> str | None:
    if text is None:
        return None
    if not text:
        return text

    # ① 先当作标准 URL 解析
    try:
        parsed = urlparse(text)
        if parsed.scheme and parsed.netloc and parsed.password:
            netloc = parsed.netloc.replace(parsed.password, "****")     # L36 ← str.replace（子串）
            return urlunparse(parsed._replace(netloc=netloc))
    except Exception:
        pass

    # ② 兜底：非标准 URL 的文本
    url_pattern = re.compile(r"(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@[^\/\s]+)")
    text = re.sub(url_pattern, r"\1****\3", text)

    # ③ key=value 形式（无引号）
    param_pattern = re.compile(r'(password=)([^\s&;"\']+)', re.IGNORECASE)
    text = re.sub(param_pattern, r"\1****", text)

    # ④ DSN 单引号 / ⑤ 双引号
    dsn_single_quote = re.compile(r"(password\s*=\s*')([^']+)(')", re.IGNORECASE)
    text = re.sub(dsn_single_quote, r"\1****\3", text)
    dsn_double_quote = re.compile(r'(password\s*=\s*")([^"]+)(")', re.IGNORECASE)
    text = re.sub(dsn_double_quote, r"\1****\3", text)

    return text                                  # L59
```

### 逐行解析

**① URL 分支（L30–38）**：`urlparse` 识别 `scheme://user:pass@host/db`，用 `parsed.password` 取密码后替换。

> ⚠️ **`netloc.replace(parsed.password, "****")`（L36）是子串替换，不是位置替换。**
> 若密码是短串（如 `a`），会替换 netloc 中**所有** `a` 字符（用户名、主机名都可能被误伤）；替换后长度也可能变化，**破坏 URL 结构**。
> 正确写法：`netloc.replace(f":{password}@", ":****@")` 或按位置重建 netloc。

**②–⑤ 正则兜底（L40–57）**：只在 URL 解析失败/无 password 字段时生效。② 保持 `user:` 与 `@host`，只把中间密码换 `****`（`\1****\3`）；③④⑤ 覆盖 `password=xxx`、单引号、双引号三种 DSN 写法。

> ✅ **意图正确**：一层**纵深防御**，避免错误信息/日志/异常栈泄露凭据。此类工具在数据类项目里常被忽略，**值得抄**。

### 关键缺陷（重要）

🔴 **脱敏只在 `DbConnPool.pool_connect` 的异常路径被调用一次**（L114 `obfuscate_password(str(e))`），而：

- `DbConnPool._last_error = str(e)`（**L109**）**存原始错误串**，并经 `last_error` 属性（**L134**）**原样暴露** → **绕过脱敏**。
- `SqlDriver._execute_with_connection` 的异常路径 `logger.error(f"Error executing query ({query}): {e}")`（**L271**）**既不脱敏 `{e}`，还打印原始 SQL**（可能含敏感字面量）。
- `SqlDriver.execute_query` 也把 `self.conn._last_error = str(e)`（**L218**）再写一次未脱敏错误。

> 📌 **结论：脱敏不彻底、不一致。** 审计时不能因为"有这个函数"就认为凭据已受保护。SDK 应把脱敏**下沉到日志/异常的唯一出口**。

---

## 二、`DbConnPool`（L62–136）—— 连接池

### 2.1 `__init__`（L65–68）

```python
def __init__(self, connection_url: Optional[str] = None):
    self.connection_url = connection_url
    self.pool: AsyncConnectionPool | None = None
    self._is_valid = False
    self._last_error = None
```

**解析**：纯状态容器；**不在构造时连接**（懒连接）。`_is_valid`/`_last_error` 是"健康标记 + 最后错误"，构成后面"失败后自动重建"的基础。

### 2.2 `pool_connect()`（L71–114）★

```python
async def pool_connect(self, connection_url=None) -> AsyncConnectionPool:
    """Initialize connection pool with retry logic."""          # ← 文档说 retry
    # ① 已有有效池 → 复用
    if self.pool and self._is_valid:
        return self.pool

    url = connection_url or self.connection_url
    self.connection_url = url
    if not url:
        self._is_valid = False
        self._last_error = "Database connection URL not provided"
        raise ValueError(self._last_error)

    # ② 建新池前先关旧池（避免泄漏）      L85
    await self.close()

    try:
        # ③ 创建池（先不连接）              L89–93
        self.pool = AsyncConnectionPool(conninfo=url, min_size=1, max_size=5, open=False)
        # ④ 显式打开
        await self.pool.open()
        # ⑤ 冒烟测试                        L102
        async with self.pool.connection() as conn:
            async with conn.cursor() as cursor:
                await cursor.execute("SELECT 1")
        self._is_valid = True
        self._last_error = None
        return self.pool
    except Exception as e:                                        # L107
        self._is_valid = False
        self._last_error = str(e)                                 # L109 ← 🔴 原始错误（未脱敏）
        await self.close()                                        # L112
        raise ValueError(f"Connection attempt failed: {obfuscate_password(str(e))}") from e   # L114
```

**逐行解析**：

- **① 复用（L73–74）**：短路返回，避免每次查询都建池。
- **② `await self.close()` 在创建前（L85）**：先释放旧池，防句柄泄漏。✅
- **③ `open=False` + ④ `await open()`（L89–95）**：把"创建对象"与"建立连接"分开。
- **⑤ `SELECT 1` 冒烟测试（L102）**：**fail fast**，不把"能建对象"当成"能连库"。✅
- **⑥ 失败清理（L107–114）**：置无效 + 关池 + 抛带脱敏信息的异常。
- 🔴 **`_last_error = str(e)`（L109）存原始错误**：psycopg 连接错误常回显 DSN（含密码）→ 经 `last_error` 属性泄露。
- 🟠 **docstring 说 "with retry logic"（L72），函数体内无任何退避/重试**。真正"重试"是**隐式**的：失败后 `_is_valid=False`，下次调用重新走建池流程。**文档与实现不符**（与 `safe_sql.py` 的 docstring 问题同源，是该项目系统性习惯）。
- 🟠 **`max_size=5` 硬编码（L92）**：无配置；多客户端并发时可能成瓶颈，小场景又偏大。
- 🟠 **`await self.pool.open()` 无超时（L95）**：数据库不可达时依赖 psycopg_pool 内部默认值，启动阶段可能"挂住"。
- 🟠 **并发竞态**：`is_valid` 检查 → `close()` → 建池之间**无锁**。两协程同时进入会各建一池，其中一个被覆盖 → 连接泄漏。

### 2.3 `close()`（L116–127）与属性（L128–136）

```python
async def close(self) -> None:
    if self.pool:
        try:
            await self.pool.close()
        except Exception as e:
            logger.warning(f"Error closing connection pool: {e}")
        finally:
            self.pool = None          # finally 保证状态复位
            self._is_valid = False

@property
def is_valid(self) -> bool: return self._is_valid          # L129
@property
def last_error(self) -> Optional[str]: return self._last_error   # L134
```

**解析**：`finally` 保证即使 `close()` 抛错，`self.pool` 也清空、标记无效 —— **幂等、不留"半关"状态**。✅

---

## 三、`SqlDriver`（L139–272）—— 执行器

### 3.1 `RowResult`（L142–146）—— L0 原子

```python
@dataclass
class RowResult:
    """Simple class to match the Griptape RowResult interface."""
    cells: Dict[str, Any]
```

**解析**：**行 = `{列名: 值}` 字典**。用 `@dataclass` 包一层是为**兼容 Griptape 的接口签名**（`cells` 字段名）——说明接口形态受**上游生态约定**约束，而非自由设计。**做 SDK 时要注意"接口形状可能被外部生态绑定"。**

### 3.2 `__init__`（L148–170）与 `connect()`（L172–180）

```python
def __init__(self, conn=None, engine_url=None):
    if conn:
        self.conn = conn
        self.is_pool = isinstance(conn, DbConnPool)      # L163 ← 用具体类型判断
    elif engine_url:
        self.engine_url = engine_url
        self.conn = None
        self.is_pool = False
    else:
        raise ValueError("Either conn or engine_url must be provided")

def connect(self):
    if self.conn is not None: return self.conn            # 已有 → 直接用
    if self.engine_url:
        self.conn = DbConnPool(self.engine_url)           # 懒建池
        self.is_pool = True
        return self.conn
    raise ValueError("Connection not established. Either conn or engine_url must be provided")
```

**逐行解析**：
- **双入口**：既能注入已有连接（`conn`），也能给 DSN 自建（`engine_url`）——**端口适配器**写法（既接受外部资源，也能自己创建）。
- **`is_pool = isinstance(conn, DbConnPool)`（L163）**：用**具体类型判断**区分两条执行路径。⚠️ **硬编码耦合**，把"可否池化"绑死在具体类上，违反依赖倒置（应依赖接口）。
- ⚠️ **`self.engine_url` 只在 `elif` 分支赋值（L157）**：若传 `conn`，该属性**不存在**。正常路径下 `connect()` 会在 `self.conn is not None` 提前返回；但一旦 `conn` 被置空（见 L220），`connect()` 走到 `if self.engine_url` 会 **`AttributeError`**。**隐藏脆弱点。**
- ✅ **懒连接**：`__init__` 不建立连接（注释明说 *"Don't connect here since we need async connection"*）。

### 3.3 `execute_query()`（L182–222）—— 路由与失败降级

```python
async def execute_query(self, query: LiteralString, params=None,
                        force_readonly: bool = False,          # L186 ← ⚠️ 底层默认「可写」
) -> Optional[List[RowResult]]:
    try:
        if self.conn is None:
            self.connect()
            if self.conn is None:
                raise ValueError("Connection not established")

        if self.is_pool:                                        # ① 池路径
            pool = await self.conn.pool_connect()
            async with pool.connection() as connection:
                return await self._execute_with_connection(connection, query, params, force_readonly=force_readonly)
        else:                                                    # ② 直连路径
            return await self._execute_with_connection(self.conn, query, params, force_readonly=force_readonly)
    except Exception as e:                                       # L214
        # ③ 失败降级
        if self.conn and self.is_pool:
            self.conn._is_valid = False
            self.conn._last_error = str(e)                       # L218 ← 🔴 第二处未脱敏
        elif self.conn and not self.is_pool:
            self.conn = None
        raise e                                                  # L222
```

**逐行解析**：

- **① 池路径（L190–193）**：每次从池借连接，`async with` 保证归还。
- **② 直连路径（L195–196）**：直接用注入的连接。
- **③ 失败降级（L214–221）**：池 → 标无效（下次重建）；直连 → 置 `None`（下次 `connect()` 重建）。

> 🟠 **`force_readonly` 默认 `False`（L186）** —— 而 `SafeSqlDriver` 把它硬编码成 `True`。
> 即：**底层驱动默认"可写"**，只读完全依赖上层包装。**上层包装一旦被绕过（如 `execute_param_query`），就是可写连接。** 我们 SDK 应把只读**下沉为驱动的默认值**。
>
> 🔴 **第二处泄露**：`self.conn._last_error = str(e)`（L218）。
> 🟡 `raise e`（L222）而非裸 `raise`：重置异常上下文，丢失重抛点栈信息。

### 3.4 `_execute_with_connection()`（L224–272）★★ 核心执行

#### 源码

```python
async def _execute_with_connection(self, connection, query, params, force_readonly) -> Optional[List[RowResult]]:
    transaction_started = False
    try:
        async with connection.cursor(row_factory=dict_row) as cursor:
            # ① 只读事务                                   L231
            if force_readonly:
                await cursor.execute("BEGIN TRANSACTION READ ONLY")
                transaction_started = True

            # ② 执行（有参/无参）
            if params:
                await cursor.execute(query, params)
            else:
                await cursor.execute(query)

            # ③ 多结果集：跳到最后一个                       L240
            while cursor.nextset():
                pass

            # ④ 无结果集（如 DDL）
            if cursor.description is None:
                if not force_readonly:
                    await cursor.execute("COMMIT")
                elif transaction_started:
                    await cursor.execute("ROLLBACK")
                    transaction_started = False
                return None

            # ⑤ 取全部行 —— 无行数上限                       L252
            rows = await cursor.fetchall()

            # ⑥ 结束事务
            if not force_readonly:
                await cursor.execute("COMMIT")
            elif transaction_started:
                await cursor.execute("ROLLBACK")
                transaction_started = False

            return [SqlDriver.RowResult(cells=dict(row)) for row in rows]

    except Exception as e:                                    # L263
        # ⑦ 仅在"只读事务已开始"时回滚
        if transaction_started:
            try:
                await connection.rollback()
            except Exception as rollback_error:
                logger.error(f"Error rolling back transaction: {rollback_error}")   # L269
        logger.error(f"Error executing query ({query}): {e}")                       # L271 🔴
        raise e                                                                     # L272
```

#### 逐行解析

**① `await cursor.execute("BEGIN TRANSACTION READ ONLY")`（L231）—— 🔴 需实测验证的高风险点**

这是只读保证的来源。但 **psycopg3 默认 `autocommit=False`**：连接的**第一个 `execute` 会自动开启隐式事务**（发 `BEGIN`）。因此：

- 若连接**已在隐式事务中**，再执行 `BEGIN TRANSACTION READ ONLY` 会得到 PostgreSQL 警告 *"there is already a transaction in progress"*，且**不会改变当前事务的只读属性** → **只读实际未生效**。
- 只有 **autocommit 模式**下，该语句才真正开启只读事务。

而池的创建处（**L89–93** `AsyncConnectionPool(conninfo=url, min_size=1, max_size=5, open=False)`）**没有设置 `autocommit=True`**。

> 📌 **psycopg3 的正确做法**是连接级属性：`conn.read_only = True`（或 `await conn.set_read_only(True)` / `set_session(readonly=True)`），由驱动在 `BEGIN` 时带上 `READ ONLY`。
> **结论：这条"只读事务"很可能只产生了警告而没有真正只读。** 属**必须实测验证的第一优先项**。
> **验证方法**：在只读路径下执行 `INSERT`（或 `CREATE TEMP TABLE`）——
> - 若报 `cannot execute INSERT in a read-only transaction` → 生效；
> - 若写入成功 → **未生效**，白名单是唯一防线。
> 这也解释了为什么上层 `SafeSqlDriver` 的白名单如此厚重。

**② 有参/无参分支（L234–237）**：`cursor.execute(query, params)` 走**服务端参数绑定**，此路径无注入问题。✅

**③ `while cursor.nextset(): pass`（L240–241）**
丢弃前面所有结果集，**只保留最后一个**。

> ⚠️ 这**证明驱动允许一次执行多条语句**（`nextset()` 只在多结果集时有意义）。因此 `SafeSqlDriver._validate` 的"逐条语句白名单"**必不可少**；同时也构成前面提过的**隐式契约风险**（解析器切分 vs 驱动执行必须一致）。

**④ `cursor.description is None`（L244–252）**：处理不返回行的语句（DDL/SET/写操作），提交或回滚后返回 `None`。

**⑤ `rows = await cursor.fetchall()`（L252）—— 🟠 无行数上限**
一次性把**全部结果**读进内存。

> 对 `SELECT * FROM 亿级表`：在上层 `asyncio.timeout` 生效前，内存可能已被打爆。
> **正确做法**：上层注入 `LIMIT`，或此处逐行读并截断（`for row in cursor: if n>=cap: break`）。**这是可用性/内存安全的实质缺口。**

**⑥ 结束事务（L255–261）**：可写 → `COMMIT`；只读 → `ROLLBACK`。读操作无需提交，语义正确。✅

**⑦ 异常回滚不对称（L263–271）—— 🟠**

```python
if transaction_started:          # 只在「只读且成功发过 BEGIN」时为 True
    await connection.rollback()
```

- **可写路径**（`force_readonly=False`）下 `transaction_started` **永远为 `False`** → **异常时不回滚**，隐式事务可能处于 open/aborted 状态被还回池（依赖 `psycopg_pool` 的 reset 兜底，但**代码自身不保证**）。
- 只读路径回滚的是 `connection`（连接级）而非 `cursor`，粒度与风格不统一。

**🔴 第三处泄露（L271）**：`logger.error(f"Error executing query ({query}): {e}")` —— **原始 SQL 入日志**（可能含 PII/敏感字面量），`{e}` **未脱敏**。

**🟠 缺少数据库级超时**：全文件**未设置 `statement_timeout`**，上限仅依赖上层 `asyncio.timeout`。上层取消协程时，服务端查询是否被取消取决于驱动实现（psycopg 会尝试 cancel），但**不如数据库侧可靠**。建议连接初始化时 `SET statement_timeout = <ms>`。

---

## 四、风险 → 位置对照

| 级别 | 风险 | 位置 | 说明 |
|---|---|---|---|
| 🔴 | **只读可能未生效** | **L231** `BEGIN TRANSACTION READ ONLY` | psycopg3 非 autocommit 下隐式事务已开启 → 该语句只产生警告，**不改变只读属性**；应改用 `conn.read_only=True`。**需实测** |
| 🔴 | **只读默认值在底层是关闭的** | **L186** `force_readonly: bool = False` | 只读完全依赖上层包装 |
| 🔴 | **凭据泄露（3 处）** | **L109**、**L218**、**L271** | 脱敏仅在 L114 生效一次；`last_error` 属性（L134）原样暴露 |
| 🔴 | **敏感 SQL 入日志** | **L271** | 原始 query 进日志 |
| 🟠 | **无行数上限** | **L252** `fetchall()` | 一次拉全量 → 内存风险 |
| 🟠 | **异常回滚不对称** | **L263–271** | 可写路径 `transaction_started=False` → 不回滚 |
| 🟠 | **无数据库级超时** | 全文件 | 未设 `statement_timeout` |
| 🟠 | **建池无超时/无重试/无锁** | **L71–114** | docstring 说 retry 但无实现；`max_size=5` 硬编码（L92）；并发竞态可泄漏池 |
| 🟠 | **`engine_url` 属性可能不存在** | **L148–180** | 传 `conn` 时未赋值；`conn` 被置 None（L220）后 `connect()` 会 `AttributeError` |
| 🟡 | **子串替换破坏 URL** | **L36** `netloc.replace(password,…)` | 短密码会误伤 netloc |
| 🟡 | **`is_pool` 用具体类型判断** | **L163** | 违反依赖倒置 |
| 🟡 | **`raise e`** | **L222 / L272** | 丢栈上下文 |

---

## 五、值得抄的正确做法

1. ✅ **懒连接**：`__init__` 不建连接（异步场景必须如此）。
2. ✅ **建池前先 `close()`（L85）**：避免句柄泄漏；`close()` 用 `finally` 复位状态（幂等）。
3. ✅ **冒烟测试 `SELECT 1`（L102）**：区分"对象建成"与"真的能连"。
4. ✅ **`async with pool.connection()` / `async with connection.cursor()`**：上下文管理器保证归还与关闭。
5. ✅ **失败降级（L214–221）**：池标无效、直连置 None → 下次自动重建（隐式自愈）。
6. ✅ **参数化查询**：`cursor.execute(query, params)` 服务端绑定。
7. ✅ **凭据脱敏函数**（思路对，落点不全）。
8. ✅ **`row_factory=dict_row`**：行即字典，与 `RowResult.cells` 对齐。

---

## 六、与 `safe_sql.py` 的关系（两层防御的真实分工）

```
SafeSqlDriver（应用层）
  ├─ 解析 + 白名单（重重枚举）
  └─ force_readonly=True 硬编码
        │
        ▼
SqlDriver（驱动层）
  ├─ execute_query(force_readonly=False 默认)   ← 默认开放
  └─ _execute_with_connection
        └─ BEGIN TRANSACTION READ ONLY            ← 可能未生效（psycopg3 语义）
```

**核心结论**：项目名义上是"**应用层白名单 + 引擎层只读事务**"双层防御；但推演表明：

- **引擎层只读很可能是名义上的**（`BEGIN` 在隐式事务中无效，且未用 `conn.read_only`）；
- **应用层白名单因此是唯一有效防线**，而它自身有一个**完全绕过它的旁路**（`execute_param_query`）。

> 📌 **对 SDK 的直接启示**：不要把只读寄托在"执行前发一条 `BEGIN ... READ ONLY`"上，应当：
> 1. 用**驱动提供的连接级只读属性**（psycopg3 `read_only`、SQLite `readOnly` 句柄、PG `default_transaction_read_only`）；
> 2. 连接初始化时设 **`statement_timeout`**；
> 3. **唯一执行出口**（无旁路）；
> 4. 结果**逐行截断**而非 `fetchall()`；
> 5. 脱敏与 SQL 日志**下沉到统一出口**。

---

*本注解基于 `sql_driver.py` 全文 272 行实读；行号已与源码逐一核对。*
