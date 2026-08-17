// GRADER for chunk `store`. Imports ONLY src/store.js.
import test from "node:test";
import assert from "node:assert/strict";

import {
  addTodo,
  toggleTodo,
  removeTodo,
  clearCompleted,
  filterTodos,
  countRemaining,
} from "../src/store.js";

const sample = () => [
  { id: 1, title: "buy milk", done: false },
  { id: 2, title: "walk dog", done: true },
  { id: 3, title: "pay rent", done: false },
];

test("addTodo appends with the next id past the LARGEST present", () => {
  assert.deepEqual(addTodo([], "buy milk"), [{ id: 1, title: "buy milk", done: false }]);
  assert.equal(addTodo(sample(), "new")[3].id, 4);
  assert.equal(addTodo([{ id: 7, title: "old", done: false }], "new")[1].id, 8);
  const gapped = [
    { id: 1, title: "a", done: false },
    { id: 5, title: "b", done: false },
  ];
  assert.equal(addTodo(gapped, "c")[2].id, 6);
});

test("addTodo trims, and rejects a bad list, a bad title type, an empty title", () => {
  assert.equal(addTodo([], "  buy milk  ")[0].title, "buy milk");
  assert.throws(() => addTodo(null, "a"), TypeError);
  assert.throws(() => addTodo([], 5), TypeError);
  assert.throws(() => addTodo([], "   "), RangeError);
});

test("toggleTodo flips one and keeps the order", () => {
  const out = toggleTodo(sample(), 2);
  assert.equal(out[1].done, false);
  assert.equal(out[0].done, false);
  assert.deepEqual(
    out.map((t) => t.id),
    [1, 2, 3],
  );
  assert.throws(() => toggleTodo(sample(), "2"), TypeError);
  assert.throws(() => toggleTodo(sample(), 99), RangeError);
  assert.throws(() => toggleTodo(null, 1), TypeError);
});

test("removeTodo drops one and keeps the order", () => {
  assert.deepEqual(
    removeTodo(sample(), 2).map((t) => t.id),
    [1, 3],
  );
  assert.deepEqual(removeTodo([{ id: 4, title: "only", done: false }], 4), []);
  assert.throws(() => removeTodo(sample(), 99), RangeError);
  assert.throws(() => removeTodo(sample(), null), TypeError);
});

test("clearCompleted drops the done ones", () => {
  assert.deepEqual(
    clearCompleted(sample()).map((t) => t.id),
    [1, 3],
  );
  assert.deepEqual(clearCompleted([]), []);
  assert.throws(() => clearCompleted("nope"), TypeError);
});

test("filterTodos: all, open, done -- in order, case-sensitive", () => {
  assert.deepEqual(
    filterTodos(sample(), "all").map((t) => t.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    filterTodos(sample(), "open").map((t) => t.id),
    [1, 3],
  );
  assert.deepEqual(
    filterTodos(sample(), "done").map((t) => t.id),
    [2],
  );
  assert.throws(() => filterTodos(sample(), "active"), RangeError);
  assert.throws(() => filterTodos(sample(), "All"), RangeError);
  assert.throws(() => filterTodos(sample(), 1), TypeError);
});

test("countRemaining counts the not-done", () => {
  assert.equal(countRemaining(sample()), 2);
  assert.equal(countRemaining([]), 0);
  assert.throws(() => countRemaining(null), TypeError);
});

// An implementation that mutates passes nearly every assertion above, because
// they inspect the value that came back rather than the one that went in.
test("nothing mutates its input", () => {
  const original = sample();
  const snapshot = JSON.parse(JSON.stringify(original));
  const first = original[0];

  addTodo(original, "new");
  toggleTodo(original, 1);
  removeTodo(original, 1);
  clearCompleted(original);
  filterTodos(original, "open");
  countRemaining(original);

  assert.deepEqual(original, snapshot, "the input array was modified");
  assert.equal(original[0], first, "a todo object was replaced in place");
});

test("a returned list is a new array even when nothing changed, and untouched todos are shared", () => {
  const nothingDone = [{ id: 1, title: "a", done: false }];
  assert.notEqual(clearCompleted(nothingDone), nothingDone);
  assert.notEqual(filterTodos(nothingDone, "all"), nothingDone);

  const list = sample();
  const out = toggleTodo(list, 1);
  assert.notEqual(out[0], list[0], "the changed todo should be a new object");
  assert.equal(out[1], list[1], "an untouched todo may -- and should -- be shared");
});
