import { compile } from "./compile.js";
import { match } from "./match.js";

export function createRouter() {
  const routes = [];
  const router = {
    add(method, pattern, handler) {
      const compiled = compile(pattern);
      routes.push({
        method: String(method).toUpperCase(),
        pattern: String(pattern),
        compiled,
        handler,
      });
      return router;
    },
    resolve(method, path) {
      const m = String(method).toUpperCase();
      let best = null;
      for (const r of routes) {
        if (r.method !== m) continue;
        const hit = match(r.compiled, path);
        if (!hit) continue;
        if (best === null || r.compiled.score > best.score) {
          best = { handler: r.handler, params: hit.params, score: r.compiled.score };
        }
      }
      return best === null ? null : { handler: best.handler, params: best.params };
    },
    routes() {
      return routes.map((r) => ({
        method: r.method,
        pattern: r.pattern,
        score: r.compiled.score,
      }));
    },
  };
  return router;
}
