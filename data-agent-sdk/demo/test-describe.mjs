import { spawn } from "node:child_process";
const RUNNER = "C:/Users/Administrator/.pi/agent/extensions/data-copilot/runner.mjs";
const DB = "D:/pi_project/data-agent-sdk/demo/demo.db";
function job(payload, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [RUNNER], { windowsHide: true });
		let out = "";
		let settled = false;
		const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); resolve({ ok: false, error: "timeout" }); } }, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.on("close", () => { if (!settled) { settled = true; clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: out.slice(0, 200) }); } } });
		child.stdin.write(JSON.stringify({ dbPath: DB, ...payload }));
		child.stdin.end();
	});
}
console.log(JSON.stringify(await job({ kind: "describe", table: "orders" }), null, 1));
console.log(JSON.stringify(await job({ kind: "describe", table: "order_items" }), null, 1));
