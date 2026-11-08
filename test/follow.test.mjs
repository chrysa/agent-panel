import { test } from "node:test";
import assert from "node:assert/strict";
import { widthFix } from "../src/follow.mjs";

const layout = (agent, panel, zoomed = false) => ({
  zoomed,
  panes: [{ pane_id: "a", rect: { width: agent } }, { pane_id: "p", rect: { width: panel } }],
});

test("widens the agent back to the saved ratio", () => {
  assert.deepEqual(widthFix(layout(90, 90), "a", "p", 0.75),
    ["pane", "resize", "--pane", "a", "--direction", "right", "--amount", "0.250"]);
});

test("narrows the agent when the panel is too small", () => {
  assert.deepEqual(widthFix(layout(170, 10), "a", "p", 0.75)?.slice(4), ["--direction", "left", "--amount", "0.194"]);
});

test("leaves a split already at the ratio, a zoomed tab, or missing panes", () => {
  assert.equal(widthFix(layout(135, 45), "a", "p", 0.75), null);
  assert.equal(widthFix(layout(90, 90, true), "a", "p", 0.75), null);
  assert.equal(widthFix(layout(90, 90), "a", "gone", 0.75), null);
  assert.equal(widthFix(undefined, "a", "p", 0.75), null);
  assert.equal(widthFix({ panes: [{ pane_id: "a", rect: {} }, { pane_id: "p", rect: {} }] }, "a", "p", 0.75), null);
});
