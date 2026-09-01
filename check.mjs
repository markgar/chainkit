#!/usr/bin/env node
// chainkit's own gate. This is the whole of it -- what its CI would run once it
// lives in its own repo, and what the host repo's done-bar runs in the meantime.
//
// It ships WITH the engine rather than sitting in the host repo's scripts, on the
// same principle as everything else in this directory: vendor chainkit into a repo
// and its gate comes along, unchanged. Nothing here knows anything about the host.
//
// The selftests are the load-bearing part. prettier and eslint check shape; the
// selftests are the only thing that checks BEHAVIOUR, and they have caught defects
// -- a mis-attributed file, an inference that ordered a post-loop stage wrongly --
// that every other gate here waved through. Read-side defects do not announce
// themselves: a broken write fails loudly, a broken read returns a plausible number.
//
// The canvases are part of the engine's surface, so their selftests run here too.
// They live in the host repo's extensions dir today; when chainkit is extracted
// they move with it, which is why they are looked up rather than hardcoded as
// required -- a missing canvas is reported, not fatal.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadChain, warnChain } from "./kernel/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// The repo chainkit is being checked INSIDE of -- its own, or the host that
// vendored it. Derived by walking up to the nearest git root rather than counting
// directory levels: "two up" is only true while chainkit sits at <host>/vendor/
// chainkit, so the moment it becomes its own repo the old rule pointed hostRoot at
// the directory ABOVE the repo, and prettier/eslint would have run from outside the
// tree they were meant to check. This is the extraction bug the vendoring test
// exists to catch, and it would have shipped silently.
function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // No git anywhere (a tarball, a container copy): standalone if we look like a
  // package root, otherwise fall back to the vendored layout.
  return existsSync(path.join(start, "package.json")) ? start : path.resolve(start, "..", "..");
}
const hostRoot = findRepoRoot(here);
// Where the host repo keeps us, derived rather than written down: prettier and
// eslint run from the host root so they pick up its shared config, and they need
// a path to point at. Hardcoding "vendor/chainkit" would be one more thing to
// remember to change when this directory moves.
const selfPath = path.relative(hostRoot, here) || ".";

// Canvases that belong to the engine, wherever the repo keeps them: under the
// host's extensions dir while vendored, at the top level once extracted.
const canvasNames = ["chainkit-canvas", "chainkit-designer"];
const canvases = canvasNames
  .flatMap((n) => [
    path.join(hostRoot, ".github", "extensions", n, "selftest.mjs"),
    path.join(here, "extensions", n, "selftest.mjs"),
  ])
  .filter((f) => existsSync(f));

// EVERY CHAIN THAT SHIPS WITH THE ENGINE MUST VALIDATE. Without this the gate
// checks the engine's code and none of its config -- a chain with a typo'd
// artifact reference, a missing prompt file or an unbounded loop would pass a
// green build and fail only when someone paid to run it. Validation is free, so
// there is no reason it is not part of the gate.
//
// Orphan prompts are checked at the same time and for the same reason: knip
// reads .mjs and nothing reads these, so a prompt left behind by a deleted chain
// lives forever, and the next reader cannot tell it from a live one.
//
// The root is a PARAMETER, not this directory, because the engine's own chains are
// only ever examples -- the chains a host repo actually runs live in the host, and
// they are the ones whose breakage costs real money. `--chains <dir>` (repeatable)
// lets the host add its own without the engine learning anything about the host.
//
// Discovery is RECURSIVE and layout-agnostic: any .yaml/.yml under the root is a
// chain, and any .md inside a directory named `prompts` is a prompt. That covers
// both shapes without the gate having to know either -- the examples here keep one
// chain and its own prompts per directory, while a host repo usually keeps
// `chains/` and `prompts/` side by side. Dot-directories are skipped, which is also
// what keeps CI workflow YAML from being read as a chain.
const SKIP_DIRS = new Set(["node_modules", "results", "fixtures"]);
function findFiles(dir, test, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      findFiles(full, test, out);
    } else if (test(full)) out.push(full);
  }
  return out;
}

// A chain file is EITHER `chain.yaml` in its own directory (this repo's examples)
// OR any yaml inside a directory named `chains/` (the shape a host repo keeps).
// This is a stated convention, not a blocklist: "every .yaml under the root" is
// greedy enough to swallow a lockfile or a CI workflow and then fail the gate with
// "unknown key: lockfileVersion", which reads as a broken chain rather than as a
// file that was never a chain. CI caught exactly that; a dev tree without a
// lockfile could not.
function isChainFile(full) {
  if (!/\.ya?ml$/i.test(full)) return false;
  const base = path.basename(full).toLowerCase();
  if (base === "chain.yaml" || base === "chain.yml") return true;
  return path.basename(path.dirname(full)) === "chains";
}

