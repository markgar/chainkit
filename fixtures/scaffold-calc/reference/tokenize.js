// REFERENCE. Never copied into a workdir -- prep-workdir.mjs copies only acceptance/.
const OPS = new Set(["+", "-", "*", "/"]);

export function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ type: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ type: "rparen" });
      i++;
      continue;
    }
    if (OPS.has(c)) {
      out.push({ type: "op", value: c });
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < src.length && src[i] >= "0" && src[i] <= "9") i++;
      if (src[i] === ".") {
        i++;
        if (!(i < src.length && src[i] >= "0" && src[i] <= "9"))
          throw new SyntaxError(`malformed number at index ${start}`);
        while (i < src.length && src[i] >= "0" && src[i] <= "9") i++;
      }
      out.push({ type: "num", value: Number(src.slice(start, i)) });
      continue;
    }
    throw new SyntaxError(`unexpected character "${c}" at index ${i}`);
  }
  return out;
}
