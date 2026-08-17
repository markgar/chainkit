// GRADER for chunk `parse`. Imports ONLY src/parse.js: if this suite needed a
// neighbouring module it would blame this chunk for another chunk's defect, and
// per-chunk blame is the whole reason rung 04 gates per chunk.
import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/parse.js";

test("add joins the rest with single spaces and trims", () => {
  assert.deepEqual(parseArgs(["add", "buy", "milk"]), { cmd: "add", title: "buy milk" });
  assert.deepEqual(parseArgs(["add", "milk"]), { cmd: "add", title: "milk" });
  assert.deepEqual(parseArgs(["add", "  buy  ", "milk"]), { cmd: "add", title: "buy   milk" });
});

test("add with no words is a RangeError", () => {
  assert.throws(() => parseArgs(["add"]), RangeError);
  assert.throws(() => parseArgs(["add", "   "]), RangeError);
});

test("done and rm map to toggle and remove, with a numeric id", () => {
  assert.deepEqual(parseArgs(["done", "2"]), { cmd: "toggle", id: 2 });
  assert.deepEqual(parseArgs(["rm", "3"]), { cmd: "remove", id: 3 });
  assert.deepEqual(parseArgs(["rm", "007"]), { cmd: "remove", id: 7 });
});

test("an id must be digits only", () => {
  for (const bad of ["abc", "1.5", "-1", "", "1e3", "1 ", "0x2"]) {
    assert.throws(() => parseArgs(["rm", bad]), RangeError, `expected RangeError for ${bad}`);
  }
});

test("done and rm take exactly one argument", () => {
  assert.throws(() => parseArgs(["done"]), RangeError);
  assert.throws(() => parseArgs(["done", "1", "2"]), RangeError);
  assert.throws(() => parseArgs(["rm"]), RangeError);
});

test("clear takes none", () => {
  assert.deepEqual(parseArgs(["clear"]), { cmd: "clear" });
  assert.throws(() => parseArgs(["clear", "all"]), RangeError);
});

test("list defaults to the all filter", () => {
  assert.deepEqual(parseArgs(["list"]), { cmd: "list", filter: "all" });
});

test("list accepts exactly --filter <all|open|done>", () => {
  assert.deepEqual(parseArgs(["list", "--filter", "open"]), { cmd: "list", filter: "open" });
  assert.deepEqual(parseArgs(["list", "--filter", "done"]), { cmd: "list", filter: "done" });
  assert.deepEqual(parseArgs(["list", "--filter", "all"]), { cmd: "list", filter: "all" });
});

test("list rejects a bad filter, a missing value, a stray flag, extra arguments", () => {
  assert.throws(() => parseArgs(["list", "--filter", "active"]), RangeError);
  assert.throws(() => parseArgs(["list", "--filter"]), RangeError);
  assert.throws(() => parseArgs(["list", "--all"]), RangeError);
  assert.throws(() => parseArgs(["list", "open"]), RangeError);
  assert.throws(() => parseArgs(["list", "--filter", "open", "extra"]), RangeError);
});

test("unknown command and empty argv are RangeErrors", () => {
  assert.throws(() => parseArgs(["nope"]), RangeError);
  assert.throws(() => parseArgs([]), RangeError);
});

test("a non-array argv, or a non-string element, is a TypeError", () => {
  assert.throws(() => parseArgs(null), TypeError);
  assert.throws(() => parseArgs("add milk"), TypeError);
  assert.throws(() => parseArgs(["rm", 2]), TypeError);
});
