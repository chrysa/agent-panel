// Fork addition: the agent's project, for scoping the Made tab and for the Repo tab.
//
// The project is the git work tree of the agent's folder. When that folder is not in a
// work tree (a folder of many repos), the projects are the repos the session touched
// (files written or edited), newest first, at most MAX_REPOS.
//
// The Repo tab sums each project up, refreshed in the background so drawing never waits:
// open pull requests (`gh pr list`, every PR_EVERY_MS), worktrees and branches without a
// pull request (`git`, every GIT_EVERY_MS). Commands run with an argument list, never a
// shell; their text is stripped of control characters before it reaches the terminal.
//
// The repos come from files the agent edited, so a repo may be untrusted (an unpacked archive
// with its own .git). A repo's config can name programs that read-only git commands start:
// - any command reading a missing object of a "partial clone" fetches it from the promisor
//   remote, and that fetch runs the repo's core.sshCommand or uploadpack: every git call here
//   runs with GIT_NO_LAZY_FETCH=1 and protocol.allow=never (no transport at all);
// - `status` runs core.fsmonitor, the filter drivers (clean/process) its .gitattributes picks,
//   and the same in submodules: gitStatus() turns those off, and skips status when it cannot
//   read the repo's filters (it fails closed). No hook runs for these commands.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const MAX_REPOS = 3;
const LONG_LIVED = new Set(["main", "master", "develop", "staging", "production"]); // never "without a PR"
const PR_EVERY_MS = 30_000;
const GIT_EVERY_MS = 5_000;
export const clean = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");

const roots = new Map(); // folder -> its work tree root, or "" (cached: folders do not move)
// The work tree holding a folder or file: the nearest parent with a .git entry.
export function repoRoot(file, exists = fs.existsSync) {
  if (!file) return "";
  let dir = path.resolve(String(file));
  const start = dir;
  if (roots.has(start)) return roots.get(start);
  for (;;) {
    if (exists(path.join(dir, ".git"))) break;
    const up = path.dirname(dir);
    if (up === dir) { dir = ""; break; }
    dir = up;
  }
  roots.set(start, dir);
  return dir;
}

// The project's work trees: the agent's own, else those its edited files live in.
export function projectRoots(cwd, files = [], exists = fs.existsSync) {
  const own = repoRoot(cwd, exists);
  if (own) return [own];
  const found = [];
  for (const f of [...files].sort((a, b) => b.ts - a.ts)) {
    const root = repoRoot(f.value, exists);
    if (root && !found.includes(root)) found.push(root);
    if (found.length >= MAX_REPOS) break;
  }
  return found;
}

// "owner/repo" from a GitHub remote URL (https, ssh, scp-like), lower case; "" otherwise.
export function remoteSlug(url) {
  const m = String(url || "").trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return m ? m[1].toLowerCase() : "";
}

// `git worktree list --porcelain` -> [{ path, branch, detached }]
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: clean(line.slice(9)), branch: "", detached: false }; out.push(cur); }
    else if (cur && line.startsWith("branch ")) cur.branch = clean(line.slice(7).replace(/^refs\/heads\//, ""));
    else if (cur && line === "detached") cur.detached = true;
  }
  return out;
}

// `git status --porcelain=v2 --branch` -> { changed, ahead, behind }
export function parseStatus(text) {
  let changed = 0, ahead = 0, behind = 0;
  for (const line of String(text).split("\n")) {
    const ab = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
    if (ab) { ahead = Number(ab[1]); behind = Number(ab[2]); }
    else if (/^[12u?] /.test(line)) changed++;
  }
  return { changed, ahead, behind };
}

