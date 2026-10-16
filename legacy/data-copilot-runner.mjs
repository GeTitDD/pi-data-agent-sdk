/**
 * data-copilot runner — executes one read-only SQLite job in an isolated child process.
 *
 * Contract: read a single JSON job from stdin, write a single JSON result to stdout.
 * Keeping execution in a child process gives us a hard timeout (the parent can kill
 * it) and crash isolation from the Pi process.
 *
 * Job shapes:
 *   { kind: "ping",     dbPath }
 *   { kind: "tables",   dbPath, includeCounts?: boolean }
 *   { kind: "describe", dbPath, table }
 *   { kind: "search",   dbPath, query }
 *   { kind: "query",    dbPath, sql, maxRows? }
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MAX_DEFAULT = 200;
const WRITE_KEYWORDS =
	/\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|truncate|grant|revoke|begin|commit|rollback|savepoint|pragma)\b/i;
const ALLOWED_STARTS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

/** Replace comments and string/identifier literals with spaces (keeps structure). */
function blankLiterals(sql) {
	let out = "";
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (ch === "-" && next === "-") {
			while (i < sql.length && sql[i] !== "\n") i++;
			out += " ";
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
			i++;
			out += " ";
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			const quote = ch;
			i++;
			while (i < sql.length) {
				if (sql[i] === quote) {
					if (sql[i + 1] === quote) {
						i += 2;
						continue;
					}
					break;
				}
				i++;
			}
			out += " ";
			continue;
		}
		if (ch === "[") {
			while (i < sql.length && sql[i] !== "]") i++;
			out += " ";
			continue;
		}
		out += ch;
	}
	return out;
}

/** Enforce: exactly one statement, read-only, no write/DDL keywords. */
function assertReadOnly(sql) {
	const blanked = blankLiterals(sql).trim();
	const body = blanked.endsWith(";") ? blanked.slice(0, -1) : blanked;
	if (body.includes(";")) throw new Error("Only a single SQL statement is allowed.");
	const first = (blanked.match(/[A-Za-z_]+/) || [""])[0].toUpperCase();
	if (!ALLOWED_STARTS.has(first)) {
		throw new Error(`Read-only mode: statement must start with SELECT, WITH, VALUES or EXPLAIN (got "${first || "?"}").`);
	}
	if (WRITE_KEYWORDS.test(blanked)) {
		throw new Error("Read-only mode: write/DDL keywords are not allowed.");
	}
}

function normalizeValue(value) {
	if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
	if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
	return value;
}

function normalizeRow(row) {
	const out = {};
	for (const key of Object.keys(row)) out[key] = normalizeValue(row[key]);
	return out;
}

function openReadOnly(dbPath) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	// query_only is engine-level defence on top of the read-only file handle.
	db.exec("PRAGMA query_only = ON");
	return db;
}

function run(job) {
	const started = Date.now();

	if (job.kind === "ping") {
		const db = openReadOnly(job.dbPath);
		const row = db.prepare("select sqlite_version() as version").get();
		db.close();
		return { version: row.version };
	}

	if (job.kind === "tables") {
		const db = openReadOnly(job.dbPath);
		const objects = db
			.prepare(
				"select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by type, name",
			)
			.all();
		const tables = objects.map((o) => ({ name: o.name, type: o.type, rowCount: null }));
		if (job.includeCounts !== false) {
			for (const t of tables) {
				try {
					const quoted = `"${String(t.name).replace(/"/g, '""')}"`;
					t.rowCount = db.prepare(`select count(*) as n from ${quoted}`).get().n;
				} catch {
					t.rowCount = null;
				}
			}
		}
		db.close();
		return { tables };
	}

	if (job.kind === "describe") {
		const db = openReadOnly(job.dbPath);
		const columns = db
			.prepare('select cid, name, type, "notnull" as not_null, dflt_value, pk from pragma_table_info(?) order by cid')
			.all(job.table)
			.map(normalizeRow);
		const indexes = db
			.prepare('select name, "unique" as is_unique, origin, partial from pragma_index_list(?)')
			.all(job.table)
			.map(normalizeRow);
		const foreignKeys = db
			.prepare('select id, seq, "table" as ref_table, "from" as from_column, "to" as to_column from pragma_foreign_key_list(?)')
			.all(job.table)
			.map(normalizeRow);
		db.close();
		return { table: job.table, columns, indexes, foreignKeys };
	}

	if (job.kind === "search") {
		const db = openReadOnly(job.dbPath);
		const like = `%${String(job.query).toLowerCase()}%`;
		const matches = db
			.prepare(
				`select m.name as table_name, m.type as object_type, p.name as column_name, p.type as data_type
				 from sqlite_master m join pragma_table_info(m.name) p
				 where m.type in ('table','view') and m.name not like 'sqlite_%'
				   and (lower(m.name) like ? or lower(p.name) like ?)
				 order by m.name, p.cid`,
			)
			.all(like, like);
		db.close();
		return { matches };
	}

	if (job.kind === "query") {
		assertReadOnly(job.sql);
		const maxRows = Number.isFinite(job.maxRows) && job.maxRows > 0 ? Math.floor(job.maxRows) : MAX_DEFAULT;
		const db = openReadOnly(job.dbPath);
		const stmt = db.prepare(job.sql);
		const columns = stmt.columns().map((c) => c.name);
		const rows = [];
		let truncated = false;
		for (const row of stmt.iterate()) {
			if (rows.length >= maxRows) {
				truncated = true;
				break;
			}
			rows.push(normalizeRow(row));
		}
		db.close();
		return { columns, rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - started };
	}

	throw new Error(`Unknown job kind: ${job.kind}`);
}

let job;
try {
	job = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: `Invalid job JSON: ${error.message}` }));
	process.exit(0);
}

try {
	const result = run(job);
	process.stdout.write(JSON.stringify({ ok: true, ...result }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
