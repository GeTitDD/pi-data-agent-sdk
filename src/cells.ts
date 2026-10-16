/**
 * L2 细胞 —— 单职责变换。纯编排，**不 import adapters**（只依赖 ports 的接口）。
 *
 * 参考 shopkeeper-agent 的流水线骨架（抽词→召回→上下文→生成→校验→修正→执行），
 * 但去掉 LangGraph：这里的流程是线性的，只用一个有上限的重试点。
 *
 * 关键设计：上下文按**命名 section** 组织（对齐 Pi 的 `buildSystemPromptSections`），
 * 便于将来做 diff，而不是拼一大段字符串。
 */

import type { ExecResult, Value } from "./atoms.ts";
import type { AskContext, Deps, TableRef } from "./ports.ts";

/** 轻量分词：只取 ASCII 词（标识符是英文），用于表/列的相关性排序 */
export function tokenize(text: string): string[] {
	const words = text.toLowerCase().match(/[a-z][a-z0-9_]{1,}/g) ?? [];
	return [...new Set(words)];
}

/** 值域采样只对"看起来像枚举"的列做 */
const CATEGORICAL = /(status|state|type|kind|category|segment|region|country|city|channel|level|tier|priority|group|stage|name)$/i;
const TEXTY = /text|char|clob|varchar/i;

const MAX_TABLES = 5;
const MAX_VALUES_PER_COLUMN = 5;
const MAX_CATEGORICAL_COLUMNS = 2;

/** 确定性选表：表少则全给；表多则按问题词与表名的词面重叠排序 */
export function pickTables(tables: TableRef[], question: string, max = MAX_TABLES): TableRef[] {
	const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
	if (sorted.length <= max) return sorted;

	const tokens = tokenize(question);
	const scored = sorted
		.map((t) => ({ t, score: tokens.filter((tok) => t.name.toLowerCase().includes(tok)).length }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

	return (scored.length ? scored.map((s) => s.t) : sorted).slice(0, max);
}

/** 组装上下文（schema / 值域 / 口径 / 环境） */
export async function buildContext(deps: Deps, question: string): Promise<AskContext> {
	const tables = await deps.catalog.tables();
	const chosen = pickTables(tables, question);

	const schemaLines: string[] = [];
	const valueLines: string[] = [];

	for (const t of chosen) {
		const detail = await deps.catalog.describe(t.name);
		schemaLines.push(`### ${t.name}${typeof t.rowCount === "number" ? ` (${t.rowCount} rows)` : ""}`);
		for (const c of detail.columns) {
			const marks = [c.type, c.pk ? "PK" : "", c.notNull ? "NOT NULL" : ""].filter(Boolean).join(" ");
			schemaLines.push(`- ${c.name}${marks ? ` — ${marks}` : ""}`);
		}

		const categorical = detail.columns
			.filter((c) => CATEGORICAL.test(c.name) && TEXTY.test(c.type ?? "text"))
			.slice(0, MAX_CATEGORICAL_COLUMNS);
		for (const c of categorical) {
			const values = await deps.catalog.values(t.name, c.name, MAX_VALUES_PER_COLUMN);
			if (values.length) valueLines.push(`- ${t.name}.${c.name}: ${values.map((v) => JSON.stringify(v)).join(", ")}`);
		}
	}

	const metrics = await deps.metrics.list();
	const now = deps.clock();
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getUTCDay()];
	const environment = [
		`engine: ${deps.connector.engine}`,
		`today: ${now.toISOString().slice(0, 10)} (${weekday})`,
		`quarter: Q${Math.floor(now.getUTCMonth() / 3) + 1}`,
		`year: ${now.getUTCFullYear()}`,
	].join("\n");

	const sections: Record<string, string> = { schema: schemaLines.join("\n"), environment };
	if (valueLines.length) sections.values = valueLines.join("\n");
	if (metrics.length) {
		sections.metrics = metrics
			.map((m) => `- ${m.name}${m.expression ? ` = ${m.expression}` : ""}${m.description ? ` — ${m.description}` : ""}`)
			.join("\n");
	}

	return { sections, tableNames: chosen.map((t) => t.name) };
}

/** 组装提示词（section 化；修复轮把上次错误回喂） */
export function buildPrompt(context: AskContext, question: string, repair?: { attempt: number; error: string }): string {
	const parts = [
		"You translate a business question into ONE read-only SQLite query.",
		"Output ONLY the SQL statement. No explanation. No markdown fences. Exactly one statement.",
		"",
		"<schema>",
		context.sections.schema ?? "",
		"</schema>",
	];
	if (context.sections.values) parts.push("", "<values>", context.sections.values, "</values>");
	if (context.sections.metrics) parts.push("", "<metrics>", context.sections.metrics, "</metrics>");
	parts.push("", "<environment>", context.sections.environment ?? "", "</environment>");
	parts.push("", "<question>", question, "</question>");
	if (repair) {
		parts.push(
			"",
			`<previous_attempt_failed attempt="${repair.attempt}">`,
			repair.error,
			"</previous_attempt_failed>",
			"Fix the problem above and output the corrected SQL only.",
		);
	}
	return parts.join("\n");
}

/** 从模型输出里提取纯 SQL（去 markdown 围栏、去前后解释文字） */
export function extractSql(raw: string): string {
	let text = raw.trim();

	const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) text = fenced[1].trim();

	const start = text.search(/\b(select|with|values|explain)\b/i);
	if (start > 0) text = text.slice(start);
	text = text.trim();

	// 截到第一个"顶层"分号（忽略单引号字符串内的分号）
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "'") {
			if (inString && text[i + 1] === "'") {
				i++;
				continue;
			}
			inString = !inString;
			continue;
		}
		if (ch === ";" && !inString) {
			text = text.slice(0, i + 1);
			break;
		}
	}
	return text.trim();
}

