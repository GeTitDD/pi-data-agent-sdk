# Pi Data Agent SDK · v1 设计规格（冻结版）

**决策（已确认）**：实现语言 **TypeScript / Node**；v1 能力边界 **只读 SQL 问答**（不含 Python 执行、不含沙箱、不含写入）。

**设计目标**：只吸收参考项目中"便宜且高价值"的部分；**机制类一律押后**。

---

## 0. 三条取舍原则

| 类别 | 成本 | 处理 |
|---|---|---|
| **原则 / 不变量** | 极低 | ✅ 全部采纳 |
| **机制**（框架、依赖、状态） | 高 | ⏸ 默认不做，附触发条件 |
| **形式**（插件系统、DI、事件总线、深层目录） | 中 | ❌ 不做 |

> 把各家的**教训**变成我们的**不变量**；把各家的**框架**变成我们的**暂不做**。

---

## 1. 非目标（Non-Goals，v1 明确不做）

| 不做 | 理由 | 触发条件（何时再考虑） |
|---|---|---|
| 完整语义层（MDL/Cube/血缘/列级 ACL） | 口径只需 3 个字段 | 出现指标版本管理/血缘/权限需求 |
| 向量库 / RAG 检索 | schema 装得进上下文时，确定性检索更准更省 | 表数 > ~200，schema 放不下 |
| Python / pandas 执行 | 无代码执行 → **无需沙箱** | 需要统计分析或画图 |
| 容器沙箱 / 多运行时工厂 | 同上 | 同上一行 |
| 多数据源适配工厂 | 一个端口 + 一个 sqlite 适配器足够 | 接第 2 个数据库（只加 1 个文件） |
| 组织 / 鉴权 / 多租户 | 本地单用户 | 多人使用 |
| 仪表盘 / 可视化渲染 | 先返回表格 | 用户明确要图 |
| Golden SQL 少样本库 | 先用回归题攒需求 | 出现重复问题、要"越问越准" |
| 插件系统 / DI 容器 / 事件总线 | 普通函数参数注入即可 | 永不（除非有第三方扩展生态） |
| i18n / 主题 / 复杂配置 schema | YAGNI | 按需 |

**复杂度预算（硬约束）**
- 模块数 **≤ 8**；代码 **≤ 800 行**；运行时依赖 **= 1**（SQL 解析器 `node-sql-parser`）。
- 超出即视为过度设计，需在评审中说明。

---

## 2. 模块图（依赖严格单向）

```
        ┌──────────── ask.ts ────────────┐        L2 端到端入口
        │                                │
   cells.ts                          prompt.ts     L2 细胞 / 提示词
        │                                │
        └──────────► ports.ts ◄──────────┘        L1 接口（不 import 任何实现）
                       ▲
        ┌──────────────┼───────────────┐
   guard.ts       catalog.ts       metrics.ts       L1 能力
        │              │                │
        └──────────────┴────────────────┘
                       ▲
              adapters/sqlite.ts                    L1 唯一具体实现（唯一 IO）
                       │
                   atoms.ts                         L0 纯类型
```

**铁律**
1. `cells.ts` / `ask.ts` **不得 import `adapters/*`**，只依赖 `ports.ts` 的接口；具体实现由最外层注入。
2. `guard.ts` 是**全工程唯一解析 SQL 的地方**。
3. `adapters/sqlite.ts` 是**唯一接触数据库的地方**。
4. 依赖只向下；不存在向上或横向依赖。

---

## 3. 接口契约（L0 / L1 / L2）

