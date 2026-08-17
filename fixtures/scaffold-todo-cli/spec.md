# Spec: `todo-cli` — a zero-dependency todo list command line, in four modules

Scaffold a small Node package from nothing. The working directory is empty except for an `acceptance/` folder.

This is the todo list again, but as a command line tool, and deliberately **split into four modules that can be built and graded independently**. Each has its own acceptance suite that imports only that module. A fourth suite checks them wired together.

Everything is a pure function. No file system, no clock, no `process.exit`, no printing — `run()` returns the text it would have printed. That is what makes the behaviour gradeable.

## Rules of the exercise

- **Do not modify, delete, or add anything under `acceptance/`.** Those tests are the grader. Changing them fails the run.
- No dependencies. No `npm install`. Standard library only.
- ES modules.
- **A module may not import another module unless this spec says so.** Only `src/app.js` imports anything.

## Files to create

- `package.json` — name `todo-cli`, `"type": "module"`, and a `test` script that runs `node --test acceptance/*.test.js`.
- `src/parse.js` — exports `parseArgs`.
- `src/store.js` — exports `addTodo`, `toggleTodo`, `removeTodo`, `clearCompleted`, `filterTodos`, `countRemaining`.
- `src/render.js` — exports `renderList`, `renderFooter`.
- `src/app.js` — exports `run`. This is the only module that imports the other three.
- `README.md` — a short usage section.

## The shape of a todo

```js
{ id: 1, title: "buy milk", done: false }
```

A list is a plain array of those, in insertion order.

---

## `src/parse.js`

### `parseArgs(argv)` → command object

`argv` is an array of strings — the arguments after the program name.

| input                          | result                              |
| ------------------------------ | ----------------------------------- |
| `["add", "buy", "milk"]`       | `{ cmd: "add", title: "buy milk" }` |
| `["done", "2"]`                | `{ cmd: "toggle", id: 2 }`          |
| `["rm", "3"]`                  | `{ cmd: "remove", id: 3 }`          |
| `["clear"]`                    | `{ cmd: "clear" }`                  |
| `["list"]`                     | `{ cmd: "list", filter: "all" }`    |
| `["list", "--filter", "done"]` | `{ cmd: "list", filter: "done" }`   |

Notes that are behaviour, not detail:

- `add` joins its remaining arguments with a **single space**, whatever spacing was on the command line, and the result is trimmed. `add` with nothing after it → `RangeError`.
- An id must be **digits only**: `"abc"`, `"1.5"`, `"-1"`, `""` are each a `RangeError`. `"007"` is valid and means `7`.
- `done` and `rm` take exactly one argument. Zero or more than one → `RangeError`.
- `list` accepts `--filter <value>` where value is `all`, `open`, or `done`. Any other value → `RangeError`. `--filter` with nothing after it → `RangeError`. Any other flag or extra argument → `RangeError`.
- `clear` takes no arguments; extra ones → `RangeError`.
- An unknown command, or an empty `argv` → `RangeError`.
- `argv` not an array, or any element not a string → `TypeError`.

## `src/store.js`

Pure list operations. **Nothing mutates its input** — every function returns a new array, and a changed todo is a new object while untouched ones are shared. This holds even when there was nothing to do.

- `addTodo(list, title)` — appends `{ id, title, done: false }`. `title` is trimmed. The new id is **one greater than the largest id present**, or `1` for an empty list. Non-array list or non-string title → `TypeError`; empty-after-trim title → `RangeError`.
- `toggleTodo(list, id)` — flips `done`, order unchanged. Non-array list or non-number id → `TypeError`; unknown id → `RangeError`.
- `removeTodo(list, id)` — removes it, order of the rest unchanged. Same errors as `toggleTodo`.
- `clearCompleted(list)` — drops every `done: true`. Non-array → `TypeError`.
- `filterTodos(list, filter)` — `"all"` → everything, `"open"` → not done, `"done"` → done. Order preserved. Non-array list or non-string filter → `TypeError`; any other string → `RangeError` (case-sensitive).
- `countRemaining(list)` — how many are not done.

## `src/render.js`

Text only. It is given todos and numbers; it looks nothing up and imports nothing.

### `renderList(todos)` → string

One line per todo, joined with `\n`, no trailing newline:

```
1. [ ] buy milk
2. [x] walk dog
```

The marker is `[x]` when done and `[ ]` — with one space — when not. Exactly one space after the `.` and after the `]`.

An empty array renders as the single line `nothing to show`.

Non-array → `TypeError`.

### `renderFooter(remaining, total)` → string

`"1 of 3 remaining"` — always that wording, with no pluralisation and no special case for zero.

Either argument not a number, or not a non-negative integer → `TypeError` for the wrong type, `RangeError` for a bad value (negative, fractional, `NaN`, `Infinity`).

## `src/app.js`

### `run(argv, list)` → `{ list, output }`

The only module that wires the others together.

1. Parse `argv`.
2. Apply the command to `list`, producing the next list. For `list`, nothing changes.
3. Render the output: the rendered view, then `\n`, then the footer.

Which todos appear in the view:

- After `add`, `done`, `rm`, `clear` → **all** todos in the resulting list.
- After `list` → the todos matching the requested filter.

The footer **always counts the whole resulting list**, not the filtered view. That is the point of splitting the two: `list --filter done` can show one line while the footer says `2 of 3 remaining`.

The filter names on the command line (`all`, `open`, `done`) are the same strings `filterTodos` takes; no translation.

`run` does not catch anything. An error from any module reaches the caller unchanged.

Non-array `list` → `TypeError`.

## Example

```js
run(["add", "buy", "milk"], []);
// { list: [{ id: 1, title: "buy milk", done: false }],
//   output: "1. [ ] buy milk\n1 of 1 remaining" }

run(["list", "--filter", "done"], [{ id: 1, title: "buy milk", done: false }]);
// { list: <unchanged>, output: "nothing to show\n1 of 1 remaining" }
```

## Done when

`node --test acceptance/*.test.js` passes with every test green, and `acceptance/` is byte-for-byte unchanged.
