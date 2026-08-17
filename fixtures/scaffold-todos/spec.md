# Spec: `todos` — a zero-dependency todo list core

Scaffold a small Node package from nothing. The working directory is empty except for an `acceptance/` folder.

This is the familiar todo list with the screen removed: every operation is a pure function over a list. There is no storage, no UI, no clock, no randomness — so a run either implements the described behaviour or does not, and nothing else can move the result.

## Rules of the exercise

- **Do not modify, delete, or add anything under `acceptance/`.** Those tests are the grader. Changing them fails the run.
- No dependencies. No `npm install`. Standard library only.
- ES modules.

## Files to create

- `package.json` — name `todos`, `"type": "module"`, and a `test` script that runs `node --test acceptance/*.test.js`.
- `src/todos.js` — exports `addTodo`, `toggleTodo`, `removeTodo`, `renameTodo`, `clearCompleted`, `filterTodos`, and `countRemaining` as **named** exports.
- `README.md` — a short usage section.

## The shape of a todo

```js
{ id: 1, title: "buy milk", done: false }
```

A list is a plain array of those, in insertion order. An empty list is `[]`.

## Nothing mutates its input

**Every function below returns a new array. None of them modifies the array it was given, or any object inside it.** Callers hold on to earlier versions — that is the whole reason this is a set of pure functions rather than a class.

This applies to the todos themselves: changing one produces a new object for that one. The untouched todos may be the very same objects, since nothing ever writes to them.

A function with no work to do — `clearCompleted` on a list where nothing is completed — still returns a new array.

## `addTodo(list, title)` → new list

Appends a todo at the end.

- `title` is trimmed of leading and trailing whitespace before it is stored.
- **The new id is one greater than the largest id present in the list**, or `1` when the list is empty. Ids are unique within a list at any moment; they are not reserved forever. Empty a list completely and the next id is `1` again.
- `done` starts as `false`.
- Errors: `list` not an array → `TypeError`. `title` not a string → `TypeError`. `title` empty after trimming → `RangeError`.

## `toggleTodo(list, id)` → new list

Flips `done` on the todo with that id, leaving every other todo untouched and the order unchanged.

- Errors: `list` not an array → `TypeError`. `id` not a number → `TypeError`. No todo with that id → `RangeError`.

## `removeTodo(list, id)` → new list

Removes that todo. The order of the rest is unchanged.

- Errors: the same three as `toggleTodo`.

## `renameTodo(list, id, title)` → new list

Replaces the title of that todo. Its `done` and its position are unchanged.

- `title` is trimmed and must be non-empty afterwards — the same rules as `addTodo`.
- Errors: `list` not an array → `TypeError`. `id` not a number → `TypeError`. `title` not a string → `TypeError`. No todo with that id → `RangeError`. Title empty after trimming → `RangeError`.

**Error precedence:** a `title` of the wrong type is a `TypeError` even when the id also does not exist. Check the argument types before looking anything up.

## `clearCompleted(list)` → new list

Drops every todo with `done: true`. The order of the rest is unchanged.

- Errors: `list` not an array → `TypeError`.

## `filterTodos(list, filter)` → new list

- `"all"` → every todo.
- `"active"` → only `done: false`.
- `"completed"` → only `done: true`.
- Order is always preserved.
- Errors: `list` not an array → `TypeError`. `filter` not a string → `TypeError`. Any string other than those three → `RangeError`. It is **case-sensitive**, so `"All"` is a `RangeError`.

## `countRemaining(list)` → number

How many todos are not done. `0` for an empty list.

- Errors: `list` not an array → `TypeError`.

## Examples

```js
let list = [];
list = addTodo(list, "  buy milk  "); // [{ id: 1, title: "buy milk", done: false }]
list = addTodo(list, "walk dog"); // ids 1, 2
list = toggleTodo(list, 1); // id 1 is now done
countRemaining(list); // 1
filterTodos(list, "active"); // [{ id: 2, title: "walk dog", done: false }]
list = clearCompleted(list); // [{ id: 2, ... }]
list = addTodo(list, "pay rent"); // id 3 -- the largest id present was 2
```

## Done when

`node --test acceptance/*.test.js` passes with every test green, and `acceptance/` is byte-for-byte unchanged.
