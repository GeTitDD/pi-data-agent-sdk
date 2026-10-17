/**
 * L1 SQLite 适配器 —— 唯一接触数据库的地方。
 *
 * 迁移来源：legacy/data-copilot-index.ts 的 runJob()（L184–216，spawn + kill 超时）。
 *
 * 设计要点（借自 postgres-mcp 的三个教训并做了修正）：
 *  - 只读**由构造保证**：runner 以 `readOnly: true` 句柄打开库（不依赖 `BEGIN ... READ ONLY`）。
 *  - 超时用**子进程 + kill**（Node 无 asyncio；`node:sqlite` 是同步 API，不隔离会阻塞主进程）。
 *  - 行数**逐行截断**（不是 `fetchall()`）。
 *
 * 两条通道（M1 新增 introspect）：
 *  - `execute(sql)`   —— 模型生成的 SQL，调用方**必须先过 Guard**
 *  - `introspect(job)` —— 平台内置自省，入参为**闭集 union**，结构上无法传入任意 SQL
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExecResult, Row, Value } from "../atoms.ts";
import type { Connector, IntrospectJob, IntrospectResult } from "../ports.ts";

interface RawResult {
	ok: boolean;
	/** 失败分类（S2 协议）：ok / denied / error */
	status?: "ok" | "denied" | "error";
	error?: string;
	/** 由本适配器标注：子进程被超时杀掉 */
	timedOut?: boolean;
	// query
	columns?: string[];
	rows?: Row[];
	rowCount?: number;
	truncated?: boolean;
	elapsedMs?: number;
	// introspect
	tables?: Array<Record<string, unknown>>;
	table?: string;
	indexes?: Array<Record<string, unknown>>;
	foreignKeys?: Array<Record<string, unknown>>;
	matches?: Array<Record<string, unknown>>;
	values?: unknown[];
}

const runnerPath = (): string => fileURLToPath(new URL("./runner.mjs", import.meta.url));

/** 在隔离子进程中执行一个作业；超时则强杀。 */
function runJob(job: Record<string, unknown>, timeoutMs: number): Promise<RawResult> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [runnerPath()], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (result: RawResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			child.kill();
			finish({ ok: false, timedOut: true, error: `Job timed out after ${timeoutMs}ms and was killed.` });
		}, timeoutMs);

		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("close", () => {
			try {
				finish(JSON.parse(stdout) as RawResult);
			} catch {
				finish({ ok: false, error: (stderr || stdout).slice(0, 300) || "Runner produced no output." });
			}
		});

		child.stdin.write(JSON.stringify(job));
		child.stdin.end();
	});
}

/** 把失败分类统一成 ExecStatus */
function failureStatus(raw: RawResult): ExecResult["status"] {
	if (raw.timedOut) return "timeout";
	return raw.status === "denied" ? "denied" : "error";
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : v == null ? undefined : String(v));
const bool = (v: unknown): boolean => v === 1 || v === true || v === "1";

export interface SqliteConnectorOptions {
	dbPath: string;
	engine?: string;
	/** introspect 的默认超时（execute 用调用方传入的 limits.timeoutMs） */
	introspectTimeoutMs?: number;
}

export function createSqliteConnector(options: SqliteConnectorOptions): Connector {
	const introspectTimeoutMs = options.introspectTimeoutMs ?? 20_000;

	return {
		engine: options.engine ?? "sqlite",

		async execute(sql: string, o: { maxRows: number; timeoutMs: number }): Promise<ExecResult> {
			const started = Date.now();
			const raw = await runJob({ kind: "query", dbPath: options.dbPath, sql, maxRows: o.maxRows }, o.timeoutMs);
			const elapsed = raw.elapsedMs ?? Date.now() - started;

			if (!raw.ok) {
				return { status: failureStatus(raw), columns: [], rows: [], truncated: false, elapsedMs: elapsed, error: raw.error };
			}
			return {
				status: "ok",
				columns: raw.columns ?? [],
				rows: raw.rows ?? [],
				truncated: Boolean(raw.truncated),
				elapsedMs: elapsed,
			};
		},

		async introspect(job: IntrospectJob, o?: { timeoutMs?: number }): Promise<IntrospectResult> {
			const raw = await runJob({ ...job, dbPath: options.dbPath }, o?.timeoutMs ?? introspectTimeoutMs);
			if (!raw.ok) {
				const status = failureStatus(raw);
				return { status: status === "ok" ? "error" : status, error: raw.error };
			}

			switch (job.kind) {
				case "tables":
					return {
						status: "ok",
						tables: (raw.tables ?? []).map((t) => ({
							name: String(t.name),
							type: str(t.type),
							rowCount: typeof t.rowCount === "number" ? t.rowCount : null,
						})),
					};

				case "describe":
					return {
						status: "ok",
						table: raw.table ?? job.table,
						columns: (raw.columns ?? []).map((c) => ({
							name: String(c.name),
							type: str(c.type),
							notNull: bool(c.not_null),
							pk: bool(c.pk),
							default: c.dflt_value,
						})),
						indexes: (raw.indexes ?? []).map((i) => ({ name: String(i.name), unique: bool(i.is_unique) })),
						foreignKeys: (raw.foreignKeys ?? []).map((f) => ({
							fromColumn: str(f.from_column),
							refTable: str(f.ref_table),
							toColumn: str(f.to_column),
						})),
					};

				case "search":
					return {
						status: "ok",
						matches: (raw.matches ?? []).map((m) => ({
							tableName: String(m.table_name),
							columnName: String(m.column_name),
							dataType: str(m.data_type),
						})),
					};

				case "values":
					return { status: "ok", values: (raw.values ?? []) as Value[] };
			}
		},

		async close(): Promise<void> {
			// 无长连接：每次 execute/introspect 起一个短命子进程，无需释放。
		},
	};
}