// `git for-each-ref --format=%(refname)%09%(committerdate:unix)` -> [{ name, remote, ts }]
export function parseBranches(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const [ref, unix] = line.split("\t");
    if (!ref) continue;
    const local = ref.startsWith("refs/heads/");
    const remote = ref.startsWith("refs/remotes/origin/");
    if (!local && !remote) continue;
    const name = clean(ref.replace(/^refs\/heads\/|^refs\/remotes\/origin\//, ""));
    if (name === "HEAD") continue;
    out.push({ name, remote, ts: Number(unix) * 1000 || 0 });
  }
  return out;
}

// One summary state for a CI rollup: "pass", "fail", "pending" or "" (no checks).
export function ciState(rollup) {
  const states = (Array.isArray(rollup) ? rollup : []).map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  if (!states.length) return "";
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "fail";
  if (states.some((s) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED", ""].includes(s))) return "pending";
  return "pass";
}

// `gh pr list --json ...` -> [{ number, title, author, draft, review, ci, branch, url, ts }]
export function parsePulls(json) {
  let list = [];
  try { list = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(list)) return null;
  return list.map((p) => ({
    number: Number(p.number) || 0,
    title: clean(p.title),
    author: clean(p.author?.login),
    draft: !!p.isDraft,
    review: clean(p.reviewDecision),
    ci: ciState(p.statusCheckRollup),
    branch: clean(p.headRefName),
    url: /^https:\/\/github\.com\//.test(p.url || "") ? clean(p.url) : "",
    ts: Date.parse(p.updatedAt) || 0,
  }));
}

// The rows of one repo's summary, given what was read.
export function summarize({ root, pulls, worktrees, statuses, branches, defaultBranch, finished = new Set() }) {
  // A branch whose PR was merged or closed is done, not forgotten.
  const prBranches = new Set([...(pulls || []).map((p) => p.branch), ...finished]);
  const worktreeBranches = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const seen = new Set();
  const lonely = [];
  for (const b of [...branches].sort((a, b2) => b2.ts - a.ts)) {
    if (b.name === defaultBranch || LONG_LIVED.has(b.name) || prBranches.has(b.name) || seen.has(b.name)) continue;
    seen.add(b.name);
    const pushed = branches.some((x) => x.remote && x.name === b.name);
    lonely.push({ name: b.name, pushed, inWorktree: worktreeBranches.has(b.name), ts: b.ts });
  }
  return {
    root,
    pulls: pulls || [],
    worktrees: worktrees.map((w) => ({ ...w, ...(statuses[w.path] || { changed: 0, ahead: 0, behind: 0 }),
      pull: (pulls || []).find((p) => p.branch && p.branch === w.branch) || null })),
    branches: lonely,
  };
}

// -> { err, stdout }: err is null, or execFile's error (its `code`: the exit code, or a string
// such as ERR_CHILD_PROCESS_STDIO_MAXBUFFER).
const exec = (cmd, args, cwd, env) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: String(stdout ?? "") }));
});
const run = async (cmd, args, cwd) => { const r = await exec(cmd, args, cwd); return r.err ? null : r.stdout; };
// Read-only git in a repo that may be untrusted: no lazy fetch, no transport, no prompt.
const GIT_ENV = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
const runGit = (dir, args) => exec("git", ["-C", dir, "-c", "protocol.allow=never", ...args], dir, GIT_ENV);
const git = async (dir, args) => { const r = await runGit(dir, args); return r.err ? null : r.stdout; };

