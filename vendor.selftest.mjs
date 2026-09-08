#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDistribution, verifyDistribution } from "./vendor.mjs";

let passed = 0;
const failures = [];

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function ok(label, value) {
  eq(label, Boolean(value), true);
}

function write(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function names(directory) {
  return readdirSync(directory).sort();
}

const source = mkdtempSync(path.join(tmpdir(), "chainkit-source-"));
const consumer = mkdtempSync(path.join(tmpdir(), "chainkit-consumer-"));

try {
  write(source, "LICENSE", "MIT\n");
  write(source, "README.md", "fixture\n");
  write(source, "vendor.mjs", "// fixture installer\n");
  write(source, "extensions/chainkit-canvas/extension.mjs", "// extension v1\n");
  write(source, "extensions/chainkit-canvas/render.mjs", "// render v1\n");
  write(source, "extensions/chainkit-canvas/selftest.mjs", "// selftest v1\n");
  write(source, "extensions/chainkit-canvas/telemetry.mjs", "// telemetry v1\n");
  write(source, "extensions/chainkit-canvas/obsolete.mjs", "// removed in v2\n");
  write(source, "skills/chainkit/SKILL.md", "# skill v1\n");
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.email", "chainkit@local");
  git(source, "config", "user.name", "chainkit");
  const revision1 = commit(source, "fixture v1");

  const first = installDistribution({ sourceRoot: source, consumerRoot: consumer });
  eq("install derives the committed source revision", first.revision, revision1);
  eq(
    "the complete canonical dashboard source is packaged",
    names(path.join(consumer, "vendor/chainkit/extensions/chainkit-canvas")),
    ["extension.mjs", "obsolete.mjs", "render.mjs", "selftest.mjs", "telemetry.mjs"],
  );
  eq(
    "the dashboard is installed at the consumer extension root",
    names(path.join(consumer, ".github/extensions/chainkit-canvas")),
    ["extension.mjs", "obsolete.mjs", "render.mjs", "selftest.mjs", "telemetry.mjs"],
  );
  eq(
    "the generic operator skill is installed at the consumer skill root",
    names(path.join(consumer, ".github/skills/chainkit")),
    ["SKILL.md"],
  );
  const vendorManifest = JSON.parse(
    readFileSync(path.join(consumer, ".chainkit/vendor.json"), "utf8"),
  );
  eq(
    "the established vendor manifest shape stays backward compatible",
    Object.keys(vendorManifest),
    ["repository", "revision", "license", "files"],
  );
  const installManifest = readFileSync(
    path.join(consumer, ".chainkit/vendor-install.json"),
    "utf8",
  );
  verifyDistribution(consumer);

  installDistribution({ sourceRoot: source, consumerRoot: consumer });
  eq(
    "reinstalling the same revision writes an identical install manifest",
    readFileSync(path.join(consumer, ".chainkit/vendor-install.json"), "utf8"),
    installManifest,
  );

  write(consumer, ".github/extensions/other-extension/keep.txt", "extension\n");
  write(consumer, ".github/skills/consumer-policy/SKILL.md", "consumer policy\n");
  write(consumer, ".github/extensions/chainkit-canvas/local-only.txt", "replace me\n");
  write(consumer, ".github/skills/chainkit/local-only.txt", "replace me\n");

  write(source, "extensions/chainkit-canvas/render.mjs", "// render v2\n");
  rmSync(path.join(source, "extensions/chainkit-canvas/obsolete.mjs"));
  write(source, "skills/chainkit/SKILL.md", "# skill v2\n");
  const revision2 = commit(source, "fixture v2");
  installDistribution({ sourceRoot: source, consumerRoot: consumer });

  eq(
    "an update replaces the managed dashboard directory deterministically",
    names(path.join(consumer, ".github/extensions/chainkit-canvas")),
    ["extension.mjs", "render.mjs", "selftest.mjs", "telemetry.mjs"],
  );
  eq(
    "an update replaces the managed skill directory deterministically",
    names(path.join(consumer, ".github/skills/chainkit")),
    ["SKILL.md"],
  );
  ok(
    "an unrelated extension survives dashboard installation",
    existsSync(path.join(consumer, ".github/extensions/other-extension/keep.txt")),
  );
  ok(
    "an unrelated skill survives Chainkit skill installation",
    existsSync(path.join(consumer, ".github/skills/consumer-policy/SKILL.md")),
  );
  eq(
    "updated dashboard content reaches the consumer",
    readFileSync(path.join(consumer, ".github/extensions/chainkit-canvas/render.mjs"), "utf8"),
    "// render v2\n",
  );
  eq(
    "updated skill content reaches the consumer",
    readFileSync(path.join(consumer, ".github/skills/chainkit/SKILL.md"), "utf8"),
    "# skill v2\n",
  );
  eq(
    "the update records the new revision",
    JSON.parse(readFileSync(path.join(consumer, ".chainkit/vendor.json"), "utf8")).revision,
    revision2,
  );
  verifyDistribution(consumer);

  write(consumer, ".github/extensions/chainkit-canvas/render.mjs", "tampered\n");
  let rejected = "";
  try {
    verifyDistribution(consumer);
  } catch (error) {
    rejected = error.message;
  }
  ok("integrity verification rejects a modified installed dashboard", rejected.includes("differs"));

  installDistribution({
    sourceRoot: path.join(consumer, "vendor", "chainkit"),
    consumerRoot: consumer,
    revision: revision2,
  });
  eq(
    "an in-place vendored installer restores the root dashboard",
    readFileSync(path.join(consumer, ".github/extensions/chainkit-canvas/render.mjs"), "utf8"),
    "// render v2\n",
  );
  verifyDistribution(consumer);

  write(consumer, "vendor/chainkit/README.md", "tampered\n");
  rejected = "";
  try {
    verifyDistribution(consumer);
  } catch (error) {
    rejected = error.message;
  }
  ok("integrity verification rejects a modified vendor snapshot", rejected.includes("differs"));
} finally {
  rmSync(source, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`vendor selftest: ${passed} passed`);