function checkChainRoot(root) {
  const files = findFiles(root, isChainFile);
  if (files.length === 0) return [];
  const problems = [];
  const used = new Set();
  for (const full of files) {
    const f = path.relative(root, full);
    let loaded;
    try {
      loaded = loadChain(full);
    } catch (e) {
      problems.push(`${f}: ${e.message}`);
      continue;
    }
    for (const e of loaded.errors) problems.push(`${f}: ${e}`);
    // Warnings are advisory at run time but not here: a chain that ships with the
    // engine is a worked example, and a worked example carrying a known wiring
    // mistake teaches it to everyone who copies it.
    for (const w of warnChain(loaded.chain, { promptRoot: loaded.promptRoot }))
      problems.push(`${f}: ${w}`);
    for (const s of loaded.chain.stages || [])
      if (s.prompt) used.add(path.resolve(loaded.promptRoot, s.prompt));
    for (const s of loaded.chain.stages || [])
      if (s.resumePrompt) used.add(path.resolve(loaded.promptRoot, s.resumePrompt));
    // A seed of the form `@path` reads a file: a supporting doc -- a coding
    // standard, a review rubric -- kept beside the chain instead of pasted into
    // it. Those count as referenced for the same reason prompts do.
    for (const v of Object.values(loaded.chain.seeds || {}))
      if (typeof v === "string" && v.startsWith("@"))
        used.add(path.resolve(loaded.promptRoot, v.slice(1)));
  }
  // An unreferenced prompt or supporting doc is the quiet failure this catches: it
  // still reads like part of the process, so a change made to it looks landed while
  // no run has ever loaded it.
  for (const p of findFiles(
    root,
    (f) => f.endsWith(".md") && ["prompts", "docs"].includes(path.basename(path.dirname(f))),
  ))
    if (!used.has(p)) problems.push(`${path.relative(root, p)}: no chain references it`);
  return problems.map((p) => `${path.relative(hostRoot, root) || "."}/${p}`);
}

// `--chains <dir>` is resolved against the CWD the operator is standing in, which
// is the host root when this runs as the host's gate.
const extraChainRoots = process.argv
  .flatMap((a, i) => (a === "--chains" ? [process.argv[i + 1]] : []))
  .filter(Boolean)
  .map((d) => path.resolve(d));

function checkChains() {
  const problems = [here, ...extraChainRoots].flatMap(checkChainRoot);
  return { ok: problems.length === 0, out: problems.join("\n") };
}

// A HOST'S CHAIN DIRECTORY USUALLY CONTAINS CODE, and that code decides things.
//
// A chain is not only prompts and YAML. The host keeps deterministic scripts beside
// them -- the checks worth doing for free, before a model is paid to do arithmetic --
// and those scripts are gates. Their verdicts halt runs and send repair stages to
// work. They are the highest-leverage code in the whole arrangement and, until this
// existed, nothing ran a single test of them.
//
// It cost a run to notice. A plan gate judged every chunk against the base commit,
// as if each ran first, so a chunk verifying an earlier chunk's output was told its
// files did not exist. The plan was fine. The gate was wrong, it was wrong
// confidently, and it emitted well-formed JSON saying so -- which is precisely the
// shape of failure a selftest catches and no amount of reading catches.
//
// So: any `*.selftest.mjs` under a `--chains` root is run here, by the same gate
// that runs the engine's own. The engine learns nothing about the host in the
// process -- it discovers a filename convention and executes it, exactly as it
// already does for the canvases.
const hostSuites = extraChainRoots.flatMap((root) =>
  findFiles(root, (f) => f.endsWith(".selftest.mjs")),
);

const steps = [
  // Formatting and lint run from the host root so they pick up its shared config.
  // Standalone, these become the repo's own `prettier --check .` / `eslint .`.
  { name: "format", cmd: "npx", args: ["prettier", "--check", selfPath], cwd: hostRoot },
  { name: "lint", cmd: "npx", args: ["eslint", selfPath], cwd: hostRoot },
  { name: "deadcode", cmd: "npx", args: ["knip", "--directory", here], cwd: hostRoot },
  { name: "chains", run: checkChains },
  { name: "selftest:kernel", cmd: "node", args: [path.join(here, "selftest.mjs")], cwd: here },
  {
    name: "selftest:completion",
    cmd: "node",
    args: [path.join(here, "completion.selftest.mjs")],
    cwd: here,
  },
  {
    name: "selftest:resume",
    cmd: "node",
    args: [path.join(here, "resume.selftest.mjs")],
    cwd: here,
  },
  ...canvases.map((f) => ({
    name: `selftest:${path.basename(path.dirname(f))}`,
    cmd: "node",
    args: [f],
    cwd: path.dirname(f),
  })),
  // Run from the chain root, not the script's own directory: a host gate resolves
  // repo paths against the root it would really run in.
  ...hostSuites.map((f) => ({
    name: `selftest:${path.basename(f).replace(/\.selftest\.mjs$/, "")}`,
    cmd: "node",
    args: [f],
    cwd: hostRoot,
  })),
];

let failed = 0;
for (const s of steps) {
  let ok, out;
  if (s.run) {
    const r = s.run();
    ok = r.ok;
    out = r.out;
  } else {
    const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: "utf8" });
    ok = r.status === 0;
    out = `${r.stdout || ""}${r.stderr || ""}`;
  }
  if (ok) {
    console.log(`  ok    ${s.name}`);
    continue;
  }
  failed++;
  console.log(`  FAIL  ${s.name}`);
  // The failure's own words, not a summary of them. A gate that reports only
  // which step failed makes the reader re-run it by hand to learn anything.
  const text = (out || "").trim();
  console.log(text ? text.replace(/^/gm, "        ") : "        (no output)");
}

if (canvases.length < 2)
  console.log(`  note  ${2 - canvases.length} canvas selftest(s) not found; skipped`);

console.log(failed ? `\nchainkit check FAILED — ${failed} step(s)` : "\nchainkit check PASS");
process.exit(failed ? 1 : 0);
