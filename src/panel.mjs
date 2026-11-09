// Side panel for the Claude Code session in this tab, with four tabs:
//   Subagents — its subagents; Enter/click switches Claude to that subagent, m back to main
//   Messages  — your messages and Claude's, in order; Enter/click shows one in full in a popup, Space expands it here
//   Refs      — URLs and files Claude mentioned, by message; Enter/click opens one, y copies it
//   To do     — what Claude says you still have to do (its latest ACTION: list); x checks one off, Enter/click shows where it asked
//   Made      — (fork) pages it published, GitHub PRs/releases/pushes, files it wrote; Enter/click opens, y copies
//   Apps      — (fork) project services, background commands, browser tabs and herdr panes it drives; Enter/click opens
//   Repo      — (fork) the project's open pull requests, worktrees and branches without a PR; Enter/click opens
// Made is scoped to the project (the agent's git work tree, else the repos the session touched).
// Tab, ←/→, 1–7 or a click on the tab bar switches tabs. j/k move, q closes the panel in this tab.
// The transcript is watched: a new line redraws at once (the 1 s timer is the fallback).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LABEL, PLUGIN_ID, PLUGIN_LABELS, STATE_DIR, herdr, isAgentPane, setDismissed, snapshot } from "./lib.mjs";
import { createSession, paneSession, readConversation } from "./providers.mjs";
import { viewInClaude } from "./jump.mjs";
import { fitLine, headerLines, markShown, unmarkShown } from "./header.mjs";
import { displayPath } from "./refs.mjs";
import { openingTab, tabAt } from "./tabs.mjs";
import { serviceItems } from "./services.mjs";
import { MODE, fileIcon, githubIcon, icon } from "./icons.mjs";
import { ProjectSummaries, projectRoots, scopeMade } from "./project.mjs";
import { WHO, c, plain, width, fit, fitMiddle, wrap, dur, ago, firstLine, spread, copyText } from "./text.mjs";

const out = process.stdout;
const RECENT_MS = 30 * 60 * 1000;
const TAB_FILE = path.join(STATE_DIR, "tab");
const ICON = {
  running: `${c.yellow}●${c.reset}`, done: `${c.green}✓${c.reset}`, failed: `${c.red}✗${c.reset}`,
  killed: `${c.dim}⊘${c.reset}`, stalled: `${c.magenta}◌${c.reset}`,
};
const ORDER = { running: 0, stalled: 1, failed: 2, killed: 3, done: 4 };

// ---------- state ----------

let tracked = null; // { paneId, sessionId, cwd, status }
let session = null;
const TABS = ["subagents", "messages", "refs", "todo", "made", "apps", "repo"];
const savedTab = () => { try { const t = fs.readFileSync(TAB_FILE, "utf8").trim(); return TABS.includes(t) ? t : TABS[0]; } catch { return TABS[0]; } };
let tab = savedTab(); // the shown tab; openingTab() may differ from the saved one for a new session
let refs = []; // what the Refs tab lists: by the Claude message that mentions them, newest first
let todos = []; // what the To do tab lists: Claude's latest list, in its order, the ones you checked off last
let made = []; // fork: what the Made tab lists (Outputs.made)
let apps = []; // fork: what the Apps tab lists (services, then Outputs.apps)
let repoItems = []; // fork: what the Repo tab lists (pull requests, worktrees, branches without a PR, per repo)
let projectRootsNow = []; // fork: the project's work trees
const projects = new ProjectSummaries();
// Checked-off to-dos: { [sessionId]: [todo id] }.
const DONE_FILE = path.join(STATE_DIR, "todo-done.json");
const readDone = () => { try { return JSON.parse(fs.readFileSync(DONE_FILE, "utf8")); } catch { return {}; } };
const views = {
  messages: { cursor: -1, scroll: 0, expanded: new Set(), follow: true },
  subagents: { cursor: 0, scroll: 0, expanded: new Set() },
  refs: { cursor: 0, scroll: 0, expanded: new Set() },
  todo: { cursor: 0, scroll: 0, expanded: new Set() },
  made: { cursor: 0, scroll: 0, expanded: new Set() },
  apps: { cursor: 0, scroll: 0, expanded: new Set() },
  repo: { cursor: 0, scroll: 0, expanded: new Set() },
};
let showAll = false;
const FINISHED_FILE = path.join(STATE_DIR, "finished-collapsed");
let finishedCollapsed = (() => { try { return fs.readFileSync(FINISHED_FILE, "utf8").trim() !== "0"; } catch { return true; } })();
let finishedCount = 0;
let agents = []; // what the Subagents tab lists (finished ones left out while collapsed)
let screenRows = []; // screen row (1-based) -> item index, for clicks
let tabHits = []; // [{ from, to, tab }] columns on the tab bar
let tabRow = 1; // the tab bar's screen row (1-based), below the header lines
let flash = "", flashUntil = 0;
let busy = false;
let detail = null; // { agent, items, stamp, scroll } — a subagent's conversation shown in the panel

const NO_AGENT_GRACE_MS = 5000;
let noAgentSince = 0;

// Which Claude agent to show: the focused pane when it's in this tab, else the
// last one shown, else the first Claude pane in this tab.
function pickAgent() {
  if (process.env.SA_SESSION) { // testing outside herdr
    session ||= createSession(process.env.SA_SESSION, process.env.SA_PROVIDER);
    tracked = { cwd: process.env.SA_CWD || "", status: "idle" };
    return;
  }
  const snap = snapshot();
  if (!snap) return;
  const panes = snap.panes || [];
  const me = panes.find((p) => p.label === LABEL);
  const myTab = me?.tab_id;
  // The pane it sat beside was closed and only plugin panels are left: go with it.
  if (me && !panes.some((p) => p.tab_id === myTab && !PLUGIN_LABELS.has(p.label))) {
    herdr(["pane", "close", me.pane_id]);
    return quit();
  }
  // Claude quit in this tab: after a grace period (detection can blink), go too.
  if (me && !panes.some((p) => p.tab_id === myTab && isAgentPane(p))) {
    noAgentSince ||= Date.now();
    if (Date.now() - noAgentSince > NO_AGENT_GRACE_MS) {
      herdr(["pane", "close", me.pane_id]);
      return quit();
    }
  } else noAgentSince = 0;
  const isEligible = (p) => p && p.tab_id === myTab && isAgentPane(p) && p.agent_session?.value;
  const focused = panes.find((p) => p.pane_id === snap.focused_pane_id);
  const still = tracked && panes.find((p) => p.pane_id === tracked.paneId);
  const pick = isEligible(focused) ? focused : isEligible(still) ? still : panes.find(isEligible);
  if (!pick) { tracked = null; session = null; markShown(""); return; }
  // The session on screen, which differs from herdr's record after Claude's ← agent view switches it,
  // and after a resume that carried on in a new transcript.
  const sessionId = paneSession(pick, pickAgent);
  if (sessionId !== session?.sessionId || pick.agent !== session?.provider) {
    session = createSession(sessionId, pick.agent);
    views.messages = { cursor: -1, scroll: 0, expanded: new Set(), follow: true };
    views.subagents = { cursor: 0, scroll: 0, expanded: new Set() };
    views.refs = { cursor: 0, scroll: 0, expanded: new Set() };
    views.todo = { cursor: 0, scroll: 0, expanded: new Set() };
    views.made = { cursor: 0, scroll: 0, expanded: new Set() };
    views.apps = { cursor: 0, scroll: 0, expanded: new Set() };
    views.repo = { cursor: 0, scroll: 0, expanded: new Set() };
    refresh();
    tab = openingTab(savedTab(), { subagents: agents.length + finishedCount, todos: todos.filter((t) => !t.done).length });
  }
  tracked = { paneId: pick.pane_id, sessionId, cwd: pick.cwd, status: pick.agent_status };
  markShown(pick.pane_id);
}

