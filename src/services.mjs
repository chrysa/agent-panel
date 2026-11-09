// Fork addition: the project's services for the Apps tab, from a command of your own.
//
// Configure it with an executable path in <plugin config dir>/services-command. It runs every
// few seconds with the agent's folder as working directory and the same arguments as the
// header command (<cwd> <provider> <session id> <agent pane id>), and prints one service per
// line: <state>\t<name>\t<url> (state: up or down; url may be empty). No file: no services.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { PLUGIN_ID } from "./lib.mjs";
import { MODE } from "./icons.mjs";

const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".config/herdr/plugins/config", PLUGIN_ID);
const COMMAND_FILE = path.join(CONFIG_DIR, "services-command");
const EVERY_MS = 3000;
const MAX = 40;
const unsafe = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g; // no escape sequences at all: plain text only

let items = [];
let key = "";
let last = 0;
let running = false;

function command() {
  try {
    const cmd = fs.readFileSync(COMMAND_FILE, "utf8").trim();
    return cmd && path.isAbsolute(cmd) ? cmd : "";
  } catch { return ""; }
}

export function parseServices(stdout, ts = Date.now()) {
  return stdout.split("\n").map((l) => l.replace(unsafe, "").split("\t")).filter((f) => f.length >= 2 && f[1].trim())
    .slice(0, MAX)
    .map(([state, name, url = ""]) => ({ kind: "service", title: name.trim(), value: url.trim(), up: state.trim() === "up", ts }));
}

// Services of the agent's project; refreshed in the background, so this never blocks.
export function serviceItems(tracked, session, onChange) {
  const cmd = command();
  const args = tracked?.cwd && session ? [tracked.cwd, session.provider || "", session.sessionId || "", tracked.paneId || ""] : null;
  const k = args ? args.join("\0") : "";
  if (!cmd || !args) { items = []; return items; }
  if (k !== key) { key = k; items = []; last = 0; }
  if (!running && Date.now() - last > EVERY_MS) {
    running = true;
    last = Date.now();
    execFile(cmd, args, { cwd: tracked.cwd, env: { ...process.env, AGENT_PANEL_ICONS: MODE }, timeout: 2500, maxBuffer: 64 * 1024 }, (err, stdout) => {
      running = false;
      if (k !== key) return;
      const next = err ? [] : parseServices(stdout, items[0]?.ts || Date.now());
      const sig = (list) => list.map((s) => `${s.up}${s.title}${s.value}`).join("\n");
      if (sig(next) !== sig(items)) { items = next; onChange(); }
    });
  }
  return items;
}
