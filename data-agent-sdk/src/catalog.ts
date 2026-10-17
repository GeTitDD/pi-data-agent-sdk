/**
 * L1 `Catalog` 适配器 —— schema 与值域自省。
 *
 * 迁移来源：legacy/data-copilot-runner.mjs 的 tables/describe/search 三段 SQL
 * （S1 时它们还留在 runner 里，M1 把"取什么"移到本文件，runner 只负责"执行"）。
 *
 * 注意：catalog 走的是 `Connector.introspect()`（闭集作业），**不走 guard**——
 * 因为它发出的是平台自己写死的 SQL，而不是模型生成的 SQL。
 */

import type { Value } from "./atoms.ts";
import type { Catalog, Connector, TableDetail, TableRef } from "./ports.ts";

export function createCatalog(connector: Connector): Catalog {
	return {
		async tables(): Promise<TableRef[]> {
			const r = await connector.introspect({ kind: "tables" });
			if (r.status !== "ok") throw new Error(`catalog.tables: ${r.error ?? r.status}`);
			return (r.tables ?? []).map((t) => ({ name: t.name, rowCount: t.rowCount ?? null }));
		},

		async describe(table: string): Promise<TableDetail> {
			const r = await connector.introspect({ kind: "describe", table });
			if (r.status !== "ok") throw new Error(`catalog.describe(${table}): ${r.error ?? r.status}`);
			return { table, columns: r.columns ?? [] };
		},

		async values(table: string, column: string, limit: number): Promise<Value[]> {
			// 值域是"锦上添花"：取不到不应让整条流水线失败
			const r = await connector.introspect({ kind: "values", table, column, limit });
			return r.status === "ok" ? (r.values ?? []) : [];
		},
	};
}
