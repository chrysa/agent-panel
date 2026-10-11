import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLines, fitLine } from "../src/header.mjs";

test("keeps colors, drops other control sequences and blank lines", () => {
  const out = cleanLines("\x1b[32mperso\x1b[0m\x1b[2J\x07\n\n\x1b]0;title\x07x\n");
  assert.deepEqual(out, ["\x1b[32mperso\x1b[0m", "0;titlex"]);
});

test("at most six lines", () => {
  assert.equal(cleanLines("a\nb\nc\nd\ne\nf\ng\n").length, 6);
});

test("cuts a line wider than the panel as plain text", () => {
  assert.equal(fitLine("\x1b[31mabcdef\x1b[0m", 4), "abc…");
  assert.equal(fitLine("\x1b[31mab\x1b[0m", 4), "\x1b[31mab\x1b[0m\x1b[0m");
});
