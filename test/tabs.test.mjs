import { test } from "node:test";
import assert from "node:assert/strict";
import { openingTab, tabAt } from "../src/tabs.mjs";

test("keeps the saved tab when it has something to show", () => {
  assert.equal(openingTab("subagents", { subagents: 2, todos: 3 }), "subagents");
  assert.equal(openingTab("refs", { subagents: 0, todos: 0 }), "refs");
  assert.equal(openingTab("messages", { subagents: 0, todos: 5 }), "messages");
});

test("an empty Subagents tab opens To do, else Messages", () => {
  assert.equal(openingTab("subagents", { subagents: 0, todos: 7 }), "todo");
  assert.equal(openingTab("subagents", { subagents: 0, todos: 0 }), "messages");
  assert.equal(openingTab("subagents"), "messages");
});

test("a click picks the tab on the tab bar's row, wherever the header puts it", () => {
  const hits = [{ from: 2, to: 12, tab: "subagents" }, { from: 14, to: 23, tab: "messages" }];
  assert.equal(tabAt(15, 4, 4, hits), "messages"); // three header lines above
  assert.equal(tabAt(15, 1, 4, hits), null); // a header line, not the tab bar
  assert.equal(tabAt(13, 4, 4, hits), null); // the gap between two tabs
  assert.equal(tabAt(3, 1, 1, hits), "subagents"); // no header
});
