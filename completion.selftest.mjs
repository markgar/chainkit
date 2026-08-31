#!/usr/bin/env node

import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failed = [];

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failed.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function replayLine() {
  return [
    JSON.stringify({
      type: "assistant.message",
      data: { model: "gpt-5.6-sol", outputTokens: 3, content: "done" },
    }),
    JSON.stringify({ type: "result", data: {} }),
    "",
  ].join("\n");
}

function runCase(name, checkBody, max = 3) {
  const root = mkdtempSync(path.join(tmpdir(), `chainkit-completion-${name}-`));
  const work = path.join(root, "work");
  const replay = path.join(root, "replay");
  const results = path.join(root, "results");
  mkdirSync(work);
  mkdirSync(replay);
  writeFileSync(path.join(work, "base.txt"), "base\n");
  spawnSync("git", ["init", "-q"], { cwd: work });
  spawnSync("git", ["add", "base.txt"], { cwd: work });
  spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
    { cwd: work },
  );

  writeFileSync(path.join(root, "prompt.md"), "Build the thing.\n");
  writeFileSync(path.join(root, "check.mjs"), checkBody);
  writeFileSync(
    path.join(root, "chain.yaml"),
    [
      `name: completion-${name}`,
      "defaults:",
      "  model: gpt-5.6-sol",
      "stages:",
      "  - id: build",
      "    prompt: prompt.md",
      "    tools: false",
      "    resume: true",
      "    completion:",
      `      run: node ${path.join(root, "check.mjs")}`,
      `      max: ${max}`,
      'gate: "true"',
      "",
    ].join("\n"),
  );
  for (let attempt = 0; attempt < max; attempt++) {
    const label = attempt ? `build.a${attempt + 1}` : "build";
    writeFileSync(path.join(replay, `${label}.jsonl`), replayLine());
  }

  spawnSync(
    process.execPath,
    [
      path.join(here, "run.mjs"),
      "--chain",
      path.join(root, "chain.yaml"),
      "--workdir",
      work,
      "--results",
      results,
      "--tag",
      "test",
    ],
    {
      env: { ...process.env, FLASH_CHAIN_REPLAY: replay },
      encoding: "utf8",
    },
  );

  const records = readdirSync(path.join(results, "chain-runs")).filter((f) => f.endsWith(".json"));
  const record = JSON.parse(readFileSync(path.join(results, "chain-runs", records[0]), "utf8"));
  return { root, work, record };
}

function runGateRepairCase() {
  const root = mkdtempSync(path.join(tmpdir(), "chainkit-gate-repair-"));
  const work = path.join(root, "work");
  const replay = path.join(root, "replay");
  const results = path.join(root, "results");
  const marker = path.join(root, "gate-seen");
  const bin = path.join(root, "bin");
  mkdirSync(work);
  mkdirSync(replay);
  mkdirSync(bin);
  writeFileSync(path.join(work, "base.txt"), "base\n");
  spawnSync("git", ["init", "-q"], { cwd: work });
  spawnSync("git", ["config", "user.name", "test"], { cwd: work });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
  spawnSync("git", ["add", "base.txt"], { cwd: work });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: work });
  writeFileSync(
    path.join(bin, "copilot"),
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('base.txt', 'fixed\\n');",
      `console.log(${JSON.stringify(
        JSON.stringify({
          type: "assistant.message",
          data: { model: "gpt-5.6-sol", outputTokens: 3, content: "done" },
        }),
      )});`,
      `console.log(${JSON.stringify(JSON.stringify({ type: "result", data: {} }))});`,
      "",
    ].join("\n"),
  );
  chmodSync(path.join(bin, "copilot"), 0o755);
  writeFileSync(path.join(root, "fix.md"), "Repair the deterministic failure.\n");
  writeFileSync(
    path.join(root, "gate.mjs"),
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      "if (!existsSync(marker)) {",
      "  writeFileSync(marker, 'seen');",
      "  console.error('final gate red');",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "chain.yaml"),
    [
      "name: gate-repair",
      "defaults:",
      "  model: gpt-5.6-sol",
      "stages:",
      "  - id: integration-fix",
      "    prompt: fix.md",
      "    tools: true",
      "    resume: true",
      "gate:",
      `  run: node ${path.join(root, "gate.mjs")}`,
      "  repair:",
      "    stages: [integration-fix]",
      "    max: 2",
      "",
    ].join("\n"),
  );
  spawnSync(
    process.execPath,
    [
      path.join(here, "run.mjs"),
      "--chain",
      path.join(root, "chain.yaml"),
      "--workdir",
      work,
      "--results",
      results,
      "--tag",
      "test",
    ],
    {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    },
  );
  const records = readdirSync(path.join(results, "chain-runs")).filter((f) => f.endsWith(".json"));
  const record = JSON.parse(readFileSync(path.join(results, "chain-runs", records[0]), "utf8"));
  return {
    root,
    record,
    status: spawnSync("git", ["status", "--porcelain"], { cwd: work, encoding: "utf8" }).stdout,
    content: readFileSync(path.join(work, "base.txt"), "utf8"),
  };
}

