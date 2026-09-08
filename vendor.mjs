#!/usr/bin/env node
// Install a committed Chainkit snapshot and the repository-root surfaces that a
// consumer must discover outside vendor/chainkit.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "markgar/chainkit";
const LICENSE = "MIT";
const VENDOR_MANIFEST = path.join(".chainkit", "vendor.json");
const INSTALL_MANIFEST = path.join(".chainkit", "vendor-install.json");
const INSTALLATIONS = [
  {
    source: path.join("extensions", "chainkit-canvas"),
    target: path.join(".github", "extensions", "chainkit-canvas"),
    required: ["extension.mjs", "render.mjs", "selftest.mjs", "telemetry.mjs"],
  },
  {
    source: path.join("skills", "chainkit"),
    target: path.join(".github", "skills", "chainkit"),
    required: ["SKILL.md"],
  },
];
const EXCLUDED_ROOTS = new Set([".git", "node_modules", "results"]);
const here = path.dirname(fileURLToPath(import.meta.url));

function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fileRecord(file) {
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
  return { sha256: hash(file), executable: (stat.mode & 0o111) !== 0 };
}

function walkFiles(directory, prefix = "") {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareNames(a.name, b.name),
  )) {
    if (!prefix && EXCLUDED_ROOTS.has(entry.name)) continue;
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, relative));
    else if (entry.isFile()) out.push(relative);
    else throw new Error(`Distribution cannot contain a symlink or special file: ${relative}`);
  }
  return out;
}

function inventory(directory, files = walkFiles(directory)) {
  return Object.fromEntries(
    [...files]
      .sort(compareNames)
      .map((relative) => [relative, fileRecord(path.join(directory, relative))]),
  );
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed:\n${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function committedSource(root, requestedRevision) {
  const top = realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim());
  if (top !== realpathSync(root))
    throw new Error(`Chainkit source must be a repository root, got ${root} inside ${top}`);
  const dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (dirty)
    throw new Error(`Chainkit source must be clean before vendoring; commit or remove:\n${dirty}`);
  const revision = git(root, ["rev-parse", "HEAD"]).trim();
  if (requestedRevision && requestedRevision !== revision)
    throw new Error(
      `Requested revision ${requestedRevision} does not match source HEAD ${revision}`,
    );
  const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean).sort(compareNames);
  for (const file of files) fileRecord(path.join(root, file));
  return { revision, files };
}

function copyFiles(source, target, files) {
  for (const relative of files) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    const stat = lstatSync(from);
    if (!stat.isFile()) throw new Error(`Expected a regular source file: ${from}`);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, stat.mode & 0o777);
  }
}

function replaceDirectory(source, target, files) {
  mkdirSync(path.dirname(target), { recursive: true });
  const staged = mkdtempSync(path.join(path.dirname(target), ".chainkit-install-"));
  let moved = false;
  try {
    copyFiles(source, staged, files);
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
    moved = true;
  } finally {
    if (!moved) rmSync(staged, { recursive: true, force: true });
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staged, file);
}

function assertRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision || ""))
    throw new Error(`Revision must be a full 40-character lowercase commit SHA, got ${revision}`);
}

function assertInstallationSource(root, installation) {
  const source = path.join(root, installation.source);
  for (const required of installation.required)
    if (!existsSync(path.join(source, required)))
      throw new Error(`Chainkit distribution is missing ${installation.source}/${required}`);
}

function vendorManifest(revision, directory) {
  return {
    repository: REPOSITORY,
    revision,
    license: LICENSE,
    files: inventory(directory),
  };
}

function installManifest(revision, engineRoot) {
  return {
    repository: REPOSITORY,
    revision,
    license: LICENSE,
    installations: INSTALLATIONS.map(({ source, target }) => ({
      source: source.split(path.sep).join("/"),
      target: target.split(path.sep).join("/"),
      files: inventory(path.join(engineRoot, source)),
    })),
  };
}

