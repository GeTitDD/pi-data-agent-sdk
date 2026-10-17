/**
 * L2 端到端入口 —— 7 步流水线。
 *
 *   context → generate → guard → validate(EXPLAIN) → execute → verify → answer
 *
 * 三条硬约束：
 *  1. **唯一执行出口**：本文件里 `connector.execute` 只出现三次（validate / execute / 无）；
 *     下游（cells）不执行任何东西。
 *  2. **修复循环有上限**（`limits.repairAttempts`）—— 无界循环是本方法论的反模式 5。
 *  3. **数字唯一来源**：`answer` 由 `result` 渲染，不由模型撰写。
 *
 * M0 暴露的接口缺口：catalog 的 schema 查询会被 guard 拒绝（表名白名单 + 禁 PRAGMA），
 * 因此 `Connector` 新增了 `introspect()`（闭集作业）—— 这是纪律⑤「只增不改」的首次使用。
 */

import { buildContext, buildPrompt, extractSql, renderAnswer, validateSql, verify } from "./cells.ts";
import type { ExecResult } from "./atoms.ts";
import type { AskResult, Deps } from "./ports.ts";

const failResult = (error: string): ExecResult => ({
	status: "error",
	columns: [],
	rows: [],
	truncated: false,
	elapsedMs: 0,
	error,
});

export async function ask(question: string, deps: Deps): Promise<AskResult> {
	// 1. context —— 取不到 schema 就不该硬编 SQL，直接失败
	let context;
	try {
		context = await buildContext(deps, question);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			sql: "",
			result: failResult(message),
			answer: `无法获取 schema：${message}`,
			evidence: [`context failed: ${message}`],
			status: "error",
			repairs: 0,
		};
	}

	// 2. generate
	let raw = await deps.model.complete(buildPrompt(context, question));
	let sql = extractSql(raw);

	// 3./4. guard + validate，失败则回喂修复（有上限）
	let lastError = "";
	let repairs = 0;

	for (let attempt = 0; ; attempt++) {
		const verdict = deps.guard.check(sql, { tables: context.tableNames });
		if (!verdict.allowed) {
			lastError = `${verdict.kind}: ${verdict.reason ?? "rejected"}`;
		} else {
			const probe = await validateSql(deps, sql);
			if (probe.status === "ok") {
				lastError = "";
				break;
			}
			lastError = `validation: ${probe.error ?? probe.status}`;
		}

		if (attempt >= deps.limits.repairAttempts) break;

		// 可纠正的错误（未知表 / 语法错）回喂模型
		repairs++;
		raw = await deps.model.complete(buildPrompt(context, question, { attempt: repairs, error: lastError }));
		sql = extractSql(raw);
	}

	if (lastError) {
		return {
			sql,
			result: failResult(lastError),
			answer: `未能生成可执行的查询（已修复 ${repairs} 轮）。\n\n\`\`\`sql\n${sql}\n\`\`\`\n\n最后一次错误：${lastError}`,
			evidence: [`validation failed: ${lastError}`],
			status: "error",
			repairs,
		};
	}

	// 5. execute —— 数字的唯一来源
	const result = await deps.connector.execute(sql, { maxRows: deps.limits.maxRows, timeoutMs: deps.limits.timeoutMs });

	// 6. verify
	const evidence = verify(result);

	// 7. answer（确定性渲染）
	return { sql, result, answer: renderAnswer(sql, result, evidence), evidence, status: result.status, repairs };
}
