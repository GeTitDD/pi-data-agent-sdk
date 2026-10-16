# M1 设计说明：A2 确定性流水线

> M1 = 在 M0 的信任边界之上，补齐「**检索 → 生成 → 校验 → 执行 → 验证 → 作答**」。
> 目标不是"接上真模型"，而是**先得到一个离线、确定、可复现的闭环**。
> 代码：`src/catalog.ts` · `src/metrics.ts` · `src/cells.ts` · `src/ask.ts`

---

## 0. 一句话定位

> **M0 兜住"危险"，M1 负责"聪明"。** M0 决定"这个 SQL 能不能跑"，M1 决定"该跑哪个 SQL、跑出来的结果能不能信"。

---

## 1. 交付物

| 文件 | 层 | 职责 |
|---|---|---|
| `src/catalog.ts` | A1 | schema / 列 / **值域** 自省，走 `Connector.introspect()` |
| `src/metrics.ts` | A1 | 极简语义层 `{name, expression, description}`（兼容 legacy `notes`）|
| `src/cells.ts` | A2 | 6 个单职责变换 + 提取纯 SQL + 干跑校验 + 机械核对 + **确定性渲染** |
| `src/ask.ts` | A2 | 7 步流水线编排，唯一端到端入口 |
| `test/helpers.ts` | — | **Stub Model** + CountingConnector + 临时库夹具 |
| `test/m1.test.ts` | — | 15 项端到端测试 |

---

## 2. M0 契约的第一次演进（纪律⑤「只增不改」）

### 问题
`catalog` 要读 `sqlite_master` / `pragma_table_info(?)`，但这两者**会被 guard 自己拒掉**：
- 规则 5 表名白名单 → `sqlite_master` 不在 `ctx.tables`
- 规则 3 语句族 / 禁 PRAGMA → `pragma_table_info` 被当成表名

**给 guard 开例外是不可接受的**——那等于给模型开洞。

### 解法
`Connector` **新增** `introspect(job)`，入参是**闭集 union**：

```ts
export type IntrospectJob =
  | { kind: "tables"; includeCounts?: boolean }
  | { kind: "describe"; table: string }
  | { kind: "search"; query: string }
  | { kind: "values"; table: string; column: string; limit: number };
```

**安全性来自类型系统**（🟢 外部强制维度）：**结构上无法传入任意 SQL**。
这正是对 `postgres-mcp` 的 `execute_param_query` 反模式（接受任意 SQL 且不校验 → 成为绕过护栏的后门）的正面回答。

**代价控制**：只**新增**方法，未改 `execute` 签名 → M0 的 24 项测试**一行未动**，仅新增测试。

---

## 3. 7 步流水线

```
ask(question, deps)
 ├─ 1. context   Catalog + Metrics → 命名 section         失败 → 直接返回失败（不硬编 SQL）
 ├─ 2. generate  Model.complete(prompt) → 原始文本
 ├─ 3. guard     Guard.check(sql, {tables})               拒绝 → 进入修复
 ├─ 4. validate  EXPLAIN QUERY PLAN（不执行）              报错 → 进入修复
 ├─ 5. execute   Connector.execute()   ★ 数字唯一来源      timeout/error → 直接返回
 ├─ 6. verify    行数 / NULL / 截断（纯函数）              不阻断，只记录
 └─ 7. answer    确定性渲染（纯函数）
```

**关键点**

| 点 | 说明 |
|---|---|
| 上下文**只注入该注入的** | 表少则全给；表多则按问题词与表名词面重叠排序（确定性） |
| **值域对齐** | 只对"像枚举"的列（`status/country/segment/category…`）采样真实取值，最多 2 列 × 5 值 |
| **日期/方言注入** | `deps.clock()` 可注入 → 上下文可复现；`engine` 来自 `Connector.engine` |
| **纯 SQL 提取** | 去 markdown 围栏、去前后解释、截到第一个顶层分号（忽略引号内）|
| **EXPLAIN 干跑** | 只让数据库解析，**前移**列名/语法错误；它**不提供安全**（安全是 M0 的事）|
| **修复循环有上限** | `limits.repairAttempts`（默认 2）—— 无界循环是方法论反模式 5 |

