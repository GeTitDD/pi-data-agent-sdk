/**
 * S1 契约测试：护栏（guard）。
 * 用例集 = 旧 data-demo/test-runner.mjs 的护栏部分，搬到 node:test。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { blankLiterals, createGuard } from "../src/guard.ts";

const guard = createGuard();
const ctx = { tables: ["orders", "customers"] };
const check = (sql: string) => guard.check(sql, ctx);

test("blankLiterals 会抹掉注释与字面量", () => {
	assert.equal(blankLiterals("select ';' from t").includes(";"), false);
	assert.equal(blankLiterals("select 1 -- ; drop").includes(";"), false);
	assert.equal(blankLiterals("select /* ; */ 1").includes(";"), false);
});

test("多语句被拒", () => {
	const r = check("SELECT 1; DROP TABLE orders");
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "multiple_statements");
});

test("DELETE 被拒（语句族）", () => {
	const r = check("DELETE FROM orders");
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "not_allowed");
});

test("DROP / CREATE 被拒", () => {
	assert.equal(check("DROP TABLE orders").allowed, false);
	assert.equal(check("CREATE TABLE x(a int)").allowed, false);
});

test("WITH ... DELETE 被拒（CTE 写）", () => {
	const r = check("WITH x AS (SELECT 1) DELETE FROM orders");
	assert.equal(r.allowed, false);
	// 首关键字是 WITH（在允许族里），因此由黑名单拦下
	assert.equal(r.kind, "banned_keyword");
});

test("PRAGMA 被拒", () => {
	assert.equal(check("PRAGMA table_info(orders)").allowed, false);
});

test("ATTACH 被拒", () => {
	assert.equal(check("ATTACH DATABASE 'x.db' AS x").allowed, false);
});

test("空语句被拒", () => {
	const r = check("   ");
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "empty");
});

test("字面量里的分号不误判", () => {
	const r = check("SELECT ';' AS s");
	assert.equal(r.allowed, true);
	assert.equal(r.kind, "select");
});

test("字面量里的关键词不误判", () => {
	assert.equal(check("SELECT 'DROP TABLE orders' AS s").allowed, true);
});

test("四种允许的语句族都通过", () => {
	for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "VALUES (1)", "EXPLAIN SELECT 1"]) {
		assert.equal(check(sql).allowed, true, `应允许: ${sql}`);
	}
});

// ---- S2 新增规则 ----

test("ANALYZE 被拒（EXPLAIN ANALYZE 会真的执行语句）", () => {
	const r = check("EXPLAIN ANALYZE SELECT 1");
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "banned_keyword");
	assert.match(r.reason ?? "", /analyze/i);
});

test("未知表被拒（不信任模型给的表名）", () => {
	const r = check("SELECT * FROM secret_table");
	assert.equal(r.allowed, false);
	assert.equal(r.kind, "unknown_table");
});

test("已知表放行", () => {
	assert.equal(check("SELECT id FROM orders").allowed, true);
	assert.equal(check("SELECT o.id FROM orders o JOIN customers c ON c.id = o.id").allowed, true);
});

test("带引号的表名也能识别", () => {
	assert.equal(check('SELECT * FROM "orders"').allowed, true);
	assert.equal(check("SELECT * FROM [orders]").allowed, true);
	assert.equal(check("SELECT * FROM `orders`").allowed, true);
});

test("字符串/注释里的 FROM 不会误抽出表名", () => {
	assert.equal(check("SELECT 'FROM secret_table' AS s").allowed, true);
	assert.equal(check("SELECT 1 AS s -- FROM secret_table").allowed, true);
});

test("CTE 名与派生表别名不算未知表", () => {
	assert.equal(check("WITH x AS (SELECT 1) SELECT * FROM x").allowed, true);
	assert.equal(check("SELECT * FROM (SELECT 1) t").allowed, true);
	assert.equal(check("SELECT * FROM orders WHERE id IN (SELECT id FROM customers)").allowed, true);
});

test("schema 限定名取最后一段", () => {
	assert.equal(check("SELECT * FROM main.orders").allowed, true);
});