// Keep the cursor on the same item (by key) when a list is rebuilt.
function keepCursor(view, before, after, key) {
  const at = before[view.cursor] ? key(before[view.cursor]) : null;
  const i = at === null ? -1 : after.findIndex((x) => key(x) === at);
  view.cursor = i >= 0 ? i : Math.min(view.cursor, Math.max(0, after.length - 1));
}
const itemKey = (x) => `${x.kind}:${x.id || x.value}:${x.title}`;

// Real time: the transcript and the subagents folder are watched, so a new line redraws at once.
let watched = "";
let watchers = [];
let soon = null;
function watchSession() {
  const file = session?.mainFile || "";
  if (file === watched) return;
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
  watched = file;
  if (!file) return;
  const changed = () => {
    if (soon) return;
    soon = setTimeout(() => { soon = null; refresh(); render(); }, 40);
  };
  for (const target of [file, session.dir]) {
    try { if (target) watchers.push(fs.watch(target, changed)); } catch {}
  }
}

function refresh() {
  if (!session) { agents = []; refs = []; todos = []; made = []; apps = []; repoItems = []; return; }
  session.refresh();
  watchSession();
  const outs = session.outputs;
  // Fork: the project, its summaries, and Made scoped to it (grouped by repo when several).
  projectRootsNow = projectRoots(tracked?.cwd || session.cwd || "", outs ? [...outs.files.values()] : []);
  const summaries = projects.summaries(projectRootsNow, render);
  const slugs = new Set(summaries.map((s) => s.slug).filter(Boolean));
  const several = projectRootsNow.length > 1;
  const rootOf = (file) => projectRootsNow.find((root) => file === root || file.startsWith(root + "/"));
  const order = (x) => (x.kind === "file" && several ? projectRootsNow.indexOf(rootOf(x.value)) : -1);
  const nextMade = scopeMade(outs ? outs.made() : [], projectRootsNow, slugs)
    .map((x) => (several && x.kind === "file" ? { ...x, group: path.basename(rootOf(x.value) || "") } : x))
    .map((x, n) => ({ x, n })) // files of one repo together (in the project's order), newest first inside
    .sort((a, b) => (a.x.kind === "file" && b.x.kind === "file" ? order(a.x) - order(b.x) || a.n - b.n : a.n - b.n))
    .map(({ x }) => x);
  const nextRepo = repoItemsOf(summaries);
  keepCursor(views.repo, repoItems, nextRepo, itemKey);
  repoItems = nextRepo;
  keepCursor(views.made, made, nextMade, itemKey);
  made = nextMade;
  const nextApps = [...serviceItems(tracked, session, render), ...(outs ? outs.apps() : [])];
  keepCursor(views.apps, apps, nextApps, itemKey);
  apps = nextApps;
  // Keep the cursor on the same ref when a new mention reorders the list.
  const at = refs[views.refs.cursor]?.value;
  refs = [...session.refs.values()].sort((a, b) => b.msg - a.msg || a.order - b.order);
  const keep = refs.findIndex((r) => r.value === at);
  views.refs.cursor = keep >= 0 ? keep : Math.min(views.refs.cursor, Math.max(0, refs.length - 1));
  const doneIds = new Set(readDone()[session.sessionId] || []);
  const atTodo = todos[views.todo.cursor]?.id;
  todos = session.todos.map((t) => ({ ...t, done: doneIds.has(t.id) }))
    .sort((a, b) => Number(a.done) - Number(b.done)); // stable: Claude's order otherwise
  const keepTodo = todos.findIndex((t) => t.id === atTodo);
  views.todo.cursor = keepTodo >= 0 ? keepTodo : Math.min(views.todo.cursor, Math.max(0, todos.length - 1));
  const now = Date.now();
  agents = session.list(now)
    .filter((a) => showAll || a.status === "running" || a.status === "stalled" || now - (a.ended || now) < RECENT_MS)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.ended || b.started) - (a.ended || a.started));
  const live = (a) => a.status === "running" || a.status === "stalled";
  finishedCount = agents.filter((a) => !live(a)).length;
  if (finishedCollapsed) agents = agents.filter(live);
  const m = views.messages, n = session.messages.length;
  if (m.follow || m.cursor < 0) m.cursor = n - 1; // newest message, like a chat
  m.cursor = Math.min(m.cursor, n - 1);
  views.subagents.cursor = Math.min(views.subagents.cursor, Math.max(0, agents.length - 1));
}

const LISTS = { refs: () => refs, todo: () => todos, made: () => made, apps: () => apps, repo: () => repoItems };
const items = () => (tab === "messages" ? session?.messages || [] : LISTS[tab] ? LISTS[tab]() : agents);

// ---------- views ----------

