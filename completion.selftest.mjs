#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.join(here, ".completion-selftest");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch);
let passed = 0;
const failed = [];

function caseRoot(name) {
  const root = path.join(scratch, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
  return root;
}

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

function runYamlCase(name, makeYaml, { dirty = false, copilotBody = null } = {}) {
  const root = caseRoot(name);
  const work = path.join(root, "work");
  const results = path.join(root, "results");
  const bin = path.join(root, "bin");
  mkdirSync(work);
  mkdirSync(bin);
  writeFileSync(path.join(work, "base.txt"), "base\n");
  spawnSync("git", ["init", "-q"], { cwd: work });
  spawnSync("git", ["config", "user.name", "test"], { cwd: work });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
  spawnSync("git", ["add", "base.txt"], { cwd: work });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: work });
  writeFileSync(path.join(root, "prompt.md"), "Repair {{item.id}}.\n");
  if (dirty) writeFileSync(path.join(work, "dirty.txt"), "dirty\n");
  if (copilotBody) {
    writeFileSync(path.join(bin, "copilot"), copilotBody);
    chmodSync(path.join(bin, "copilot"), 0o755);
  }
  writeFileSync(path.join(root, "chain.yaml"), makeYaml(root));
  const child = spawnSync(
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
  const records = existsSync(path.join(results, "chain-runs"))
    ? readdirSync(path.join(results, "chain-runs")).filter((f) => f.endsWith(".json"))
    : [];
  const record = records.length
    ? JSON.parse(readFileSync(path.join(results, "chain-runs", records[0]), "utf8"))
    : null;
  return { root, work, results, child, record };
}

