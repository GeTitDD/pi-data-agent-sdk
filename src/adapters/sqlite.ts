/**
 * L1 SQLite 适配器 —— 唯一接触数据库的地方。
 *
 * 迁移来源：legacy/data-copilot-index.ts 的 runJob()（L184–216，spawn + kill 超时）。
 *
 * 设计要点（借自 postgres-mcp 的两个教训并做了修正）：
 *  - 只读**由构造保证**：runner 以 `readOnly: true` 句柄打开库（不再依赖 `BEGIN ... READ ONLY`）。
 *  - 超时用**子进程 + kill**（Node 无 asyncio；`node:sqlite` 是同步 API，不隔离会阻塞主进程）。
 *  - 行数**逐行截断**（不是 `fetchall()`）。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExecResult, Row } from "../atoms.ts";
import type { Connector } from "../ports.ts";

interface RawResult {
	ok: boolean;
	error?: string;
	/** 由本适配器标注：子进程被超时杀掉 */
	timedOut?: boolean;
	columns?: string[];
	rows?: Row[];
	rowCount?: number;
	truncated?: boolean;
	elapsedMs?: number;
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
			finish({ ok: false, timedOut: true, error: `Query timed out after ${timeoutMs}ms and was killed.` });
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

export function createSqliteConnector(options: { dbPath: string; engine?: string }): Connector {
	return {
		engine: options.engine ?? "sqlite",

		async execute(sql: string, o: { maxRows: number; timeoutMs: number }): Promise<ExecResult> {
			const started = Date.now();
			const raw = await runJob({ kind: "query", dbPath: options.dbPath, sql, maxRows: o.maxRows }, o.timeoutMs);
			const elapsed = raw.elapsedMs ?? Date.now() - started;

			if (raw.timedOut) {
				return { status: "timeout", columns: [], rows: [], truncated: false, elapsedMs: elapsed, error: raw.error };
			}
			if (!raw.ok) {
				return { status: "error", columns: [], rows: [], truncated: false, elapsedMs: elapsed, error: raw.error };
			}
			return {
				status: "ok",
				columns: raw.columns ?? [],
				rows: raw.rows ?? [],
				truncated: Boolean(raw.truncated),
				elapsedMs: elapsed,
			};
		},

		async close(): Promise<void> {
			// 无长连接：每次 execute 起一个短命子进程，无需释放。
		},
	};
}
