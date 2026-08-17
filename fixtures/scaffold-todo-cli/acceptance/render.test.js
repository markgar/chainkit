// GRADER for chunk `render`. Imports ONLY src/render.js.
import test from "node:test";
import assert from "node:assert/strict";

import { renderList, renderFooter } from "../src/render.js";

test("one line per todo, marker reflects done", () => {
  const out = renderList([
    { id: 1, title: "buy milk", done: false },
    { id: 2, title: "walk dog", done: true },
  ]);
  assert.equal(out, "1. [ ] buy milk\n2. [x] walk dog");
});

test("the empty marker is exactly one space, and spacing is exact", () => {
  assert.equal(renderList([{ id: 7, title: "x", done: false }]), "7. [ ] x");
  assert.equal(renderList([{ id: 7, title: "x", done: true }]), "7. [x] x");
});

test("no trailing newline", () => {
  const out = renderList([{ id: 1, title: "a", done: false }]);
  assert.equal(out.endsWith("\n"), false);
  assert.equal(out.split("\n").length, 1);
});

test("ids are printed as given, not as positions", () => {
  const out = renderList([
    { id: 4, title: "a", done: false },
    { id: 9, title: "b", done: false },
  ]);
  assert.equal(out, "4. [ ] a\n9. [ ] b");
});

test("an empty list is the single line 'nothing to show'", () => {
  assert.equal(renderList([]), "nothing to show");
});

test("renderList rejects a non-array", () => {
  assert.throws(() => renderList(null), TypeError);
  assert.throws(() => renderList("a"), TypeError);
});

test("the footer wording is fixed, with no pluralisation and no zero case", () => {
  assert.equal(renderFooter(1, 3), "1 of 3 remaining");
  assert.equal(renderFooter(0, 0), "0 of 0 remaining");
  assert.equal(renderFooter(1, 1), "1 of 1 remaining");
  assert.equal(renderFooter(2, 2), "2 of 2 remaining");
});

test("the footer rejects wrong types and bad values", () => {
  assert.throws(() => renderFooter("1", 3), TypeError);
  assert.throws(() => renderFooter(1, null), TypeError);
  assert.throws(() => renderFooter(-1, 3), RangeError);
  assert.throws(() => renderFooter(1.5, 3), RangeError);
  assert.throws(() => renderFooter(1, NaN), RangeError);
  assert.throws(() => renderFooter(1, Infinity), RangeError);
});
