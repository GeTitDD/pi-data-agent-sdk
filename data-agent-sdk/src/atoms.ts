/**
 * L0 原子层 —— 纯类型与纯函数，无 IO、无状态、可单测。
 *
 * 迁移来源：legacy/data-copilot-index.ts 的类型定义段（L46–88）。
 */

/** 数据库单元格允许的值（blob 已被适配器归一化为字符串描述） */
export type Value = null | number | string;

/** 一行 = 列名 → 值 */
export type Row = Record<string, Value>;

/**
 * 失败分类（迁移自 DB-GPT 的 ExecutionStatus 设计）。
 * 禁止用异常类型来表达业务失败。
 */
export type ExecStatus = "ok" | "denied" | "error" | "timeout";

/** 一次 SQL 执行的结果。数字的唯一来源。 */
export interface ExecResult {
	status: ExecStatus;
	columns: string[];
	rows: Row[];
	/** 是否因达到行数上限而截断 */
	truncated: boolean;
	elapsedMs: number;
	error?: string;
}
