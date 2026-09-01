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
const scratch = path.join(here, ".resume-selftest");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch);
let passed = 0;
const failed = [];

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failed.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function setup(name, yaml, copilotBody, files = {}) {
  const root = path.join(scratch, name);
  const work = path.join(root, "work");
  const results = path.join(root, "results");
  const bin = path.join(root, "bin");
  mkdirSync(work, { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(work, "base.txt"), "base\n");
  spawnSync("git", ["init", "-q"], { cwd: work });
  spawnSync("git", ["config", "user.name", "test"], { cwd: work });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
  spawnSync("git", ["add", "base.txt"], { cwd: work });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: work });
  for (const [name2, body] of Object.entries(files)) writeFileSync(path.join(root, name2), body);
  writeFileSync(path.join(root, "chain.yaml"), yaml(root));
  writeFileSync(path.join(bin, "copilot"), copilotBody(root));
  chmodSync(path.join(bin, "copilot"), 0o755);
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
  const runDir = existsSync(path.join(results, "chain-runs", "logs"))
    ? path.join(
        results,
        "chain-runs",
        "logs",
        readdirSync(path.join(results, "chain-runs", "logs"))[0],
      )
    : null;
  const calls = existsSync(path.join(root, "calls.jsonl"))
    ? readFileSync(path.join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  const events =
    runDir && existsSync(path.join(runDir, "_events.jsonl"))
      ? readFileSync(path.join(runDir, "_events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];
  return { root, child, record, calls, events };
}

function fakeCopilot({ missingPlanSession = false, reviewRounds = false } = {}) {
  return (root) =>
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';",
      `const root = ${JSON.stringify(root)};`,
      "const prompt = process.argv[process.argv.indexOf('-p') + 1];",
      "const sessionAt = process.argv.indexOf('--session-id');",
      "const sessionId = sessionAt >= 0 ? process.argv[sessionAt + 1] : null;",
      "appendFileSync(root + '/calls.jsonl', JSON.stringify({ prompt, sessionId }) + '\\n');",
      reviewRounds
        ? [
            "let content = 'done';",
            "if (prompt.startsWith('REVIEW')) {",
            "  const counter = root + '/review-count';",
            "  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;",
            "  writeFileSync(counter, String(n));",
            "  content = JSON.stringify({ pass: false, finding: `round-${n}` });",
            "}",
          ].join("\n")
        : "const content = 'done';",
      "const assigned = sessionId || (prompt.includes('ORIGINAL PLANNER') ? 'plan-session' : prompt.includes('CODE a') ? 'item-a-session' : prompt.includes('CODE b') ? 'item-b-session' : `fresh-${Math.random()}`);",
      "console.log(JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-5.6-sol', outputTokens: 3, content } }));",
      missingPlanSession
        ? "console.log(JSON.stringify(prompt.includes('ORIGINAL PLANNER') ? { type: 'result' } : { type: 'result', sessionId: assigned }));"
        : "console.log(JSON.stringify({ type: 'result', sessionId: assigned }));",
      "",
    ].join("\n");
}

const top = setup(
  "top-level",
  (root) => {
    writeFileSync(
      path.join(root, "check.mjs"),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `const marker = ${JSON.stringify(path.join(root, "checked"))};`,
        "if (!existsSync(marker)) { writeFileSync(marker, 'x'); console.error('fix still red'); process.exit(1); }",
        "",
      ].join("\n"),
    );
    return [
      "name: cross-stage-top",
      "seeds: { finding: reviewer-only-delta }",
      "defaults: { model: gpt-5.6-sol }",
      "stages:",
      "  - id: plan",
      "    prompt: plan.md",
      "  - id: fix",
      "    prompt: fix.md",
      "    resumeFrom: plan",
      "    completion:",
      `      run: node ${path.join(root, "check.mjs")}`,
      "      attempts: 2",
      "completion: { run: 'true', attempts: 1 }",
      "",
    ].join("\n");
  },
  fakeCopilot(),
  {
    "plan.md": "ORIGINAL PLANNER PROMPT",
    "fix.md": "NEW FIX PROMPT {{finding}}",
  },
);
eq("top-level resume run completes", top.child.status, 0);
eq("the target receives the source session id", top.calls[1].sessionId, "plan-session");
eq(
  "the target prompt contains its own delta",
  top.calls[1].prompt.includes("reviewer-only-delta"),
  true,
);
eq(
  "the target prompt does not replay the source prompt",
  top.calls[1].prompt.includes("ORIGINAL PLANNER"),
  false,
);
eq("the completion retry stays on the inherited session", top.calls[2].sessionId, "plan-session");
eq("the completion retry is compact", top.calls[2].prompt.includes("NEW FIX PROMPT"), false);
eq(
  "prompt modes distinguish adoption and retry",
  top.record.stageLog.map((row) => row.promptMode),
  ["initial", "cross-stage-resume", "completion-continuation"],
);
eq("the final record names the source stage", top.record.stageLog[1].resumedFrom.stage, "plan");
eq(
  "the event journal records inherited continuation",
  top.events.filter((event) => event.type === "session.resumed").length,
  2,
);
rmSync(top.root, { recursive: true, force: true });

