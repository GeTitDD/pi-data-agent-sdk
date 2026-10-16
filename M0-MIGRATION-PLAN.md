# M0 迁移与重构方案（不重造轮子）

**前提**：我们**已经有**一份能跑的实现（Pi 扩展 `data-copilot`，777 行）。M0 的目标不是"从零写 SDK"，而是**把现有代码按层切开、补齐 3 处缺口、把测试扩到 15 项**。

---

## 一、资产盘点：现有代码已经实现了 M0 的什么

| 现有资产 | 位置 | 已实现的能力 | 对应 M0 的哪一块 |
|---|---|---|---|
| `blankLiterals()` | `runner.mjs` L27–66 | **词法净化**（注释/字符串/标识符置空格）—— 最难写对的一步 | `guard.ts` 的地基 |
| `assertReadOnly()` | `runner.mjs` L68–80 | 单语句 + 语句族 + 写/DDL 黑名单 | `guard.ts` 的 3/6 条规则 |
| `openReadOnly()` | `runner.mjs` L95–99 | **`readOnly:true` 句柄 + `PRAGMA query_only`**（已实测引擎级生效） | `adapters/sqlite.ts` 的只读保证 |
| `normalizeValue/Row()` | `runner.mjs` L82–93 | bigint/blob 归一化（防 `JSON.stringify` 崩） | `adapters/sqlite.ts` |
| `run()` 的 `query` 分支 | `runner.mjs` L170–189 | **`stmt.iterate()` 逐行 + `maxRows` 截断 + `elapsedMs`** | `Connector.execute()` 核心 |
| `run()` 的 `tables/describe/search` | `runner.mjs` L118–168 | Catalog 的三段 SQL（含 `pragma_table_info(?)` 参数化） | `catalog.ts` |
| `runJob()` | `index.ts` L184–216 | **`spawn` 子进程 + `setTimeout` kill**（Node 里唯一的真超时方案，已实测） | `adapters/sqlite.ts` |
| `loadConfig/expandEnv/resolveSourcePath` | `index.ts` L94–144 | 配置加载 + `$ENV` 展开 + 相对路径解析 | `config.ts` |
| `readNotes/writeNotes` + `withFileMutationQueue` | `index.ts` L150–170 | 原子写 + 文件锁 | `metrics.ts` |
| `formatTable/formatCell` | `index.ts` L222–239 | 等宽表格渲染 | `cells.ts` |
| 4 个工具 + 1 个命令 + 1 个事件 | `index.ts` L306–575 | Pi 侧完整接口面 | `pi-tools.ts`（薄适配层） |
| `seed.mjs` + `demo.db` | `data-demo/` | 确定性测试数据（300 客户/1200 订单/2974 明细/106 退款） | 测试夹具 |

**结论**：现有代码覆盖了 M0 约 **70%**。真正"缺"的只有三处（见第四节）。

---

## 二、迁移原则

1. **能跑的不重写**：`blankLiterals`、`openReadOnly`、spawn 超时、`iterate` 截断——**原样搬**，只加类型。
2. **接口最小化，实现可复用**：`ports.ts` 只暴露**单源**语义（`Connector` 对应一个库）；多源解析留在 `config.ts` / Pi 层，解析完**注入一个 Connector**。这样接口简单，而现有多源代码不用重写。
3. **只依赖下一层**：`cells/ask` 不得 import `adapters/*`。
4. **零第三方依赖**（M0）：用 Node 内置 + Pi 宿主提供的，不引新包。

---

## 三、迁移映射表（逐条）