```ts
/* ─────────── L0 atoms.ts ─────────── */
export type Value = null | number | string;
export type Row = Record<string, Value>;

/** 失败分类：抄 DB-GPT（不要用单一异常类型表达四种失败） */
export type ExecStatus = "ok" | "denied" | "error" | "timeout";

export interface ExecResult {
  status: ExecStatus;
  columns: string[];
  rows: Row[];
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

/* ─────────── L1 ports.ts ─────────── */
export interface Connector {                 // 唯一碰数据库
  readonly engine: string;
  execute(sql: string, o: { maxRows: number; timeoutMs: number }): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface GuardResult {
  allowed: boolean;
  kind: string;                              // "select" | "denied" | "parse_error" | ...
  reason?: string;
}
export interface Guard {                     // 唯一解析 SQL
  check(sql: string, ctx: { tables: string[] }): GuardResult;
}

export interface TableRef { name: string; rowCount?: number }
export interface ColumnRef { name: string; type: string; notNull: boolean; pk: boolean }
export interface TableDetail { table: string; columns: ColumnRef[]; examples: Record<string, Value[]> }

export interface Catalog {
  tables(): Promise<TableRef[]>;
  describe(table: string): Promise<TableDetail>;
  values(table: string, column: string, limit: number): Promise<Value[]>;   // 值域对齐
}

export interface Metric { name: string; expression: string; description: string }
export interface Metrics { list(): Promise<Metric[]> }                       // 极简语义层

export interface Model { complete(prompt: string): Promise<string> }

export interface Deps {
  connector: Connector;
  guard: Guard;
  catalog: Catalog;
  metrics: Metrics;
  model: Model;
  limits: { maxRows: number; timeoutMs: number; repairAttempts: number };
}

/* ─────────── L2 ask.ts ─────────── */
export interface AskResult {
  sql: string;                // 实际执行的 SQL（可审计）
  result: ExecResult;         // ★ 数字的唯一来源
  answer: string;             // 给模型/用户的自然语言
  evidence: string[];         // 校验记录：行数 / NULL / 交叉核对
  status: ExecStatus;
}
export declare function ask(question: string, deps: Deps): Promise<AskResult>;
```

---

## 4. 六个不变量（几行代码即可保证）

| # | 不变量 | 实现方式 |
|---|---|---|
| 1 | **只读由构造保证** | SQLite 连接用 `readOnly` 句柄 + `PRAGMA query_only=ON`；**不依赖**"执行前发 BEGIN" |
| 2 | **默认拒绝 + 失败即关闭** | `Guard.check` 只有明确匹配才 `allowed:true`；解析异常 → `allowed:false` |
| 3 | **唯一执行出口** | 全工程只有 `adapters/sqlite.ts` 内一处调 driver |
| 4 | **行数上限 + 超时** | 上限在 `Connector.execute` 内逐行截断；超时覆盖"校验 + 执行"全程 |
| 5 | **数字必须可溯源** | `answer` 中任何数字只能取自 `AskResult.result`；无结果则不得给数 |
| 6 | **失败分类** | `ExecStatus` 四态，禁止用异常类型区分业务失败 |

> **互补原则（重要）**：**护栏强度应与引擎保证互补。**
> SQLite 有可靠的连接级只读 → `Guard` 可以**轻量**（单语句 + SELECT 族 + 禁止 PRAGMA/ATTACH + 表名白名单）。
> Postgres 无会话级只读 → 那时**必须**升级为 AST 白名单（见 `ANALYSIS-safe_sql-logic.md`）。
> **不要为将来的 Postgres 提前付出复杂度。**

---

## 5. `guard.ts` 规则集（v1 具体规则）

```
输入: sql（用户/模型产出的单条语句）

1. 解析           → 用 node-sql-parser；解析失败 ⇒ { allowed:false, kind:"parse_error" }
2. 单语句         → 解析结果必须是 1 条语句（不是靠分号正则） ⇒ 否则 denied
3. 语句族         → 必须为 SELECT / WITH…SELECT / VALUES / EXPLAIN
                    （SQLite 的 EXPLAIN 不执行语句，安全；仍显式拒绝任何 ANALYZE 关键字）
4. 禁止项         → PRAGMA / ATTACH / DETACH / BEGIN / COMMIT / ROLLBACK / SAVEPOINT
5. 表名白名单     → 语句引用的每张表必须出现在 ctx.tables 中
                    （抄 SQLBot："不信任模型返回的表名"）
6. 输出           → { allowed:true, kind:"select" }
```

**与参考实现的差异（刻意的简化）**：
- 不做 494 项函数白名单 —— 因为 SQLite `readOnly` 已阻断一切副作用函数；
- 不做 109 项扩展白名单 —— v1 不允许 `CREATE EXTENSION`；
- 保留 `EXPLAIN ANALYZE` 的**同类风险检查**（凡 "ANALYZE" 一律拒绝）。

---

## 6. `cells.ts` 流水线（对齐 shopkeeper-agent 的骨架，但去掉 LangGraph）

