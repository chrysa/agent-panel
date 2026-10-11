// Optional header above the tab bar, filled by a command of your own (account, model,
// folder, git state, services... whatever your status line shows), and a marker telling
// that command, or a status line, which agent pane the panel is showing.
//
// Configure it with an executable path in <plugin config dir>/header-command. It runs
// every few seconds with the agent's folder as working directory and these arguments:
// <cwd> <provider> <session id> <agent pane id>. Its stdout, at most MAX_LINES lines,
// is shown as is (ANSI colors allowed). No file: no header, nothing runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { PLUGIN_ID } from "./lib.mjs";
import { c, fit, plain, width } from "./text.mjs";

const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".config/herdr/plugins/config", PLUGIN_ID);
const COMMAND_FILE = path.join(CONFIG_DIR, "header-command");
// A fixed place, so a status line can find it without knowing herdr's plugin state dir.
export const SHOWN_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "agent-panel", "shown");
const EVERY_MS = 3000;
const MAX_LINES = 6;
// Keep colors (SGR) only: every other ESC, C0 and C1 control character is dropped, so what
// is left of any other sequence is plain text.
const unsafe = /\x1b(?!\[[0-9;]*m)|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g;

let lines = [];
let key = "";
let last = 0;
let running = false;
let marked = "";

function command() {
  try {
    const cmd = fs.readFileSync(COMMAND_FILE, "utf8").trim();
    return cmd && path.isAbsolute(cmd) ? cmd : "";
  } catch { return ""; }
}

// Colored when it fits, plain and cut when it doesn't.
export const fitLine = (l, w) => (width(l) <= w ? l + c.reset : fit(plain(l), w));

export function cleanLines(stdout) {
  return stdout.replace(unsafe, "").split("\n").filter((l) => l.trim()).slice(0, MAX_LINES);
}

// Header lines for the agent on screen; refreshed in the background, so this never blocks.
export function headerLines(tracked, session, onChange) {
  const cmd = command();
  const args = tracked?.cwd && session ? [tracked.cwd, session.provider || "", session.sessionId || "", tracked.paneId || ""] : null;
  const k = args ? args.join("\0") : "";
  if (!cmd || !args) { lines = []; return lines; }
  if (k !== key) { key = k; lines = []; last = 0; }
  if (!running && Date.now() - last > EVERY_MS) {
    running = true;
    last = Date.now();
    execFile(cmd, args, { cwd: tracked.cwd, timeout: 2000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      running = false;
      if (k !== key) return;
      const next = err ? [] : cleanLines(stdout);
      if (next.join("\n") !== lines.join("\n")) { lines = next; onChange(); }
    });
  }
  return lines;
}

// shown/<agent pane id> holds this panel's pid while it shows that agent.
export function markShown(paneId) {
  if (paneId === marked) return;
  unmarkShown();
  if (!paneId) return;
  try {
    fs.mkdirSync(SHOWN_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOWN_DIR, paneId), String(process.pid));
    marked = paneId;
  } catch {}
}

export function unmarkShown() {
  if (!marked) return;
  try { fs.unlinkSync(path.join(SHOWN_DIR, marked)); } catch {}
  marked = "";
}
