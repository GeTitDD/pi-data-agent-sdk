/**
 * Package entry. Re-exports only. Every name here is defined in the port or stage modules,
 * so the call graph and the file layout stay exactly as the spec draws them.
 *
 * A host needs three things from this entry: `ask`, the factories that build `Deps`, and the
 * types that describe the result. Stage internals (`cells.ts`) stay reachable by deep import
 * for tests that drive one stage at a time.
 */

export type { ExecResult, ExecStatus, Row, Value } from "./atoms.ts";

export type {
	AskContext,
	AskResult,
	Catalog,
	ColumnRef,
	Connector,
	Deps,
	Guard,
	GuardResult,
	IntrospectJob,
	IntrospectResult,
	Metric,
	Metrics,
	Model,
	TableDetail,
	TableRef,
} from "./ports.ts";

export { createSqliteConnector, type SqliteConnectorOptions } from "./adapters/sqlite.ts";
export { ask } from "./ask.ts";
export { createCatalog } from "./catalog.ts";
export { createGuard } from "./guard.ts";
export { createFileMetrics } from "./metrics.ts";