// Your messages and Claude's, in order. Each: a line with who, what it did and when, then the
// text at full width (3 rows, or all of it when expanded). The selected one gets a bar in the margin.
// Markdown syntax costs columns in a 3-row preview: drop fences, emphasis, backticks and heading marks.
const unmark = (s) => s.replace(/^```\w*$/gm, "").replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "· ");
// A message's rows (header, then body), cached: re-wrapping every message on every frame made
// scrolling a long session lag. Rebuilt only when what it shows changes.
const rowCache = new WeakMap(); // message -> { key, rows }
function messageBlock(m, w, expanded, time) {
  const results = expanded || !m.text ? m.actions.map((a) => a.result[0]).join("") : "";
  const key = `${w}|${expanded}|${time}|${m.text.length}|${m.actions.length}|${m.edits}${m.cmds}${m.errors}|${results}`;
  const hit = rowCache.get(m);
  if (hit?.key === key) return hit.rows;
  // What its tool calls did, in words ("2 edits · 4 cmds · 1 failed"), or as
  // symbols ("✎2 $4 ✗1") when the words don't fit next to the time.
  const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const say = [
    m.edits ? `${c.cyan}${count(m.edits, "edit")}${c.reset}` : "",
    m.cmds ? `${c.dim}${count(m.cmds, "cmd")}${c.reset}` : "",
    m.errors ? `${c.red}${m.errors} failed${c.reset}` : "",
  ].filter(Boolean);
  const brief = [
    m.edits ? `${c.cyan}✎${m.edits}${c.reset}` : "",
    m.cmds ? `${c.dim}$${m.cmds}${c.reset}` : "",
    m.errors ? `${c.red}✗${m.errors}${c.reset}` : "",
  ].filter(Boolean).join(" ");
  let head = `${WHO[m.role]}${say.length ? "  " + say.join(`${c.dim} · ${c.reset}`) : ""}`;
  if (width(head) + width(time) + 1 > w) head = `${WHO[m.role]}${brief ? "  " + brief : ""}`;
  const rows = [spread(head, time, w)];
  if (expanded) {
    rows.push(...wrap(m.text, w).slice(0, 80));
    if (m.actions.length) {
      if (m.text) rows.push("");
      for (const a of m.actions.slice(-12)) {
        const r = a.result === "ok" ? `${c.green}✓${c.reset}` : a.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
        rows.push(`${r} ${c.dim}${fit(`${a.name} ${a.summary}`, w - 2)}${c.reset}`);
      }
    }
  } else if (m.text) {
    // 3 rows never hold more than 3w characters, so wrap just the start of a long message.
    const lines = wrap(unmark(m.text.slice(0, w * 5)).replace(/\s+/g, " "), w);
    if (lines.length > 3) lines.splice(2, Infinity, fit(lines.slice(2).join(" "), w));
    rows.push(...lines);
  } else {
    const n = m.actions.length, last = m.actions.at(-1);
    rows.push(`${c.dim}${c.italic}${n} tool call${n === 1 ? "" : "s"}${last ? ` · ${fit(`${last.name} ${last.summary}`, w - 16)}` : ""}${c.reset}`);
  }
  rowCache.set(m, { key, rows });
  return rows;
}

function messageRows(w, now) {
  const v = views.messages;
  const rows = [];
  const msgs = session?.messages || [];
  msgs.forEach((m, i) => {
    if (m.role === "you" && rows.length) rows.push({ text: "", i: -1 });
    const live = i === msgs.length - 1 && tracked?.status === "working";
    const time = live ? `${c.yellow}working…${c.reset}` : `${c.dim}${ago(now - m.ts)}${c.reset}`;
    for (const text of messageBlock(m, w, v.expanded.has(i), time)) rows.push({ text, i });
  });
  if (!msgs.length) rows.push({ text: `${c.dim}  ${session ? "No messages yet" : "No supported agent session in this tab"}${c.reset}`, i: -1 });
  return rows;
}

function subagentRows(w, now) {
  const v = views.subagents;
  const rows = [];
  const live = (a) => a.status === "running" || a.status === "stalled";
  const nLive = agents.filter(live).length;
  // Section headers, so finished agents aren't mistaken for running ones. Finished folds (f or click).
  const finishedHeader = () => {
    if (rows.length) rows.push({ text: "", i: -1 });
    const arrow = finishedCollapsed ? "▸" : "▾";
    rows.push({ text: `${c.dim}${arrow} FINISHED · ${showAll ? "all" : "last 30 min"} · ${finishedCount}${c.reset}`, i: "finished" });
  };
  if (session) rows.push({ text: `${c.dim}RUNNING · ${nLive || "none"}${c.reset}`, i: -1 });
  agents.forEach((a, i) => {
    if (!live(a) && (i === 0 || live(agents[i - 1]))) finishedHeader();
    const mark = " "; // the selection is a bar in the margin (draw)
    const time = a.status === "running" ? dur(now - a.started) : a.status === "stalled" ? `quiet ${dur(a.idleFor).split(" ")[0]}` : ago(now - a.ended);
    const title = fit(a.description, w - width(time) - 5);
    rows.push({ text: spread(`${mark} ${ICON[a.status] || "?"} ${a.status === "running" ? c.bold : ""}${title}${c.reset}`, `${c.dim}${time}${c.reset}`, w), i });
    rows.push({ text: `    ${c.dim}${fit(`${a.type} · ${a.toolCount} tools${a.status !== "running" && a.ended ? ` · took ${dur(a.ended - a.started)}` : ""}`, w - 4)}${c.reset}`, i });
    if (a.progress && (a.status === "running" || a.status === "stalled")) {
      const p = a.progress;
      const barW = Math.min(12, Math.max(6, Math.floor(w / 5)));
      const bar = p.percent !== undefined
        ? `${c.green}${"▰".repeat(Math.round((p.percent / 100) * barW))}${c.dim}${"▱".repeat(barW - Math.round((p.percent / 100) * barW))}${c.reset} `
        : "";
      const count = p.total ? `${p.done}/${p.total} ` : p.percent !== undefined ? `${p.percent}% ` : "";
      rows.push({ text: `    ${bar}${c.bold}${count}${c.reset}${fit(p.step, Math.max(8, w - 6 - barW - width(count)))}`, i });
    }
    if (a.current) rows.push({ text: `    ${c.cyan}↳${c.reset} ${fit(`${a.current.name} ${a.current.summary}`, w - 6)}`, i });
    if (v.expanded.has(a.id)) {
      for (const act of a.actions.slice(-8)) {
        const r = act.result === "ok" ? `${c.green}✓${c.reset}` : act.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
        rows.push({ text: `      ${r} ${c.dim}${fit(`${act.name} ${act.summary}`, w - 8)}${c.reset}`, i });
      }
      const text = a.status === "running" ? a.lastText : a.lastText || a.task;
      if (text) {
        rows.push({ text: "", i });
        for (const line of wrap(text, w - 6).slice(0, 10)) rows.push({ text: `      ${c.italic}${line}${c.reset}`, i });
      }
    }
    rows.push({ text: "", i });
  });
  if (finishedCount && finishedCollapsed) finishedHeader();
  if (!session) rows.push({ text: `${c.dim}  No supported agent session in this tab${c.reset}`, i: -1 });
  else if (!agents.length && !finishedCount) rows.push({ text: `${c.dim}  ${showAll ? "No subagents in this session" : "None in the last 30 min — a shows all"}${c.reset}`, i: -1 });
  return rows;
}

// Grouped under the Claude message that mentions them, newest first; a click on the group's
// header shows that message in full.
function refRows(w, now) {
  const v = views.refs;
  const rows = [];
  const cwd = tracked?.cwd || session?.cwd || "";
  let group = -1;
  refs.forEach((r, i) => {
    if (r.msg !== group) {
      if (rows.length) rows.push({ text: "", i: -1 });
      const m = session.messages[r.msg];
      const time = `${c.dim}${ago(now - (m?.ts || r.ts))}${c.reset}`;
      const title = `${c.orange}●${c.reset} ${c.dim}${fit(firstLine(m?.text).replace(/\*\*|`/g, ""), w - width(time) - 4)}${c.reset}`;
      rows.push({ text: spread(title, time, w), i: `msg:${r.msg}` });
      group = r.msg;
    }
    const mark = " "; // the selection is a bar in the margin (draw)
    let stat = null;
    if (r.kind === "file") try { stat = fs.statSync(r.value); } catch {}
    const missing = r.kind === "file" && !stat;
    const edited = r.kind === "file" && session.edited.has(r.value);
    const pict = r.kind === "url" ? icon("url") : fileIcon(r.value, { dir: !!stat?.isDirectory() });
    const glyph = missing ? `${c.dim}?${c.reset}` : pict ? `${r.kind === "url" ? c.cyan : c.dim}${pict.trim()}${c.reset}`
      : r.kind === "url" ? `${c.cyan}↗${c.reset}` : `${c.dim}▤${c.reset}`;
    const right = edited ? `${c.cyan}✎${c.reset}` : "";
    const name = r.kind === "url" ? r.value.replace(/^https?:\/\//, "") : displayPath(r.value, cwd) + (stat?.isDirectory() ? "/" : "") + (r.line ? `:${r.line}` : "");
    const title = fitMiddle(name, w - width(right) - 5);
    const style = missing ? c.dim : "";
    rows.push({ text: spread(`${mark} ${glyph} ${style}${title}${c.reset}`, right, w), i });
    if (v.expanded.has(r.value)) {
      for (const line of wrap(r.value, w - 6).slice(0, 4)) rows.push({ text: `      ${line}`, i });
      if (missing) rows.push({ text: `      ${c.dim}not on disk${c.reset}`, i });
    }
  });
  if (!refs.length) rows.push({ text: `${c.dim}  ${session ? "The agent hasn't mentioned any URLs or files yet" : "No supported agent session in this tab"}${c.reset}`, i: -1 });
  return rows;
}

// Claude's current list: open items, then the ones you checked off. Each: up to 3 rows of the request,
// with when Claude first asked in the margin of the first.
function todoRows(w, now) {
  const v = views.todo;
  const rows = [];
  let section = null;
  todos.forEach((t, i) => {
    if (t.done !== section) {
      if (rows.length) rows.push({ text: "", i: -1 });
      const n = todos.filter((x) => x.done === t.done).length;
      const head = `${c.dim}${t.done ? "DONE" : "OPEN"} · ${n}${c.reset}`;
      rows.push({ text: rows.length ? head : spread(head, `${c.dim}list from ${ago(now - session.todoTs)}${c.reset}`, w), i: -1 });
      section = t.done;
    }
    const mark = " "; // the selection is a bar in the margin (draw)
    const icon = t.done ? `${c.green}✓${c.reset}` : `${c.yellow}○${c.reset}`;
    const time = `${c.dim}${ago(now - t.ts)}${c.reset}`;
    const text = t.text.replace(/\*\*|`/g, "");
    const lines = wrap(text, w - 4);
    if (lines.length > 3) lines.splice(2, Infinity, fit(lines.slice(2).join(" "), w - 4));
    const style = t.done ? c.dim : "";
    lines.forEach((line, n) => {
      const row = `${n ? "   " : `${mark}${icon} `} ${style}${line}${c.reset}`;
      rows.push({ text: n === 0 && width(row) + width(time) + 1 <= w ? spread(row, time, w) : row, i });
    });
    if (width(`${mark}${icon}  ${lines[0]}`) + width(time) + 1 > w) rows.push({ text: `    ${time}`, i });
  });
  if (!todos.length) {
    const cleared = session?.todoMsg >= 0;
    rows.push({ text: `${c.dim}  ${!session ? "No supported agent session in this tab" : cleared ? `Nothing left to do · ${ago(now - session.todoTs)}` : "The agent hasn't asked you for anything"}${c.reset}`, i: -1 });
    if (session && !cleared) rows.push({ text: `${c.dim}  (it lists requests as ACTION: lines, see README)${c.reset}`, i: -1 });
  }
  return rows;
}

// Fork: Made and Apps rows. One line each: an icon, the title, its age; Space shows the full value.
const ITEM_COLOR = { page: c.cyan, github: c.magenta, browser: c.cyan, pane: c.blue };
const ITEM_ICON = {
  page: `${c.cyan}◆${c.reset}`, github: `${c.magenta}⎇${c.reset}`, file: `${c.dim}▤${c.reset}`,
  service: null, task: null, browser: `${c.cyan}◎${c.reset}`, pane: `${c.blue}▣${c.reset}`,
};
const SECTION = {
  page: "PAGES", github: "GITHUB", file: "FILES", service: "SERVICES", task: "BACKGROUND",
  browser: "BROWSER", pane: "HERDR PANES",
};
const SECTION_ICON = { page: "page", github: "github", file: "files", service: "service", task: "task", browser: "browser", pane: "pane" };
// Fork: the item's own pictogram (file by extension, PR/issue/release/push...), "" when they are off.
function kindIcon(x) {
  if (x.kind === "file") return fileIcon(x.value);
  if (x.kind === "github") return githubIcon(x.title);
  if (x.kind === "browser") return icon(x.tool === "Playwright" ? "playwright" : "browser");
  return icon(x.kind);
}
function itemRows(list, view, w, now, empty) {
  const rows = [];
  const cwd = tracked?.cwd || session?.cwd || "";
  let section = null;
  list.forEach((x, i) => {
    const live = (y) => y.status === "running" || y.status === "stalled";
    const groupOf = (y) => (y.kind === "task" ? (live(y) ? "task" : "task-done") : y.group ? `${y.kind}:${y.group}` : y.kind);
    const group = groupOf(x);
    if (group !== section) {
      if (rows.length) rows.push({ text: "", i: -1 });
      const n = list.filter((y) => groupOf(y) === group).length;
      const pict = group === "task-done" ? icon("finished") : icon(SECTION_ICON[x.kind]);
      const label = group === "task-done" ? "FINISHED" : `${SECTION[x.kind]}${x.group ? ` · ${x.group}` : ""}`;
      rows.push({ text: `${c.dim}${pict}${label} · ${n}${c.reset}`, i: -1 });
      section = group;
    }
    const pict = kindIcon(x);
    const state = x.kind === "service" ? (x.up ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`)
      : x.kind === "task" ? ICON[x.status] || ICON.done
      : x.kind === "file" ? (x.written ? `${c.green}✚${c.reset}` : `${c.cyan}✎${c.reset}`)
      : null;
    // A state glyph (meaning without colour) then the pictogram; kinds without a state show the pictogram alone.
    const glyph = state ? `${state} ${pict}` : pict ? `${ITEM_COLOR[x.kind] || ""}${pict}${c.reset}` : `${ITEM_ICON[x.kind]} `;
    const name = x.kind === "file" ? displayPath(x.value, cwd)
      : x.kind === "service" ? `${x.title}${x.value ? ` ${c.dim}${x.value.replace(/^https?:\/\//, "")}${c.reset}` : ""}`
      : x.kind === "browser" ? (x.title || x.value.replace(/^https?:\/\//, ""))
      : x.kind === "pane" ? `${x.value} ${c.dim}${x.title}${x.count > 1 ? ` ×${x.count}` : ""}${c.reset}`
      : x.title;
    const age = x.kind === "service" ? "" : `${c.dim}${ago(now - (x.kind === "task" && x.ended ? x.ended : x.ts))}${c.reset}`;
    const room = w - width(age) - 5;
    const title = x.kind === "file" ? fitMiddle(name, room) : width(name) > room ? fit(plain(name), room) : name;
    rows.push({ text: spread(`  ${glyph}${title}${c.reset}`, age, w), i });
    if (view.expanded.has(itemKey(x)) && x.value) for (const line of wrap(x.value, w - 6).slice(0, 4)) rows.push({ text: `      ${c.dim}${line}${c.reset}`, i });
  });
  if (!list.length) rows.push({ text: `${c.dim}  ${session ? empty : "No supported agent session in this tab"}${c.reset}`, i: -1 });
  return rows;
}
// Fork: the Repo tab's items, one list for every repo of the project.
function repoItemsOf(summaries) {
  const items = [];
  const seen = new Set(); // a repo reached through its main checkout and a worktree is summed up once
  for (const s of summaries) {
    if (s.slug && seen.has(s.slug)) continue;
    if (s.slug) seen.add(s.slug);
    const repo = s.slug || path.basename(s.root);
    items.push({ kind: "repo-head", repo, root: s.root, title: repo, value: s.slug ? `https://github.com/${s.slug}` : s.root,
      ghError: s.ghError, loading: s.loading, counts: [s.pulls.length, s.worktrees.length, s.branches.length], ts: 0 });
    for (const p of s.pulls) items.push({ kind: "pull", repo, root: s.root, ...p, value: p.url, title: `#${p.number} ${p.title}` });
    for (const w of s.worktrees) items.push({ kind: "worktree", repo, root: s.root, ...w, value: w.path, title: w.branch || "(detached)", ts: 0 });
    for (const b of s.branches) {
      items.push({ kind: "branch", repo, root: s.root, ...b, title: b.name, value: b.pushed && s.slug ? `https://github.com/${s.slug}/tree/${encodeURI(b.name)}` : "" });
    }
  }
  return items;
}

const MAX_BRANCH_ROWS = 10;
const CI_GLYPH = { pass: `${c.green}✓${c.reset}`, fail: `${c.red}✗${c.reset}`, pending: `${c.yellow}●${c.reset}`, "": `${c.dim}·${c.reset}` };
const REVIEW_MARK = { APPROVED: `${c.green}approved${c.reset}`, CHANGES_REQUESTED: `${c.red}changes${c.reset}`, REVIEW_REQUIRED: `${c.dim}review${c.reset}` };
const REPO_SECTION = { pull: ["pr", "PULL REQUESTS"], worktree: ["worktree", "WORKTREES"], branch: ["branch", "BRANCHES WITHOUT PR"] };

function repoRows(w, now) {
  const v = views.repo;
  const rows = [];
  let section = null;
  repoItems.forEach((x, i) => {
    if (x.kind === "repo-head") {
      if (rows.length) rows.push({ text: "", i: -1 });
      const state = x.loading ? `${c.dim}reading…${c.reset}` : x.ghError ? `${c.red}GitHub unavailable${c.reset}` : "";
      rows.push({ text: spread(`${c.bold}${icon("repository")}${fit(x.title, w - 22)}${c.reset}`, state, w), i });
      section = null;
      return;
    }
    // At most MAX_BRANCH_ROWS branches per repo, then "+N more" (Space on the last one lists all).
    if (x.kind === "branch") {
      const mine = repoItems.filter((y) => y.repo === x.repo && y.kind === "branch");
      const at = mine.indexOf(x);
      if (at >= MAX_BRANCH_ROWS && !v.expanded.has(`more:${x.repo}`)) {
        if (at === MAX_BRANCH_ROWS) rows.push({ text: `   ${c.dim}+${mine.length - MAX_BRANCH_ROWS} more · Space on the last one shows them${c.reset}`, i: -1 });
        return;
      }
    }
    if (x.kind !== section) {
      const n = repoItems.filter((y) => y.repo === x.repo && y.kind === x.kind).length;
      rows.push({ text: `${c.dim}${icon(REPO_SECTION[x.kind][0])}${REPO_SECTION[x.kind][1]} · ${n}${c.reset}`, i: -1 });
      section = x.kind;
    }
    let left, right;
    if (x.kind === "pull") {
      const review = REVIEW_MARK[x.review] ? ` ${REVIEW_MARK[x.review]}` : "";
      right = `${c.dim}${x.author ? x.author + " " : ""}${ago(now - x.ts)}${c.reset}`;
      left = `  ${CI_GLYPH[x.ci]} ${x.draft ? c.dim : ""}${fit(x.title, Math.max(8, w - width(right) - width(review) - 6))}${c.reset}${review}`;
    } else if (x.kind === "worktree") {
      const marks = [x.changed ? `${c.yellow}~${x.changed}${c.reset}` : "", x.ahead ? `${c.cyan}↑${x.ahead}${c.reset}` : "",
        x.behind ? `${c.magenta}↓${x.behind}${c.reset}` : "", x.pull ? `${c.dim}#${x.pull.number}${c.reset}` : ""].filter(Boolean).join(" ");
      const where = x.path === x.root ? "." : path.basename(x.path);
      right = `${c.dim}${fitMiddle(where, Math.max(6, Math.floor(w / 3)))}${c.reset}`;
      left = `  ${x.changed ? `${c.yellow}●${c.reset}` : `${c.green}✓${c.reset}`} ${icon("worktree")}${fit(x.title, Math.max(8, w - width(right) - width(marks) - 8))} ${marks}`;
    } else {
      right = `${c.dim}${x.pushed ? "pushed" : "local"} ${ago(now - x.ts)}${c.reset}`;
      left = `  ${x.pushed ? `${c.cyan}↑${c.reset}` : `${c.dim}○${c.reset}`} ${icon("branch")}${fit(x.title, Math.max(8, w - width(right) - 7))}`;
    }
    rows.push({ text: spread(left, right, w), i });
    if (v.expanded.has(itemKey(x)) && x.value) for (const line of wrap(x.value, w - 6).slice(0, 3)) rows.push({ text: `      ${c.dim}${line}${c.reset}`, i });
  });
  if (!repoItems.length) rows.push({ text: `${c.dim}  ${session ? "No git repository for this agent yet" : "No supported agent session in this tab"}${c.reset}`, i: -1 });
  return rows;
}

const madeRows = (w, now) => itemRows(made, views.made, w, now, session?.outputs ? "Nothing published, pushed or written yet" : "Not tracked for this agent");
const appsRows = (w, now) => itemRows(apps, views.apps, w, now, "No services, background commands, browser tabs or panes yet");

// Enter or click on a Made/Apps item: pages, PRs, services and tabs open in the browser; files
// and a background command's output in the File Viewer; a herdr pane gets focus.
function openItem(x) {
  if (!x) return;
  if (x.kind === "pane") {
    const pane = (snapshot()?.panes || []).find((p) => p.pane_id === x.value);
    const res = pane ? herdr(["tab", "focus", pane.tab_id]) : { ok: false };
    flash = res.ok ? `${c.green}Focused ${x.value}` : `${c.red}Pane ${x.value} is gone`;
    flashUntil = Date.now() + 3000;
    return render();
  }
  if (!x.value) {
    if (x.kind === "branch") return copyRef({ value: x.title }); // a local branch: its name
    flash = `${c.dim}Nothing to open`; flashUntil = Date.now() + 2000; return render();
  }
  openRef({ kind: x.kind === "file" || x.kind === "task" || x.kind === "worktree" ? "file" : "url", value: x.value, line: 0 });
}

function toggleTodo(t) {
  if (!t || !session) return;
  const all = readDone();
  const ids = new Set(all[session.sessionId] || []);
  ids.has(t.id) ? ids.delete(t.id) : ids.add(t.id);
  all[session.sessionId] = [...ids];
  // Only the 50 most recently changed sessions are kept.
  const keep = Object.fromEntries(Object.entries(all).filter(([k]) => k !== session.sessionId).slice(-49));
  keep[session.sessionId] = all[session.sessionId];
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(DONE_FILE, JSON.stringify(keep)); } catch {}
  refresh();
  render();
}

// ---------- conversation view ----------

function openDetail(agent) {
  detail = { agent, items: [], stamp: 0, scroll: 0 };
  reloadDetail();
}

function reloadDetail() {
  if (!detail) return;
  let stamp = 0;
  try { stamp = fs.statSync(detail.agent.file).mtimeMs; } catch {}
  if (stamp === detail.stamp) return;
  const atEnd = detail.stamp && detail.scroll >= detail.maxScroll;
  detail.stamp = stamp;
  detail.items = readConversation(detail.agent.file, session?.provider);
  if (atEnd) detail.scroll = Infinity; // keep following a running agent
}

function detailRows(w) {
  const rows = [];
  for (const it of detail.items) {
    if (it.kind === "task") {
      rows.push(`${c.dim}TASK${c.reset}`);
      for (const l of wrap(it.text, w - 2).slice(0, 30)) rows.push(`${c.bold}${l}${c.reset}`);
      rows.push("");
    } else if (it.kind === "text") {
      for (const l of wrap(it.text, w - 2)) rows.push(l);
      rows.push("");
    } else {
      const r = it.result === "ok" ? `${c.green}✓${c.reset}` : it.result === "error" ? `${c.red}✗${c.reset}` : `${c.yellow}…${c.reset}`;
      rows.push(`${r} ${c.dim}${fit(`${it.name} ${it.summary}`, w - 4)}${c.reset}`);
      if (it.error) for (const l of wrap(it.error, w - 4).slice(0, 3)) rows.push(`  ${c.red}${l}${c.reset}`);
    }
  }
  return rows;
}

function renderDetail() {
  const W = out.columns || 50, H = out.rows || 30, w = W - 2;
  const a = detail.agent;
  const head = [
    `${c.bold}← ${fit(a.description, w - 3)}${c.reset}`,
    `${c.dim}${fit(`${a.type} · ${a.status} · ${a.toolCount} tools`, w)}${c.reset}`,
    `${c.dim}${"─".repeat(Math.max(0, w))}${c.reset}`,
  ];
  const rows = detailRows(w);
  const bodyH = H - head.length - 1;
  detail.maxScroll = Math.max(0, rows.length - bodyH);
  detail.scroll = Math.max(0, Math.min(detail.scroll, detail.maxScroll));
  const help = flash && Date.now() < flashUntil ? flash : `${c.dim}Esc back · j/k scroll · space page · z zoom`;
  let frame = "\x1b[H" + head.map((l) => " " + l + "\x1b[K").join("\n") + "\n";
  frame += rows.slice(detail.scroll, detail.scroll + bodyH).map((l) => " " + l + "\x1b[K").join("\n") + "\x1b[J";
  frame += `\x1b[${H};1H ${width(help) > w ? c.dim + fit(plain(help), w) : help}${c.reset}\x1b[K`;
  out.write(frame);
}

function zoom() {
  const me = (snapshot()?.panes || []).find((p) => p.label === LABEL);
  if (me) herdr(["pane", "zoom", me.pane_id, "--toggle"]);
}

function onDetailKey(key) {
  const page = (out.rows || 30) - 5;
  const wheel = key.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (wheel) {
    if (wheel[1] === "64") detail.scroll -= 3;
    else if (wheel[1] === "65") detail.scroll += 3;
    else if (wheel[1] === "0" && /M$/.test(key) && /^\x1b\[<0;\d+;1M$/.test(key)) detail = null; // click the title to go back
    return render();
  }
  if (key === "\x1b" || key === "q" || key === "\x7f" || key === "\x1b[D") detail = null;
  else if (key === "j" || key === "\x1b[B") detail.scroll += 1;
  else if (key === "k" || key === "\x1b[A") detail.scroll -= 1;
  else if (key === " " || key === "\x1b[6~") detail.scroll += page;
  else if (key === "\x1b[5~") detail.scroll -= page;
  else if (key === "g") detail.scroll = 0;
  else if (key === "G") detail.scroll = Infinity;
  else if (key === "z") return zoom();
  else return;
  render();
}

// ---------- rendering ----------

// Draw on the next tick, once, however many events asked for it: a trackpad flick sends dozens of
// wheel events at once, and drawing after each one fell behind.
let drawPending = false;
function render() {
  if (drawPending) return;
  drawPending = true;
  setImmediate(() => { drawPending = false; draw(); });
}

function draw() {
  if (detail) return renderDetail();
  const W = out.columns || 50;
  const H = out.rows || 30;
  const w = W - 2;
  const now = Date.now();

  // Tab bar
  const all = session ? session.list(now) : [];
  const running = all.filter((a) => a.status === "running").length;
  // Tab labels, shortened until the bar fits the panel's width.
  const counts = {
    messages: `${c.dim}${session?.turns.length || 0}${c.reset}`, // yours
    subagents: running ? `${c.yellow}●${running}${c.reset}` : "", // running only, like Claude's own count
    refs: refs.length ? `${c.dim}${refs.length}${c.reset}` : "",
    todo: (() => { const n = todos.filter((t) => !t.done).length; return n ? `${c.yellow}○${n}${c.reset}` : ""; })(),
    made: made.length ? `${c.dim}${made.length}${c.reset}` : "",
    apps: (() => { const n = apps.filter((x) => x.kind === "task" && x.status === "running").length; return n ? `${c.yellow}●${n}${c.reset}` : apps.length ? `${c.dim}${apps.length}${c.reset}` : ""; })(),
    repo: (() => {
      const failing = repoItems.filter((x) => x.kind === "pull" && x.ci === "fail").length;
      const pulls = repoItems.filter((x) => x.kind === "pull").length;
      return failing ? `${c.red}✗${failing}${c.reset}` : pulls ? `${c.dim}${pulls}${c.reset}` : "";
    })(),
  };
  const names = [
    { messages: "Messages", subagents: "Subagents", refs: "Refs", todo: "To do", made: "Made", apps: "Apps", repo: "Repo" },
    { messages: "Msgs", subagents: "Agents", refs: "Refs", todo: "To do", made: "Made", apps: "Apps", repo: "Repo" },
    { messages: "M", subagents: "A", refs: "R", todo: "D", made: "O", apps: "P", repo: "G" },
  ];
  let bar = "";
  if (MODE === "nerd") { // fork: a pictogram before each name; the narrowest bar keeps only the pictogram
    for (const name of TABS) { names[0][name] = icon(name) + names[0][name]; names[1][name] = icon(name) + names[1][name]; names[2][name] = icon(name).trim(); }
  }
  for (const set of names) {
    let col = 2;
    bar = "";
    tabHits = [];
    for (const name of TABS) {
      const text = ` ${set[name]}${counts[name] ? " " + counts[name] : ""} `;
      tabHits.push({ from: col, to: col + width(text) - 1, tab: name });
      bar += (name === tab ? `${c.inverse}${c.bold}${plain(text)}${c.reset}` : text) + (set === names[2] ? "" : " ");
      col += width(text) + (set === names[2] ? 0 : 1);
    }
    if (width(bar) <= w) break;
  }
  const where = tracked?.cwd ? path.basename(tracked.cwd) : "";
  const room = w - width(bar) - 1;
  const head = [
    ...headerLines(tracked, session, render).map((l) => fitLine(l, w)),
    room >= 6 ? spread(bar, `${c.dim}${fit(where, room)}${c.reset}`, w) : bar,
    `${c.dim}${"─".repeat(Math.max(0, w))}${c.reset}`,
  ];

  const v = views[tab];
  const rows = tab === "messages" ? messageRows(w, now) : tab === "refs" ? refRows(w, now) : tab === "todo" ? todoRows(w, now)
    : tab === "made" ? madeRows(w, now) : tab === "apps" ? appsRows(w, now) : tab === "repo" ? repoRows(w, now) : subagentRows(w, now);
  const bodyH = H - head.length - 1;
  v.maxScroll = Math.max(0, rows.length - bodyH);
  if (v.free) {
    // Scrolled with the wheel: the view stays put (or on the bottom, if it's there) wherever the cursor is.
    if (v.stick) v.scroll = v.maxScroll;
  } else {
    const first = rows.findIndex((r) => r.i === v.cursor);
    let last = first;
    while (last + 1 < rows.length && rows[last + 1].i === v.cursor) last++;
    if (first >= 0) {
      if (first < v.scroll) v.scroll = first;
      if (last >= v.scroll + bodyH) v.scroll = Math.min(first, last - bodyH + 1);
    }
  }
  v.scroll = Math.max(0, Math.min(v.scroll, v.maxScroll));
  // The selected item gets a teal bar in the margin, down all its rows but the blank ones after it.
  const sel = v.cursor >= 0 && items().length ? rows.map((r, n) => (r.i === v.cursor ? n : -1)).filter((n) => n >= 0) : [];
  while (sel.length && !plain(rows[sel[sel.length - 1]].text).trim()) sel.pop();
  const barred = new Set(sel);
  const shown = rows.slice(v.scroll, v.scroll + bodyH).map((r, n) => ({ ...r, bar: barred.has(v.scroll + n) }));
  screenRows = [...head.map(() => -1), ...shown.map((r) => r.i)];
  tabRow = head.length - 1; // head = header lines, the tab bar, its rule

  let help;
  if (busy) help = `${c.yellow}switching…`;
  else if (flash && now < flashUntil) help = flash;
  else if (tab === "messages") help = `${c.dim}click/Enter full message · Space expand · q close`;
  else if (tab === "refs") help = `${c.dim}click/Enter open · y copy · click ● message · q close`;
  else if (tab === "todo") help = `${c.dim}x done · click/Enter message · y copy · q close`;
  else if (tab === "made" || tab === "apps" || tab === "repo") help = `${c.dim}click/Enter open · Space details · y copy · q close`;
  else help = `${c.dim}${w >= 58 ? `${session?.provider === "codex" ? "click/Enter read" : "click/Enter open in Claude"} · v read here · f finished · a ${showAll ? "recent" : "all"}` : "click open · v read · f finished"}`;
  const footer = width(help) > w ? `${c.dim}${fit(plain(help), w)}` : help;

  let frame = "\x1b[H" + head.map((l) => " " + l + "\x1b[K").join("\n") + "\n";
  frame += shown.map((r) => (r.bar ? `${c.cyan}▎${c.reset}` : " ") + r.text + "\x1b[K").join("\n") + "\x1b[J";
  frame += `\x1b[${H};1H ${footer}${c.reset}\x1b[K`;
  out.write(frame);
}

// ---------- input ----------

// dismiss: close in this tab only; the panel keeps following you to other Claude tabs.
function quit({ dismiss = false } = {}) {
  if (dismiss) {
    const snap = snapshot();
    const me = (snap?.panes || []).find((p) => p.label === LABEL);
    if (me) setDismissed(me.tab_id, true, new Set((snap.tabs || []).map((t) => t.tab_id)));
  }
  unmarkShown();
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  process.exit(0);
}

function setTab(name) {
  tab = name;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(TAB_FILE, name); } catch {}
}

// Switch the Claude session's own view to this subagent (or main).
async function openInClaude(target) {
  if (session?.provider === "codex") {
    if (target !== "main") openDetail(target); else detail = null;
    return render();
  }
  if (busy || !tracked?.paneId) return;
  busy = true;
  draw(); // now: switching can block before its first pause
  const err = await viewInClaude(tracked.paneId, target);
  busy = false;
  // Claude only lists running and recent subagents; show finished ones' conversations here instead.
  if (err && target !== "main" && /Not in Claude's list|isn't showing/.test(err)) {
    openDetail(target);
    flash = `${c.dim}Claude no longer lists it — showing its conversation here`;
    flashUntil = Date.now() + 5000;
    return render();
  }
  flash = err ? `${c.red}${err}` : `${c.green}Showing ${target === "main" ? "main" : target.description} in Claude`;
  flashUntil = Date.now() + 4000;
  render();
}

function toggleFinished() {
  finishedCollapsed = !finishedCollapsed;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(FINISHED_FILE, finishedCollapsed ? "1" : "0"); } catch {}
  refresh();
  render();
}

// Open a ref: files and web pages through the File Viewer plugin when it's installed
// (the file in its popup, pages in its browser tab), else the system's default app.
let viewerRoot; // File Viewer's folder, looked up once
function openRef(r) {
  if (!r) return;
  const isDir = r.kind === "file" && (() => { try { return fs.statSync(r.value).isDirectory(); } catch { return false; } })();
  if (r.kind === "file" && !isDir && !fs.existsSync(r.value)) {
    flash = `${c.red}Not on disk: ${displayPath(r.value, session?.cwd || "")}`;
    flashUntil = Date.now() + 4000;
    return render();
  }
  if (viewerRoot === undefined) {
    const p = herdr(["plugin", "list", "--plugin", "file-viewer", "--json"]).json?.result?.plugins?.[0];
    viewerRoot = p?.enabled ? p.plugin_root : null;
  }
  if (viewerRoot && !isDir && tracked?.paneId) {
    const env = { ...process.env, HERDR_PLUGIN_ID: "file-viewer",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ selected_text: r.line ? `${r.value}:${r.line}` : r.value, focused_pane_id: tracked.paneId }) };
    delete env.HERDR_PLUGIN_CLICKED_URL;
    // Its state lives next to ours (…/plugins/<id>), where its panel reads it.
    if (process.env.HERDR_PLUGIN_STATE_DIR) env.HERDR_PLUGIN_STATE_DIR = path.join(path.dirname(process.env.HERDR_PLUGIN_STATE_DIR), "file-viewer");
    else delete env.HERDR_PLUGIN_STATE_DIR;
    spawn(process.execPath, [path.join(viewerRoot, "src", "open.mjs")], { cwd: viewerRoot, env, detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [r.value], { detached: true, stdio: "ignore" }).unref();
  }
  flash = `${c.green}Opening ${fit(r.kind === "url" ? r.value.replace(/^https?:\/\//, "") : path.basename(r.value), 40)}`;
  flashUntil = Date.now() + 3000;
  render();
}

function copyRef(r) {
  if (!r) return;
  const text = r.value;
  const ok = copyText(text);
  flash = ok ? `${c.green}Copied ${fit(text, 40)}` : `${c.red}No clipboard tool found`;
  flashUntil = Date.now() + 3000;
  render();
}

// One message in full, in a popup over the whole terminal (src/message.mjs). Where that can't
// open (another herdr dialog is up, or testing outside herdr), expand it in the panel instead.
function popOut(i) {
  if (i < 0 || !session) return;
  const res = process.env.SA_SESSION ? { ok: false, stderr: "not in herdr" }
    : herdr(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "message",
      "--env", `MSG_SESSION=${session.sessionId}`, "--env", `MSG_INDEX=${i}`, "--env", `MSG_PROVIDER=${session.provider}`]);
  if (res.ok) return;
  views.messages.expanded.add(i);
  flash = `${c.dim}No popup (${fit(res.stderr || "herdr refused", 30)}) — expanded here`;
  flashUntil = Date.now() + 4000;
  render();
}

function activate() { // Enter or click on the current item
  const v = views[tab];
  if (tab === "refs") return openRef(refs[v.cursor]);
  if (tab === "made") return openItem(made[v.cursor]);
  if (tab === "apps") return openItem(apps[v.cursor]);
  if (tab === "repo") return openItem(repoItems[v.cursor]);
  if (tab === "todo") return todos[v.cursor] && popOut(todos[v.cursor].msg);
  if (tab === "messages") return popOut(v.cursor);
  const a = agents[v.cursor];
  if (a) openInClaude(a);
}

function move(delta) {
  const v = views[tab];
  const n = items().length;
  if (v.free) {
    // Back from wheel scrolling: start from what's on screen, not a cursor scrolled out of view.
    v.free = false;
    const visible = screenRows.filter((x) => typeof x === "number" && x >= 0);
    if (visible.length && !visible.includes(v.cursor)) {
      v.cursor = delta < 0 ? visible[visible.length - 1] : visible[0];
      if (tab === "messages") views.messages.follow = v.cursor === n - 1;
      return;
    }
  }
  v.cursor = Math.max(0, Math.min(n - 1, v.cursor + delta));
  if (tab === "messages") views.messages.follow = v.cursor === n - 1;
}

// The wheel scrolls the view a row at a time and leaves the cursor alone. Moving the cursor by whole
// items made a trackpad flick (which keeps sending wheel events after you let go) fly through the list.
function wheel(delta) {
  const v = views[tab];
  v.free = true;
  v.scroll = Math.max(0, Math.min(v.maxScroll ?? 0, v.scroll + delta));
  v.stick = v.scroll >= (v.maxScroll ?? 0);
  if (tab === "messages") views.messages.follow = v.stick; // at the bottom: keep showing new messages
}

function onKey(key) {
  if (detail && key !== "\x03") return onDetailKey(key);
  const mouse = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouse) {
    const [, b, x, y, kind] = mouse;
    if (b === "64") wheel(-1);
    else if (b === "65") wheel(1);
    else if (b === "0" && kind === "M") {
      const clicked = tabAt(Number(x), Number(y), tabRow, tabHits);
      if (Number(y) === tabRow) {
        if (clicked) setTab(clicked);
      } else if (screenRows[Number(y) - 1] === "finished") {
        return toggleFinished();
      } else if (/^msg:\d+$/.test(screenRows[Number(y) - 1])) {
        return popOut(Number(screenRows[Number(y) - 1].slice(4)));
      } else if (screenRows[Number(y) - 1] >= 0) {
        views[tab].cursor = screenRows[Number(y) - 1];
        if (tab === "messages") views.messages.follow = views.messages.cursor === items().length - 1;
        return activate();
      }
    }
    return render();
  }
  if (key === "\x03") return quit();
  if (key === "q") return quit({ dismiss: true });
  if (key === "\t" || key === "\x1b[C") setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]); // Tab, →
  else if (key === "\x1b[D") setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]); // ←
  else if (/^[1-7]$/.test(key)) setTab(TABS[Number(key) - 1]);
  else if (key === "j" || key === "\x1b[B") move(1);
  else if (key === "k" || key === "\x1b[A") move(-1);
  else if (key === "g") move(-Infinity);
  else if (key === "G") move(Infinity);
  else if (key === "\r") return activate();
  else if (key === " " || key === "l" || key === "h") {
    const v = views[tab];
    // Repo tab: Space on the last shown branch of a repo lists them all (and back).
    const cur = tab === "repo" ? repoItems[v.cursor] : null;
    if (cur?.kind === "branch") {
      const mine = repoItems.filter((y) => y.repo === cur.repo && y.kind === "branch");
      if (mine.indexOf(cur) === MAX_BRANCH_ROWS - 1 || v.expanded.has(`more:${cur.repo}`)) {
        const k = `more:${cur.repo}`;
        v.expanded.has(k) ? v.expanded.delete(k) : v.expanded.add(k);
      }
    }
    const id = tab === "messages" ? v.cursor : tab === "refs" ? refs[v.cursor]?.value
      : tab === "made" || tab === "apps" || tab === "repo" ? (items()[v.cursor] ? itemKey(items()[v.cursor]) : undefined) : agents[v.cursor]?.id;
    if (id !== undefined && id !== -1) v.expanded.has(id) ? v.expanded.delete(id) : v.expanded.add(id);
  } else if (key === "m" && tab === "subagents") return openInClaude("main");
  else if (key === "v" && tab === "subagents" && agents[views.subagents.cursor]) openDetail(agents[views.subagents.cursor]);
  else if (key === "a" && tab === "subagents") { showAll = !showAll; refresh(); }
  else if (key === "y" && tab === "refs") return copyRef(refs[views.refs.cursor]);
  else if (key === "y" && (tab === "made" || tab === "apps" || tab === "repo") && items()[views[tab].cursor]) {
    const x = items()[views[tab].cursor];
    return copyRef({ value: x.value || x.title });
  }
  else if (key === "x" && tab === "todo") return toggleTodo(todos[views.todo.cursor]);
  else if (key === "y" && tab === "todo" && todos[views.todo.cursor]) {
    // A request with a command in it ("Run `herdr server stop`") copies just the command.
    const t = todos[views.todo.cursor].text;
    const text = t.match(/`([^`]+)`/)?.[1] || t.replace(/\*\*|`/g, "");
    flash = copyText(text) ? `${c.green}Copied ${fit(text, 40)}` : `${c.red}No clipboard tool found`;
    flashUntil = Date.now() + 3000;
  }
  else if (key === "f" && tab === "subagents") return toggleFinished();
  else return;
  render();
}

// ---------- main ----------

out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1006h"); // mouse clicks and wheel
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk.match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;]*[~A-Za-z]|\x1b.|[\s\S]/gu) || []) onKey(key);
});
out.on("resize", () => { out.write("\x1b[2J"); render(); });
process.on("SIGTERM", () => quit());
process.on("SIGHUP", () => quit());

pickAgent();
refresh();
render();
setInterval(() => { refresh(); reloadDetail(); render(); }, 1000);
setInterval(pickAgent, 1500);