// The filter drivers a repo's config defines (reading config starts nothing), each switched
// off with `-c`; null when a driver's name could not be passed safely (status is then skipped).
export function filtersOff(configText) {
  const names = new Set();
  for (const line of String(configText || "").split("\n")) {
    const m = line.match(/^filter\.(.+?)\.(?:clean|smudge|process|required)\s/i);
    if (m) names.add(m[1]);
  }
  if ([...names].some((n) => !/^[\w.-]+$/.test(n))) return null;
  return [...names].flatMap((n) => ["-c", `filter.${n}.clean=`, "-c", `filter.${n}.smudge=`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`]);
}

// `git status --porcelain=v2 --branch` in a work tree, with nothing the repo's config names run;
// null when it did not run. Reading the filters must succeed, or end with exit 1 and no output
// (no filter): any other failure (output past maxBuffer, timeout...) skips status.
export async function gitStatus(dir, runner = runGit) {
  const cfg = await runner(dir, ["config", "--get-regexp", "^filter\\."]);
  const none = cfg.err?.code === 1 && !cfg.stdout;
  if (cfg.err && !none) return null;
  const off = filtersOff(none ? "" : cfg.stdout);
  if (!off) return null;
  const st = await runner(dir, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...off,
    "status", "--porcelain=v2", "--branch", "--ignore-submodules=all"]);
  return st.err ? null : st.stdout;
}

// Background reader of the summaries; summaries(roots, onChange) never blocks.
export class ProjectSummaries {
  constructor() {
    this.repos = new Map(); // root -> { slug, defaultBranch, pulls, ghError, worktrees, statuses, branches, gitAt, prAt, busy }
  }

  summaries(rootsList, onChange, now = Date.now()) {
    for (const root of rootsList) {
      let r = this.repos.get(root);
      if (!r) {
        r = { slug: "", defaultBranch: "", pulls: null, finished: new Set(), ghError: false, worktrees: [], statuses: {}, branches: [], gitAt: 0, prAt: 0, busy: false };
        this.repos.set(root, r);
      }
      if (!r.busy && (now - r.gitAt > GIT_EVERY_MS || (r.slug && now - r.prAt > PR_EVERY_MS))) this.read(root, r, onChange, now).catch(() => {}); // read() never throws; its finally redraws
    }
    return rootsList.map((root) => {
      const r = this.repos.get(root);
      return { ...summarize({ root, pulls: r.pulls, worktrees: r.worktrees, statuses: r.statuses, branches: r.branches, defaultBranch: r.defaultBranch, finished: r.finished }),
        slug: r.slug, ghError: r.ghError, loading: !r.gitAt };
    });
  }

  async read(root, r, onChange, now) {
    r.busy = true;
    try {
      const [remote, head, list, refs] = await Promise.all([
        git(root, ["config", "--get", "remote.origin.url"]),
        git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
        git(root, ["worktree", "list", "--porcelain"]),
        git(root, ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)", "refs/heads", "refs/remotes/origin"]),
      ]);
      r.slug = remoteSlug(remote);
      r.defaultBranch = clean((head || "").trim().replace(/^origin\//, "")) || "main";
      r.worktrees = parseWorktrees(list || "");
      r.branches = parseBranches(refs || "");
      const statuses = {};
      await Promise.all(r.worktrees.map(async (w) => {
        const s = await gitStatus(w.path);
        if (s !== null) statuses[w.path] = parseStatus(s);
      }));
      r.statuses = statuses;
      r.gitAt = Date.now();
      if (r.slug && now - r.prAt > PR_EVERY_MS) {
        const json = await run("gh", ["pr", "list", "--repo", r.slug, "--state", "open", "--limit", "50", "--json",
          "number,title,author,isDraft,reviewDecision,statusCheckRollup,headRefName,updatedAt,url"], root);
        const pulls = json === null ? null : parsePulls(json);
        r.ghError = pulls === null;
        if (pulls) r.pulls = pulls;
        const done = await run("gh", ["pr", "list", "--repo", r.slug, "--state", "all", "--limit", "300", "--json", "headRefName,state"], root);
        try { r.finished = new Set(JSON.parse(done || "[]").filter((p) => p.state !== "OPEN").map((p) => clean(p.headRefName))); } catch {}
        r.prAt = Date.now();
      }
    } finally {
      r.busy = false;
      onChange();
    }
  }
}

// Made scoped to the project: files outside its work trees and GitHub items of other repos are
// marked `outside` (the panel folds them away); published pages are not tied to a repo.
// With no project, nothing is outside.
export function scopeMade(items, rootsList, slugs) {
  if (!rootsList.length) return items;
  const inside = (file) => rootsList.some((root) => file === root || file.startsWith(root + "/"));
  const mine = (x) => (x.kind === "file" ? inside(x.value) : x.kind === "github" ? !slugs.size || slugs.has(x.repo) : true);
  return items.map((x) => (mine(x) ? x : { ...x, outside: true }));
}
