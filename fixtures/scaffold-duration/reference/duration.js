const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
const PAIR = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)/;

export function parseDuration(input) {
  if (typeof input !== "string") throw new TypeError("expected a string");
  let rest = input.trim();
  if (rest === "") throw new SyntaxError("empty duration");
  const seen = new Set();
  let total = 0;
  while (rest !== "") {
    const m = PAIR.exec(rest);
    if (!m) throw new SyntaxError(`bad duration: ${input}`);
    if (seen.has(m[2])) throw new SyntaxError(`repeated unit: ${m[2]}`);
    seen.add(m[2]);
    total += Number(m[1]) * UNITS[m[2]];
    rest = rest.slice(m[0].length).replace(/^\s+/, "");
  }
  return Math.round(total);
}

export function formatDuration(ms) {
  if (typeof ms !== "number") throw new TypeError("expected a number");
  if (!Number.isInteger(ms) || ms < 0) throw new RangeError("expected a non-negative integer");
  if (ms === 0) return "0ms";
  let rest = ms;
  let out = "";
  for (const u of ["d", "h", "m", "s", "ms"]) {
    const n = Math.floor(rest / UNITS[u]);
    if (n > 0) out += `${n}${u}`;
    rest -= n * UNITS[u];
  }
  return out;
}
