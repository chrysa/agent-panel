import { test } from "node:test";
import assert from "node:assert/strict";
import { GLYPHS, fileIcon, githubIcon, icon, iconMode } from "../src/icons.mjs";

test("pictograms are off unless asked for", () => {
  assert.equal(iconMode({}, "/nonexistent/icons"), "plain");
  assert.equal(iconMode({ AGENT_PANEL_ICONS: "nerd" }, "/nonexistent/icons"), "nerd");
  assert.equal(iconMode({ AGENT_PANEL_ICONS: "emoji" }, "/nonexistent/icons"), "plain");
  assert.equal(icon("made", "plain"), "");
  assert.equal(fileIcon("a.py", { mode: "plain" }), "");
});

test("nerd mode: one glyph and a space, by tab, file type and GitHub kind", () => {
  assert.equal(icon("made", "nerd"), `${GLYPHS.made} `);
  assert.equal(icon("unknown", "nerd"), "");
  assert.equal(fileIcon("/x/tidy.py", { mode: "nerd" }), " ");
  assert.equal(fileIcon("/x/Dockerfile", { mode: "nerd" }), " ");
  assert.equal(fileIcon("/x/notes", { mode: "nerd" }), `${GLYPHS.file} `);
  assert.equal(fileIcon("/x/src", { dir: true, mode: "nerd" }), `${GLYPHS.folder} `);
  assert.equal(githubIcon("chrysa/x PR #9", "nerd"), `${GLYPHS.pr} `);
  assert.equal(githubIcon("chrysa/x release v1", "nerd"), `${GLYPHS.release} `);
  assert.equal(githubIcon("chrysa/x pushed feat/y", "nerd"), `${GLYPHS.push} `);
});
