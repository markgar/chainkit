// The designer's READ SIDE: find the roots, list the chains, and build the design
// model from one. No SDK, no server, no HTML -- on purpose.
//
// It was all inside extension.mjs, which imports the extension SDK and therefore
// cannot be loaded outside the extension host. That put the only logic worth
// testing behind an import nothing could satisfy, and the selftest said so in a
// scope note rather than covering it. This is the same split the run canvas
// already had (telemetry.mjs beside its extension.mjs), applied here.
//
// The stakes are the usual ones for read-side code: a broken write fails loudly,
// a broken read returns a plausible answer. A roots bug here does not throw, it
// renders a confident, empty, wrong panel -- which is exactly what happened once.

import { existsSync, readFileSync, realpathSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

// TWO DIFFERENT ROOTS, and conflating them is the bug. The ENGINE root holds
// `kernel/` -- it is vendored, replaced wholesale, and there is exactly one. The
// CHAIN roots hold chain files -- `.chainkit/` is the processes this repo runs and
// `vendor/chainkit/` is the engine's own examples, and both are real. The designer
// validates a chain from either root using the one engine.
export function engineRoot(workspacePath, { base = repoRoot } = {}) {
  for (const b of [base, workspacePath, process.cwd()]) {
    if (!b) continue;
    const cand = path.join(b, "vendor", "chainkit");
    if (existsSync(path.join(cand, "kernel"))) return cand;
  }
  return path.join(base, "vendor", "chainkit");
}

export function chainRoots(workspacePath, input, { base = repoRoot } = {}) {
  if (input?.root) return [path.isAbsolute(input.root) ? input.root : path.join(base, input.root)];
  const out = [];
  // Dedupe by RESOLVED path, not by the string: the same directory routinely
  // arrives by two different spellings (a symlinked parent, `.` vs an absolute
  // base), and a string compare then lists one root twice -- so the picker shows
  // every chain in it twice and the user cannot tell which entry is which.
  const seen = new Set();
  for (const b of [base, workspacePath, process.cwd()]) {
    if (!b) continue;
    for (const rel of [".chainkit", path.join("vendor", "chainkit")]) {
      const cand = path.join(b, rel);
      let key = cand;
      try {
        key = realpathSync(cand);
      } catch {
        /* not present; findChainFiles below will say so */
      }
      if (seen.has(key)) continue;
      if (findChainFiles(cand).length) {
        seen.add(key);
        out.push(cand);
      }
    }
  }
  return out.length ? out : [path.join(base, ".chainkit")];
}

// Load the engine's OWN loader/validator at call time rather than at import time.
// Imported eagerly, a syntax error in the kernel would take down the whole
// extension with an opaque startup failure; loaded here, it surfaces as an error
// in the panel where it can be read.
async function kernel(root) {
  const url = pathToFileURL(path.join(root, "kernel", "config.mjs")).href;
  // Cache-bust so an edited kernel is picked up without restarting the extension.
  return import(`${url}?t=${Date.now()}`);
}

// Chain files are found RECURSIVELY rather than in one fixed directory, because
// there are two conventions in the wild and both are legitimate: a repo that keeps
// `chains/*.yaml` side by side, and the examples here, which keep one chain and its
// own prompts per directory so a reader gets a whole worked process in one place.
// A chain file is EITHER `chain.yaml` in its own directory OR any yaml inside a
// directory named `chains/`. That is a stated convention rather than a blocklist:
// "any .yaml under the root" is greedy enough to offer a lockfile or a CI workflow
// as a chain, and skipping dot-directories only hides half of that.
const SKIP = new Set(["node_modules", "results", "fixtures", "kernel", "extensions"]);
function isChainFile(full) {
  if (!/\.ya?ml$/i.test(full)) return false;
  const base = path.basename(full).toLowerCase();
  if (base === "chain.yaml" || base === "chain.yml") return true;
  return path.basename(path.dirname(full)) === "chains";
}
function findChainFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // a broken symlink is not a chain
    }
    if (st.isDirectory()) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      findChainFiles(full, out);
    } else if (isChainFile(full)) out.push(full);
  }
  return out;
}

