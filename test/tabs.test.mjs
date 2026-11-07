import { test } from "node:test";
import assert from "node:assert/strict";
import { openingTab } from "../src/tabs.mjs";

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
