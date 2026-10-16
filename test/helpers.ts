/**
 * 测试替身（不进 src/）。M1 的核心验收方式是"离线确定性"——所以模型必须是可控的。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ExecResult } from "../src/atoms.ts";
import type { Connector, IntrospectJob, IntrospectResult, Model } from "../src/ports.ts";

/** 可脚本化的模型：按顺序返回预设回复，并记录收到的 prompt */
export interface StubModel extends Model {
	calls: string[];
}

export function createStubModel(replies: string[]): StubModel {
	const calls: string[] = [];
	let index = 0;
	return {
		calls,
		async complete(prompt: string): Promise<string> {
			calls.push(prompt);
			const reply = replies[Math.min(index, replies.length - 1)];
			index += 1;
			return reply ?? "SELECT 1";
		},
	};
}

/** 包一层 Connector，记录所有真正执行过的 SQL（用于断言"护栏拒绝的东西没有被执行"） */
export interface CountingConnector extends Connector {
	executed: string[];
}

export function createCountingConnector(inner: Connector): CountingConnector {
	const executed: string[] = [];
	return {
		engine: inner.engine,
		executed,
		async execute(sql: string, o): Promise<ExecResult> {
			executed.push(sql);
			return inner.execute(sql, o);
		},
		async introspect(job: IntrospectJob, o): Promise<IntrospectResult> {
			return inner.introspect(job, o);
		},
		async close(): Promise<void> {
			return inner.close();
		},
	};
}

/** 建一个可写测试库（仅测试期），返回库路径 */
export function makeTempDb(): { dir: string; dbPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-data-sdk-m1-"));
	const dbPath = join(dir, "t.db");
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, country TEXT, segment TEXT);
		CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, category TEXT, price_cents INTEGER);
		CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, amount_cents INTEGER, created_at TEXT);
	`);
	const cust = db.prepare("INSERT INTO customers VALUES (?,?,?,?)");
	cust.run(1, "Ada", "US", "vip");
	cust.run(2, "Bo", "DE", "new");
	cust.run(3, "Cy", "US", "returning");
	const prod = db.prepare("INSERT INTO products VALUES (?,?,?,?)");
	prod.run(1, "Earbuds", "Electronics", 9900);
	prod.run(2, "Lamp", "Home", 4500);
	const ord = db.prepare("INSERT INTO orders VALUES (?,?,?,?,?)");
	ord.run(1, 1, "paid", 9900, "2026-10-01 10:00:00");
	ord.run(2, 2, "refunded", 4500, "2026-10-02 11:00:00");
	ord.run(3, 1, "paid", 4500, "2026-10-03 12:00:00");
	db.close();
	return { dir, dbPath };
}
