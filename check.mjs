#!/usr/bin/env node
// chainkit's own gate. This is the whole of it -- what its CI would run once it
// lives in its own repo, and what the host repo's done-bar runs in the meantime.
//
// It ships WITH the engine rather than sitting in the host repo's scripts, on the
// same principle as everything else in this directory: extract chainkit to its own
// repo and its gate comes along, unchanged. Nothing here knows the word "trellis".
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
import { existsSync, readdirSync } from "node:fs";
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
function checkChainRoot(root) {
  const dir = path.join(root, "chains");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const problems = [];
  const used = new Set();
  for (const f of files) {
    const full = path.join(dir, f);
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
  }
  const promptDir = path.join(root, "prompts");
  if (existsSync(promptDir))
    for (const p of readdirSync(promptDir).filter((f) => f.endsWith(".md")))
      if (!used.has(path.join(promptDir, p))) problems.push(`prompts/${p}: no chain references it`);
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

const steps = [
  // Formatting and lint run from the host root so they pick up its shared config.
  // Standalone, these become the repo's own `prettier --check .` / `eslint .`.
  { name: "format", cmd: "npx", args: ["prettier", "--check", selfPath], cwd: hostRoot },
  { name: "lint", cmd: "npx", args: ["eslint", selfPath], cwd: hostRoot },
  { name: "deadcode", cmd: "npx", args: ["knip", "--directory", here], cwd: hostRoot },
  { name: "chains", run: checkChains },
  { name: "selftest:kernel", cmd: "node", args: [path.join(here, "selftest.mjs")], cwd: here },
  ...canvases.map((f) => ({
    name: `selftest:${path.basename(path.dirname(f))}`,
    cmd: "node",
    args: [f],
    cwd: path.dirname(f),
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