| # | 现有 | 目标 | 处理 | 具体改动 |
|---|---|---|---|---|
| 1 | `blankLiterals()` `runner.mjs` L27–66 | `src/guard.ts` | **搬** | 加 TS 类型；逻辑不动 |
| 2 | `assertReadOnly()` `runner.mjs` L68–80 | `src/guard.ts` | **改** | ① 由 `throw` 改为**返回 `GuardResult`**；② 补 `ANALYZE` 禁项；③ 补**表名白名单**（需 `ctx.tables`） |
| 3 | `ALLOWED_STARTS` / `WRITE_KEYWORDS` `runner.mjs` L21–24 | `src/guard.ts` | **搬+裁** | 现有黑名单已含 `pragma/attach/detach/begin/commit/rollback/savepoint`，**保留**；补 `analyze` |
| 4 | `normalizeValue/Row()` L82–93 | `src/adapters/sqlite.ts` | **搬** | 加类型 |
| 5 | `openReadOnly()` L95–99 | `src/adapters/sqlite.ts` | **搬** | 不加 `BEGIN ... READ ONLY`（踩过的坑） |
| 6 | `run("query")` L170–189 | `src/adapters/sqlite.ts` | **改** | 返回值加 `status`；错误分类（timeout/error/denied） |
| 7 | `run("tables"/"describe"/"search")` L118–168 | 逻辑→`src/catalog.ts`；执行→`runner.mjs` | **拆** | runner 退化为"**只执行一段 SQL**"，SQL 文本移到 `catalog.ts` |
| 8 | `run()` 的 stdin/stdout 协议 | `runner.mjs` | **改** | 统一返回 `{ ok, status, columns, rows, truncated, elapsedMs, error }` |
| 9 | `runJob()` L184–216 | `src/adapters/sqlite.ts` | **搬** | spawn 逻辑不动；按 `status` 解析结果 |
| 10 | `loadConfig/expandEnv/resolveSourcePath` L94–144 | `src/config.ts` | **搬** | 保留多源解析（已能跑）；对外只暴露"解析出单个 dbPath" |
| 11 | `readNotes/writeNotes/notesPath` L150–170 | `src/metrics.ts` | **改** | 从自由文本 `{id,text,tags}` 升级为 `{name, expression, description}` |
| 12 | `formatTable/formatCell` L222–239 | `src/cells.ts` | **搬** | — |
| 13 | `QueryDetails` / `tableResult` L241–254 | `src/atoms.ts` | **删** | 被 `ExecResult` / `AskResult` 取代 |
| 14 | `before_agent_start` 注入文本 L306–330 | 文本→`src/cells.ts`（prompt 组装）；注入动作→`pi-tools.ts` | **拆** | 提示词与 Pi API 解耦 |
| 15 | `data_sources` 工具 L332–345 | `pi-tools.ts` | **改** | v1 单源 → 合并进 `data_schema`/prompt，**少一个工具** |
| 16 | `data_schema` 工具 L347–404 | `pi-tools.ts` → 调 `catalog.ts` | **搬+改** | 展示逻辑搬走，数据获取改走 `Catalog` 端口 |
| 17 | `data_query` 工具 L406–462 | `pi-tools.ts` → 调 `ask()`/`Connector` | **搬+改** | 变薄：只做参数校验 + 调用 |
| 18 | `data_notes` 工具 L464–507 | `pi-tools.ts` → 调 `metrics.ts` | **改** | 语义从"notes"变"metrics" |
| 19 | `/data` 命令 L509–575 | `pi-tools.ts` | **搬+改** | 调用改走端口 |
| 20 | `seed.mjs` + `demo.db` | `test/fixtures/` | **搬** | 作为 15 项契约测试的数据源 |
| 21 | `test-runner.mjs`（~10 用例） | `test/guard.test.ts` + `test/sqlite.test.ts` | **改+扩** | 扩到 15 项；改用 `node:test` |

---

## 四、需要"补"的三处（唯一的新代码）

### 缺口 1：`guard.ts` 结构化返回 + 2 条新规则（~60 行新增）

现在的 `assertReadOnly` 是 `throw Error`，调用方**无法区分** "被拒绝" vs "执行错误"。

```ts
// 现状（runner.mjs L68）
function assertReadOnly(sql) { ...; throw new Error("Only a single SQL statement is allowed."); }

// 目标
export function createGuard(): Guard {
  return {
    check(sql, { tables }) {
      const s = blankLiterals(sql).trim();                       // ← 直接复用现有函数
      if (!s) return deny("empty");
      const body = s.endsWith(";") ? s.slice(0, -1) : s;
      if (body.includes(";")) return deny("multiple_statements");
      const first = (s.match(/[A-Za-z_]+) ?? [""])[0].toUpperCase();
      if (!["SELECT","WITH","VALUES","EXPLAIN"].includes(first)) return deny(`not_allowed:${first}`);
      for (const k of BANNED) if (new RegExp(`\\b${k}\\b`).test(s)) return deny(`banned:${k}`);  // 现有黑名单 + ANALYZE
      for (const t of extractTableNames(s)) if (!tables.includes(t)) return deny(`unknown_table:${t}`);  // ← 新增
      return { allowed: true, kind: "select" };
    },
  };
}
```

**净新增**：`extractTableNames()`（~20 行词法抽取）+ `ANALYZE` 一条 + 返回结构调整。

### 缺口 2：`ExecStatus` 四态分类（~30 行）

现在只有 `{ok: boolean, error}`。目标：
- 父进程 `setTimeout` 触发 kill → `status: "timeout"`（**已有机制，只需标注**）
- runner 返回 `{ok:false, status:"denied"}` ← guard 拒绝
- runner 返回 `{ok:false, status:"error"}` ← SQLite 报错
- 成功 → `status: "ok"`

### 缺口 3：测试从 ~10 项扩到 15 项（~120 行）

