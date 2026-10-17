/**
 * L1 `Metrics` 适配器 —— 极简语义层（只保留三个字段）。
 *
 * 迁移来源：legacy/data-copilot-index.ts 的 notes 读写（L150–170），
 * 从"自由文本 note"升级为结构化 `{name, expression, description}`（对齐 WrenAI MDL 的 measure）。
 *
 * 两个刻意的改动：
 *  1. **不再 import Pi 的 `withFileMutationQueue`** —— 那会把 SDK 耦合到宿主（A4）。M1 只读，无需写。
 *  2. 兼容 legacy `notes` 形态，便于从旧实现平滑迁移。
 *
 * `description` 是给检索/模型用的（WrenAI: "indexed for agent comprehension"），不是给人看的注释。
 */

import { readFile } from "node:fs/promises";

import type { Metric, Metrics } from "./ports.ts";

interface LegacyNote {
	name?: unknown;
	expression?: unknown;
	description?: unknown;
	text?: unknown;
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 归一化：支持 `{metrics:[{name,expression,description}]}` 与 legacy `{notes:[{text}]}` */
export function normalizeMetrics(parsed: unknown): Metric[] {
	if (!parsed || typeof parsed !== "object") return [];
	const obj = parsed as { metrics?: unknown; notes?: unknown };

	const source = Array.isArray(obj.metrics) ? obj.metrics : Array.isArray(obj.notes) ? obj.notes : [];
	return (source as LegacyNote[])
		.map((item, index) => {
			const description = asString(item.description) || asString(item.text);
			const name = asString(item.name) || `metric_${index + 1}`;
			return { name, expression: asString(item.expression), description };
		})
		.filter((m) => m.description || m.expression);
}

export function createFileMetrics(options: { path: string }): Metrics {
	return {
		async list(): Promise<Metric[]> {
			try {
				const raw = await readFile(options.path, "utf8");
				return normalizeMetrics(JSON.parse(raw));
			} catch {
				// 文件不存在 / 格式错误 → 视为"没有定义"，不阻断问答
				return [];
			}
		},
	};
}
