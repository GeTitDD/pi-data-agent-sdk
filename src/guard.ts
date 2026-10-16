/**
 * L1 护栏 —— 全工程唯一解析 SQL 的地方。
 *
 * 规则集（6 条）：
 *   1. 非空
 *   2. 恰好一条语句（去掉尾部一个分号后不得再有分号）
 *   3. 语句族白名单（SELECT / WITH / VALUES / EXPLAIN）
 *   4. 写 / DDL / 事务控制 / ANALYZE 关键词黑名单
 *   5. 表名白名单（不信任模型给的表名 —— 借自 SQLBot）
 *   6. CTE 名视为合法表名（避免 WITH ... SELECT * FROM x 被误拒）
 *
 * 强度说明：**护栏强度与引擎保证互补**。SQLite 有连接级只读（见 adapters/sqlite.ts），
 * 因此这里的目标是"防误用 + 防越权读 + 防多语句"，而不是"防写入"。
 * 第 5 条是 best-effort 词法抽取（无 AST），真正的兜底永远是引擎只读。
 */

import type { Guard, GuardResult } from "./ports.ts";

/** 允许的起始语句族 */
const ALLOWED_STARTS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

/** 写 / DDL / 事务控制关键词黑名单（+ analyze：EXPLAIN ANALYZE 会真的执行语句） */
const BANNED_KEYWORDS =
	/\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|truncate|grant|revoke|begin|commit|rollback|savepoint|pragma|analyze)\b/i;

/**
 * 把注释与字符串/标识符字面量替换成空格，保留其余字符结构。
 *
 * 这是护栏最容易写错的一步：若不做净化，`SELECT ';'` 会被误判为多语句，
 * `SELECT 'DROP TABLE'` 会被误判为 DDL。
 */
export function blankLiterals(sql: string): string {
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

/**
 * 只抹掉注释与**单引号字符串**，保留带引号的标识符（"t" / `t` / [t]）。
 * 用于抽取表名：`FROM "orders"` 必须能被看到，而 `WHERE note = 'from admin'` 不能。
 */
function codeContext(sql: string): string {
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
		if (ch === "'") {
			i++;
			while (i < sql.length) {
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
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
		out += ch;
	}
	return out;
}

/** 去掉标识符的引号（"t" / `t` / [t] → t），并取 schema 限定名的最后一段 */
export function unquoteIdentifier(raw: string): string {
	let name = raw.trim();
	if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("`") && name.endsWith("`"))) {
		name = name.slice(1, -1).replace(/""/g, '"');
	} else if (name.startsWith("[") && name.endsWith("]")) {
		name = name.slice(1, -1);
	}
	const parts = name.split(".");
	return (parts[parts.length - 1] ?? name).trim();
}

/** 抽取 FROM / JOIN 之后引用的表名（best-effort 词法） */
export function extractTableNames(sql: string): string[] {
	const text = codeContext(sql);
	const found = new Set<string>();
	const re = /\b(?:from|join)\s+("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$.]*))/gi;
	for (const m of text.matchAll(re)) {
		const raw = m[2] ?? m[3] ?? m[4] ?? m[5];
		if (raw) found.add(unquoteIdentifier(raw));
	}
	return [...found];
}

/** 抽取 CTE 名（`name AS (`），它们是合法的引用目标 */
export function extractCteNames(sql: string): string[] {
	const text = codeContext(sql);
	const found = new Set<string>();
	const re = /(?:^|[\s,(])([A-Za-z_][A-Za-z0-9_$]*)\s+as\s*\(/gi;
	for (const m of text.matchAll(re)) found.add(unquoteIdentifier(m[1]));
	return [...found];
}

const deny = (kind: string, reason: string): GuardResult => ({ allowed: false, kind, reason });

/** 创建护栏。`ctx.tables` 为可引用的表名白名单（大小写不敏感）。 */
export function createGuard(): Guard {
	return {
		check(sql: string, ctx: { tables: string[] }): GuardResult {
			const blanked = blankLiterals(sql).trim();
			if (!blanked) return deny("empty", "Empty statement.");

			// 规则 2：恰好一条语句
			const body = blanked.endsWith(";") ? blanked.slice(0, -1) : blanked;
			if (body.includes(";")) return deny("multiple_statements", "Only a single SQL statement is allowed.");

			// 规则 3：语句族白名单
			const first = (blanked.match(/[A-Za-z_]+/) ?? [""])[0].toUpperCase();
			if (!ALLOWED_STARTS.has(first)) {
				return deny("not_allowed", `Statement must start with SELECT, WITH, VALUES or EXPLAIN (got "${first || "?"}").`);
			}

			// 规则 4：关键词黑名单（含 ANALYZE）
			const hit = blanked.match(BANNED_KEYWORDS);
			if (hit) return deny("banned_keyword", `Keyword "${hit[0]}" is not allowed in read-only mode.`);

			// 规则 5 + 6：表名白名单（CTE 名视为合法）
			const allowed = new Set([...ctx.tables, ...extractCteNames(sql)].map((t) => t.toLowerCase()));
			for (const table of extractTableNames(sql)) {
				if (!allowed.has(table.toLowerCase())) {
					return deny("unknown_table", `Unknown table "${table}". Run the schema tool first, or add it to the source allowlist.`);
				}
			}

			return { allowed: true, kind: "select" };
		},
	};
}