/** 干跑校验：`EXPLAIN QUERY PLAN` **不执行**语句，只让数据库解析一次 */
export async function validateSql(deps: Deps, sql: string): Promise<ExecResult> {
	return deps.connector.execute(`EXPLAIN QUERY PLAN ${sql}`, { maxRows: 20, timeoutMs: deps.limits.timeoutMs });
}

/** 机械核对：行数 / NULL / 截断（不做语义判断，只记录事实） */
export function verify(result: ExecResult): string[] {
	const out: string[] = [`rows: ${result.rows.length}`];
	if (result.status !== "ok") out.push(`status: ${result.status}${result.error ? ` (${result.error})` : ""}`);
	if (result.rows.length === 0) out.push("no rows returned — the filter may be too narrow");
	if (result.truncated) out.push(`truncated at maxRows (${result.rows.length} returned)`);
	for (const col of result.columns) {
		const nulls = result.rows.filter((r) => r[col] === null || r[col] === undefined).length;
		if (nulls > 0) out.push(`${col}: ${nulls}/${result.rows.length} NULL`);
	}
	return out;
}

/**
 * 确定性渲染答案（**不由模型撰写**）。
 *
 * 这样做的收益：`answer` 里出现的每一个数字都来自 `result.rows`，是**构造保证**而非事后检查。
 * 让模型写散文需要额外的"数字校验"模块——那是 M2 的工作，且可靠性更低。
 */
export function renderAnswer(sql: string, result: ExecResult, evidence: string[]): string {
	const cell = (v: Value): string => String(v ?? "NULL").replace(/\|/g, "\\|");
	const lines = ["```sql", sql.trim(), "```", ""];

	if (result.status !== "ok") {
		lines.push(`**Query failed** (${result.status}): ${result.error ?? ""}`);
	} else if (result.columns.length === 0) {
		lines.push("(no columns returned)");
	} else {
		const suffix = result.truncated ? ", truncated" : "";
		lines.push(`**Result** (${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${suffix})`, "");
		lines.push(`| ${result.columns.join(" | ")} |`);
		lines.push(`| ${result.columns.map(() => "---").join(" | ")} |`);
		for (const row of result.rows) lines.push(`| ${result.columns.map((c) => cell(row[c])).join(" | ")} |`);
	}

	if (evidence.length) lines.push("", `**Checks**: ${evidence.join(" · ")}`);
	return lines.join("\n");
}