---

## 4. ★ 最重要的简化：v1 的答案**不由模型撰写**

`answer` 是**确定性渲染**（SQL + 结果表 + Checks），而不是模型写的散文。

**收益**：
1. **"凡数字必来自执行结果"由构造保证**，而非事后检查——有测试断言"answer 表格里每个数字都出现在 `result.rows` 中"（测试 31）。
2. **整条流水线确定性**：Stub Model 一给，全链路输出可复现 → 可写端到端断言。
3. 让模型写散文需要额外的"数字校验"模块——那是 M2，且可靠性更低。

**推论（来自 `CASE-PI.md` §8 的新纪律）**：**呈现类型不得向上污染**。
所以 A2 只产出语义（`ExecStatus` + `ExecResult` + `evidence`），**渲染与措辞属于 A4**。
M1 的 `renderAnswer` 是最小占位；M2 由宿主决定如何呈现。

---

## 5. 保证强度（本层自检）

| 承诺 | 强度 | 兜底 |
|---|---|---|
| 拒绝不合法 SQL | 🟡 自身实现 | 🟢 M0 引擎只读（绕过 guard 也写不进）|
| 修复不会死循环 | 🟢 外部强制（`for` + 上限计数）| — |
| 数字可溯源 | 🟢 外部强制（渲染函数是纯函数，输入只有 `result`）| — |
| 值域/路径取自真实库 | 🟢 外部强制（来自 `introspect` 实查，不是模型猜）| — |
| 上下文不耦合 Pi | 🟢 依赖注入（`Deps`）| 且 `metrics` **去掉了** legacy 对 Pi `withFileMutationQueue` 的依赖 |

---

## 6. 明确不做（归 M2 / v2）

| 不做 | 归谁 |
|---|---|
| 真实模型调用 | **M2** |
| HITL 提问（口径歧义时问人）| **M2**（M1 只把已定义口径注入）|
| 模型撰写自然语言答案 | **M2** |
| Pi 扩展面（工具/命令/事件）| **M2** |
| 语义层版本化/血缘/列级 ACL | v2 |
| 向量检索 / RAG / Python 沙箱 | v1 非目标 |

---

## 7. 验收（离线、确定性、可复现）

```
node --test test/guard.test.ts test/sqlite.test.ts test/m1.test.ts
# tests 39 · pass 39 · fail 0
```

M1 的 15 项覆盖：

| # | 场景 | 断言要点 |
|---|---|---|
| 19 | 正常问答 | `ok`、answer 含 SQL 与表格、`rows: 2` |
| 20 | markdown 围栏 + 解释文字 | 正确提取纯 SQL |
| 21 | 未知表 → 修复 | `repairs=1`、model 调用 2 次、**被拒 SQL 从未执行** |
| 22 | 错误回喂 | 第二次 prompt 含 `previous_attempt_failed` + `unknown_table` |
| 23 | 语法错 → EXPLAIN 失败 → 修复 | `repairs=1` |
| 24 | 修复用尽 | `status=error`、调用次数 = 1+repairAttempts（**不死循环**）|
| 25 | 写语句 | **`connector.executed` 为空**，且库内容未变 |
| 26 | 0 行 | `status=ok` 但 evidence 记录 `no rows returned` |
| 27 | 截断 | `truncated=true`、answer 显式说明 |
| 28 | 值域注入 | prompt 含 `customers.country` 与真实取值 `"US"` |
| 29 | 口径注入 | prompt 含 `revenue` 与口径描述 |
| 30 | 日期/环境注入 | prompt 含 `today: 2026-10-16`、`engine: sqlite`、`quarter: Q4` |
| 31 | **数字溯源** | answer 表格中每个数字都在 `result.rows` 中 |
| 32 | schema 取不到 | 直接失败，且**未执行任何 SQL** |
| 33 | legacy notes 归一化 | 平滑迁移 |

---

## 8. 复现方式

```bash
node --test test/guard.test.ts test/sqlite.test.ts test/m1.test.ts
```
零第三方依赖；不需要网络、密钥、模型。
