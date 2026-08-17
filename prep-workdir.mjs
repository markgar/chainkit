#!/usr/bin/env node
// Build a clean scaffold workdir for a chain run.
//
// The workdir is a real git repo with a base commit, because that is what makes a
// run judgeable: delivery is "the diff since base is non-empty". Without it, a gate
// can pass vacuously and the run reports a confident false green. run.mjs refuses
// to start without one; this is the thing that produces it.
//
// The base commit contains ONLY the fixture's `acceptance/` grader. `reference/`
// is deliberately not copied -- no process may see a worked solution.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

const fixture = arg("fixture");
const workDir = arg("workdir") && path.resolve(arg("workdir"));

if (!fixture || !workDir) {
  console.error(
    "usage: node prep-workdir.mjs --fixture <name> --workdir <path> [--force]\n" +
      "  --force  delete an existing non-empty workdir first",
  );
  process.exit(2);
}

const fixtureDir = path.join(here, "fixtures", fixture);
const graderDir = path.join(fixtureDir, "acceptance");
if (!existsSync(graderDir)) {
  console.error(`✗ no acceptance/ grader at ${graderDir}`);
  process.exit(2);
}

if (existsSync(workDir) && readdirSync(workDir).length) {
  if (!has("force")) {
    console.error(`✗ ${workDir} exists and is not empty. Pass --force to replace it.`);
    process.exit(2);
  }
  rmSync(workDir, { recursive: true, force: true });
}

mkdirSync(workDir, { recursive: true });
cpSync(graderDir, path.join(workDir, "acceptance"), { recursive: true });
// A fixture's optional `base/` is copied verbatim: files that must EXIST for the
// grader to run but are not the work (a package.json declaring ESM, a config).
//
// It has to be in the base commit rather than left to the builder. Under per-chunk
// file ownership no chunk owns it, so a build that has to create it either violates
// its ownership rule or fails a gate for a reason that says nothing about the chunk.
const baseDir = path.join(fixtureDir, "base");
if (existsSync(baseDir)) cpSync(baseDir, workDir, { recursive: true });
// Agent tooling installed in the operator's environment writes its own bookkeeping
// into the CLI's working directory. That is not work the run did, and counting it
// as changed files makes the delivery signal dirtier than it is. If your tooling
// drops a directory of its own, add it here.
writeFileSync(path.join(workDir, ".gitignore"), "node_modules/\n.chainkit/\n");

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: workDir, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`✗ git ${args.join(" ")}\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.trim();
};

git("init", "-q", "-b", "main");
// Set identity locally: a run must not depend on the operator's global git config.
git("config", "user.email", "chainkit@local");
git("config", "user.name", "chainkit");
git("add", "-A");
git("commit", "-q", "-m", `base: ${fixture} acceptance grader`);

const base = git("rev-parse", "HEAD");
const tracked = git("ls-files").split("\n").filter(Boolean).length;
console.log(
  `✓ workdir ready\n  ${workDir}\n  base ${base.slice(0, 8)}  ` +
    `(${tracked} file(s): acceptance/ grader${existsSync(baseDir) ? " + base/" : ""}, no solution)`,
);
