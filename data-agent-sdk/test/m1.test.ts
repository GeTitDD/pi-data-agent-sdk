/**
 * M1 契约测试：离线确定性的端到端流水线（用 Stub Model，不接真模型）。
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createSqliteConnector } from "../src/adapters/sqlite.ts";
import { ask } from "../src/ask.ts";
import { createCatalog } from "../src/catalog.ts";
import { createGuard } from "../src/guard.ts";
import { createFileMetrics } from "../src/metrics.ts";
import type { Deps } from "../src/ports.ts";
import { createCountingConnector, createStubModel, makeTempDb } from "./helpers.ts";

const { dir, dbPath } = makeTempDb();
const metricsPath = join(dir, "metrics.json");
writeFileSync(
	metricsPath,
	JSON.stringify({
		metrics: [
			{ name: "revenue", expression: "SUM(amount_cents) / 100.0", description: "营收不含 refunded 与 cancelled 订单" },
		],
	}),
);

const FIXED_NOW = new Date("2026-10-16T12:00:00Z");

/** 每一组测试用独立的 deps（保证 model.calls / connector.executed 互不干扰） */
function makeDeps(replies: string[]) {
	const inner = createSqliteConnector({ dbPath });
	const connector = createCountingConnector(inner);
	const model = createStubModel(replies);
	const deps: Deps = {
		connector,
		guard: createGuard(),
		catalog: createCatalog(connector),
		metrics: createFileMetrics({ path: metricsPath }),
		model,
		limits: { maxRows: 200, timeoutMs: 15000, repairAttempts: 2 },
		clock: () => FIXED_NOW,
	};
	return { deps, model, connector };
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

test("正常问答：返回 ok，answer 含 SQL 与结果表，evidence 有行数", async () => {
	const { deps } = makeDeps(["SELECT status, count(*) AS n FROM orders GROUP BY status"]);
	const r = await ask("各状态的订单数", deps);

	assert.equal(r.status, "ok");
	assert.equal(r.repairs, 0);
	assert.match(r.answer, /```sql/);
	assert.match(r.answer, /\| status \| n \|/);
	assert.ok(r.evidence.some((e) => e === "rows: 2"));
	assert.equal(r.result.rows.length, 2);
});

test("模型输出带 markdown 围栏 + 解释文字，也能提取纯 SQL", async () => {
	const { deps } = makeDeps([
		"Here is the query:\n```sql\nSELECT count(*) AS n FROM orders;\n```\nThis counts all orders.",
	]);
	const r = await ask("订单总数", deps);
	assert.equal(r.status, "ok");
	assert.equal(r.result.rows[0]?.n, 3);
});

test("未知表被 guard 拒绝 → 回喂修复 → 第二次成功", async () => {
	const { deps, model, connector } = makeDeps([
		"SELECT count(*) FROM nonexistent_table",
		"SELECT count(*) AS n FROM orders",
	]);
	const r = await ask("订单数", deps);

	assert.equal(r.status, "ok");
	assert.equal(r.repairs, 1);
	assert.equal(model.calls.length, 2);
	assert.equal(r.result.rows[0]?.n, 3);
	// 关键：被拒绝的那条 SQL **从未真正执行**（只在 EXPLAIN/执行阶段才可能入 executed）
	assert.ok(!connector.executed.some((s) => s.includes("nonexistent_table")));
});

test("第二次仍含未知表，但从第一次的 prompt 里能看到错误已被回喂", async () => {
	const { deps, model } = makeDeps(["SELECT * FROM nope", "SELECT count(*) AS n FROM orders"]);
	await ask("订单数", deps);
	assert.match(model.calls[1] ?? "", /previous_attempt_failed/);
	assert.match(model.calls[1] ?? "", /unknown_table/);
});

test("语法错 → EXPLAIN 失败 → 修复后成功", async () => {
	const { deps, model } = makeDeps(["SELECT FORM orders", "SELECT count(*) AS n FROM orders"]);
	const r = await ask("订单数", deps);

	assert.equal(r.status, "ok");
	assert.equal(r.repairs, 1);
	assert.equal(model.calls.length, 2);
});

test("修复次数用尽 → 返回失败，且调用次数 = 1 + repairAttempts（不死循环）", async () => {
	const { deps, model } = makeDeps(["SELECT * FROM nope"]);
	const r = await ask("订单数", deps);

	assert.equal(r.status, "error");
	assert.equal(r.repairs, 2);
	assert.equal(model.calls.length, 3); // 首次 + 2 次修复
	assert.match(r.evidence[0] ?? "", /validation failed/);
});

test("写语句被拒：不触发任何真实执行（DB 未被改动）", async () => {
	const { deps, connector, model } = makeDeps(["DELETE FROM orders"]);
	const r = await ask("删掉所有订单", deps);

	assert.equal(r.status, "error");
	// 护栏拒绝的语句不应进入 execute（EXPLAIN 也不该跑）
	assert.equal(connector.executed.length, 0);
	// 修不了（Stub 一直返回同一条），但循环有上限
	assert.equal(model.calls.length, 3);

	// 复核数据库确实没被改动
	const check = createSqliteConnector({ dbPath });
	const after = await check.execute("SELECT count(*) AS n FROM orders", { maxRows: 10, timeoutMs: 15000 });
	assert.equal(after.rows[0]?.n, 3);
});

test("查询 0 行：status 仍为 ok，但 evidence 明确记录", async () => {
	const { deps } = makeDeps(["SELECT * FROM orders WHERE status = 'nope'"]);
	const r = await ask("不存在的状态", deps);

	assert.equal(r.status, "ok");
	assert.ok(r.evidence.some((e) => /no rows returned/.test(e)));
});

test("结果被截断：truncated=true 且 answer 显式说明", async () => {
	const inner = createSqliteConnector({ dbPath });
	const connector = createCountingConnector(inner);
	const deps: Deps = {
		connector,
		guard: createGuard(),
		catalog: createCatalog(connector),
		metrics: createFileMetrics({ path: metricsPath }),
		model: createStubModel(["SELECT id FROM orders"]),
		limits: { maxRows: 2, timeoutMs: 15000, repairAttempts: 2 },
		clock: () => FIXED_NOW,
	};
	const r = await ask("所有订单", deps);

	assert.equal(r.status, "ok");
	assert.equal(r.result.truncated, true);
	assert.equal(r.result.rows.length, 2);
	assert.match(r.answer, /truncated/);
	assert.ok(r.evidence.some((e) => /truncated at maxRows/.test(e)));
});

test("上下文注入了真实值域（值域对齐）", async () => {
	const { deps, model } = makeDeps(["SELECT count(*) AS n FROM customers"]);
	await ask("美国客户数", deps);

	const prompt = model.calls[0] ?? "";
	assert.match(prompt, /<values>/);
	assert.match(prompt, /customers\.country/);
	assert.match(prompt, /"US"/); // 真实取值，而不是模型猜的
});

test("上下文注入了指标口径", async () => {
	const { deps, model } = makeDeps(["SELECT 1 AS n"]);
	await ask("营收多少", deps);

	const prompt = model.calls[0] ?? "";
	assert.match(prompt, /<metrics>/);
	assert.match(prompt, /revenue/);
	assert.match(prompt, /不含 refunded/);
});

test("上下文注入了日期与环境（相对时间可确定）", async () => {
	const { deps, model } = makeDeps(["SELECT 1 AS n"]);
	await ask("上周的订单", deps);

	const prompt = model.calls[0] ?? "";
	assert.match(prompt, /today: 2026-10-16/);
	assert.match(prompt, /engine: sqlite/);
	assert.match(prompt, /quarter: Q4/);
});

test("数字溯源：answer 表格里的每个数字都出现在 result.rows 中", async () => {
	const { deps } = makeDeps(["SELECT status, sum(amount_cents) AS total FROM orders GROUP BY status"]);
	const r = await ask("各状态金额", deps);

	const tableLines = r.answer.split("\n").filter((l) => l.startsWith("| ")).slice(2);
	const cellSet = new Set(tableLines.flatMap((l) => l.split("|").map((s) => s.trim())).filter(Boolean));
	const rowValues = new Set(r.result.rows.flatMap((row) => r.result.columns.map((c) => String(row[c] ?? "NULL"))));

	for (const cell of cellSet) {
		if (/^-?\d+(\.\d+)?$/.test(cell)) {
			assert.ok(rowValues.has(cell), `answer 里的数字 ${cell} 未出现在结果集中`);
		}
	}
});

test("取不到 schema 时直接失败，不硬编 SQL", async () => {
	const inner = createSqliteConnector({ dbPath });
	const connector = createCountingConnector(inner);
	const brokenCatalog = {
		tables: async () => {
			throw new Error("catalog unavailable");
		},
		describe: async () => {
			throw new Error("catalog unavailable");
		},
		values: async () => [],
	};
	const deps: Deps = {
		connector,
		guard: createGuard(),
		catalog: brokenCatalog,
		metrics: createFileMetrics({ path: metricsPath }),
		model: createStubModel(["SELECT 1"]),
		limits: { maxRows: 200, timeoutMs: 15000, repairAttempts: 2 },
		clock: () => FIXED_NOW,
	};
	const r = await ask("随便问问", deps);

	assert.equal(r.status, "error");
	assert.match(r.evidence[0] ?? "", /context failed/);
	assert.equal(connector.executed.length, 0); // 没取到上下文就不该执行任何东西
});

test("legacy notes 形态可被归一化为 metrics（平滑迁移）", async () => {
	const legacyPath = join(dir, "legacy-notes.json");
	writeFileSync(legacyPath, JSON.stringify({ notes: [{ id: "n1", text: "GMV 含税" }] }));
	const metrics = createFileMetrics({ path: legacyPath });
	const list = await metrics.list();

	assert.equal(list.length, 1);
	assert.equal(list[0]?.description, "GMV 含税");
	assert.equal(list[0]?.expression, "");
});
