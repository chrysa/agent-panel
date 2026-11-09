// Fork addition: what the agent made and what it runs or drives, for the Made and Apps tabs.
// Fed with the main transcript's tool calls and results (Session.trackTurn), so it is as
// fresh as the transcript. Nothing here runs a command; services come from services.mjs.
//
// Made: Claude pages it published (Artifact tool), files it wrote or edited, GitHub pull
// requests, issues and releases its commands printed, and branches it pushed.
// Apps: background commands (running until their task notification), browser tabs it
// controls (Chrome extension, Playwright), and herdr panes its commands acted on.
import fs from "node:fs";
import path from "node:path";

const PAGE_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;
const GITHUB_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:(pull|issues)\/(\d+)|releases\/tag\/([\w.%-]+))/g;
const PUSHED = /^\s*[*+ ]?\s*(?:\[new branch\]|[0-9a-f]{7,}\.\.[0-9a-f]{7,}|\+?\s*[0-9a-f]{7,}\.\.\.[0-9a-f]{7,})\s+\S+\s+->\s+(\S+)/gm;
const PUSH_TARGET = /^To\s+(?:https:\/\/github\.com\/|(?:ssh:\/\/)?(?:git@)?github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m;
const BACKGROUND = /^Command (?:running in background with ID: |did not complete within its \S+ timeout and was moved to the background \(ID: )([A-Za-z0-9_-]+)/;
const OUTPUT_FILE = /Output is being written to: (\S+)/;
const HERDR_CALL = /\bherdr\s+(pane|tab|workspace|agent|plugin\s+pane)\s+([a-z][\w-]*)([^\n;&|]*)/g;
const PANE_ID = /\bw[0-9A-Za-z]+:[pt][0-9A-Za-z]+\b/g;
const TAB_LINE = /•\s*tabId\s+(\d+):\s*"([^"]*)"\s*\("([^"]*)"\)/g;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CHROME = "mcp__claude-in-chrome__";
const PLAYWRIGHT = /^mcp__(?:plugin_playwright_)?playwright__/;
const STOP_STATUS = { completed: "done", stopped: "killed" };
const QUIET_MS = 30 * 60 * 1000; // a running task whose output has not moved for this long shows as stalled

// Text from transcripts reaches the terminal: no control character (C0, DEL, C1) survives.
const clean = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
const fileTime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

export const textOfResult = (content) =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";

export class Outputs {
  constructor() {
    this.calls = new Map(); // tool_use id -> { name, input, ts }
    this.pages = new Map(); // url -> { kind: "page", value, title, ts }
    this.files = new Map(); // path -> { kind: "file", value, written, edits, ts }
    this.github = new Map(); // url or repo@branch -> { kind: "github", value, title, ts }
    this.tasks = new Map(); // id -> { kind: "task", id, value, title, status, ts, ended }
    this.tabs = new Map(); // tab id -> { kind: "browser", value, title, tool, ts }
    this.panes = new Map(); // pane id -> { kind: "pane", value, title, count, ts }
  }

  onToolUse(c, ts, cwd) {
    const input = c.input && typeof c.input === "object" ? c.input : {};
    this.calls.set(c.id, { name: c.name, input, ts });
    if (EDIT_TOOLS.has(c.name)) this.onEdit(c.name, input, ts, cwd);
    else if (c.name === "Bash") this.onCommand(String(input.command || ""), ts);
    else if (c.name.startsWith(CHROME)) this.onChrome(c.name.slice(CHROME.length), input, ts);
    else if (PLAYWRIGHT.test(c.name) && /navigate$/.test(c.name) && input.url) this.seeTab(`pw:${c.id}`, input.url, "", "Playwright", ts);
  }

  onToolResult(c, ts) {
    const call = this.calls.get(c.tool_use_id);
    if (!call) return;
    this.calls.delete(c.tool_use_id);
    const text = textOfResult(c.content);
    if (call.name === "Artifact") this.onArtifact(call.input, text, ts);
    else if (call.name === "TaskStop" && /^Successfully stopped/.test(text.trim())) {
      this.onNotification(String(call.input.task_id || call.input.shell_id || ""), "stopped", ts);
    }
    else if (call.name === "Bash") this.onBashResult(call.input, text, ts);
    else if (call.name.startsWith(CHROME)) this.onChromeResult(call.name.slice(CHROME.length), call.input, text, ts);
  }

  onNotification(id, status, ts) {
    const task = this.tasks.get(id);
    if (!task || task.ended > ts) return;
    task.status = STOP_STATUS[status] || status;
    task.ended = ts;
  }

  onEdit(name, input, ts, cwd) {
    const file = input.file_path || input.notebook_path;
    if (typeof file !== "string" || !file) return;
    const value = path.resolve(cwd || "/", file);
    const f = this.files.get(value) || { kind: "file", value, written: false, edits: 0, ts };
    if (name === "Write") f.written = true;
    f.edits++;
    f.ts = ts;
    this.files.set(value, f);
  }

  onCommand(command, ts) {
    for (const [, kind, verb, rest] of command.matchAll(HERDR_CALL)) {
      for (const id of rest.match(PANE_ID) || []) {
        const p = this.panes.get(id) || { kind: "pane", value: id, title: "", count: 0, ts };
        p.title = `${kind.replace(/\s+/g, " ")} ${verb}`;
        p.count++;
        p.ts = ts;
        this.panes.set(id, p);
      }
    }
  }

  onArtifact(input, text, ts) {
    const url = text.match(PAGE_URL)?.[0];
    if (!url || !/^Published\b/.test(text.trim())) return; // read, list, open...: not made here
    const file = typeof input.file_path === "string" ? input.file_path : "";
    const title = clean((typeof input.description === "string" && input.description) || (file ? path.basename(file) : url));
    this.pages.set(url, { kind: "page", value: url, title, ts });
  }

  onBashResult(input, text, ts) {
    const head = text.trimStart();
    const bg = head.match(BACKGROUND);
    if (bg) {
      const title = clean(String(input.description || input.command || "command").split("\n")[0]);
      const output = clean(head.match(OUTPUT_FILE)?.[1] || "");
      this.tasks.set(bg[1], { kind: "task", id: bg[1], value: output, title, status: "running", ts, ended: 0 });
    }
    for (const [url, repo, what, number, tag] of text.matchAll(GITHUB_URL)) {
      const label = what === "pull" ? `PR #${number}` : what === "issues" ? `issue #${number}` : `release ${tag}`; // tag as written: never decoded
      if (!this.github.has(url)) this.github.set(url, { kind: "github", value: url, title: clean(`${repo} ${label}`), ts });
    }
    const target = text.match(PUSH_TARGET)?.[1];
    if (target) {
      for (const [, branch] of text.matchAll(PUSHED)) {
        const value = clean(`https://github.com/${target}/tree/${branch}`);
        this.github.set(value, { kind: "github", value, title: clean(`${target} pushed ${branch}`), ts });
      }
    }
  }

  onChrome(tool, input, ts) {
    if (tool === "navigate" && input.url) this.seeTab(String(input.tabId ?? "chrome"), input.url, "", "Chrome", ts);
    if (tool === "tabs_close_mcp" && input.tabId !== undefined) this.tabs.delete(String(input.tabId));
    if (tool === "browser_batch" && Array.isArray(input.actions)) {
      for (const a of input.actions) {
        if (a?.name === "navigate" && a.input?.url) this.seeTab(String(a.input.tabId ?? "chrome"), a.input.url, "", "Chrome", ts);
      }
    }
  }

  // Chrome results end with the live tab list: titles and URLs of the tabs the agent controls.
  onChromeResult(tool, input, text, ts) {
    const seen = [...text.matchAll(TAB_LINE)];
    if (!seen.length) return;
    for (const [, id, title, url] of seen) this.seeTab(id, url, title, "Chrome", ts);
    const live = new Set(seen.map((m) => m[1]));
    for (const [id, t] of this.tabs) if (t.tool === "Chrome" && /^\d+$/.test(id) && !live.has(id)) this.tabs.delete(id);
    this.tabs.delete("chrome"); // a navigate without a tab id, now known by its id
  }

  seeTab(id, url, title, tool, ts) {
    url = clean(url);
    title = clean(title);
    const t = this.tabs.get(id) || { kind: "browser", value: url, title: "", tool, ts };
    t.value = url;
    if (title && title !== url) t.title = title;
    t.ts = Math.max(t.ts, ts);
    this.tabs.set(id, t);
  }

  // Made tab: pages, then GitHub, then files; newest first in each.
  made() {
    const newest = (a, b) => b.ts - a.ts;
    return [
      ...[...this.pages.values()].sort(newest),
      ...[...this.github.values()].sort(newest),
      ...[...this.files.values()].sort(newest),
    ];
  }

  // Apps tab without services: running tasks first, then browser tabs, panes, finished tasks.
  // A running task that wrote nothing for QUIET_MS (or whose output file is gone) shows as stalled:
  // it may have been stopped from another session file, which this one never sees.
  apps(now = Date.now(), mtime = fileTime) {
    const newest = (a, b) => b.ts - a.ts;
    for (const t of this.tasks.values()) {
      if (t.status !== "running" && t.status !== "stalled") continue;
      const last = Math.max(t.ts, (t.value && mtime(t.value)) || 0);
      t.status = now - last > QUIET_MS ? "stalled" : "running";
    }
    const tasks = [...this.tasks.values()];
    return [
      ...tasks.filter((t) => t.status === "running" || t.status === "stalled").sort(newest),
      ...[...this.tabs.values()].sort(newest),
      ...[...this.panes.values()].sort(newest),
      ...tasks.filter((t) => t.status !== "running" && t.status !== "stalled").sort((a, b) => b.ended - a.ended),
    ];
  }
}
