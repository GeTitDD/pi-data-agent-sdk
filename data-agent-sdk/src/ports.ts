/**
 * L1 端口层 —— 只有接口，不含任何实现。
 *
 * 铁律：上层（cells/ask）只 import 本文件，**不得 import adapters/**。
 * 具体实现由最外层注入（端口—适配器 / 依赖倒置）。
 */

import type { ExecResult, ExecStatus, Value } from "./atoms.ts";

/** 唯一接触数据库的地方。 */
export interface Connector {
	readonly engine: string;
	/** 执行**模型生成**的 SQL —— 调用方必须先过 Guard */
	execute(sql: string, options: { maxRows: number; timeoutMs: number }): Promise<ExecResult>;
	/**
	 * 执行**平台内置**的自省作业（M1 新增，见纪律⑤「只增不改」）。
	 *
	 * 为什么需要第二个方法：catalog 要读 `sqlite_master` / `pragma_table_info`，
	 * 而这两者会**被 guard 自己拒掉**（表名白名单 + 禁 PRAGMA）。给 guard 开例外等于给模型开洞，
	 * 所以改为**结构上无法传入任意 SQL** 的第二条通道：入参是闭集 union。
	 */
	introspect(job: IntrospectJob, options?: { timeoutMs?: number }): Promise<IntrospectResult>;
	close(): Promise<void>;
}

/** 护栏判定结果（结构化，而不是抛异常 —— 便于失败分类）。 */
export interface GuardResult {
	allowed: boolean;
	/** 语义标签：select / empty / multiple_statements / not_allowed / banned_keyword / unknown_table */
	kind: string;
	reason?: string;
}

/** 唯一解析 SQL 的地方。 */
export interface Guard {
	check(sql: string, ctx: { tables: string[] }): GuardResult;
}

export interface TableRef {
	name: string;
	rowCount?: number | null;
}

export interface ColumnRef {
	name: string;
	type?: string;
	notNull?: boolean;
	pk?: boolean;
}

export interface TableDetail {
	table: string;
	columns: ColumnRef[];
}

/** 只读的 schema 自省（表 / 列 / 值域）。 */
export interface Catalog {
	tables(): Promise<TableRef[]>;
	describe(table: string): Promise<TableDetail>;
	/** 值域对齐：用于 WHERE 条件里的枚举取值（参考 shopkeeper-agent 的 recall_value） */
	values(table: string, column: string, limit: number): Promise<Value[]>;
}

/** 极简语义层：只保留三个字段（参考 WrenAI MDL 的 measure/dimension） */
export interface Metric {
	name: string;
	expression: string;
	/** 说明文本是给检索/模型用的，不是注释（WrenAI: "indexed for agent comprehension"） */
	description: string;
}

export interface Metrics {
	list(): Promise<Metric[]>;
}

/** 模型端口：便于用 Stub 离线测试 */
export interface Model {
	complete(prompt: string): Promise<string>;
}

/** 运行时依赖集合（全部由外部注入） */
export interface Deps {
	connector: Connector;
	guard: Guard;
	catalog: Catalog;
	metrics: Metrics;
	model: Model;
	limits: { maxRows: number; timeoutMs: number; repairAttempts: number };
	/** 可注入时钟：日期注入必须确定性，否则上下文不可复现 */
	clock: () => Date;
}

// ---------------------------------------------------------------------------
// M1 新增（只增不改）
// ---------------------------------------------------------------------------

/** 内置自省作业：**闭集**，结构上无法传入任意 SQL */
export type IntrospectJob =
	| { kind: "tables"; includeCounts?: boolean }
	| { kind: "describe"; table: string }
	| { kind: "search"; query: string }
	| { kind: "values"; table: string; column: string; limit: number };

/** 自省结果（各字段按 kind 选择性填充） */
export interface IntrospectResult {
	status: ExecStatus;
	tables?: Array<{ name: string; type?: string; rowCount?: number | null }>;
	table?: string;
	columns?: Array<ColumnRef & { default?: unknown }>;
	indexes?: Array<{ name: string; unique?: boolean }>;
	foreignKeys?: Array<{ fromColumn?: string; refTable?: string; toColumn?: string }>;
	matches?: Array<{ tableName: string; columnName: string; dataType?: string }>;
	values?: Value[];
	error?: string;
}

/** 一次问答的结果。`result` 是**数字的唯一来源**。 */
export interface AskResult {
	sql: string;
	result: ExecResult;
	/** 确定性渲染（M1 不由模型撰写，见 M1-DESIGN） */
	answer: string;
	/** 机械核对记录：行数 / NULL / 截断 */
	evidence: string[];
	status: ExecStatus;
	/** 修复了几轮（0 表示一次过） */
	repairs: number;
}

/** 上下文块：命名为 section，便于将来做 diff（对齐 Pi 的 buildSystemPromptSections） */
export interface AskContext {
	sections: Record<string, string>;
	/** 可用于表名白名单的表集合 */
	tableNames: string[];
}