const loop = setup(
  "loop",
  () =>
    [
      "name: cross-stage-loop",
      "defaults: { model: gpt-5.6-sol }",
      "stages:",
      "  - id: plan",
      "    prompt: plan.md",
      "  - id: review",
      "    prompt: review.md",
      "    produces: verdict",
      "    parse: json",
      "    expects: { pass: boolean, finding: string }",
      "  - id: fix",
      "    prompt: fix.md",
      "    resumePrompt: fix-resume.md",
      "    resumeFrom: plan",
      "loop:",
      "  stages: [review, fix]",
      "  until: verdict.pass",
      "  max: 2",
      "  onExhausted: continue",
      "completion: { run: 'true', attempts: 1 }",
      "",
    ].join("\n"),
  fakeCopilot({ reviewRounds: true }),
  {
    "plan.md": "ORIGINAL PLANNER PROMPT",
    "review.md": "REVIEW",
    "fix.md": "FULL FIX {{verdict.finding}}",
    "fix-resume.md": "SMALL FIX {{verdict.finding}}",
  },
);
const loopFixes = loop.calls.filter(
  (call) => call.prompt.startsWith("FULL FIX") || call.prompt.startsWith("SMALL FIX"),
);
eq(
  "a later loop round stays on the inherited session",
  loopFixes.map((call) => call.sessionId),
  ["plan-session", "plan-session"],
);
eq(
  "the later loop round uses resumePrompt on the same lineage",
  loopFixes[1].prompt,
  "SMALL FIX round-2",
);
rmSync(loop.root, { recursive: true, force: true });

const foreach = setup(
  "foreach",
  () =>
    [
      "name: cross-stage-foreach",
      "seeds:",
      "  items:",
      "    - { id: a }",
      "    - { id: b }",
      "defaults: { model: gpt-5.6-sol }",
      "stages:",
      "  - id: code",
      "    prompt: code.md",
      "  - id: fix",
      "    prompt: fix.md",
      "    resumeFrom: code",
      "foreach:",
      "  over: items",
      "  as: item",
      "  stages: [code, fix]",
      "  max: 2",
      "completion: { run: 'true', attempts: 1 }",
      "",
    ].join("\n"),
  fakeCopilot(),
  {
    "code.md": "CODE {{item.id}}",
    "fix.md": "FIX {{item.id}}",
  },
);
const foreachFixes = foreach.calls.filter((call) => call.prompt.startsWith("FIX"));
eq("foreach item one resumes only item one's source", foreachFixes[0].sessionId, "item-a-session");
eq("foreach item two resumes only item two's source", foreachFixes[1].sessionId, "item-b-session");
eq(
  "foreach provenance keeps the item identity",
  foreach.record.stageLog.filter((row) => row.id === "fix").map((row) => row.resumedFrom.iter),
  [1, 2],
);
rmSync(foreach.root, { recursive: true, force: true });

const missing = setup(
  "missing-session",
  () =>
    [
      "name: cross-stage-missing",
      "defaults: { model: gpt-5.6-sol }",
      "stages:",
      "  - id: plan",
      "    prompt: plan.md",
      "  - id: fix",
      "    prompt: fix.md",
      "    resumeFrom: plan",
      "",
    ].join("\n"),
  fakeCopilot({ missingPlanSession: true }),
  {
    "plan.md": "ORIGINAL PLANNER PROMPT",
    "fix.md": "NEW FIX PROMPT",
  },
);
eq("a missing source session halts the run", missing.record.halted.kind, "resume");
eq("the missing-session target never calls the provider", missing.calls.length, 1);
eq(
  "missing-session telemetry is structured",
  missing.events.find((event) => event.type === "session.resume_failed").failure.reason,
  "source-has-no-session",
);
rmSync(missing.root, { recursive: true, force: true });

rmSync(scratch, { recursive: true, force: true });
if (failed.length) {
  for (const failure of failed) console.error(`✗ ${failure}`);
  console.error(`resume self-test FAIL — ${failed.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`resume self-test PASS — ${passed} case(s)`);
