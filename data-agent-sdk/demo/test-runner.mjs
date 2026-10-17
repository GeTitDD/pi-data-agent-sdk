import { spawn } from "node:child_process";

const RUNNER = "C:/Users/Administrator/.pi/agent/extensions/data-copilot/runner.mjs";
const DB = "D:/pi_project/data-agent-sdk/demo/demo.db";

function job(payload, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [RUNNER], { windowsHide: true });
		let out = "";
		let err = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ ok: false, error: "killed by timeout", killed: true });
		}, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, error: e.message });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				resolve(JSON.parse(out));
			} catch {
				resolve({ ok: false, error: `bad output (code ${code}): ${out.slice(0, 200)} ${err.slice(0, 200)}` });
			}
		});
		child.stdin.write(JSON.stringify({ dbPath: DB, ...payload }));
		child.stdin.end();
	});
}

const show = (label, r) => console.log(`\n### ${label}\n` + JSON.stringify(r, null, 1).slice(0, 850));

show("ping", await job({ kind: "ping" }));
show("tables", await job({ kind: "tables" }));
show("describe orders", await job({ kind: "describe", table: "orders" }));
show("search 'customer'", await job({ kind: "search", query: "customer" }));
show(
	"revenue by category (paid)",
	await job({
		kind: "query",
		sql: `select p.category, round(sum(oi.quantity*oi.unit_price_cents)/100.0,2) as revenue
		      from order_items oi
		      join orders o on o.id = oi.order_id
		      join products p on p.id = oi.product_id
		      where o.status = 'paid'
		      group by p.category order by revenue desc`,
	}),
);

console.log("\n### GUARDRAILS");
for (const [label, sql] of [
	["multi-statement", "select 1; select 2"],
	["write (delete)", "delete from orders"],
	["ddl", "drop table orders"],
	["with+delete", "with x as (select 1) delete from orders"],
	["pragma", "pragma table_info(orders)"],
	["semicolon inside string (should allow)", "select ';' as s"],
]) {
	const r = await job({ kind: "query", sql });
	console.log(`  ${label}: ${r.ok ? "ALLOWED" : "BLOCKED -> " + r.error}`);
}

const capped = await job({ kind: "query", sql: "select id, created_at from orders", maxRows: 5 });
console.log(`\n### ROW CAP: rows=${capped.rows.length} truncated=${capped.truncated}`);

const t = await job({ kind: "query", sql: "select count(*) from orders a, orders b, orders c" }, 2000);
console.log(`### TIMEOUT (cartesian, 2s): ${t.killed ? "KILLED (as expected)" : JSON.stringify(t).slice(0, 120)}`);

const missing = await job({ kind: "ping" }, 15000);
console.log(`### sanity: ping ok = ${missing.ok}`);