export function listChains(root) {
  const roots = Array.isArray(root) ? root : [root];
  if (roots.length > 1)
    return roots.flatMap((r) => listChains(r)).sort((a, b) => a.name.localeCompare(b.name));
  // The NAME is the path relative to its root, so two chains both called
  // `chain.yaml` in different example directories stay distinguishable in the
  // picker -- which they would not be if the basename were the label.
  return findChainFiles(roots[0])
    .map((file) => ({ name: path.relative(roots[0], file), file }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveChainFile(roots, want) {
  const all = Array.isArray(roots) ? roots : [roots];
  const chains = listChains(all);
  if (!want) return chains[0]?.file || null;
  if (path.isAbsolute(want)) return want;
  const norm = (n) => n.replace(/\.ya?ml$/i, "");
  const hit =
    chains.find((c) => c.name === want || norm(c.name) === want) ||
    // Also accept the containing directory's name, which is how the examples read
    // aloud ("04-plan-and-fan-out") even though every file in them is chain.yaml.
    chains.find((c) => path.basename(path.dirname(c.file)) === want);
  return hit ? hit.file : path.join(all[0], want);
}

// Build the DESIGN model: what the chain says it will do, before it does any of it.
//
// The interesting part is the artifact wiring, which is implicit in the config --
// a stage declares only what it PRODUCES, and its inputs are whatever placeholders
// its prompt file uses. Resolving that here is the whole value of the view: it
// makes the data flow visible instead of leaving it spread across N prompt files.
export async function readDesign(root, file) {
  if (!file || !existsSync(file)) return { file, exists: false };

  const { loadChain, resolveStages } = await kernel(root);
  let chain, promptRoot, errors;
  try {
    ({ chain, promptRoot, errors } = loadChain(file));
  } catch (e) {
    // A malformed file is the NORMAL state while someone is editing it. Show the
    // parse error in place and keep the panel alive rather than blanking it.
    return {
      file,
      exists: true,
      parseError: String(e.message || e),
      mtime: statSync(file).mtimeMs,
    };
  }

  const stages = resolveStages(chain);
  const seeds = Object.entries(chain.seeds || {}).map(([k, v]) => ({
    name: k,
    from: typeof v === "string" && v.startsWith("@") ? v.slice(1) : null,
    missing:
      typeof v === "string" && v.startsWith("@")
        ? !existsSync(path.resolve(promptRoot, v.slice(1)))
        : false,
  }));

  const produced = new Set(seeds.map((s) => s.name));
  const loopIds = new Set(chain.loop?.stages || []);
  const completionRepairIds = new Set(chain.completion?.repair?.stages || []);
  const foreachCompletionRepairIds = new Set(chain.foreach?.completion?.repair?.stages || []);

  const view = stages.map((s) => {
    const promptFile = s.prompt ? path.resolve(promptRoot, s.prompt) : null;
    let uses = [];
    const promptMissing = !!promptFile && !existsSync(promptFile);
    let promptChars = 0;
    if (s.run) {
      promptChars = s.run.length;
      uses = [
        ...new Set([...s.run.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1].split(".")[0])),
      ];
    } else if (!promptMissing) {
      const text = readFileSync(promptFile, "utf8");
      promptChars = text.length;
      uses = [
        ...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1].split(".")[0])),
      ];
    }
    const row = {
      ...s,
      prompt: s.prompt,
      promptFile,
      promptMissing,
      promptChars,
      uses,
      // Unresolved inputs are shown per stage rather than only in the error list,
      // so the break is visible AT the stage that breaks.
      unresolved: uses.filter((u) => !produced.has(u)),
      inLoop: loopIds.has(s.id),
      inCompletionRepair: completionRepairIds.has(s.id),
      inForeachCompletionRepair: foreachCompletionRepairIds.has(s.id),
    };
    if (s.produces) produced.add(s.produces);
    return row;
  });

  return {
    file,
    exists: true,
    mtime: statSync(file).mtimeMs,
    name: chain.name || path.basename(file),
    // The file's own comments are the design rationale -- the reason chains are
    // YAML at all -- so the header comment block is surfaced as the description.
    intent: headComment(readFileSync(file, "utf8")),
    seeds,
    stages: view,
    loop: chain.loop
      ? { stages: chain.loop.stages || [], until: chain.loop.until, max: chain.loop.max }
      : null,
    foreach: chain.foreach || null,
    completion: chain.completion || null,
    requires: chain.requires || null,
    defaults: chain.defaults || {},
    errors,
  };
}

export function headComment(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) {
      if (lines.length) break;
      continue;
    }
    if (!l.startsWith("#")) break;
    lines.push(l.replace(/^#\s?/, ""));
  }
  return lines.join("\n").trim();
}
