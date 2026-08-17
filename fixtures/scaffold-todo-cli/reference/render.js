// REFERENCE. Never copied into a run's workdir; see check-grader.mjs.
export function renderList(todos) {
  if (!Array.isArray(todos)) throw new TypeError("todos must be an array");
  if (todos.length === 0) return "nothing to show";
  return todos.map((t) => `${t.id}. [${t.done ? "x" : " "}] ${t.title}`).join("\n");
}

export function renderFooter(remaining, total) {
  for (const n of [remaining, total]) {
    if (typeof n !== "number") throw new TypeError("counts must be numbers");
    if (!Number.isInteger(n) || n < 0) throw new RangeError("counts must be non-negative integers");
  }
  return `${remaining} of ${total} remaining`;
}
