/**
 * S1 契约测试：SQLite 适配器（只读、行数上限、超时）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSqliteConnector } from "../src/adapters/sqlite.ts";

// ---- 夹具：建一个可写库（仅在测试期），再用只读适配器查询 ----
const dir = mkdtempSync(join(tmpdir(), "pi-data-sdk-"));
const dbPath = join(dir, "t.db");
{
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER, note TEXT)");
	const ins = db.prepare("INSERT INTO orders(id, amount, note) VALUES (?,?,?)");
	for (let i = 1; i <= 50; i++) ins.run(i, i * 100, i % 7 === 0 ? null : `n${i}`);
	db.close();
}

const connector = createSqliteConnector({ dbPath });
const limits = { maxRows: 200, timeoutMs: 15000 };

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("基本查询可用", async () => {
	const r = await connector.execute("SELECT count(*) AS n FROM orders", limits);
	assert.equal(r.status, "ok");
	assert.equal(r.rows[0]?.n, 50);
	assert.equal(r.columns[0], "n");
});

test("行数上限生效且 truncated=true", async () => {
	const r = await connector.execute("SELECT id, amount FROM orders", { maxRows: 5, timeoutMs: 15000 });
	assert.equal(r.status, "ok");
	assert.equal(r.rows.length, 5);
	assert.equal(r.truncated, true);
});

test("NULL 可正常返回", async () => {
	const r = await connector.execute("SELECT note FROM orders WHERE note IS NULL LIMIT 1", limits);
	assert.equal(r.status, "ok");
	assert.equal(r.rows[0]?.note, null);
});

test("写操作被拒（经 runner 护栏）", async () => {
	const r = await connector.execute("CREATE TABLE x(a int)", limits);
	assert.notEqual(r.status, "ok");
	assert.equal(r.rows.length, 0);
});

test("引擎级只读：绕过护栏直连也写不进去", () => {
	// 这是"只读由构造保证"的核心证据：不依赖任何 SQL 解析或黑名单
	const ro = new DatabaseSync(dbPath, { readOnly: true });
	assert.throws(() => ro.exec("CREATE TABLE y(a int)"));
	ro.close();
});

test("超时被强杀（笛卡尔积）", async () => {
	const r = await connector.execute(
		"SELECT count(*) FROM orders a, orders b, orders c, orders d, orders e",
		{ maxRows: 10, timeoutMs: 1500 },
	);
	assert.equal(r.status, "timeout");
	assert.match(r.error ?? "", /timed out/i);
});
