// GRADER. This file is the objective oracle for the scaffold-todos job: it is
// placed in the empty repo BEFORE the run, and the run is told not to touch it.
// The gate re-checks it is unmodified. Without that, a process could write its own
// weak tests, pass them, and score as a delivery -- a green it graded itself.
import test from "node:test";
import assert from "node:assert/strict";

import {
  addTodo,
  toggleTodo,
  removeTodo,
  renameTodo,
  clearCompleted,
  filterTodos,
  countRemaining,
} from "../src/todos.js";

const sample = () => [
  { id: 1, title: "buy milk", done: false },
  { id: 2, title: "walk dog", done: true },
  { id: 3, title: "pay rent", done: false },
];

test("addTodo: appends with the next id, not done", () => {
  assert.deepEqual(addTodo([], "buy milk"), [{ id: 1, title: "buy milk", done: false }]);
  const two = addTodo(addTodo([], "a"), "b");
  assert.deepEqual(
    two.map((t) => t.id),
    [1, 2],
  );
  assert.equal(two[1].title, "b");
  assert.equal(two[1].done, false);
});

test("addTodo: the next id is one past the LARGEST present, not the length", () => {
  const list = [{ id: 7, title: "old", done: false }];
  assert.equal(addTodo(list, "new")[1].id, 8);
  // A gap does not shift anything: 1 and 5 present -> next is 6.
  const gapped = [
    { id: 1, title: "a", done: false },
    { id: 5, title: "b", done: false },
  ];
  assert.equal(addTodo(gapped, "c")[2].id, 6);
});

test("addTodo: ids are not reserved forever -- an emptied list restarts at 1", () => {
  const list = addTodo(addTodo([], "a"), "b");
  const emptied = removeTodo(removeTodo(list, 1), 2);
  assert.deepEqual(emptied, []);
  assert.equal(addTodo(emptied, "fresh")[0].id, 1);
});

test("addTodo: title is trimmed", () => {
  assert.equal(addTodo([], "  buy milk  ")[0].title, "buy milk");
  assert.equal(addTodo([], "\tbuy milk\n")[0].title, "buy milk");
});

test("addTodo: rejects a non-array list, a non-string title, an empty title", () => {
  assert.throws(() => addTodo(null, "a"), TypeError);
  assert.throws(() => addTodo("nope", "a"), TypeError);
  assert.throws(() => addTodo([], 5), TypeError);
  assert.throws(() => addTodo([], undefined), TypeError);
  assert.throws(() => addTodo([], ""), RangeError);
  assert.throws(() => addTodo([], "   "), RangeError);
});

test("toggleTodo: flips exactly one, leaves order alone", () => {
  const out = toggleTodo(sample(), 1);
  assert.equal(out[0].done, true);
  assert.equal(out[1].done, true);
  assert.equal(out[2].done, false);
  assert.deepEqual(
    out.map((t) => t.id),
    [1, 2, 3],
  );
  assert.equal(toggleTodo(sample(), 2)[1].done, false);
});

test("toggleTodo: rejects a bad list, a non-number id, an unknown id", () => {
  assert.throws(() => toggleTodo(null, 1), TypeError);
  assert.throws(() => toggleTodo(sample(), "1"), TypeError);
  assert.throws(() => toggleTodo(sample(), 99), RangeError);
});

test("removeTodo: drops one, keeps the order of the rest", () => {
  assert.deepEqual(
    removeTodo(sample(), 2).map((t) => t.id),
    [1, 3],
  );
  assert.deepEqual(
    removeTodo(sample(), 1).map((t) => t.id),
    [2, 3],
  );
  assert.deepEqual(removeTodo([{ id: 4, title: "only", done: false }], 4), []);
});

test("removeTodo: rejects a bad list, a non-number id, an unknown id", () => {
  assert.throws(() => removeTodo({}, 1), TypeError);
  assert.throws(() => removeTodo(sample(), null), TypeError);
  assert.throws(() => removeTodo(sample(), 99), RangeError);
});

test("renameTodo: replaces the title, trims it, keeps done and position", () => {
  const out = renameTodo(sample(), 2, "  walk the dog  ");
  assert.equal(out[1].title, "walk the dog");
  assert.equal(out[1].done, true);
  assert.equal(out[1].id, 2);
  assert.deepEqual(
    out.map((t) => t.id),
    [1, 2, 3],
  );
});

test("renameTodo: a bad title type is a TypeError even when the id is also unknown", () => {
  assert.throws(() => renameTodo(sample(), 99, 5), TypeError);
  assert.throws(() => renameTodo(sample(), 99, "fine"), RangeError);
  assert.throws(() => renameTodo(sample(), 1, "   "), RangeError);
  assert.throws(() => renameTodo(sample(), "1", "fine"), TypeError);
});

test("clearCompleted: drops the done ones, order preserved", () => {
  assert.deepEqual(
    clearCompleted(sample()).map((t) => t.id),
    [1, 3],
  );
  assert.deepEqual(clearCompleted([]), []);
  assert.throws(() => clearCompleted(null), TypeError);
});

test("filterTodos: all, active, completed -- in order", () => {
  assert.deepEqual(
    filterTodos(sample(), "all").map((t) => t.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    filterTodos(sample(), "active").map((t) => t.id),
    [1, 3],
  );
  assert.deepEqual(
    filterTodos(sample(), "completed").map((t) => t.id),
    [2],
  );
});

test("filterTodos: unknown filter is RangeError, and it is case-sensitive", () => {
  assert.throws(() => filterTodos(sample(), "done"), RangeError);
  assert.throws(() => filterTodos(sample(), "All"), RangeError);
  assert.throws(() => filterTodos(sample(), ""), RangeError);
  assert.throws(() => filterTodos(sample(), 1), TypeError);
  assert.throws(() => filterTodos(null, "all"), TypeError);
});

test("countRemaining: counts the not-done", () => {
  assert.equal(countRemaining(sample()), 2);
  assert.equal(countRemaining([]), 0);
  assert.equal(countRemaining([{ id: 1, title: "a", done: true }]), 0);
  assert.throws(() => countRemaining("nope"), TypeError);
});

// The property the whole spec turns on, checked for every function that returns a
// list -- including the two that have nothing to do. An implementation that
// mutates passes almost every assertion above, because they mostly inspect the
// value that came back.
test("nothing mutates its input", () => {
  const original = sample();
  const snapshot = JSON.parse(JSON.stringify(original));
  const first = original[0];

  addTodo(original, "new");
  toggleTodo(original, 1);
  removeTodo(original, 1);
  renameTodo(original, 1, "renamed");
  clearCompleted(original);
  filterTodos(original, "active");
  countRemaining(original);

  assert.deepEqual(original, snapshot, "the input array was modified");
  assert.equal(original[0], first, "a todo object was replaced in place");
});

test("a returned list is always a new array, even when nothing changed", () => {
  const nothingDone = [{ id: 1, title: "a", done: false }];
  assert.notEqual(clearCompleted(nothingDone), nothingDone);
  assert.notEqual(filterTodos(nothingDone, "all"), nothingDone);
});

test("changing one todo does not rewrite the others", () => {
  const list = sample();
  const out = toggleTodo(list, 1);
  assert.notEqual(out[0], list[0], "the changed todo should be a new object");
  assert.equal(out[1], list[1], "an untouched todo may -- and should -- be shared");
});
