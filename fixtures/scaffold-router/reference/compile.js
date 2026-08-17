export function compile(pattern) {
  const raw = String(pattern);
  let body = raw.startsWith("/") ? raw.slice(1) : raw;
  if (body.endsWith("/")) body = body.slice(0, -1);
  const parts = body === "" ? [] : body.split("/");

  const segments = [];
  const seen = new Set();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "") throw new SyntaxError(`empty segment in pattern "${raw}"`);
    if (p === "*") {
      if (i !== parts.length - 1)
        throw new SyntaxError(`wildcard must be the last segment in pattern "${raw}"`);
      segments.push({ kind: "wildcard" });
      continue;
    }
    if (p.startsWith(":")) {
      const name = p.slice(1);
      if (name === "") throw new SyntaxError(`param with no name in pattern "${raw}"`);
      if (seen.has(name)) throw new SyntaxError(`duplicate param ":${name}" in pattern "${raw}"`);
      seen.add(name);
      segments.push({ kind: "param", name });
      continue;
    }
    segments.push({ kind: "static", value: p });
  }

  const score = segments.reduce(
    (n, s) => n + (s.kind === "static" ? 3 : s.kind === "param" ? 2 : 1),
    0,
  );
  return { segments, score };
}
