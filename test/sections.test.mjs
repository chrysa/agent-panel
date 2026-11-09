import { test } from "node:test";
import assert from "node:assert/strict";
import { foldState, sectioned } from "../src/sections.mjs";

const rows = (list) => list.map((x) => (x.kind === "section" ? `${x.folded ? "▸" : "▾"}${x.group}·${x.n}` : x.id));

test("a header with its count before each section; a folded one keeps only its header", () => {
  const list = [{ id: "p1", g: "page" }, { id: "f1", g: "file" }, { id: "f2", g: "file" }, { id: "o1", g: "outside" }];
  const fold = foldState(new Set(["outside"]));
  assert.deepEqual(rows(sectioned(list, (x) => [x.g], fold.folded)), ["▾page·1", "p1", "▾file·2", "f1", "f2", "▸outside·1"]);
  fold.toggle("outside");
  fold.toggle("file");
  assert.deepEqual(rows(sectioned(list, (x) => [x.g], fold.folded)), ["▾page·1", "p1", "▸file·2", "▾outside·1", "o1"]);
});

test("nested sections: a folded outer section hides its inner headers; hidden items still count", () => {
  const list = [{ id: "r1", g: [] }, { id: "pr1", g: ["a:pull"] }, { id: "b1", g: ["a:branch"] }, { id: "b2", g: ["a:branch"], more: true },
    { id: "r2", g: [] }, { id: "pr2", g: ["b:pull"] }];
  const fold = foldState();
  const shown = sectioned(list, (x) => x.g, fold.folded, (x) => x.more);
  assert.deepEqual(rows(shown), ["r1", "▾a:pull·1", "pr1", "▾a:branch·2", "b1", "r2", "▾b:pull·1", "pr2"]);
  const outer = [{ id: "x", g: ["top", "top:in"] }, { id: "y", g: ["top", "top:in"] }];
  fold.toggle("top");
  assert.deepEqual(rows(sectioned(outer, (x) => x.g, fold.folded)), ["▸top·2"]);
});
