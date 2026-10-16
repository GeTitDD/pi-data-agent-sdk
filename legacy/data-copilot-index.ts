/**
 * Data Copilot — a read-only analytics Q&A agent surface for Pi.
 *
 * Scope (stage 1): natural-language questions over relational databases, answered
 * with SQL, with safety and verification built in. SQLite is supported out of the
 * box via Node's built-in `node:sqlite` (no native build, read-only enforced at the
 * engine level). The `driver` field on each source is the extension point for a
 * Postgres adapter later.
 *
 * Guarantees:
 *  - Every query runs in an isolated child process, read-only, with a hard timeout,
 *    a single-statement rule, a keyword blocklist, and a row cap.
 *  - The model is told to show its SQL, clarify ambiguous metric definitions through
 *    the HITL tool, and verify results before concluding.
 *  - Business/metric definitions are stored and injected so answers stay consistent.
 *
 * Integration points:
 *  - tools     : data_sources, data_schema, data_query, data_notes
 *  - command   : /data
 *  - event     : before_agent_start (inject sources + metric definitions + rules)
 *  - entry     : appendEntry + entry renderer for durable, non-context notes
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceConfig {
	type?: "sqlite";
	driver?: "sqlite";
	path?: string;
	description?: string;
	readOnly?: boolean;
}

interface DataConfig {
	default?: string;
	maxRows?: number;
	timeoutMs?: number;
	sources?: Record<string, SourceConfig>;
}

interface DataNote {
	id: string;
	text: string;
	tags: string[];
	createdAt: number;
}

interface RunnerResult {
	ok: boolean;
	error?: string;
	version?: string;
	tables?: Array<{ name: string; type: string; rowCount: number | null }>;
	table?: string;
	columns?: Array<{ name: string; type?: string; not_null?: number; pk?: number; dflt_value?: unknown }>;
	indexes?: Array<{ name: string; is_unique?: number; origin?: string }>;
	foreignKeys?: Array<{ from_column?: string; ref_table?: string; to_column?: string }>;
	matches?: Array<{ table_name: string; column_name: string; data_type?: string; object_type?: string }>;
	rows?: Array<Record<string, unknown>>;
	rowCount?: number;
	truncated?: boolean;
	elapsedMs?: number;
}

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const HARD_TIMEOUT_MS = 60000;
const CELL_MAX = 60;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function expandEnv(value: string): string {
	return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name) => process.env[name] ?? "");
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

interface ResolvedConfig {
	default?: string;
	maxRows: number;
	timeoutMs: number;
	sources: Record<string, { config: SourceConfig; baseDir: string }>;
}

async function loadConfig(cwd: string): Promise<ResolvedConfig> {
	const projectConfig = await readJson<DataConfig>(join(cwd, ".pi", "data.json"));
	const globalConfig = await readJson<DataConfig>(join(getAgentDir(), "data.json"));

	const sources: ResolvedConfig["sources"] = {};
	if (globalConfig?.sources) {
		for (const [name, config] of Object.entries(globalConfig.sources)) {
			sources[name] = { config, baseDir: getAgentDir() };
		}
	}
	if (projectConfig?.sources) {
		for (const [name, config] of Object.entries(projectConfig.sources)) {
			sources[name] = { config, baseDir: join(cwd, ".pi") };
		}
	}

	return {
		default: projectConfig?.default ?? globalConfig?.default,
		maxRows: clamp(projectConfig?.maxRows ?? globalConfig?.maxRows ?? DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
		timeoutMs: clamp(projectConfig?.timeoutMs ?? globalConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500, HARD_TIMEOUT_MS),
		sources,
	};
}

const clamp = (value: number, min: number, max: number): number =>
	Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;

function resolveSourcePath(entry: { config: SourceConfig; baseDir: string }): string {
	const raw = expandEnv(entry.config.path ?? "");
	if (!raw) return "";
	return isAbsolute(raw) ? raw : resolve(entry.baseDir, raw);
}

// ---------------------------------------------------------------------------
// Notes (metric definitions & conventions)
// ---------------------------------------------------------------------------

function notesPath(): string {
	return join(getAgentDir(), "data-copilot", "notes.json");
}

async function readNotes(): Promise<DataNote[]> {
	const parsed = await readJson<{ notes?: DataNote[] }>(notesPath());
	return Array.isArray(parsed?.notes) ? parsed.notes : [];
}

async function writeNotes(notes: DataNote[]): Promise<void> {
	const path = notesPath();
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify({ notes }, null, 2)}\n`, "utf8");
		await rename(tmp, path);
	});
}

let noteSeq = 0;
const newNoteId = (): string => `n_${Date.now().toString(36)}${(noteSeq++).toString(36)}`;

// ---------------------------------------------------------------------------
// Runner invocation
// ---------------------------------------------------------------------------

function runnerPath(): string {
	try {
		return fileURLToPath(new URL("./runner.mjs", import.meta.url));
	} catch {
		return join(getAgentDir(), "extensions", "data-copilot", "runner.mjs");
	}
}

function runJob(job: Record<string, unknown>, timeoutMs: number): Promise<RunnerResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [runnerPath()], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: RunnerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish({ ok: false, error: `Query timed out after ${timeoutMs}ms and was killed.` });
		}, timeoutMs);

		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("close", () => {
			try {
				finish(JSON.parse(stdout) as RunnerResult);
			} catch {
				finish({ ok: false, error: (stderr || stdout).slice(0, 300) || "Runner produced no output." });
			}
		});

		child.stdin.write(JSON.stringify(job));
		child.stdin.end();
	});
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	const text = typeof value === "object" ? JSON.stringify(value) : String(value);
	return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
}

function formatTable(columns: string[], rows: Array<Record<string, unknown>>): string {
	if (!columns.length) return "(no columns)";
	if (!rows.length) return `${columns.join(" | ")}\n(0 rows)`;
	const widths = columns.map((col) => Math.max(col.length, ...rows.slice(0, 200).map((row) => formatCell(row[col]).length)));
	const renderRow = (values: string[]) => values.map((v, i) => v.padEnd(widths[i])).join(" | ");
	const lines = [
		renderRow(columns),
		widths.map((w) => "-".repeat(w)).join("-+-"),
		...rows.map((row) => renderRow(columns.map((col) => formatCell(row[col])))),
	];
	return lines.join("\n");
}

interface QueryDetails {
	kind: "query";
	source: string;
	sql: string;
	columns: string[];
	rows: Array<Record<string, unknown>>;
	truncated: boolean;
	elapsedMs?: number;
	error?: string;
}

function tableResult(text: string, details: QueryDetails): AgentToolResult<QueryDetails> {
	return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function dataCopilot(pi: ExtensionAPI) {
	async function runForSource(
		ctx: ExtensionContext,
		payload: Record<string, unknown>,
		requestedSource?: string,
	): Promise<{ source?: string; result: RunnerResult }> {
		const config = await loadConfig(ctx.cwd);
		const name = requestedSource ?? config.default ?? Object.keys(config.sources)[0];
		if (!name) {
			return { result: { ok: false, error: "No data sources configured. Create .pi/data.json or a data.json in the Pi agent directory." } };
		}
		const entry = config.sources[name];
		if (!entry) {
			const known = Object.keys(config.sources).join(", ") || "(none)";
			return { result: { ok: false, error: `Unknown source "${name}". Configured sources: ${known}` } };
		}
		const dbPath = resolveSourcePath(entry);
		if (!dbPath || !existsSync(dbPath)) {
			return { result: { ok: false, error: `Source "${name}" path not found: ${dbPath || "(unset)"}` } };
		}
		const result = await runJob({ ...payload, dbPath }, config.timeoutMs);
		return { source: name, result };
	}

	function sourceSummary(ctx: ExtensionContext, config: ResolvedConfig): string {
		const names = Object.keys(config.sources);
		if (!names.length) return "No data sources configured.";
		return names
			.map((name) => {
				const entry = config.sources[name];
				const path = resolveSourcePath(entry);
				const exists = path && existsSync(path);
				const size = exists ? `${(statSync(path).size / 1024).toFixed(0)} KB` : "missing";
				const desc = entry.config.description ? ` — ${entry.config.description}` : "";
				return `- ${name} (${entry.config.driver ?? entry.config.type ?? "sqlite"})${name === config.default ? " [default]" : ""}: ${path} (${size})${desc}`;
			})
			.join("\n");
	}

	function notesSummary(notes: DataNote[]): string {
		if (!notes.length) return "";
		return notes.map((note) => `- [${note.id}] ${note.text}`).join("\n");
	}

	// --- prompt injection ---------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		const config = await loadConfig(ctx.cwd);
		const notes = await readNotes();
		if (!Object.keys(config.sources).length && !notes.length) {
			delete event.systemPromptOptions.sections.data_copilot;
			return;
		}
		const blocks = [
			"DATA COPILOT — read-only analytics. All data access is read-only.",
			`Sources:\n${sourceSummary(ctx, config)}`,
			"Rules:",
			"- Learn the schema first (data_schema) before writing SQL; never guess table or column names.",
			"- When you report a number, also show the exact SQL you ran and the row count.",
			"- If a business/metric definition is ambiguous (e.g. does revenue include refunds or cancelled orders?), ask the user with the ask_user_question tool before querying.",
			"- Verify before concluding: check row counts, NULLs, and cross-check the total with an independent query.",
			"- The table is statement-limited and row-capped; if a result is truncated, say so and refine the query.",
			"- Never invent numbers. If a query fails, report the error.",
		];
		if (notes.length) {
			blocks.push(`Metric definitions & conventions (authoritative):\n${notesSummary(notes)}`);
		}
		event.systemPromptOptions.sections.data_copilot = blocks.join("\n");
	});

	// --- data_sources -------------------------------------------------------

	pi.registerTool({
		name: "data_sources",
		label: "Data Sources",
		description: "List the configured read-only data sources and their availability.",
		promptSnippet: "data_sources — list configured databases",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const text = sourceSummary(ctx, config);
			return { content: [{ type: "text", text }], details: { sources: Object.keys(config.sources) } };
		},
	});

	// --- data_schema --------------------------------------------------------

	pi.registerTool({
		name: "data_schema",
		label: "Data Schema",
		description:
			"Inspect the read-only schema: list tables (with row counts), describe one table (columns, keys, indexes), or search for tables/columns by name.",
		promptSnippet: "data_schema — list tables / describe table / search columns",
		promptGuidelines: ["Call data_schema before writing SQL so table and column names are correct."],
		parameters: Type.Object({
			action: StringEnum(["list", "describe", "search"] as const),
			table: Type.Optional(Type.String({ description: "Table name (action: describe)" })),
			query: Type.Optional(Type.String({ description: "Name fragment to search (action: search)" })),
			source: Type.Optional(Type.String({ description: "Source name (defaults to the configured default)" })),
			includeCounts: Type.Optional(Type.Boolean({ description: "Include row counts for list (default true)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.action === "describe") {
				if (!params.table) return { content: [{ type: "text", text: "Error: table is required for describe" }], details: {} };
				const { source, result } = await runForSource(ctx, { kind: "describe", table: params.table }, params.source);
				if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {} };
				const cols = (result.columns ?? [])
					.map((c) => `  ${c.name} ${c.type ?? ""}${c.pk ? " PK" : ""}${c.not_null ? " NOT NULL" : ""}`.trimEnd())
					.join("\n");
				const fks = (result.foreignKeys ?? [])
					.map((f) => `  ${f.from_column} -> ${f.ref_table}.${f.to_column}`)
					.join("\n");
				const idx = (result.indexes ?? []).map((i) => `  ${i.name}${i.is_unique ? " UNIQUE" : ""}`).join("\n");
				const text = [
					`Table ${result.table} (source: ${source}):`,
					"Columns:",
					cols,
					fks ? `Foreign keys:\n${fks}` : "",
					idx ? `Indexes:\n${idx}` : "",
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text", text }], details: { table: result.table, columns: result.columns } };
			}

			if (params.action === "search") {
				if (!params.query) return { content: [{ type: "text", text: "Error: query is required for search" }], details: {} };
				const { source, result } = await runForSource(ctx, { kind: "search", query: params.query }, params.source);
				if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {} };
				const text = result.matches?.length
					? `Matches for "${params.query}" (source: ${source}):\n${result.matches.map((m) => `  ${m.table_name}.${m.column_name} (${m.data_type ?? "?"})`).join("\n")}`
					: `No tables or columns match "${params.query}".`;
				return { content: [{ type: "text", text }], details: { matches: result.matches } };
			}

			const { source, result } = await runForSource(ctx, { kind: "tables", includeCounts: params.includeCounts !== false }, params.source);
			if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {} };
			const text = `Tables (source: ${source}):\n${(result.tables ?? [])
				.map((t) => `  ${t.name} [${t.type}]${t.rowCount === null ? "" : ` — ${t.rowCount} rows`}`)
				.join("\n")}`;
			return { content: [{ type: "text", text }], details: { tables: result.tables } };
		},
	});

	// --- data_query ---------------------------------------------------------

	pi.registerTool({
		name: "data_query",
		label: "Data Query",
		description:
			"Run ONE read-only SQL statement (SELECT / WITH / VALUES / EXPLAIN) against a configured source. Write-only statements are rejected. Results are row-capped.",
		promptSnippet: "data_query — run a read-only SQL query",
		promptGuidelines: [
			"Every data_query call must be a single read-only statement; run data_schema first.",
			"Include the SQL you ran when reporting any number, and re-run a cheap count to sanity-check totals.",
		],
		parameters: Type.Object({
			sql: Type.String({ description: "A single read-only SQL statement" }),
			source: Type.Optional(Type.String({ description: "Source name (defaults to the configured default)" })),
			maxRows: Type.Optional(Type.Number({ description: `Row cap (default ${DEFAULT_MAX_ROWS}, max ${HARD_MAX_ROWS})` })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd);
			const maxRows = clamp(params.maxRows ?? config.maxRows, 1, HARD_MAX_ROWS);
			const { source, result } = await runForSource(ctx, { kind: "query", sql: params.sql, maxRows }, params.source);
			const details: QueryDetails = {
				kind: "query",
				source: source ?? "?",
				sql: params.sql,
				columns: result.columns ?? [],
				rows: result.rows ?? [],
				truncated: Boolean(result.truncated),
				elapsedMs: result.elapsedMs,
				error: result.ok ? undefined : result.error,
			};
			if (!result.ok) {
				return tableResult(`Query error: ${result.error}`, details);
			}
			const header = [
				`source: ${details.source}`,
				`rows: ${details.rowCount}${details.truncated ? ` (truncated at ${maxRows})` : ""}`,
				details.elapsedMs !== undefined ? `time: ${details.elapsedMs}ms` : "",
			]
				.filter(Boolean)
				.join("  ·  ");
			const text = `${header}\n${formatTable(details.columns, details.rows)}`;
			return tableResult(text, details);
		},
		renderResult(result_, { expanded }, theme) {
			const details = result_.details as QueryDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.error) return new Text(theme.fg("error", `Query error: ${details.error}`), 0, 0);
			const first = result_.content[0];
			const text = first?.type === "text" ? first.text : "";
			if (!expanded) {
				const lines = text.split("\n");
				return new Text(lines.slice(0, 6).join("\n") + (lines.length > 6 ? theme.fg("dim", "\n… expand for more") : ""), 0, 0);
			}
			return new Text(text, 0, 0);
		},
	});

	// --- data_notes ---------------------------------------------------------

	pi.registerTool({
		name: "data_notes",
		label: "Data Notes",
		description:
			"Store authoritative metric definitions and conventions so answers stay consistent across sessions. Actions: add (text, optional tags), list, forget (id).",
		promptSnippet: "data_notes — persisted metric definitions",
		promptGuidelines: ["After the user settles an ambiguous metric definition, save it with data_notes action add."],
		parameters: Type.Object({
			action: StringEnum(["add", "list", "forget"] as const),
			text: Type.Optional(Type.String({ description: "Definition text (action: add)" })),
			id: Type.Optional(Type.String({ description: "Note id (action: forget)" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
		}),
		async execute(_id, params) {
			const notes = await readNotes();
			if (params.action === "add") {
				const text = params.text?.trim();
				if (!text) return { content: [{ type: "text", text: "Error: text is required for add" }], details: {} };
				const duplicate = notes.find((n) => n.text.toLowerCase() === text.toLowerCase());
				if (duplicate) {
					duplicate.tags = params.tags ?? duplicate.tags;
					await writeNotes(notes);
					return { content: [{ type: "text", text: `Updated definition [${duplicate.id}]: ${duplicate.text}` }], details: {} };
				}
				const note: DataNote = { id: newNoteId(), text, tags: params.tags ?? [], createdAt: Date.now() };
				notes.push(note);
				await writeNotes(notes);
				return { content: [{ type: "text", text: `Saved definition [${note.id}]: ${note.text}` }], details: {} };
			}
			if (params.action === "forget") {
				if (!params.id) return { content: [{ type: "text", text: "Error: id is required for forget" }], details: {} };
				const next = notes.filter((n) => n.id !== params.id);
				if (next.length === notes.length) return { content: [{ type: "text", text: `No definition with id ${params.id}` }], details: {} };
				await writeNotes(next);
				return { content: [{ type: "text", text: `Forgot definition [${params.id}]` }], details: {} };
			}
			return {
				content: [{ type: "text", text: notes.length ? notesSummary(notes) : "No metric definitions saved yet." }],
				details: { notes },
			};
		},
	});

	// --- /data command ------------------------------------------------------

	pi.registerCommand("data", {
		description: "Show data sources & metric definitions (usage: /data [notes|note <text>|forget <id>|sql <query>])",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const input = args.trim();
			const [sub, ...rest] = input.split(/\s+/);
			const restText = rest.join(" ").trim();
			const config = await loadConfig(ctx.cwd);

			if (sub === "sql") {
				if (!restText) {
					ctx.ui.notify("Usage: /data sql <query>", "warning");
					return;
				}
				const { source, result } = await runForSource(ctx, { kind: "query", sql: restText, maxRows: config.maxRows });
				if (!result.ok) {
					ctx.ui.notify(`Query error: ${result.error}`, "error");
					return;
				}
				const table = formatTable(result.columns ?? [], result.rows ?? []);
				ctx.ui.notify(`${source}: ${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}\n${table}`, "info");
				return;
			}

			if (sub === "note") {
				if (!restText) {
					ctx.ui.notify("Usage: /data note <definition>", "warning");
					return;
				}
				const notes = await readNotes();
				const note: DataNote = { id: newNoteId(), text: restText, tags: [], createdAt: Date.now() };
				notes.push(note);
				await writeNotes(notes);
				ctx.ui.notify(`Saved definition [${note.id}]`, "info");
				return;
			}

			if (sub === "forget") {
				const notes = await readNotes();
				const next = notes.filter((n) => n.id !== restText);
				await writeNotes(next);
				ctx.ui.notify(next.length === notes.length ? `No definition with id ${restText}` : `Forgot [${restText}]`, "info");
				return;
			}

			if (sub === "notes") {
				const notes = await readNotes();
				ctx.ui.notify(notes.length ? notesSummary(notes) : "No metric definitions saved yet.", "info");
				return;
			}

			const notes = await readNotes();
			ctx.ui.notify(
				[
					"Data Copilot (read-only)",
					sourceSummary(ctx, config),
					notes.length ? `Metric definitions: ${notes.length}` : "Metric definitions: none",
					"",
					"/data notes           list definitions",
					"/data note <text>     add a definition",
					"/data forget <id>     remove a definition",
					"/data sql <query>     run a read-only query",
				].join("\n"),
				"info",
			);
		},
	});
}
