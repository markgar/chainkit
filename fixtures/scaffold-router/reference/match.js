export function match(compiled, path) {
  const raw = String(path);
  let body = raw.startsWith("/") ? raw.slice(1) : raw;
  if (body.endsWith("/")) body = body.slice(0, -1);
  const parts = body === "" ? [] : body.split("/");

  const segments = compiled.segments;
  const params = {};

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.kind === "wildcard") {
      params["*"] = parts.slice(i).join("/");
      return { params };
    }
    const p = parts[i];
    if (p === undefined) return null;
    if (s.kind === "static") {
      if (p !== s.value) return null;
      continue;
    }
    if (p === "") return null;
    params[s.name] = p;
  }

  if (parts.length !== segments.length) return null;
  return { params };
}
