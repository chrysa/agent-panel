import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { ProjectSummaries, ciState, filtersOff, gitStatus, parseBranches, parsePulls, parseStatus, parseWorktrees, projectRoots, remoteSlug, repoRoot, scopeMade, summarize } from "../src/project.mjs";

const fakeFs = (gits) => (p) => gits.some((g) => p === `${g}/.git`);

test("the project is the agent's work tree, else the repos its edited files are in", () => {
  const exists = fakeFs(["/w/a", "/w/b", "/w/c", "/w/d"]);
  assert.equal(repoRoot("/w/a/src/x.py", exists), "/w/a");
  assert.deepEqual(projectRoots("/w/a/src", [], exists), ["/w/a"]);
  const files = [{ value: "/w/b/x", ts: 1 }, { value: "/w/c/y", ts: 3 }, { value: "/w/b/z", ts: 2 }, { value: "/w/d/q", ts: 0 }, { value: "/tmp/n", ts: 9 }];
  assert.deepEqual(projectRoots("/w", files, exists), ["/w/c", "/w/b", "/w/d"]);
});

test("GitHub slug from any remote form", () => {
  assert.equal(remoteSlug("git@github.com:chrysa/Agent-Panel.git"), "chrysa/agent-panel");
  assert.equal(remoteSlug("https://github.com/Optiways/padam-av"), "optiways/padam-av");
  assert.equal(remoteSlug("https://gitlab.com/x/y.git"), "");
});

test("worktrees, status and branches from git output", () => {
  const wt = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.wt/x\nHEAD def\ndetached\n";
  assert.deepEqual(parseWorktrees(wt), [{ path: "/r", branch: "main", detached: false }, { path: "/r/.wt/x", branch: "", detached: true }]);
  assert.deepEqual(parseStatus("# branch.oid x\n# branch.ab +2 -1\n1 .M N... a\n? new\n"), { changed: 2, ahead: 2, behind: 1 });
  assert.deepEqual(parseBranches("refs/heads/feat\t100\nrefs/remotes/origin/HEAD\t1\nrefs/remotes/origin/feat\t100\nrefs/tags/v1\t1\n"),
    [{ name: "feat", remote: false, ts: 100000 }, { name: "feat", remote: true, ts: 100000 }]);
});

test("pull requests: CI summary, control characters stripped, bad JSON is an error", () => {
  const pulls = parsePulls(JSON.stringify([{ number: 9, title: "feat\x1b[2J x", author: { login: "chrysa" }, isDraft: false,
    reviewDecision: "APPROVED", headRefName: "feat/x", updatedAt: "2026-11-09T10:00:00Z", url: "https://github.com/chrysa/a/pull/9",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }] }]));
  assert.deepEqual([pulls[0].title, pulls[0].ci, pulls[0].review], ["feat[2J x", "pending", "APPROVED"]);
  assert.equal(ciState([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "fail");
  assert.equal(ciState([]), "");
  assert.equal(parsePulls("not json"), null);
});

test("summary: worktrees get their PR; branches without a PR leave out the default and PR branches", () => {
  const s = summarize({
    root: "/r", defaultBranch: "main",
    pulls: [{ number: 9, branch: "feat/x" }],
    worktrees: [{ path: "/r", branch: "main" }, { path: "/r/.wt/x", branch: "feat/x" }],
    statuses: { "/r/.wt/x": { changed: 1, ahead: 0, behind: 0 } },
    branches: [{ name: "main", remote: false, ts: 3 }, { name: "feat/x", remote: true, ts: 2 }, { name: "old", remote: false, ts: 1 }, { name: "old", remote: true, ts: 1 },
      { name: "develop", remote: true, ts: 5 }, { name: "merged-one", remote: false, ts: 4 }],
    finished: new Set(["merged-one"]),
  });
  assert.equal(s.worktrees[1].pull.number, 9);
  assert.equal(s.worktrees[1].changed, 1);
  assert.deepEqual(s.branches.map((b) => [b.name, b.pushed]), [["old", true]]);
});