```
ask(question, deps)
  │
  ├─ 1. context   ← Catalog.tables() + describe()（+ 相关表的 values() 值域）
  │                  + Metrics.list()（口径）
  │                  + 当前日期 / 引擎方言（照抄 shopkeeper 的 date_info / db_info）
  │
  ├─ 2. generate  ← Model.complete(generatePrompt(context, question)) → 提取纯 SQL
  │
  ├─ 3. guard     ← Guard.check(sql, { tables })          ── denied ⇒ 直接返回（不执行）
  │
  ├─ 4. validate  ← EXPLAIN QUERY PLAN sql（干跑，不执行）── 失败 ⇒ 进入修复
  │        └─ repair 循环（repairAttempts 次）：把错误回喂 model，重新生成 → 回到 3
  │
  ├─ 5. execute   ← Connector.execute(sql, { maxRows, timeoutMs })  ★ 唯一取数
  │
  ├─ 6. verify    ← 行数 / NULL 检查 / 可选交叉核对（廉价的一条 count 查询）
  │
  └─ 7. answer    ← 组装：SQL + 结果表 + 结论 + evidence
```

**关键约束**
- 步骤 4 的 `EXPLAIN QUERY PLAN` **不执行**语句，是纯粹 dry-run（借 WrenAI 的 dry-plan 与 shopkeeper 的 EXPLAIN 校验）。
- 步骤 5 之后才允许产生数字；`answer` 的数字必须与 `result.rows` 一致。
- 修复循环是**普通 for 循环**，不引入图框架。

---

## 7. M0 验收（必须先做，不含 LLM）

**范围**：`atoms.ts` + `ports.ts` + `guard.ts` + `adapters/sqlite.ts` + 契约测试。

**验收用例（全部必须通过）**

| # | 用例 | 期望 |
|---|---|---|
| 1 | `SELECT 1; DROP TABLE t;` | `denied`（单语句） |
| 2 | `DELETE FROM t` | `denied`（语句族） |
| 3 | `DROP TABLE t` / `CREATE TABLE …` | `denied` |
| 4 | `WITH x AS (SELECT 1) DELETE FROM t` | `denied` |
| 5 | `PRAGMA table_info(t)` | `denied`（禁止 PRAGMA） |
| 6 | `ATTACH DATABASE 'x.db' AS x` | `denied` |
| 7 | `SELECT * FROM 不存在的表` | `denied`（表名白名单） |
| 8 | 畸形 SQL | `denied, kind=parse_error`（fail-closed） |
| 9 | `SELECT ';' AS s` | `allowed`（分号在字面量内不误判） |
| 10 | `SELECT * FROM t FOR UPDATE`（方言变体） | `denied` 或解析拒绝 |
| 11 | 含 `ANALYZE` 的语句 | `denied` |
| 12 | 对只读连接执行写操作（绕过 Guard 直连） | 引擎报 `readonly database` |
| 13 | 取 100 万行、`maxRows=200` | `rows.length=200, truncated=true` |
| 14 | 笛卡尔积、`timeoutMs=2000` | `status="timeout"` |
| 15 | 无结果的语句族边界（`VALUES(1)`） | `allowed` |

**M0 完成即可冻结 L0/L1 接口**；之后再写 `catalog/metrics/cells/ask`。

---

## 8. 里程碑

| 里程碑 | 内容 | 预估行数 | 验收 |
|---|---|---|---|
| **M0** | atoms + ports + guard + sqlite adapter | ~300 | 上表 15 项全绿（**无 LLM**） |
| **M1** | catalog + metrics + cells + ask + **Stub Model** | ~250 | 离线确定性跑通「问→SQL→执行→答案」 |
| **M2** | 真模型 + HITL 澄清 + Pi 扩展暴露 | ~200 | 真实问题可答；口径歧义会先问人 |
| — | （v2 候选）Postgres 适配 + AST 白名单升级 | — | 接 Postgres 时才做 |

**v1 总量目标：≤ 800 行，1 个运行时依赖。**

---

## 9. 待确认项（不阻塞 M0）

1. `metrics.json` 存放在 agent 目录还是项目 `.pi/`（建议：两者都支持，项目覆盖全局）。
2. `Model` 端口是否直接复用 Pi 的当前模型（建议：v1 先接受注入，Pi 侧传当前模型）。
3. `eval/questions.jsonl` 的题目来源（建议：先用我们的 `data-demo/demo.db` 出 20 题）。

---

*本规格把参考项目的"教训"固化为不变量，把"框架"明确列为非目标；M0 只依赖原则，不依赖任何框架。*
