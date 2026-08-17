// REFERENCE. Never copied into a run's workdir; see check-grader.mjs.
import { parseArgs } from "./parse.js";
import {
  addTodo,
  toggleTodo,
  removeTodo,
  clearCompleted,
  filterTodos,
  countRemaining,
} from "./store.js";
import { renderList, renderFooter } from "./render.js";

export function run(argv, list) {
  if (!Array.isArray(list)) throw new TypeError("list must be an array");
  const command = parseArgs(argv);

  let next = list;
  let view;

  if (command.cmd === "add") next = addTodo(list, command.title);
  else if (command.cmd === "toggle") next = toggleTodo(list, command.id);
  else if (command.cmd === "remove") next = removeTodo(list, command.id);
  else if (command.cmd === "clear") next = clearCompleted(list);

  // The view is filtered only for `list`; every other command shows everything.
  // The footer always counts `next`, never the view -- that is why they are two
  // separate calls rather than one render of the same array.
  view = command.cmd === "list" ? filterTodos(next, command.filter) : next;

  return { list: next, output: `${renderList(view)}\n${renderFooter(countRemaining(next), next.length)}` }; // prettier-ignore
}
