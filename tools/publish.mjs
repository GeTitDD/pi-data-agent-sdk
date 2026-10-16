#!/usr/bin/env node
/**
 * publish.mjs — push the current commit to GitHub via the Git Data API.
 *
 * WHY: in this environment `git push` cannot reach github.com:443 (TLS/connect failures
 * from both WSL and Windows git), while api.github.com is reachable. So we rebuild the
 * commit object over HTTP instead of using the git transport.
 *
 * Usage:
 *   GH_TOKEN=<token> node tools/publish.mjs [--branch main] [--dry-run]
 * (Get a token with:  gh auth token --user <account> )
 *
 * Guarantees: the pushed commit has the SAME sha as the local HEAD when the metadata
 * round-trips exactly (tree, message with trailing newline, author/committer with offset).
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const branch = args.includes("--branch") ? args[args.indexOf("--branch") + 1] : "main";
const dryRun = args.includes("--dry-run");

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (() => {
  try { return readFileSync(`${process.env.HOME}/.ghtok`, "utf8").trim(); } catch { return ""; }
})();
if (!token) { console.error("missing GH_TOKEN"); process.exit(1); }

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const g = (...a) => execFileSync("git", ["-c", `safe.directory=${process.cwd()}`, ...a], { env }).toString();

// derive owner/repo from the origin remote
const url = g("remote", "get-url", "origin").trim();
const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
if (!m) { console.error(`cannot parse origin url: ${url}`); process.exit(1); }
const [, owner, repo] = m;
const api = `https://api.github.com/repos/${owner}/${repo}`;
const H = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
            "user-agent": "publish.mjs", "content-type": "application/json" };
async function gh(url, method = "GET", body) {
  const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`${method} ${url} -> ${r.status} ${t.slice(0,200)}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}

const head = g("rev-parse", "HEAD").trim();
const parent = (() => { try { return g("rev-parse", "HEAD^").trim(); } catch { return null; } })();
const raw = g("cat-file", "commit", "HEAD");
const message = raw.slice(raw.indexOf("\n\n") + 2);          // exact, keeps trailing newline
const ident = (kind, fmt) => ({
  name: g("log", "-1", `--format=%${fmt}n`).trim(),
  email: g("log", "-1", `--format=%${fmt}e`).trim(),
  date: g("log", "-1", `--format=%${fmt}I`).trim(),           // ISO 8601 WITH timezone offset
});
void raw;

// 1) an empty repo cannot accept blobs -> bootstrap via the Contents API
try { await gh(`${api}/git/ref/heads/${branch}`); }
catch (e) {
  if (e.status !== 404) throw e;
  if (dryRun) { console.log("(dry-run) would bootstrap empty repository"); process.exit(0); }
  await gh(`${api}/contents/README.md`, "PUT", { message: "chore: bootstrap repository", branch,
    content: readFileSync("README.md").toString("base64") });
  console.log("bootstrapped empty repository");
}

// 2) upload blobs + build tree
const files = g("ls-files").trim().split("\n").filter(Boolean);
const tree = [];
for (const f of files) {
  const blob = await gh(`${api}/git/blobs`, "POST", { content: readFileSync(f).toString("base64"), encoding: "base64" });
  tree.push({ path: f, mode: "100644", type: "blob", sha: blob.sha });
}
console.log(`files: ${files.length}`);

// 3) create the commit (exact metadata -> same sha)
const commitBody = {
  message,
  tree: (await gh(`${api}/git/trees`, "POST", { tree })).sha,
  author:    ident("author", "a"),
  committer: ident("committer", "c"),
  ...(parent ? { parents: [parent] } : {}),
};
if (dryRun) { console.log("(dry-run) would push commit", head); process.exit(0); }
const commit = await gh(`${api}/git/commits`, "POST", commitBody);
await gh(`${api}/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha, force: true });
console.log(commit.sha === head ? `pushed ${head} (sha identical ✓)` : `pushed ${commit.sha} (local ${head} - metadata differed)`);
