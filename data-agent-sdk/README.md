# pi-data-agent-sdk

在 [Pi Coding Agent](https://pi.dev) 之上构建的**只读数据分析 SDK**。自然语言进，可信答案出。

**状态**：`M1` 冻结。`src/` 9 个文件、1116 行，由 **39 项契约测试**固定（M0 24 + M1 15）。宿主层（`M2`，Pi 工具面 + 真模型 + HITL）尚未建。

## 四条不变量

1. **只读由构造保证**。引擎级 `readOnly:true` + `PRAGMA query_only=ON` + 每作业独立子进程，不靠 SQL 文本
2. **默认拒绝**。护栏判定顺序为 空 → 多语句 → 语句族 → 关键词黑名单 → 表名白名单，任一不过即拒绝
3. **唯一执行出口**。只有 `adapters/runner.mjs` 里的 `DatabaseSync` 碰数据库
4. **凡数字必可溯源**。`AskResult.answer` 由纯函数 `renderAnswer(sql, result, evidence)` 渲染，模型文本没有任何进入路径

## 用法

```ts
import { ask, createCatalog, createFileMetrics, createGuard, createSqliteConnector } from "pi-data-agent-sdk";
import type { Deps, Model } from "pi-data-agent-sdk";

const connector = createSqliteConnector({ dbPath: "demo/demo.db" });
const deps: Deps = {
  connector,
  guard: createGuard(),
  catalog: createCatalog(connector),
  metrics: createFileMetrics({ path: "metrics.json" }),
  model: {
    complete: async () => "SELECT status, count(*) AS n FROM orders GROUP BY status",
  } satisfies Model,
  limits: { maxRows: 200, timeoutMs: 15_000, repairAttempts: 2 },
  clock: () => new Date(),
};

const result = await ask("各状态的订单数", deps);
console.log(result.status, result.evidence, result.answer);
```

`Deps` 是唯一的注入缝。包里没有默认 `limits`，也没有 composition root，宿主自己定这组数字。

## 命令

```bash
node demo/seed.mjs        # 重建 demo/demo.db（确定性，固定 PRNG 种子）
npm test                  # 39 项契约测试
npm run typecheck         # tsc --noEmit（strict）
```

要求 Node `>=22.18`。`.ts` 直接由 Node 的类型擦除执行，无构建步骤。`node:sqlite` 需要 22.5 以上并带实验性警告。

## 目录

```
src/
  atoms.ts             L0 语汇（Value / Row / ExecStatus / ExecResult）
  ports.ts             L1 端口：Connector / Guard / Catalog / Metrics / Model / Deps
  guard.ts             词法护栏，6 条规则，同步 check()
  catalog.ts           Catalog 实现，纯委派 Connector.introspect()
  metrics.ts           Metric 读取（3 字段），兼容 legacy { notes: [...] }
  cells.ts             A2 单职责变换：pickTables / buildContext / buildPrompt / extractSql / verify / renderAnswer
  ask.ts               7 步编排，唯一端到端入口
  index.ts             包入口，只做 re-export
  adapters/
    sqlite.ts          Connector 实现：spawn + 超时 kill + 结果映射
    runner.mjs         唯一碰 DB 的进程：只读句柄 + 行限 + 单条 JSON 进出
test/                  39 项契约测试（guard 17 / sqlite 6 / m1 15）
demo/                  seed.mjs 重建 demo.db；test-runner.mjs / test-describe.mjs 是探针，探的是仓库根 legacy/ 迁移基线的 runner（非本包），且写死了 Windows 路径
docs/
  M1-DESIGN.md         A2 设计说明（先读这个）
  METHODOLOGY.md       方法论：信任阶梯、不变量分级（本地，不入库）
  CASE-PI.md           Pi 宿主解剖：工具/命令/事件面（本地，不入库）
  analysis/            9 个开源 Data Agent 项目的研读笔记（本地，不入库）
SDK-SPEC-v1.md         冻结版规格：接口、不变量、里程碑
M0-MIGRATION-PLAN.md   M0 迁移方案（迁移基线在仓库根 legacy/）
```

`docs/` 下三份研究材料由本包 `.gitignore` 排除，只存在本地。它们的来源引用写成 `reference-projects/...`，相对仓库根。

## 两条通道

`Connector` 有两条方法，区别是刻意的。

**`execute(sql, limits)`** 跑模型生成的 SQL。调用方必须先过 `Guard`。走 `EXPLAIN QUERY PLAN` 干跑，再真执行。

**`introspect(job)`** 跑平台内置的自省作业。入参是闭集 union（`tables | describe | search | values`），结构上无法传任意 SQL。catalog 要读 `sqlite_master`，而护栏会把 `sqlite_master` 当未知表拒掉，所以自省不能走 `execute`。

## 已知边界

- **护栏是词法级，不是语法级**。规格里的 `node-sql-parser` 被有意放弃（`M0-MIGRATION-PLAN.md` 写"接 Postgres 时再引"），`kind:"parse_error"` 在代码里不存在。畸形 SQL 由后续 `EXPLAIN` 干跑兜住。
- **表名白名单只覆盖 `FROM`/`JOIN` 后第一个标识符**。逗号连接（`FROM a, b`）的第二个表不被抽取，实测可越权读到白名单外的表和 `sqlite_master`。写操作仍被引擎只读挡住。
- **表名白名单等于上下文选中的表**（`pickTables` 上限 5 张）。表数超过 5 且问题与表名词面无重叠时，第 6 张表不可达。

## 相关文档

设计规格与里程碑在 `SDK-SPEC-v1.md`。方法论、宿主解剖、参考项目研读笔记在 `docs/`。迁移基线（旧 Pi 扩展）在仓库根的 `legacy/`。