export function installDistribution({
  sourceRoot = here,
  consumerRoot = process.cwd(),
  revision,
} = {}) {
  sourceRoot = path.resolve(sourceRoot);
  consumerRoot = path.resolve(consumerRoot);
  if (!existsSync(consumerRoot) || !lstatSync(consumerRoot).isDirectory())
    throw new Error(`Consumer root is not a directory: ${consumerRoot}`);

  const engineRoot = path.join(consumerRoot, "vendor", "chainkit");
  const inPlace = sourceRoot === path.resolve(engineRoot);
  let source;
  if (inPlace) {
    assertRevision(revision);
    source = { revision, files: walkFiles(sourceRoot) };
  } else {
    source = committedSource(sourceRoot, revision);
  }
  assertRevision(source.revision);

  if (!inPlace) replaceDirectory(sourceRoot, engineRoot, source.files);
  for (const installation of INSTALLATIONS) {
    assertInstallationSource(engineRoot, installation);
    const installationSource = path.join(engineRoot, installation.source);
    const installationTarget = path.join(consumerRoot, installation.target);
    replaceDirectory(installationSource, installationTarget, walkFiles(installationSource));
  }

  writeJson(path.join(consumerRoot, VENDOR_MANIFEST), vendorManifest(source.revision, engineRoot));
  writeJson(
    path.join(consumerRoot, INSTALL_MANIFEST),
    installManifest(source.revision, engineRoot),
  );
  return {
    revision: source.revision,
    vendor: path.relative(consumerRoot, engineRoot),
    installations: INSTALLATIONS.map((entry) => entry.target.split(path.sep).join("/")),
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sameInventory(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} differs from its pinned inventory`);
}

function assertProvenance(manifest, label) {
  if (
    manifest?.repository !== REPOSITORY ||
    manifest?.license !== LICENSE ||
    !/^[a-f0-9]{40}$/.test(manifest?.revision || "")
  )
    throw new Error(`${label} has invalid Chainkit provenance`);
}

export function verifyDistribution(consumerRoot = process.cwd()) {
  consumerRoot = path.resolve(consumerRoot);
  const vendor = readJson(path.join(consumerRoot, VENDOR_MANIFEST));
  const installed = readJson(path.join(consumerRoot, INSTALL_MANIFEST));
  assertProvenance(vendor, VENDOR_MANIFEST);
  assertProvenance(installed, INSTALL_MANIFEST);
  if (vendor.revision !== installed.revision)
    throw new Error(`${VENDOR_MANIFEST} and ${INSTALL_MANIFEST} name different Chainkit revisions`);
  sameInventory(
    "Vendored Chainkit",
    inventory(path.join(consumerRoot, "vendor", "chainkit")),
    vendor.files,
  );

  const expectedTargets = INSTALLATIONS.map((entry) => entry.target.split(path.sep).join("/"));
  const actualTargets = (installed.installations || []).map((entry) => entry.target);
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets))
    throw new Error(`${INSTALL_MANIFEST} does not describe the supported installations`);
  for (const installation of installed.installations) {
    const configured = INSTALLATIONS.find(
      (entry) => entry.target.split(path.sep).join("/") === installation.target,
    );
    if (
      !configured ||
      installation.source !== configured.source.split(path.sep).join("/") ||
      !installation.files
    )
      throw new Error(`${INSTALL_MANIFEST} contains an invalid installation`);
    sameInventory(
      installation.target,
      inventory(path.join(consumerRoot, installation.target)),
      installation.files,
    );
  }
  return { revision: vendor.revision, installations: actualTargets };
}

function usage() {
  return [
    "usage:",
    "  node vendor.mjs install [consumer-root] [--revision <full-sha>]",
    "  node vendor.mjs check [consumer-root]",
    "",
    "Run install from a clean Chainkit checkout. When running the copied",
    "vendor/chainkit/vendor.mjs in-place after replacing a git archive, pass --revision.",
  ].join("\n");
}

function cli() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const revisionAt = args.indexOf("--revision");
  let revision;
  if (revisionAt !== -1) {
    revision = args[revisionAt + 1];
    args.splice(revisionAt, 2);
  }
  const consumerRoot = args[0] || process.cwd();
  if (args.length > 1 || !["install", "check"].includes(command)) throw new Error(usage());
  if (command === "install") {
    const result = installDistribution({ consumerRoot, revision });
    console.log(`Installed Chainkit ${result.revision}`);
    console.log(`  ${result.vendor}`);
    for (const target of result.installations) console.log(`  ${target}`);
  } else {
    const result = verifyDistribution(consumerRoot);
    console.log(`Verified Chainkit ${result.revision}`);
    for (const target of result.installations) console.log(`  ${target}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