const retryMarker = path.join(tmpdir(), `chainkit-completion-retry-${process.pid}`);
const retry = runCase(
  "retry",
  [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `const marker = ${JSON.stringify(retryMarker)};`,
    "if (!existsSync(marker)) {",
    "  writeFileSync(marker, 'seen');",
    "  console.error('first failure');",
    "  process.exit(1);",
    "}",
    "",
  ].join("\n"),
);
eq("a failed postcondition resumes the stage", retry.record.stageLog.length, 2);
eq(
  "the resumed completion attempt keeps the same session",
  new Set(retry.record.stageLog.map((s) => s.sessionId)).size,
  1,
);
eq("the second completion attempt passes", retry.record.stageLog[1].completion.ok, true);
rmSync(retry.root, { recursive: true, force: true });
rmSync(retryMarker, { force: true });

const stuck = runCase("stuck", "console.error('same failure'); process.exit(1);\n");
eq(
  "an unchanged failure with no file edits halts as no-progress",
  stuck.record.halted.kind,
  "no-progress",
);
rmSync(stuck.root, { recursive: true, force: true });

const exhaustedMarker = path.join(tmpdir(), `chainkit-completion-exhausted-${process.pid}`);
const exhausted = runCase(
  "exhausted",
  [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const marker = ${JSON.stringify(exhaustedMarker)};`,
    "const n = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) + 1 : 1;",
    "writeFileSync(marker, String(n));",
    "console.error(`failure ${n}`);",
    "process.exit(1);",
    "",
  ].join("\n"),
);
eq("changing failures exhaust the declared bound", exhausted.record.halted.kind, "exhausted");
eq("the declared completion bound is exact", exhausted.record.stageLog.length, 3);
rmSync(exhausted.root, { recursive: true, force: true });
rmSync(exhaustedMarker, { force: true });

const mutates = runCase(
  "mutates",
  "import { writeFileSync } from 'node:fs'; writeFileSync('bad.txt', 'changed');\n",
);
eq(
  "a completion command that changes the judged tree is rejected",
  mutates.record.halted.kind,
  "completion-mutated",
);
rmSync(mutates.root, { recursive: true, force: true });

const stages = runCase(
  "stages",
  [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('base.txt', 'staged\\n');",
    "import { spawnSync } from 'node:child_process';",
    "spawnSync('git', ['add', 'base.txt']);",
    "",
  ].join("\n"),
);
eq(
  "a completion command cannot hide its mutation in the index",
  stages.record.halted.kind,
  "completion-mutated",
);
rmSync(stages.root, { recursive: true, force: true });

const commits = runCase(
  "commits",
  [
    "import { writeFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "writeFileSync('base.txt', 'committed\\n');",
    "spawnSync('git', ['add', 'base.txt']);",
    "spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'bad']);",
    "",
  ].join("\n"),
);
eq(
  "a completion command cannot hide its mutation in a commit",
  commits.record.halted.kind,
  "completion-mutated",
);
rmSync(commits.root, { recursive: true, force: true });

const gateRepair = runGateRepairCase();
eq("a failed final gate invokes its configured repair stage", gateRepair.record.stageLog.length, 1);
eq("the exact final gate is retried to green", gateRepair.record.gate.ok, true);
eq("a successful final gate repair is committed", gateRepair.record.gate.repairCommit.attempt, 1);
eq("the committed final repair leaves a clean tree", gateRepair.status, "");
eq("the committed final repair preserves the fix", gateRepair.content, "fixed\n");
rmSync(gateRepair.root, { recursive: true, force: true });

const preflightRoot = mkdtempSync(path.join(tmpdir(), "chainkit-preflight-"));
const preflightWork = path.join(preflightRoot, "work");
mkdirSync(preflightWork);
writeFileSync(path.join(preflightWork, "base.txt"), "base\n");
spawnSync("git", ["init", "-q"], { cwd: preflightWork });
spawnSync("git", ["add", "base.txt"], { cwd: preflightWork });
spawnSync(
  "git",
  ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
  { cwd: preflightWork },
);
writeFileSync(path.join(preflightRoot, "prompt.md"), "Never run.\n");
writeFileSync(
  path.join(preflightRoot, "chain.yaml"),
  [
    "name: preflight",
    "defaults:",
    "  model: gpt-5.6-sol",
    "preflight:",
    "  run: echo refused >&2; exit 1",
    "stages:",
    "  - id: build",
    "    prompt: prompt.md",
    "",
  ].join("\n"),
);
const preflight = spawnSync(
  process.execPath,
  [
    path.join(here, "run.mjs"),
    "--chain",
    path.join(preflightRoot, "chain.yaml"),
    "--workdir",
    preflightWork,
    "--results",
    path.join(preflightRoot, "results"),
  ],
  { encoding: "utf8" },
);
eq("a repository preflight refusal exits before model spend", preflight.status, 2);
eq("the preflight's own reason is surfaced", preflight.stderr.includes("refused"), true);
eq(
  "a refused preflight leaves no empty run directory",
  readdirSync(preflightRoot).includes("results"),
  false,
);
rmSync(preflightRoot, { recursive: true, force: true });

console.log(
  failed.length
    ? `completion self-test FAIL — ${failed.length} of ${passed + failed.length} case(s)`
    : `completion self-test PASS — ${passed} case(s)`,
);
for (const failure of failed) console.log(`  ✗ ${failure}`);
process.exit(failed.length ? 1 : 0);
