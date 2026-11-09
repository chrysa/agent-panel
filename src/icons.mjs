// Fork addition: Nerd Font pictograms for the tab bar, the Made/Apps/Refs rows, their section
// headers and (through AGENT_PANEL_ICONS) the header and services commands.
//
// Off by default: the glyphs need a Nerd Font (v3) in the terminal. Turn them on with
// `nerd` in <plugin config dir>/icons, or AGENT_PANEL_ICONS=nerd. With them off every
// function returns "" and the panel looks as upstream's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "./lib.mjs";

const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".config/herdr/plugins/config", PLUGIN_ID);

export function iconMode(env = process.env, file = path.join(CONFIG_DIR, "icons")) {
  if (env.AGENT_PANEL_ICONS) return env.AGENT_PANEL_ICONS.trim() === "nerd" ? "nerd" : "plain";
  try { return fs.readFileSync(file, "utf8").trim() === "nerd" ? "nerd" : "plain"; } catch { return "plain"; }
}

export const MODE = iconMode();

// Nerd Fonts v3 code points (Font Awesome, Octicons, Devicons, Seti, Material Design).
export const GLYPHS = {
  // tabs
  subagents: "\u{f06a9}", messages: "", refs: "", todo: "", made: "", apps: "", repo: "\uf09b",
  // Made / Apps / Refs kinds
  page: "", url: "", pr: "", issue: "", release: "", push: "",
  file: "", folder: "", service: "", task: "", browser: "", playwright: "",
  pane: "", repository: "\uf401", worktree: "\uf126", branch: "\uf418",
  // sections
  github: "", files: "", finished: "",
};

const BY_EXT = {
  py: "", js: "", mjs: "", cjs: "", ts: "", tsx: "", jsx: "",
  md: "", json: "", sh: "", zsh: "", bash: "", toml: "", yml: "",
  yaml: "", ini: "", cfg: "", conf: "", env: "", html: "", css: "",
  go: "", rs: "", java: "", rb: "", php: "", sql: "", lock: "",
  svg: "", png: "", jpg: "", gif: "", pdf: "", txt: "", log: "",
  dockerfile: "", makefile: "",
};

// "<glyph> " for a name, or "" when pictograms are off or the name is unknown.
export const icon = (name, mode = MODE) => (mode === "nerd" && GLYPHS[name] ? `${GLYPHS[name]} ` : "");

// A file's pictogram from its extension (or its name: Dockerfile, Makefile), else a plain file.
export function fileIcon(file, { dir = false, mode = MODE } = {}) {
  if (mode !== "nerd") return "";
  if (dir) return `${GLYPHS.folder} `;
  const base = path.basename(String(file)).toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop() : base;
  return `${BY_EXT[ext] || GLYPHS.file} `;
}

// A GitHub item's pictogram from its title ("… PR #9", "… issue #3", "… release v1", "… pushed x").
export function githubIcon(title, mode = MODE) {
  const kind = / PR #/.test(title) ? "pr" : / issue #/.test(title) ? "issue" : / release /.test(title) ? "release" : "push";
  return icon(kind, mode);
}
