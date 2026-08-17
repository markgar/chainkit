// REFERENCE. Never copied into a run's workdir; see check-grader.mjs.
const isDigits = (s) => /^[0-9]+$/.test(s);

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  for (const a of argv) if (typeof a !== "string") throw new TypeError("argv must be strings");
  if (argv.length === 0) throw new RangeError("no command");

  const [cmd, ...rest] = argv;

  if (cmd === "add") {
    const title = rest.join(" ").trim();
    if (title === "") throw new RangeError("add needs a title");
    return { cmd: "add", title };
  }

  if (cmd === "done" || cmd === "rm") {
    if (rest.length !== 1) throw new RangeError(`${cmd} takes exactly one id`);
    if (!isDigits(rest[0])) throw new RangeError(`not an id: ${rest[0]}`);
    return { cmd: cmd === "done" ? "toggle" : "remove", id: Number(rest[0]) };
  }

  if (cmd === "clear") {
    if (rest.length !== 0) throw new RangeError("clear takes no arguments");
    return { cmd: "clear" };
  }

  if (cmd === "list") {
    if (rest.length === 0) return { cmd: "list", filter: "all" };
    if (rest[0] !== "--filter" || rest.length !== 2) throw new RangeError("usage: list [--filter <all|open|done>]"); // prettier-ignore
    const filter = rest[1];
    if (!["all", "open", "done"].includes(filter)) throw new RangeError(`unknown filter ${filter}`);
    return { cmd: "list", filter };
  }

  throw new RangeError(`unknown command ${cmd}`);
}
