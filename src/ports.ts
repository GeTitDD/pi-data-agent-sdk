/**
 * L1 端口层 —— 只有接口，不含任何实现。
 *
 * 铁律：上层（cells/ask）只 import 本文件，**不得 import adapters/**。
 * 具体实现由最外层注入（端口—适配器 / 依赖倒置）。
 */

import type { ExecResult, Value } from "./atoms.ts";

/** 唯一接触数据库的地方。 */
export interface Connector {
	readonly engine: string;
	execute(sql: string, options: { maxRows: number; timeoutMs: number }): Promise<ExecResult>;
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
}