function runCase(name, checkBody, max = 3) {
  const root = caseRoot(`agent-${name}`);
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
  writeFileSync(
    path.join(root, "check.mjs"),
    checkBody.replaceAll("__MARKER__", path.join(root, "marker")),
  );
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
      `      attempts: ${max}`,
      "completion:",
      "  run: 'true'",
      "  attempts: 1",
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

function runChainRepairCase() {
  const root = caseRoot("chain-repair");
  const work = path.join(root, "work");
  const results = path.join(root, "results");
  const marker = path.join(root, "gate-seen");
  const bin = path.join(root, "bin");
  mkdirSync(work);
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
      "name: completion-repair",
      "defaults:",
      "  model: gpt-5.6-sol",
      "stages:",
      "  - id: integration-fix",
      "    prompt: fix.md",
      "    tools: true",
      "    resume: true",
      "completion:",
      `  run: node ${path.join(root, "gate.mjs")}`,
      "  attempts: 2",
      "  repair:",
      "    stages: [integration-fix]",
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

const retry = runCase(
  "retry",
  [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `const marker = ${JSON.stringify("__MARKER__")};`,
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

const artifactAgent = [
  "#!/usr/bin/env node",
  `console.log(${JSON.stringify(
    JSON.stringify({
      type: "assistant.message",
      data: { model: "gpt-5.6-sol", outputTokens: 3, content: "green" },
    }),
  )});`,
  `console.log(${JSON.stringify(JSON.stringify({ type: "result", data: {} }))});`,
  "",
].join("\n");
const ownArtifact = runYamlCase(
  "stage-own-artifact",
  (root) => {
    writeFileSync(path.join(root, "prompt.md"), "Produce the completion value.\n");
    return [
      "name: stage-own-artifact",
      "defaults:",
      "  model: gpt-5.6-sol",
      "stages:",
      "  - id: produce",
      "    prompt: prompt.md",
      "    produces: answer",
      "    tools: false",
      "    completion:",
      '      run: test "{{answer}}" = green',
      "      attempts: 1",
      "completion:",
      "  run: 'true'",
      "  attempts: 1",
      "",
    ].join("\n");
  },
  { copilotBody: artifactAgent },
);
eq("stage completion may reference its own artifact", ownArtifact.child.status, 0);
eq("the own-artifact completion passes", ownArtifact.record.stageLog[0].completion.ok, true);
rmSync(ownArtifact.root, { recursive: true, force: true });

const stuck = runCase("stuck", "console.error('same failure'); process.exit(1);\n");
eq(
  "an unchanged failure with no file edits halts as no-progress",
  stuck.record.halted.kind,
  "no-progress",
);
rmSync(stuck.root, { recursive: true, force: true });

const exhausted = runCase(
  "exhausted",
  [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const marker = ${JSON.stringify("__MARKER__")};`,
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

const chainRepair = runChainRepairCase();
eq("failed chain completion invokes its repair stage", chainRepair.record.stageLog.length, 1);
eq("the exact chain command is retried to green", chainRepair.record.completion.ok, true);
eq("a successful chain repair is committed", chainRepair.record.completion.repairCommit.attempt, 2);
eq("the committed chain repair leaves a clean tree", chainRepair.status, "");
eq("the committed chain repair preserves the fix", chainRepair.content, "fixed\n");
rmSync(chainRepair.root, { recursive: true, force: true });

const preflightRoot = caseRoot("requires-refusal");
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
    "name: requires",
    "defaults:",
    "  model: gpt-5.6-sol",
    "requires:",
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
eq("a repository requires refusal exits before model spend", preflight.status, 2);
eq("the requires command's own reason is surfaced", preflight.stderr.includes("refused"), true);
eq(
  "a refused requires leaves no empty run directory",
  readdirSync(preflightRoot).includes("results"),
  false,
);
rmSync(preflightRoot, { recursive: true, force: true });

const optional = runYamlCase("optional-completion", () =>
  [
    "name: optional-completion",
    "stages:",
    "  - id: transform",
    "    run: printf changed > base.txt",
    "",
  ].join("\n"),
);
eq("no chain completion still exits successfully", optional.child.status, 0);
eq("no chain completion records a completed run", optional.record.completed, true);
eq("no chain completion is explicitly unverified", optional.record.completionStatus, "absent");
eq("an unverified run is never delivered", optional.record.delivered, false);
rmSync(optional.root, { recursive: true, force: true });

const dirty = runYamlCase(
  "dirty-refusal",
  () => ["name: dirty-refusal", "stages:", "  - id: noop", "    run: 'true'", ""].join("\n"),
  { dirty: true },
);
eq("a dirty worktree is refused automatically", dirty.child.status, 2);
eq("dirty-tree refusal happens before log creation", dirty.record, null);
rmSync(dirty.root, { recursive: true, force: true });

const requiresMutation = runYamlCase("requires-mutation", () =>
  [
    "name: requires-mutation",
    "requires:",
    "  run: printf bad > mutated.txt",
    "stages:",
    "  - id: noop",
    "    run: 'true'",
    "",
  ].join("\n"),
);
eq("a mutating requires command is refused", requiresMutation.child.status, 2);
eq("requires mutation happens before log creation", requiresMutation.record, null);
rmSync(requiresMutation.root, { recursive: true, force: true });

const fakeRepairAgent = [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('item.txt', 'fixed');",
  `console.log(${JSON.stringify(
    JSON.stringify({
      type: "assistant.message",
      data: { model: "gpt-5.6-sol", outputTokens: 3, content: "fixed" },
    }),
  )});`,
  `console.log(${JSON.stringify(JSON.stringify({ type: "result", data: {} }))});`,
  "",
].join("\n");
const foreachRepair = runYamlCase(
  "foreach-repair",
  () =>
    [
      "name: foreach-repair",
      "seeds:",
      "  items:",
      "    - id: one",
      "defaults:",
      "  model: gpt-5.6-sol",
      "stages:",
      "  - id: build",
      "    run: printf bad > item.txt",
      "  - id: item-fix",
      "    prompt: prompt.md",
      "    tools: true",
      "foreach:",
      "  over: items",
      "  as: item",
      "  stages: [build]",
      "  expects: { id: string }",
      "  max: 1",
      "  completion:",
      '    run: test "$(cat item.txt)" = fixed',
      "    attempts: 2",
      "    repair:",
      "      stages: [item-fix]",
      "completion:",
      "  run: 'true'",
      "  attempts: 1",
      "",
    ].join("\n"),
  { copilotBody: fakeRepairAgent },
);
eq("foreach completion repairs a failed item", foreachRepair.record.halted, null);
eq(
  "foreach completion uses two total checks",
  foreachRepair.record.foreach.iterations[0].completion.checks.length,
  2,
);
eq(
  "foreach completion reruns the identical command",
  new Set(foreachRepair.record.foreach.iterations[0].completion.checks.map((c) => c.command)).size,
  1,
);
eq(
  "successful item completion is committed",
  foreachRepair.record.foreach.iterations[0].commit.ok,
  true,
);
eq(
  "the per-item commit leaves the repository clean",
  spawnSync("git", ["status", "--porcelain"], {
    cwd: foreachRepair.work,
    encoding: "utf8",
  }).stdout,
  "",
);
rmSync(foreachRepair.root, { recursive: true, force: true });

eq(
  "chain completion reruns the identical command",
  new Set(chainRepair.record.completion.checks.map((check) => check.command)).size,
  1,
);
eq(
  "chain attempts count initial and repaired checks uniformly",
  chainRepair.record.completion.checks.length,
  2,
);

const noopAgent = [
  "#!/usr/bin/env node",
  `console.log(${JSON.stringify(
    JSON.stringify({
      type: "assistant.message",
      data: { model: "gpt-5.6-sol", outputTokens: 3, content: "no change" },
    }),
  )});`,
  `console.log(${JSON.stringify(JSON.stringify({ type: "result", data: {} }))});`,
  "",
].join("\n");
const noProgress = runYamlCase(
  "chain-no-progress",
  (root) => {
    writeFileSync(path.join(root, "prompt.md"), "Repair the failed completion command.\n");
    return [
      "name: chain-no-progress",
      "defaults:",
      "  model: gpt-5.6-sol",
      "stages:",
      "  - id: transform",
      "    run: printf changed > base.txt",
      "  - id: repair",
      "    prompt: prompt.md",
      "    tools: false",
      "completion:",
      "  run: 'false'",
      "  attempts: 3",
      "  repair:",
      "    stages: [repair]",
      "",
    ].join("\n");
  },
  { copilotBody: noopAgent },
);
eq("composite completion stops on no progress", noProgress.record.halted.kind, "no-progress");
eq("no-progress avoids spending the final attempt", noProgress.record.completion.checks.length, 2);
rmSync(noProgress.root, { recursive: true, force: true });

const mutatingChain = runYamlCase("chain-mutation", () =>
  [
    "name: chain-mutation",
    "stages:",
    "  - id: transform",
    "    run: printf changed > base.txt",
    "completion:",
    "  run: printf mutation > judged.txt",
    "  attempts: 1",
    "",
  ].join("\n"),
);
eq(
  "chain completion rejects a mutating judge",
  mutatingChain.record.halted.kind,
  "completion-mutated",
);
rmSync(mutatingChain.root, { recursive: true, force: true });

const legacy = runYamlCase("legacy-authoring", () =>
  [
    "name: legacy-authoring",
    "preflight: { run: 'true' }",
    "stages:",
    "  - id: noop",
    "    run: 'true'",
    "gate: 'true'",
    "",
  ].join("\n"),
);
eq("legacy gate/preflight YAML is rejected", legacy.child.status, 2);
eq("legacy authoring is rejected before logs", legacy.record, null);
rmSync(legacy.root, { recursive: true, force: true });

console.log(
  failed.length
    ? `completion self-test FAIL — ${failed.length} of ${passed + failed.length} case(s)`
    : `completion self-test PASS — ${passed} case(s)`,
);
for (const failure of failed) console.log(`  ✗ ${failure}`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
