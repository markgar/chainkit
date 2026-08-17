// TREE OBSERVATION — what a stage actually changed on disk.
//
// This lives in the kernel, not the driver, because the version that lived in the
// driver was wrong for a full run and nothing noticed: `git ls-files -mod` is a
// git PARSE ERROR (git wants `-m -o -d`), the helper it went through folded the
// failure into an empty string, and so every stage reported "changed no files"
// while the builder was writing the entire deliverable.
//
// That is the failure mode worth designing against here. A write that breaks fails
// loudly; a READ that breaks returns a plausible number, and a plausible number is
// never investigated. So: probes throw, probes read stdout only, and the command
// itself is pinned by a self-test against a real git repo.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The working tree is the widest channel between stages -- a builder's product is
// the files it wrote -- and it is the one the chain config cannot describe. This is
// the only evidence it leaves.
const LIST_CHANGED = "git ls-files -m -o -d --exclude-standard";

function probe(cmd, cwd) {
  const r = spawnSync("bash", ["-o", "pipefail", "-c", cmd], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`probe failed (exit ${r.status ?? "?"}): ${cmd}\n${(r.stderr || "").trim()}`);
  return r.stdout || "";
}

// Content hashes, not mtimes: a stage that rewrites a file with identical bytes
// changed nothing, and a stage that is merely re-read did not touch it.
export function treeSnapshot(workDir) {
  const out = new Map();
  for (const p of probe(LIST_CHANGED, workDir)
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)) {
    try {
      out.set(
        p,
        createHash("sha1")
          .update(readFileSync(path.join(workDir, p)))
          .digest("hex"),
      );
    } catch {
      // Listed but unreadable = deleted between the listing and the read.
      out.set(p, "(gone)");
    }
  }
  return out;
}

export function treeDelta(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

export function selfTest() {
  const CASES = [];
  const dir = mkdtempSync(path.join(tmpdir(), "ck-tree-"));
  const run = (c) => probe(c, dir);

  try {
    run("git init -q . && git config user.email t@t && git config user.name t");
    writeFileSync(path.join(dir, "kept.txt"), "one");
    run("git add -A && git commit -qm base");

    const base = treeSnapshot(dir);
    CASES.push(["a clean tree observes nothing", base.size === 0]);

    // THE REGRESSION. An untracked new file is what a from-scratch builder produces,
    // and the broken command reported none of them.
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "new.js"), "x");
    const added = treeSnapshot(dir);
    CASES.push([
      "a NEW untracked file is seen (the bug that shipped)",
      treeDelta(base, added).includes("src/new.js"),
    ]);

    writeFileSync(path.join(dir, "kept.txt"), "two");
    CASES.push([
      "a modified tracked file is seen",
      treeDelta(added, treeSnapshot(dir)).includes("kept.txt"),
    ]);

    const before = treeSnapshot(dir);
    writeFileSync(path.join(dir, "kept.txt"), "two");
    CASES.push([
      "rewriting identical bytes is NOT a change (content, not mtime)",
      treeDelta(before, treeSnapshot(dir)).length === 0,
    ]);

    unlinkSync(path.join(dir, "kept.txt"));
    CASES.push([
      "a deleted tracked file is seen",
      treeDelta(before, treeSnapshot(dir)).includes("kept.txt"),
    ]);

    writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
    mkdirSync(path.join(dir, "ignored"));
    writeFileSync(path.join(dir, "ignored", "junk"), "x");
    CASES.push([
      "an ignored path is not counted as the stage's work",
      !treeSnapshot(dir).has("ignored/junk"),
    ]);

    // The whole point of `probe`: a bad command must be an exception, not an
    // empty answer that reads as "nothing changed".
    let threw = false;
    try {
      probe("git ls-files -mod --exclude-standard", dir);
    } catch {
      threw = true;
    }
    CASES.push(["a failing probe THROWS rather than returning empty", threw]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return CASES;
}
