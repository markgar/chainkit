// REFERENCE IMPLEMENTATION. Never copied into a run's workdir -- prep-workdir.mjs
// copies only `acceptance/`. It exists so `check-grader.mjs` can prove the grader
// admits a correct solution before the grader is used to judge anything.
const asList = (list) => {
  if (!Array.isArray(list)) throw new TypeError("list must be an array");
  return list;
};

const asTitle = (title) => {
  if (typeof title !== "string") throw new TypeError("title must be a string");
  const trimmed = title.trim();
  if (trimmed === "") throw new RangeError("title must not be empty");
  return trimmed;
};

const indexOfId = (list, id) => {
  if (typeof id !== "number") throw new TypeError("id must be a number");
  const i = list.findIndex((t) => t.id === id);
  if (i === -1) throw new RangeError(`no todo with id ${id}`);
  return i;
};

export function addTodo(list, title) {
  asList(list);
  const trimmed = asTitle(title);
  const id = list.reduce((max, t) => (t.id > max ? t.id : max), 0) + 1;
  return [...list, { id, title: trimmed, done: false }];
}

export function toggleTodo(list, id) {
  asList(list);
  const i = indexOfId(list, id);
  const next = [...list];
  next[i] = { ...list[i], done: !list[i].done };
  return next;
}

export function removeTodo(list, id) {
  asList(list);
  const i = indexOfId(list, id);
  return [...list.slice(0, i), ...list.slice(i + 1)];
}

export function renameTodo(list, id, title) {
  asList(list);
  // Types before lookup: a bad title is a TypeError even when the id is also wrong.
  if (typeof id !== "number") throw new TypeError("id must be a number");
  const trimmed = asTitle(title);
  const i = indexOfId(list, id);
  const next = [...list];
  next[i] = { ...list[i], title: trimmed };
  return next;
}

export function clearCompleted(list) {
  asList(list);
  return list.filter((t) => !t.done);
}

export function filterTodos(list, filter) {
  asList(list);
  if (typeof filter !== "string") throw new TypeError("filter must be a string");
  if (filter === "all") return [...list];
  if (filter === "active") return list.filter((t) => !t.done);
  if (filter === "completed") return list.filter((t) => t.done);
  throw new RangeError(`unknown filter ${filter}`);
}

export function countRemaining(list) {
  asList(list);
  return list.filter((t) => !t.done).length;
}
