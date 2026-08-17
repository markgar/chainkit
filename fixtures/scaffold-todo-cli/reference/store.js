// REFERENCE. Never copied into a run's workdir; see check-grader.mjs.
const asList = (list) => {
  if (!Array.isArray(list)) throw new TypeError("list must be an array");
  return list;
};

const indexOfId = (list, id) => {
  if (typeof id !== "number") throw new TypeError("id must be a number");
  const i = list.findIndex((t) => t.id === id);
  if (i === -1) throw new RangeError(`no todo with id ${id}`);
  return i;
};

export function addTodo(list, title) {
  asList(list);
  if (typeof title !== "string") throw new TypeError("title must be a string");
  const trimmed = title.trim();
  if (trimmed === "") throw new RangeError("title must not be empty");
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

export function clearCompleted(list) {
  asList(list);
  return list.filter((t) => !t.done);
}

export function filterTodos(list, filter) {
  asList(list);
  if (typeof filter !== "string") throw new TypeError("filter must be a string");
  if (filter === "all") return [...list];
  if (filter === "open") return list.filter((t) => !t.done);
  if (filter === "done") return list.filter((t) => t.done);
  throw new RangeError(`unknown filter ${filter}`);
}

export function countRemaining(list) {
  asList(list);
  return list.filter((t) => !t.done).length;
}
