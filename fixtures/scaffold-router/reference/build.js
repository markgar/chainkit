export function build(compiled, params) {
  const out = [];
  for (const s of compiled.segments) {
    if (s.kind === "static") {
      out.push(s.value);
      continue;
    }
    if (s.kind === "param") {
      const v = params == null ? undefined : params[s.name];
      if (v === undefined) throw new TypeError(`missing param ":${s.name}"`);
      out.push(String(v));
      continue;
    }
    const rest = params == null ? undefined : params["*"];
    if (rest === undefined || rest === "") continue;
    out.push(String(rest));
  }
  return "/" + out.join("/");
}
