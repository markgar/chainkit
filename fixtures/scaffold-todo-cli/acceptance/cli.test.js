// GRADER for the whole package. This is the only suite that legitimately needs all
// four modules: it checks what per-chunk grading structurally cannot -- modules
// that are each correct and wired together wrong.
import test from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/app.js";

const sample = () => [
  { id: 1, title: "buy milk", done: false },
  { id: 2, title: "walk dog", done: true },
  { id: 3, title: "pay rent", done: false },
];

test("add: returns the new list and renders everything", () => {
  const { list, output } = run(["add", "buy", "milk"], []);
  assert.deepEqual(list, [{ id: 1, title: "buy milk", done: false }]);
  assert.equal(output, "1. [ ] buy milk\n1 of 1 remaining");
});

test("done: toggles, then renders ALL todos -- not just the open ones", () => {
  const { list, output } = run(["done", "1"], sample());
  assert.equal(list[0].done, true);
  assert.equal(output, "1. [x] buy milk\n2. [x] walk dog\n3. [ ] pay rent\n1 of 3 remaining");
});

test("rm: removes, and the footer reflects the list AFTER the change", () => {
  const { list, output } = run(["rm", "3"], sample());
  assert.deepEqual(
    list.map((t) => t.id),
    [1, 2],
  );
  assert.equal(output, "1. [ ] buy milk\n2. [x] walk dog\n1 of 2 remaining");
});

test("clear: drops the done ones", () => {
  const { list, output } = run(["clear"], sample());
  assert.deepEqual(
    list.map((t) => t.id),
    [1, 3],
  );
  assert.equal(output, "1. [ ] buy milk\n3. [ ] pay rent\n2 of 2 remaining");
});

test("list: does not change the list", () => {
  const before = sample();
  const { list, output } = run(["list"], before);
  assert.deepEqual(list, before);
  assert.equal(output, "1. [ ] buy milk\n2. [x] walk dog\n3. [ ] pay rent\n2 of 3 remaining");
});

// THE WIRING TEST. Each module can be perfect and this can still be wrong: the
// view is filtered, the footer is not.
test("list --filter: the view is filtered, the footer still counts the whole list", () => {
  assert.equal(run(["list", "--filter", "done"], sample()).output, "2. [x] walk dog\n2 of 3 remaining"); // prettier-ignore
  assert.equal(run(["list", "--filter", "open"], sample()).output, "1. [ ] buy milk\n3. [ ] pay rent\n2 of 3 remaining"); // prettier-ignore
});

test("a filter that matches nothing still shows the footer", () => {
  const list = [{ id: 1, title: "buy milk", done: false }];
  assert.equal(run(["list", "--filter", "done"], list).output, "nothing to show\n1 of 1 remaining");
});

test("errors from any module reach the caller unchanged", () => {
  assert.throws(() => run(["nope"], []), RangeError);
  assert.throws(() => run(["add"], []), RangeError);
  assert.throws(() => run(["rm", "99"], sample()), RangeError);
  assert.throws(() => run(["rm", "abc"], sample()), RangeError);
  assert.throws(() => run(["list", "--filter", "active"], sample()), RangeError);
  assert.throws(() => run(null, []), TypeError);
  assert.throws(() => run(["list"], null), TypeError);
});

test("run does not mutate the list it was given", () => {
  const before = sample();
  const snapshot = JSON.parse(JSON.stringify(before));
  run(["add", "x"], before);
  run(["done", "1"], before);
  run(["rm", "1"], before);
  run(["clear"], before);
  assert.deepEqual(before, snapshot);
});

test("a sequence threads through: the list out is the list in", () => {
  let list = [];
  ({ list } = run(["add", "buy", "milk"], list));
  ({ list } = run(["add", "walk", "dog"], list));
  ({ list } = run(["done", "1"], list));
  const { output } = run(["list", "--filter", "open"], list);
  assert.equal(output, "2. [ ] walk dog\n1 of 2 remaining");
});