现有 `test-runner.mjs` 已覆盖：多语句、delete、ddl、with+delete、pragma、字面量分号、行数上限、超时（8 项）。
**需新增 7 项**：`ATTACH`、`ANALYZE`、表名白名单、引擎级只读（绕过 guard 直连）、`VALUES(1)` 边界、空语句、畸形 SQL 的 `parse_error` 分类。

---

## 五、用现成的轮子（不造）

| 需要 | 用什么 | 状态 |
|---|---|---|
| SQL 执行 | `node:sqlite`（Node 内置） | ✅ 已在用 |
| 子进程 / 硬超时 | `node:child_process` + `setTimeout` | ✅ 已在用 |
| 测试 | `node:test` + `node:assert`（内置） | ✅ 已在用 |
| 类型 / 参数校验（Pi 侧） | TypeBox（Pi 宿主提供） | ✅ 已在用 |
| 原子写 + 文件锁 | Pi 的 `withFileMutationQueue` | ✅ 已在用 |
| 配置解析 | `JSON.parse` | ✅ 已在用 |
| SQL AST 解析（**M0 不需要**） | `node-sql-parser`（MIT） | ⏸ 接 Postgres 时再引 |
| 表格渲染 | 自己 ~20 行 | 不值得引轮子 |

**明确不造**：SQL 解析器、测试框架、ORM、DI 容器、CLI 框架、配置库、日志库。

---

## 六、目标文件与行数预估

```
pi-data-sdk/
  src/
    atoms.ts        ~35    纯类型（从 index.ts L46–83 提炼）
    ports.ts        ~70    接口（新写，但只是签名）
    guard.ts        ~130   搬 blankLiterals + assertReadOnly，补 2 条规则
    catalog.ts      ~110   搬 runner 的 3 段 SQL + 收口到 Connector
    metrics.ts      ~80    搬 notes 读写，改成结构化 metrics
    cells.ts        ~150   新写（prompt 组装 + 修复循环 + 表格渲染）
    ask.ts          ~80    新写（7 步流水线编排）
    config.ts       ~90    搬 loadConfig 等
    adapters/
      sqlite.ts     ~150   搬 spawn + readOnly + iterate 截断
      runner.mjs    ~150   由现有 runner.mjs 瘦身（去掉 kinds，只留 query）
    pi-tools.ts     ~180   搬 4 工具/1 命令/1 事件，变薄
  test/
    guard.test.ts   ~90
    sqlite.test.ts  ~90
```

**核心 8 个模块（atoms…config）≈ 805 行**（略超 800 预算，因搬入的 `blankLiterals` 与 catalog SQL 是既有资产）；**净新增约 250 行**（guard 补丁 60 + cells 150 + ask 编排的一部分）。Pi 适配层与测试不计入核心预算。

---

## 七、迁移步骤（每步可独立验证、可回滚）

| 步 | 动作 | 验收 | 回滚 |
|---|---|---|---|
| **S1** | 建 `pi-data-sdk/` 骨架；**只搬** `blankLiterals`+`assertReadOnly`+`openReadOnly`+`normalize*`，复制成 `.ts` | `node --test` 跑通搬过来的 8 项（原 test-runner.mjs 用例） | 删目录即可（现有扩展不受影响） |
| **S2** | 补 `guard.ts` 的 3 条规则 + `GuardResult`；`runner.mjs` 协议改为带 `status` | 15 项契约测试全绿 | git 未初始化 → 先 `git init` 保住现有扩展 |
| **S3** | 拆 `catalog.ts`（SQL 移出 runner）；`runner.mjs` 只留 `query` | catalog 三段的测试通过 | 恢复 runner 的 kinds |
| **S4** | 迁 `config.ts` + `metrics.ts` | 配置解析/notes 往返测试 | — |
| **S5** | 写 `cells.ts` + `ask.ts`（Stub Model 离线跑通）→ **M1** | 离线端到端一致 | — |

> ⚠️ **先做一件事**：`pi-data-sdk/` 应 `git init` 并首次提交现有 `data-copilot` 作为基线，这样"迁移"才是安全的（可 diff、可回滚）。**目前没有版本控制。**

---

## 八、迁移 vs 从零写：收益对照

| 维度 | 从零写 | 迁移（本方案） |
|---|---|---|
| 最难写对的部分 | 需重写词法净化（易被 `';'`/注释骗） | **已有并已测** |
| 超时 | 需重写子进程方案 | **已有并已测** |
| 只读保证 | 需重新验证引擎语义 | **已实测生效** |
| catalog SQL | 需重写 `pragma_table_info` 参数化等 | **已有并已测** |
| 新增代码 | ~800 行 | **~250 行净新增** |
| 风险 | 引入新 bug | 主要是"搬错位置" |

---

*源自我方现有实现（`data-copilot` 777 行）的实证盘点；M0 的实质是**切分 + 补 3 处 + 扩测试**。*