test("Made scoped to the project: other files and repos marked outside, pages kept", () => {
  const items = [{ kind: "file", value: "/w/a/x" }, { kind: "file", value: "/w/b/y" }, { kind: "github", repo: "chrysa/a" },
    { kind: "github", repo: "chrysa/b" }, { kind: "page", value: "https://claude.ai/artifact/1" }];
  assert.deepEqual(scopeMade(items, ["/w/a"], new Set(["chrysa/a"])).filter((x) => !x.outside).map((x) => x.value || x.repo),
    ["/w/a/x", "chrysa/a", "https://claude.ai/artifact/1"]);
  assert.deepEqual(scopeMade(items, ["/w/a"], new Set(["chrysa/a"])).filter((x) => x.outside).map((x) => x.value || x.repo), ["/w/b/y", "chrysa/b"]);
  assert.equal(scopeMade(items, [], new Set()).filter((x) => x.outside).length, 0);
});

test("filter drivers are switched off; an odd driver name skips status", () => {
  assert.deepEqual(filtersOff(null), []);
  assert.deepEqual(filtersOff("filter.lfs.clean git-lfs clean -- %f\nfilter.lfs.process git-lfs filter-process\n"),
    ["-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false"]);
  assert.equal(filtersOff("filter.a b.clean x\n"), null);
});

test("status in an untrusted repo runs nothing its config names (fsmonitor, filters)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-"));
  const marks = path.join(dir, "marks");
  fs.mkdirSync(marks);
  const git = (...args) => execFileSync("git", ["-C", path.join(dir, "repo"), ...args], { stdio: "pipe" });
  fs.mkdirSync(path.join(dir, "repo"));
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "repo", "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "x");
  git("config", "core.fsmonitor", `touch ${marks}/fsmonitor; false`);
  git("config", "filter.evil.clean", `touch ${marks}/filter; cat`);
  fs.writeFileSync(path.join(dir, "repo", ".gitattributes"), "* filter=evil\n");
  fs.writeFileSync(path.join(dir, "repo", "a.txt"), "two\n");
  try {
    git("status", "--porcelain"); // positive control: plain status runs them
    assert.ok(fs.readdirSync(marks).length > 0, "the control should have run the repo's commands");
    for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
    fs.writeFileSync(path.join(dir, "repo", "a.txt"), "three\n");
    const out = await gitStatus(path.join(dir, "repo"));
    assert.match(out, /^# branch\.oid /m);
    assert.deepEqual(fs.readdirSync(marks), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("status fails closed: when the repo's filters cannot be read, it does not run", async () => {
  const calls = [];
  const runner = (fail) => async (dir, args) => {
    calls.push(args.includes("status") ? "status" : "config");
    return args.includes("status") ? { err: null, stdout: "# branch.oid x\n" } : fail;
  };
  const tooBig = Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  assert.equal(await gitStatus("/r", runner({ err: tooBig, stdout: "filter.pad.v AAAA" })), null);
  assert.equal(await gitStatus("/r", runner({ err: Object.assign(new Error("x"), { code: 1 }), stdout: "filter.x.clean y" })), null);
  assert.deepEqual(calls, ["config", "config"]);
  assert.equal(await gitStatus("/r", runner({ err: Object.assign(new Error("none"), { code: 1 }), stdout: "" })), "# branch.oid x\n"); // no filter
});

test("no lazy fetch from a partial clone's promisor remote (its sshCommand never runs)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-"));
  const marks = path.join(dir, "marks");
  fs.mkdirSync(marks);
  const repo = path.join(dir, "repo");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "remote.origin.url", "ssh://example.invalid/x.git");
  git("config", "remote.origin.promisor", "true");
  git("config", "extensions.partialClone", "origin");
  git("config", "core.sshCommand", `touch ${marks}/ssh; false`);
  git("config", "protocol.ssh.allow", "always"); // the repo re-allowing ssh does not get past the panel
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`); // HEAD's commit is missing
  try {
    try { git("status", "--porcelain"); } catch {} // positive control: plain status fetches it, running sshCommand
    assert.ok(fs.readdirSync(marks).length > 0, "the control should have run the repo's sshCommand");
    for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
    const s = new ProjectSummaries();
    await s.read(repo, { finished: new Set(), prAt: 0 }, () => {}, Date.now());
    await gitStatus(repo);
    assert.deepEqual(fs.readdirSync(marks), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
