#!/usr/bin/env node
/**
 * new-issue.mjs — file an issue on GitHub through the REST API.
 *
 * WHY this exists: on this machine `github.com:443` is unreachable (TCP timeout from both WSL
 * and Windows), while `api.github.com` answers fine. So every agent that needs to file an issue
 * calls this script instead of `gh issue create` or the web UI. It needs nothing but node and a
 * token, which makes it usable from any agent runtime (pi, codex, a shell script).
 *
 * Usage:
 *   node tools/new-issue.mjs --title "..." --body "..." [--label bug] [--repo owner/name] [--dry-run]
 *   node tools/new-issue.mjs --title "..." --body-file notes.md [--label bug,agent]
 *
 * Token lookup order: GITHUB_TOKEN, GH_TOKEN, then ~/.ghtok (chmod 600 recommended).
 * Repo lookup order: --repo, then parsed from the origin remote.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? undefined : argv[i + 1];
};

const readToken = () => {
	for (const env of ["GITHUB_TOKEN", "GH_TOKEN"]) {
		const v = process.env[env];
		if (v && v.trim()) return v.trim();
	}
	try {
		return readFileSync(join(homedir(), ".ghtok"), "utf8").trim();
	} catch {
		return "";
	}
};

const repoFromOrigin = () => {
	try {
		const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
		const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
		return m ? `${m[1]}/${m[2]}` : "";
	} catch {
		return "";
	}
};

const title = value("title");
const bodyFile = value("body-file");
const body = bodyFile ? readFileSync(bodyFile, "utf8") : value("body");
const labels = (value("label") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const repo = value("repo") || repoFromOrigin();
const dryRun = flag("dry-run");

if (!title) {
	console.error("missing --title");
	process.exit(1);
}
if (!body) {
	console.error("missing --body or --body-file");
	process.exit(1);
}
if (!repo) {
	console.error("cannot determine repo: pass --repo owner/name");
	process.exit(1);
}

const token = readToken();
if (!token) {
	console.error("missing token: set GITHUB_TOKEN, GH_TOKEN, or write one to ~/.ghtok");
	process.exit(1);
}

const payload = { title, body, ...(labels.length > 0 ? { labels } : {}) };

if (dryRun) {
	console.log(`(dry-run) POST https://api.github.com/repos/${repo}/issues`);
	console.log(JSON.stringify(payload, null, 2));
	process.exit(0);
}

const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"content-type": "application/json",
		"user-agent": "new-issue.mjs",
	},
	body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
	console.error(`POST failed -> ${response.status} ${text.slice(0, 400)}`);
	process.exit(1);
}
const issue = JSON.parse(text);
console.log(`#${issue.number} ${issue.html_url}`);
