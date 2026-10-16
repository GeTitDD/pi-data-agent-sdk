/**
 * L1 护栏 —— 全工程唯一解析 SQL 的地方。
 *
 * 迁移来源：legacy/data-copilot-runner.mjs 的 blankLiterals()（L27–66）与 assertReadOnly()（L68–80）。
 * S1 阶段只做"搬迁 + 结构化"：规则集与旧实现一致（单语句 / 语句族 / 写关键词黑名单）。
 * 新增规则（ANALYZE 禁项、表名白名单）留到 S2。
 */

import type { Guard, GuardResult } from "./ports.ts";

/** 允许的起始语句族（迁移自 runner 的 ALLOWED_STARTS） */
const ALLOWED_STARTS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

/** 写 / DDL / 事务控制关键词黑名单（迁移自 runner 的 WRITE_KEYWORDS） */
const WRITE_KEYWORDS =
	/\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|truncate|grant|revoke|begin|commit|rollback|savepoint|pragma)\b/i;

/**
 * 把注释与字符串/标识符字面量替换成空格，保留其余字符结构。
 *
 * 这是护栏最容易写错的一步：若不做净化，`SELECT ';'` 会被误判为多语句，
 * `SELECT 'DROP TABLE'` 会被误判为 DDL。此实现自旧 runner 原样搬入。
 */
export function blankLiterals(sql: string): string {
	let out = "";
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1];
		// 行注释
		if (ch === "-" && next === "-") {
			while (i < sql.length && sql[i] !== "\n") i++;
			out += " ";
			continue;
		}
		// 块注释
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
			i++;
			out += " ";
			continue;
		}
		// 字符串 / 双引号标识符 / 反引号标识符
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
		// [方括号] 标识符
		if (ch === "[") {
			while (i < sql.length && sql[i] !== "]") i++;
			out += " ";
			continue;
		}
		out += ch;
	}
	return out;
}

const deny = (kind: string, reason: string): GuardResult => ({ allowed: false, kind, reason });

/**
 * 创建护栏。`ctx.tables` 在 S1 未使用（S2 用作表名白名单）。
 */
export function createGuard(): Guard {
	return {
		check(sql: string, _ctx: { tables: string[] }): GuardResult {
			const blanked = blankLiterals(sql).trim();

			if (!blanked) return deny("empty", "Empty statement.");

			// 规则 1：恰好一条语句（去掉尾部一个分号后不得再有分号）
			const body = blanked.endsWith(";") ? blanked.slice(0, -1) : blanked;
			if (body.includes(";")) return deny("multiple_statements", "Only a single SQL statement is allowed.");

			// 规则 2：语句族白名单
			const first = (blanked.match(/[A-Za-z_]+/) ?? [""])[0].toUpperCase();
			if (!ALLOWED_STARTS.has(first)) {
				return deny("not_allowed", `Statement must start with SELECT, WITH, VALUES or EXPLAIN (got "${first || "?"}").`);
			}

			// 规则 3：写 / DDL / 事务控制关键词黑名单
			const hit = blanked.match(WRITE_KEYWORDS);
			if (hit) return deny("banned_keyword", `Keyword "${hit[0]}" is not allowed in read-only mode.`);

			return { allowed: true, kind: "select" };
		},
	};
}
