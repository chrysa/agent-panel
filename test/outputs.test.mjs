import { test } from "node:test";
import assert from "node:assert/strict";
import { Outputs } from "../src/outputs.mjs";
import { parseServices } from "../src/services.mjs";

const use = (o, id, name, input, ts = 1, cwd = "/repo") => o.onToolUse({ id, name, input }, ts, cwd);
const result = (o, id, text, ts = 2) => o.onToolResult({ tool_use_id: id, content: [{ type: "text", text }] }, ts);

test("a published page is made; reading or listing pages is not", () => {
  const o = new Outputs();
  use(o, "a1", "Artifact", { file_path: "/tmp/x/usine-hexa.html" });
  result(o, "a1", "Published /tmp/x/usine-hexa.html at https://claude.ai/artifact/4Ru4xy3k (Version 1)");
  use(o, "a2", "Artifact", { action: "read", url: "https://claude.ai/artifact/Pmd" });
  result(o, "a2", "[Artifact b864 (version 1) — owned by you] https://claude.ai/artifact/Pmd");
  assert.deepEqual(o.made().map((x) => [x.kind, x.title, x.value]),
    [["page", "usine-hexa.html", "https://claude.ai/artifact/4Ru4xy3k"]]);
});

test("files written and edited, resolved from the session folder", () => {
  const o = new Outputs();
  use(o, "w", "Write", { file_path: "notes/plan.md" }, 1);
  use(o, "e1", "Edit", { file_path: "/repo/src/a.mjs" }, 2);
  use(o, "e2", "Edit", { file_path: "/repo/src/a.mjs" }, 3);
  const files = o.made().filter((x) => x.kind === "file");
  assert.deepEqual(files.map((x) => [x.value, x.written, x.edits]), [["/repo/src/a.mjs", false, 2], ["/repo/notes/plan.md", true, 1]]);
});

test("GitHub pull requests, releases and pushed branches from command output", () => {
  const o = new Outputs();
  use(o, "b1", "Bash", { command: "gh api -X POST repos/chrysa/x/pulls", description: "Open PR" });
  result(o, "b1", "#64 https://github.com/chrysa/herdr-cockpit/pull/64 head=abc");
  use(o, "b2", "Bash", { command: "git push -u origin feat/x" });
  result(o, "b2", "To github.com:chrysa/agent-panel.git\n * [new branch]      feat/x -> feat/x\n");
  use(o, "b3", "Bash", { command: "gh release create v0.8.0" });
  result(o, "b3", "https://github.com/chrysa/herdr-cockpit/releases/tag/v0.8.0\nremote: https://github.com/chrysa/x/pull/new/feat/x");
  const titles = o.made().map((x) => x.title).sort();
  assert.deepEqual(titles, ["chrysa/agent-panel pushed feat/x", "chrysa/herdr-cockpit PR #64", "chrysa/herdr-cockpit release v0.8.0"]);
});

test("a background command runs until its notification, with its output file", () => {
  const o = new Outputs();
  use(o, "t", "Bash", { command: "npm run dev", description: "Dev server" });
  result(o, "t", "Command running in background with ID: b7hl. Output is being written to: /tmp/tasks/b7hl.output");
  use(o, "q", "Bash", { command: "echo 'Command running in background with ID: fake'" });
  result(o, "q", "Command running in background with ID: fake"); // starts the result: counted (a real Bash result)
  assert.equal(o.apps().filter((x) => x.kind === "task").length, 2);
  o.onNotification("b7hl", "stopped", 5);
  const task = o.apps().find((x) => x.id === "b7hl");
  assert.deepEqual([task.status, task.value, task.title], ["killed", "/tmp/tasks/b7hl.output", "Dev server"]);
  use(o, "p", "Bash", { command: "cat log" });
  result(o, "p", "log line: Command running in background with ID: nope");
  assert.equal(o.apps().some((x) => x.id === "nope"), false);
});

test("browser tabs from Chrome's live tab list, closed tabs dropped", () => {
  const o = new Outputs();
  use(o, "n", "mcp__claude-in-chrome__navigate", { url: "http://127.0.0.1:8767/" });
  result(o, "n", 'Navigated\n- Available tabs:\n  • tabId 21: "Cockpit" ("http://127.0.0.1:8767/")\n  • tabId 22: "Docs" ("https://herdr.dev/docs")');
  assert.deepEqual(o.apps().map((x) => [x.kind, x.title, x.value]).sort(),
    [["browser", "Cockpit", "http://127.0.0.1:8767/"], ["browser", "Docs", "https://herdr.dev/docs"]]);
  use(o, "c", "mcp__claude-in-chrome__tabs_close_mcp", { tabId: 22 });
  assert.deepEqual(o.apps().map((x) => x.title), ["Cockpit"]);
});

test("herdr panes its commands acted on", () => {
  const o = new Outputs();
  use(o, "h1", "Bash", { command: "herdr pane send-keys w3Y:p1 ctrl+c ctrl+c" }, 1);
  use(o, "h2", "Bash", { command: "herdr pane read w3Y:p1 --lines 8 && herdr pane move w31:p1QT --new-tab" }, 2);
  const panes = o.apps().filter((x) => x.kind === "pane").map((x) => [x.value, x.title, x.count]);
  assert.deepEqual(panes, [["w3Y:p1", "pane read", 2], ["w31:p1QT", "pane move", 1]]);
});

test("services from the services command, plain text only", () => {
  const items = parseServices("up\tapi\thttp://localhost:8000\ndown\tdb\t\n\x1b[31mup\tweb\thttp://localhost:5173\nbad line\n");
  assert.deepEqual(items.map((s) => [s.up, s.title, s.value]),
    [[true, "api", "http://localhost:8000"], [false, "db", ""], [false, "web", "http://localhost:5173"]]);
});

test("TaskStop ends a background command", () => {
  const o = new Outputs();
  use(o, "t", "Bash", { command: "sleep 600", description: "Wait" });
  result(o, "t", "Command running in background with ID: b1. Output is being written to: /tmp/b1.output", 2);
  use(o, "s", "TaskStop", { task_id: "b1" });
  result(o, "s", "Successfully stopped task: b1 (sleep 600)", 9);
  const task = o.apps().find((x) => x.id === "b1");
  assert.deepEqual([task.status, task.ended], ["killed", 9]);
});

test("a running task whose output has not moved for 30 min shows as stalled", () => {
  const o = new Outputs();
  use(o, "t", "Bash", { command: "sleep 9999", description: "Wait" });
  result(o, "t", "Command running in background with ID: b2. Output is being written to: /tmp/b2.output", 1000);
  const minutes = (n) => n * 60 * 1000;
  assert.equal(o.apps(1000 + minutes(10), () => 0).find((x) => x.id === "b2").status, "running");
  assert.equal(o.apps(1000 + minutes(40), () => 0).find((x) => x.id === "b2").status, "stalled");
  assert.equal(o.apps(1000 + minutes(40), () => 1000 + minutes(35)).find((x) => x.id === "b2").status, "running"); // output moved
});
