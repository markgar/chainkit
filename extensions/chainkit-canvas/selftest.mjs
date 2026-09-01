// Self-test for the telemetry reader. Run: node selftest.mjs
//
// Exists because this reader carries the arithmetic this project has already got
// wrong once in production -- session usage checkpoints are CUMULATIVE, so summing
// them instead of taking each call's maximum inflated a run's cost by 9x. That bug
// is invisible to `node --check` and to any test that only asserts "it rendered".
//
// It also pins the property the reader was rewritten for: it must render a chain
// it has never seen, with stage names nobody chose in advance. The fixture below
// deliberately contains a stage called `nobody-has-ever-seen-this`, and if a future
// change reintroduces an allow-list of known stage kinds, that stage vanishes and
// this test fails.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readRun,
  listRuns,
  describeTool,
  annotateConcurrency,
  runState,
  runHeadline,
} from "./telemetry.mjs";
import { page } from "./render.mjs";
import { runCommandStage } from "../../kernel/stage.mjs";
import vm from "node:vm";

let pass = 0;
const fails = [];
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const root = mkdtempSync(path.join(tmpdir(), "ck-canvas-"));
const runId = "fixture__zz__2026-01-01T00-00-00";
const runDir = path.join(root, "results", "chain-runs", "logs", runId);
const write = (dir, file, lines) => {
  mkdirSync(path.join(runDir, dir), { recursive: true });
  writeFileSync(path.join(runDir, dir, file), lines.map((l) => JSON.stringify(l)).join("\n"));
};

// Stage 1: prose output, a failed tool, and TWO cumulative usage checkpoints.
write("01-plan", "plan.jsonl", [
  {
    type: "user.message",
    data: { content: "## Exact prompt\n\n- preserve **this**\n- escape <script>alert(1)</script>" },
  },
  {
    type: "user.message",
    data: { content: "A later user message must not replace the sent prompt." },
  },
  {
    type: "tool.execution_start",
    data: { toolCallId: "a", toolName: "view", arguments: { path: "src/x.ts" }, model: "model-a" },
  },
  { type: "tool.execution_complete", data: { toolCallId: "a", success: true } },
  {
    type: "tool.execution_start",
    data: { toolCallId: "b", toolName: "grep", arguments: { pattern: "foo" } },
  },
  { type: "tool.execution_complete", data: { toolCallId: "b", success: false } },
  {
    type: "assistant.message",
    data: { model: "model-a", outputTokens: 1000, content: "plan in prose" },
  },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 3e9 } },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 5e9 } },
  { type: "result", data: {} },
]);
writeFileSync(
  path.join(runDir, "01-plan", "plan.argv.jsonl"),
  JSON.stringify({ sessionId: "s-plan" }, null, 2),
);
write("06-current-only", "current-only.jsonl", [
  {
    type: "model.model_call_success",
    data: { responseUsage: { completion_tokens: 806 } },
  },
  { type: "assistant.message", data: { model: "model-current", content: "current schema only" } },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 0 } },
  { type: "result", data: {} },
]);
// Stage 2: two loop rounds, JSON output, one value nested.
write("02-review", "review.jsonl", [
  {
    type: "assistant.message",
    data: {
      model: "model-b",
      outputTokens: 200,
      content: '{"pass":false,"blocking":[{"file":"a.ts"}]}',
    },
  },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 7e9 } },
  { type: "result", data: {} },
]);
write("02-review", "review.r1.jsonl", [
  {
    type: "assistant.message",
    data: { model: "model-b", outputTokens: 100, content: '{"pass":true}' },
  },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 8e9 } },
  { type: "result", data: {} },
]);
writeFileSync(
  path.join(runDir, "02-review", "review.argv.jsonl"),
  JSON.stringify(
    {
      sessionId: "s-plan",
      resumedFrom: { stage: "plan", sessionId: "s-plan", callSeq: 1, iter: 0, round: 0 },
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(runDir, "02-review", "review.r1.argv.jsonl"),
  JSON.stringify({ sessionId: "s-plan" }, null, 2),
);
// Stage 3: a name no allow-list could contain, and NO usage checkpoint at all.
write("03-nobody-has-ever-seen-this", "nobody-has-ever-seen-this.jsonl", [
  {
    type: "tool.execution_start",
    data: {
      toolCallId: "z",
      toolName: "bash",
      arguments: { command: "pnpm test" },
      model: "mystery-9000",
    },
  },
  { type: "result", data: {} },
]);
write("05-current-usage", "current-usage.jsonl", [
  {
    type: "model.model_call_success",
    data: { responseUsage: { completion_tokens: 647 } },
  },
  {
    type: "assistant.message",
    data: { model: "model-current", outputTokens: 647, content: "mixed schema" },
  },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 0 } },
  { type: "result", data: {} },
]);

// The run record. It is the ONLY source for the two handoffs that leave no trace
// in the call logs: the shared working tree, and a resumed CLI session.
mkdirSync(path.join(root, "results", "chain-runs"), { recursive: true });
writeFileSync(
  path.join(root, "results", "chain-runs", `${runId}.json`),
  JSON.stringify({
    stageLog: [
      {
        id: "plan",
        round: 0,
        filesChanged: [],
        sessionId: "s-plan",
        resume: null,
        completion: { attempt: 1, max: 3, command: "pnpm check", code: 0, ok: true },
      },
      {
        id: "review",
        round: 0,
        filesChanged: ["src/a.ts"],
        sessionId: "s-plan",
        resumeFrom: "plan",
        resumed: true,
        resumedFrom: { stage: "plan", sessionId: "s-plan", callSeq: 1, iter: 0, round: 0 },
        expects: { pass: "boolean" },
      },
      {
        id: "review",
        round: 1,
        filesChanged: ["src/b.ts"],
        sessionId: "s-plan",
        resumeFrom: "plan",
        resumed: true,
      },
    ],
    artifactHistory: [
      { name: "verdict", by: "review", round: 0, value: { pass: false } },
      { name: "verdict", by: "review", round: 1, value: { pass: true } },
    ],
  }),
);

// THE DECLARED PIPELINE, written before anything runs. `plan` is deliberately the
// LAST stage in the manifest and has no log dir, so it must appear as pending.
writeFileSync(
  path.join(runDir, "_chain.json"),
  JSON.stringify({
    name: "fixture",
    stages: [
      {
        id: "plan",
        ord: 1,
        model: "model-a",
        tools: true,
        produces: "plan",
        parse: "text",
        completion: { run: "pnpm check", max: 3 },
      },
      {
        id: "review",
        ord: 2,
        model: "model-b",
        tools: false,
        resumeFrom: "plan",
        produces: "verdict",
        parse: "json",
      },
      {
        id: "nobody-has-ever-seen-this",
        ord: 3,
        model: "mystery-9000",
        tools: true,
        parse: "text",
      },
      { id: "never-ran", ord: 4, model: "model-z", tools: true, resume: true, parse: "text" },
      { id: "current-usage", ord: 5, model: "model-current", tools: false, parse: "text" },
      { id: "current-only", ord: 6, model: "model-current", tools: false, parse: "text" },
    ],
  }),
);

const run = readRun(runDir, root);
// ONE ROW PER CALL. `review` ran twice, so it is two rows -- that is the point of
// the row model: a fix loop's interleaving is only visible if each round is a row.
const [s1, s2, s2b, s3, , s5, s6] = run.stages;

// THE 9x BUG. Checkpoints are cumulative: 3 then 5 means the call cost 5, not 8.
eq("cumulative checkpoints collapse to max", s1.aiu, 5);
eq("run total sums per-call maxima", run.totals.aiu, 8);

eq(
  "stages are in execution order",
  run.stages.map((s) => s.id),
  [
    "plan",
    "review",
    "review",
    "nobody-has-ever-seen-this",
    "never-ran",
    "current-usage",
    "current-only",
  ],
);
eq(
  "ord comes from the dir prefix, or from the manifest for a stage with no dir yet",
  run.stages.map((s) => s.ord),
  [1, 2, 2, 3, 4, 5, 6],
);
eq("an unknown stage name still renders", s3.id, "nobody-has-ever-seen-this");
eq("a declared completion command reaches the run view", s1.declared.completion.run, "pnpm check");
eq("a completed postcondition reaches the run view", s1.completion[0].ok, true);

eq(
  "loop rounds are separate ROWS, in the order they ran",
  run.stages.filter((s) => s.id === "review").map((s) => s.round),
  [0, 1],
);
eq("each round row carries only its own spend", [s2.aiu, s2b.aiu], [2, 1]);
eq(
  "a row's key is unique per round, so expanding one does not expand both",
  s2.key === s2b.key,
  false,
);

// An unmetered call must read as "not measured", never as free.
eq("unmetered call has null aiu", s3.rounds[0].aiu, null);
eq("unmetered count reaches the totals", run.totals.unmetered, 1);
eq("current responseUsage tokens reach the call", s5.rounds[0].outputTokens, 647);
eq("mixed current and legacy token schemas are not double-counted", s5.outputTokens, 647);
eq("current-only responseUsage tokens reach the call", s6.rounds[0].outputTokens, 806);

// JSON output is flattened without interpreting any key.
eq(
  "json output is flattened",
  s2.rounds[0].output.map((o) => o.key),
  ["pass", "blocking"],
);
eq(
  "nested values are marked non-scalar",
  s2.rounds[0].output.find((o) => o.key === "blocking").scalar,
  false,
);
eq("the echoed json say-step is dropped", s2.rounds[0].steps.length, 0);
eq("prose output is not treated as structured", s1.rounds[0].output, undefined);
eq(
  "the exact first sent prompt reaches the call",
  s1.rounds[0].prompt,
  "## Exact prompt\n\n- preserve **this**\n- escape <script>alert(1)</script>",
);

eq("tool status survives", s1.rounds[0].steps.filter((x) => x.status === "failed").length, 1);
eq(
  "totals count calls, and stages counts what the chain DECLARED (incl. not-yet-run)",
  [run.totals.calls, run.totals.stages],
  [6, 6],
);
eq("a total with an unreported call remains unknown", run.totals.outputTokens, null);

// No process-specific field may reappear on the public shape.
for (const k of ["chunks", "builderAiu", "reviewerAiu"]) {
  eq(`run has no "${k}"`, k in run || k in run.totals, false);
}
eq("a call carries no kind", "kind" in s1.rounds[0], false);

// The non-model channels. Without these a chain looks like a tidy sequence of
// prompts while the real coupling -- a shared tree and an inherited conversation --
// stays invisible.
eq(
  "files changed are folded in from the record, per round",
  [s2.filesChanged, s2b.filesChanged],
  [["src/a.ts"], ["src/b.ts"]],
);
eq("a stage that wrote nothing reports an empty list, not undefined", s1.filesChanged, []);
eq("a stage that inherited nothing says so", s1.resume, null);
// A cross-stage target inherits on its first call; a later round on the same session
// remains resumed. Both directions are pinned because they come from different read
// paths: explicit provenance for the first, legacy session-id inference for the next.
eq("a cross-stage first call reports the source it inherited", s2.resume, "plan");
eq("cross-stage provenance names the exact source session", s2.resumedFrom.sessionId, "s-plan");
eq("a later round on that same session did", s2b.resume, "plan");
eq("the declared contract is surfaced", Object.keys(s2.expects || {}), ["pass"]);
eq(
  "round-over-round artifact values survive, so a loop can be read as converging",
  run.artifactHistory.map((h) => h.value.pass),
  [false, true],
);
// Still generic: the fold-in must not teach the view any stage's meaning.
eq("folding in the record added no process-specific field", "verdict" in run, false);

// PRE-LOADING THE PIPELINE. Without it the view discovers a stage only when that
// stage starts writing, so a live run cannot be told apart from a halted one --
// both look like a chain with exactly the stages that have logs.
eq("a declared stage that has not started still appears", run.stages.length, 7);
const pending = run.stages[4];
// This fixture is a FINISHED run (it has a record), so an unrun stage is skipped,
// not pending. The live-run case -- where "pending" is still the right word -- is
// covered by the fan-out block below.
eq(
  "a stage that has not started is marked skipped once the run is over",
  pending.status,
  "skipped",
);
eq("a pending stage has no calls and no spend", [pending.rounds.length, pending.aiu], [0, 0]);
eq("a pending stage still shows the model it WILL run", pending.model, "model-z");
eq("a pending stage surfaces its declared inherited session", pending.declared.resume, true);
eq("a stage that ran is not marked pending", run.stages[0].status, "ran");
eq("the declared config is attached to stages that already ran", s2.declared.tools, false);
// Generic to the end: a manifest naming a stage nobody could have guessed works.
eq("a declared stage name nobody chose in advance survives", run.stages[3].model, "mystery-9000");

// A run recorded before the manifest existed must still read.
rmSync(path.join(runDir, "_chain.json"));
const legacy = readRun(runDir, root);
eq("a run with no manifest still reads", legacy.stages.length, 6);
eq(
  "with no manifest, nothing is pending",
  legacy.stages.filter((s) => s.status === "pending").length,
  0,
);

rmSync(root, { recursive: true, force: true });

// FAN-OUT: a stage list run once per element. Regression cover for a view that
// reported a finished run as still pending, and a serial run as if it were grouped
// by stage. Both are read-side defects, and a read-side defect returns a plausible
// answer instead of failing -- so it is only ever caught by a case like this.
{
  const feRoot = mkdtempSync(path.join(tmpdir(), "ck-canvas-fe-"));
  const feId = "fanout__zz__2026-01-01T00-00-00";
  const feDir = path.join(feRoot, "results", "chain-runs", "logs", feId);
  const put = (dir, model) => {
    mkdirSync(path.join(feDir, dir), { recursive: true });
    writeFileSync(
      path.join(feDir, dir, "c.jsonl"),
      [
        { type: "assistant.message", data: { model, outputTokens: 10, content: "{}" } },
        { type: "session.usage_checkpoint", data: { totalNanoAiu: 1e9 } },
        { type: "result", data: {} },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
  };
  // The chain DECLARES five stages; `fix` never runs because every review passed.
  mkdirSync(feDir, { recursive: true });
  writeFileSync(
    path.join(feDir, "_chain.json"),
    JSON.stringify({
      stages: [
        { id: "plan", ord: 1, model: "m-plan" },
        { id: "plan-review", ord: 2, model: "m-pr" },
        { id: "code", ord: 3, model: "m-code", inForeach: true },
        { id: "review", ord: 4, model: "m-rev", inForeach: true },
        { id: "fix", ord: 5, model: "m-fix", inForeach: true },
      ],
    }),
  );
  put("01-plan", "m-plan");
  put("02-plan-review", "m-pr");
  for (const i of [1, 2, 3]) {
    put(`03-code__i${i}`, "m-code");
    put(`04-review__i${i}`, "m-rev");
  }
  // No record file yet => the run is still live.
  const live = readRun(feDir, feRoot);

  // ORDER. The directory prefix is the DECLARED index, so a plain name sort puts
  // every `code` ahead of every `review` -- a real order, just not the one that
  // happened. It ran an element at a time.
  eq(
    "fan-out rows are in execution order, element by element",
    live.stages.map((s) => s.label),
    [
      "plan",
      "plan-review",
      "code · 1",
      "review · 1",
      "code · 2",
      "review · 2",
      "code · 3",
      "review · 3",
      "fix",
    ],
  );
  eq(
    "each row is numbered by its position in the run",
    live.stages.map((s) => s.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );

  // PHANTOMS. `code__i1` must reconcile against the declared `code`, or the
  // "declared but not started" pass re-adds `code` as a row that stays pending
  // forever on a run where all three of its iterations finished.
  eq(
    "a fan-out stage that ran is not also re-added as pending",
    live.stages.filter((s) => s.id === "code").length,
    3,
  );
  eq(
    "only the genuinely unrun stage is pending",
    live.stages.filter((s) => s.status === "pending").map((s) => s.id),
    ["fix"],
  );

  // IDENTITY. The base id drives config lookup; the key must stay unique or the
  // view's expand-state collapses four chunks into one.
  eq(
    "the declared model resolves through the base id",
    live.stages.find((s) => s.label === "code · 2").model,
    "m-code",
  );
  eq(
    "each fan-out row keeps a unique key",
    new Set(live.stages.map((s) => s.key)).size,
    live.stages.length,
  );
  eq(
    "iteration is carried explicitly, not left in the id",
    live.stages.filter((s) => s.iter > 0).length,
    6,
  );

  // FINISHED. Once the record exists the run is over, so nothing is "pending" --
  // `fix` was skipped, which is now a normal outcome of the loop-condition fix.
  mkdirSync(path.join(feRoot, "results", "chain-runs"), { recursive: true });
  writeFileSync(
    path.join(feRoot, "results", "chain-runs", `${feId}.json`),
    JSON.stringify({
      delivered: true,
      stageLog: [
        { id: "code", iter: 1, filesChanged: ["src/a.js"] },
        { id: "code", iter: 2, filesChanged: ["src/b.js"] },
        { id: "code", iter: 3, filesChanged: ["src/c.js"] },
      ],
    }),
  );
  const done = readRun(feDir, feRoot);
  // FILE OWNERSHIP. A fan-out stage shares one id across every element, so folding
  // the record in by id ALONE unions all three chunks' files onto all three rows.
  // That is the worst kind of read defect: per-chunk file ownership is the safety
  // property of the fan-out, and a view where every chunk touched every file cannot
  // show a violation of it. It reports a plausible superset instead of failing.
  eq(
    "each element reports only its own changed files",
    done.stages.filter((s) => s.id === "code").map((s) => s.filesChanged),
    [["src/a.js"], ["src/b.js"], ["src/c.js"]],
  );
  eq(
    "a finished run has no pending stages",
    done.stages.filter((s) => s.status === "pending").length,
    0,
  );
  eq(
    "the unrun stage reads as skipped, not pending",
    done.stages.find((s) => s.id === "fix").status,
    "skipped",
  );

  rmSync(feRoot, { recursive: true, force: true });
}

// "DID NOT PRODUCE A MODEL CALL" IS NOT "DID NOT RUN". A `$ command` stage writes no
// model-call log at all, so it stayed pending and was then relabelled "skipped --
// never needed" on a run where it had executed and returned the verdict the chain
// branched on. And on a HALTED run the stages after the halt were reported the same
// way, which says the chain decided against them rather than never got to them.
{
  const r = mkdtempSync(path.join(tmpdir(), "ck-status-"));
  const id = "c__t__2026-01-01T00-00-00";
  const dir = path.join(r, "results", "chain-runs", "logs", id);
  mkdirSync(path.join(dir, "01-cmd"), { recursive: true });
  mkdirSync(path.join(dir, "02-think"), { recursive: true });
  // Only the model stage leaves a call log; the command stage leaves nothing.
  writeFileSync(
    path.join(dir, "02-think", "think.jsonl"),
    JSON.stringify({
      type: "assistant.message",
      timestamp: "2026-01-01T00:00:01.000Z",
      data: { content: "done", model: "m" },
    }) + "\n",
  );
  writeFileSync(
    path.join(dir, "_chain.json"),
    JSON.stringify({ stages: [{ id: "cmd" }, { id: "think" }, { id: "later" }] }),
  );
  mkdirSync(path.join(r, "results", "chain-runs"), { recursive: true });

  const write = (extra) =>
    writeFileSync(
      path.join(r, "results", "chain-runs", `${id}.json`),
      JSON.stringify({
        delivered: false,
        stageLog: [
          { id: "cmd", wallMs: 46 },
          { id: "think", wallMs: 900 },
        ],
        ...extra,
      }),
    );

  write({ halted: { stage: "loop", kind: "exhausted", reason: "budget" } });
  const halted = readRun(dir, r);
  eq(
    "a command stage that ran is not called skipped",
    halted.stages.find((s) => s.id === "cmd").status,
    "ran",
  );
  eq(
    "and it says why it has no calls to show",
    halted.stages.find((s) => s.id === "cmd").noModelCalls,
    true,
  );
  eq("its wall time comes from the record", halted.stages.find((s) => s.id === "cmd").wallMs, 46);
  eq(
    "a stage after a halt was never reached, not never needed",
    halted.stages.find((s) => s.id === "later").status,
    "unreached",
  );

  write({});
  const clean = readRun(dir, r);
  eq(
    "on a run that finished, an unrun stage really was skipped",
    clean.stages.find((s) => s.id === "later").status,
    "skipped",
  );

  // A STAGE HANDED TOOLS THAT CALLED NONE. It is `ok`, so nothing else about it
  // looks unusual -- which is exactly why the flag has to survive into the view.
  write({
    stageLog: [
      { id: "cmd", wallMs: 46 },
      { id: "think", wallMs: 900, declaredToolsUnused: true },
    ],
  });
  const unused = readRun(dir, r);
  eq(
    "a stage that never used its declared tools is flagged in the view",
    unused.stages.find((s) => s.id === "think").declaredToolsUnused,
    true,
  );
  eq(
    "a stage that did use them is not",
    unused.stages.find((s) => s.id === "cmd").declaredToolsUnused,
    false,
  );

  // MID-RUN there is no record at all, so the block above does nothing and a live
  // run showed "not started" beside command stages the journal proves had run.
  {
    const live = path.join(r, "results", "chain-runs", "logs", "c__live__2026-01-01T00-00-00");
    mkdirSync(path.join(live, "01-cmd"), { recursive: true });
    mkdirSync(path.join(live, "02-think"), { recursive: true });
    writeFileSync(
      path.join(live, "02-think", "think.jsonl"),
      JSON.stringify({
        type: "assistant.message",
        timestamp: "2026-01-01T00:00:01.000Z",
        data: { content: "done", model: "m" },
      }) + "\n",
    );
    writeFileSync(
      path.join(live, "_chain.json"),
      JSON.stringify({ stages: [{ id: "cmd" }, { id: "think" }, { id: "gate" }, { id: "later" }] }),
    );
    // cmd ran, think ran, gate is the newest call and has no model log yet.
    writeFileSync(
      path.join(live, "_calls.jsonl"),
      [
        { seq: 1, id: "cmd", iter: 0, round: 0 },
        { seq: 2, id: "think", iter: 0, round: 0 },
        { seq: 3, id: "gate", iter: 0, round: 0 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const l = readRun(live, r);
    const S = (id) => l.stages.find((s) => s.id === id);
    eq(
      "mid-run, a command stage the journal recorded is not 'not started'",
      S("cmd").status,
      "ran",
    );
    eq("the newest journal entry is the stage running now", S("gate").status, "running");
    eq("a stage the journal has never seen really has not started", S("later").status, "pending");
    // A LOOP STAGE is journalled under the round it ran in, while its pending row
    // still carries round 0. Keying on round misses exactly the stages a loop
    // re-runs -- observed live: a recheck that passed and released the fan-out was
    // still labelled "not started" while the build was already underway.
    writeFileSync(
      path.join(live, "_calls.jsonl"),
      [
        { seq: 1, id: "cmd", iter: 0, round: 0 },
        { seq: 2, id: "gate", iter: 0, round: 2 },
        { seq: 3, id: "think", iter: 0, round: 0 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    eq(
      "a command stage that ran inside a loop round is not 'not started'",
      readRun(live, r).stages.find((s) => s.id === "gate").status,
      "ran",
    );
    // ...and it must sit where it RAN. A missed lookup does not merely mislabel the
    // stage, it drops it to the fallback sort, which places it after everything the
    // journal ordered -- so a plan-stage loop that gated the fan-out rendered BELOW
    // the builder it had released. `gate` ran second here and declares third.
    eq(
      "a loop stage sorts by when it ran, not after everything the journal placed",
      readRun(live, r)
        .stages.map((s) => s.id)
        .join(","),
      "cmd,gate,think,later",
    );
    rmSync(live, { recursive: true, force: true });
  }

  // A FAN-OUT COMMAND STAGE. It makes no model call, so it leaves no log directory
  // and is invisible to the log-dir walk; the declared pipeline then gives it one
  // row at element 0, where it will never run. It reads "not started" for the whole
  // run while in fact executing once per element. The journal knows which elements
  // it ran in, so it earns a row per element the same way a model stage earns one
  // by leaving a directory.
  {
    const fan = path.join(r, "results", "chain-runs", "logs", "c__fan__2026-01-01T00-00-00");
    mkdirSync(path.join(fan, "01-code~1"), { recursive: true });
    writeFileSync(
      path.join(fan, "_chain.json"),
      JSON.stringify({
        stages: [
          { id: "code", inForeach: true },
          { id: "facts", inForeach: true },
        ],
      }),
    );
    writeFileSync(
      path.join(fan, "_calls.jsonl"),
      [
        { seq: 1, id: "code", iter: 1, round: 0 },
        { seq: 2, id: "facts", iter: 1, round: 1 },
        { seq: 3, id: "code", iter: 2, round: 0 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const f = readRun(fan, r);
    const facts = f.stages.filter((s) => s.id === "facts");
    eq("a fan-out command stage gets a row per element it ran in", facts.length, 1);
    eq("that row is attributed to the element, not element 0", facts[0].iter, 1);
    eq("and it is not reported as never started", facts[0].status, "ran");
    // The fan-out's unit is named BY THE CHAIN. "element" is not neutral, it is
    // just a worse name than the one the config already declares in foreach.as --
    // the same binding the prompts read as {{chunk.id}}. The canvas repeats it
    // without ever learning what the thing is.
    eq("a chain's own word for its fan-out unit is carried through", f.unit, "element");
    writeFileSync(
      path.join(fan, "_chain.json"),
      JSON.stringify({
        stages: [
          { id: "code", inForeach: true },
          { id: "facts", inForeach: true },
        ],
        foreach: { over: "plan.chunks", as: "chunk" },
      }),
    );
    eq("a declared binding name replaces the generic one", readRun(fan, r).unit, "chunk");
    rmSync(fan, { recursive: true, force: true });
  }

  // AN ABSENT COST IS NOT A ZERO COST. A stage still running has reported no usage
  // yet, and "0.00 AiU" beside 41 tool calls reads as work done for free. The real
  // figure for the call that prompted this was 58.83 AiU, minutes later.
  {
    const c = mkdtempSync(path.join(tmpdir(), "ck-cost-"));
    const cid = "c__cost__2026-01-01T00-00-00";
    const cdir = path.join(c, "results", "chain-runs", "logs", cid);
    mkdirSync(path.join(cdir, "01-live"), { recursive: true });
    mkdirSync(path.join(cdir, "02-done"), { recursive: true });
    // In flight: tool calls, an assistant message, and no usage checkpoint at all.
    writeFileSync(
      path.join(cdir, "01-live", "live.jsonl"),
      [
        { type: "tool.execution_start", data: { toolCallId: "a", toolName: "view" } },
        { type: "tool.execution_complete", data: { toolCallId: "a", success: true } },
        { type: "assistant.message", data: { model: "m", outputTokens: 10, content: "…" } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    writeFileSync(
      path.join(cdir, "02-done", "done.jsonl"),
      [
        { type: "assistant.message", data: { model: "m", outputTokens: 10, content: "ok" } },
        { type: "session.usage_checkpoint", data: { totalNanoAiu: 7e9 } },
        { type: "result", data: {} },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const cr = readRun(cdir, c);
    const S = (id) => cr.stages.find((s) => s.id === id);
    eq("a stage that has reported no usage says so", S("live").aiuKnown, false);
    eq("and it is not claimed to have cost zero", S("live").aiu, 0);
    eq("a stage that reported usage is known", S("done").aiuKnown, true);
    eq("and carries the real figure", S("done").aiu, 7);
    rmSync(c, { recursive: true, force: true });
  }

  // A RESUMED STAGE'S COST IS CUMULATIVE, SO IT IS A DIFFERENCE, NOT A SUM.
  // Real numbers from a resumed fixer: round 1 reported 20.74 and round 2 reported
  // 45.39, because round 2 continued round 1's session and its checkpoint carries
  // the whole session's running total. Summing them claimed 66.13 for a stage that
  // cost 45.39 -- and made every per-round figure wrong too. The tell that this is
  // cumulative and not two independent calls is `totalPremiumRequests`: 1 then 2.
  {
    const w = mkdtempSync(path.join(tmpdir(), "ck-warm-"));
    const wid = "w__warm__2026-01-01T00-00-00";
    const wdir = path.join(w, "results", "chain-runs", "logs", wid);
    const call = (dir, label, aiu, sessionId) => {
      mkdirSync(path.join(wdir, dir), { recursive: true });
      writeFileSync(
        path.join(wdir, dir, `${label}.jsonl`),
        [
          { type: "assistant.message", data: { model: "m", outputTokens: 10, content: "ok" } },
          { type: "session.usage_checkpoint", data: { totalNanoAiu: aiu * 1e9 } },
          { type: "result", data: {} },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n"),
      );
      if (sessionId !== undefined)
        writeFileSync(
          path.join(wdir, dir, `${label}.argv.jsonl`),
          // PRETTY-PRINTED, because that is how the kernel writes it. Minified here
          // once, and the reader's "parse the first line" bug passed this suite
          // while doing nothing at all on a real run.
          JSON.stringify({ sessionId, model: "m" }, null, 2),
        );
    };
    // Resumed: both rounds on one session, checkpoints cumulative.
    call("01-fix", "fix.r1", 20.74, "s-fix");
    call("01-fix", "fix.r2", 45.39, "s-fix");
    // Not resumed: a fresh session per round, so each checkpoint is already its own.
    call("02-review", "review.r1", 27.52, "s-rev-1");
    call("02-review", "review.r2", 26.51, "s-rev-2");
    // No sidecar at all -- an older run. Must behave exactly as it did before.
    call("03-legacy", "legacy", 9);
    const wr = readRun(wdir, w);
    const R = (id, round) => wr.stages.find((s) => s.id === id && (s.round || 0) === round);
    eq("the round that opened a session reports its own cost", R("fix", 1).aiu, 20.74);
    eq(
      "a resumed round reports only what IT added, not the session total",
      Number(R("fix", 2).aiu.toFixed(2)),
      24.65,
    );
    eq(
      "the resumed stage's rounds sum to the session total, not to more",
      Number((R("fix", 1).aiu + R("fix", 2).aiu).toFixed(2)),
      45.39,
    );
    eq(
      "a stage with a fresh session per round is untouched",
      [R("review", 1).aiu, R("review", 2).aiu],
      [27.52, 26.51],
    );
    eq("a call with no session id is left exactly as it was", R("legacy", 0).aiu, 9);
    eq(
      "the run total counts the resumed session once",
      Number(wr.totals.aiu.toFixed(2)),
      Number((45.39 + 27.52 + 26.51 + 9).toFixed(2)),
    );
    rmSync(w, { recursive: true, force: true });
  }

  rmSync(r, { recursive: true, force: true });
}

// THE CALL JOURNAL. Order used to be INFERRED from (element, round, declared
// index). That is right for every shape seen so far and wrong the moment a
// non-loop stage sits AFTER a loop: its round is 0, so it sorts ahead of every
// loop round and the view claims it ran second when it ran last. The driver knows
// the true order at the instant it calls, so it writes it down; this pins that the
// reader uses it, and that the inference alone would get this run wrong.
{
  const jRoot = mkdtempSync(path.join(tmpdir(), "ck-canvas-j-"));
  const jId = "journal__zz__2026-01-01T00-00-00";
  const jDir = path.join(jRoot, "results", "chain-runs", "logs", jId);
  const put = (dir, file) => {
    mkdirSync(path.join(jDir, dir), { recursive: true });
    writeFileSync(
      path.join(jDir, dir, file),
      [
        { type: "assistant.message", data: { model: "m", outputTokens: 1, content: "{}" } },
        { type: "result", data: {} },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
  };
  // setup, then a two-round loop over [build, check], then a teardown stage that
  // is NOT in the loop and runs last.
  put("01-setup", "setup.jsonl");
  put("02-build", "build.r1.jsonl");
  put("02-build", "build.r2.jsonl");
  put("03-check", "check.r1.jsonl");
  put("03-check", "check.r2.jsonl");
  put("04-teardown", "teardown.jsonl");
  const journal = [
    { seq: 1, id: "setup", iter: 0, round: 0 },
    { seq: 2, id: "build", iter: 0, round: 1 },
    { seq: 3, id: "check", iter: 0, round: 1 },
    { seq: 4, id: "build", iter: 0, round: 2 },
    { seq: 5, id: "check", iter: 0, round: 2 },
    { seq: 6, id: "teardown", iter: 0, round: 0 },
  ];
  writeFileSync(
    path.join(jDir, "_calls.jsonl"),
    journal.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const withJournal = readRun(jDir, jRoot);
  eq(
    "the run is shown in the order the driver actually called the stages",
    withJournal.stages.map((s) => s.id + (s.round ? " r" + s.round : "")),
    ["setup", "build r1", "check r1", "build r2", "check r2", "teardown"],
  );

  // Without the journal the same run reads wrong -- teardown jumps to second.
  // This is what the journal is FOR, so it is asserted rather than assumed.
  rmSync(path.join(jDir, "_calls.jsonl"));
  const inferred = readRun(jDir, jRoot);
  eq(
    "inference alone puts a post-loop stage in the wrong place",
    inferred.stages.map((s) => s.id)[1],
    "teardown",
  );

  rmSync(jRoot, { recursive: true, force: true });
}

// A completion failure must be visible before the final run record exists.
{
  const liveRoot = mkdtempSync(path.join(tmpdir(), "ck-canvas-events-"));
  const liveId = "events__zz__2026-01-01T00-00-00";
  const liveDir = path.join(liveRoot, "results", "chain-runs", "logs", liveId);
  mkdirSync(path.join(liveDir, "01-build"), { recursive: true });
  writeFileSync(
    path.join(liveDir, "_chain.json"),
    JSON.stringify({
      stages: [
        {
          id: "build",
          ord: 1,
          model: "m",
          tools: true,
          completion: { run: "pnpm check", attempts: 3 },
        },
      ],
    }),
  );
  writeFileSync(
    path.join(liveDir, "01-build", "build.jsonl"),
    [
      { type: "assistant.message", data: { model: "m", outputTokens: 1, content: "done" } },
      { type: "result", data: {} },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  writeFileSync(
    path.join(liveDir, "_events.jsonl"),
    JSON.stringify({
      type: "completion.checked",
      timestamp: "2026-01-01T00:00:01Z",
      scope: "stage",
      identity: { stage: "build", iter: 0, round: 0, callAttempt: 0 },
      check: {
        command: "pnpm check",
        status: "failed",
        exitCode: 1,
        output: "first line\nsecond line\nthird line",
        attempt: 1,
        attempts: 3,
        ok: false,
      },
    }) + "\n",
  );
  const liveFailure = readRun(liveDir, liveRoot);
  eq("generic completion events are exposed by the run reader", liveFailure.events.length, 1);
  eq(
    "a live event failure attaches to attempt one without a final record",
    liveFailure.stages[0].rounds[0].completionCheck.output,
    "first line\nsecond line\nthird line",
  );
  eq(
    "all bounded failure lines reach the stage completion detail",
    liveFailure.stages[0].completion[0].output,
    "first line\nsecond line\nthird line",
  );
  rmSync(liveRoot, { recursive: true, force: true });
}

// COMMAND STAGES. Their append-only lifecycle is the only live evidence available:
// there is no model-call JSONL and the final record does not exist until the run ends.
{
  const commandRoot = mkdtempSync(path.join(tmpdir(), "ck-command-events-"));
  const logs = path.join(commandRoot, "logs");
  const ctx = { snapshot: () => ({}) };
  const execute = async (stage) => {
    const lifecycle = [];
    const result = await runCommandStage({
      stage: { timeoutMs: 5000, expects: null, ord: 1, ...stage },
      ctx,
      workDir: commandRoot,
      logRoot: logs,
      onLifecycle: (event) => lifecycle.push(event),
    });
    return { result, lifecycle };
  };

  const text = await execute({
    id: "text-artifact",
    run: "printf 'alpha\\nbeta\\n'",
    parse: "text",
    produces: "report",
  });
  eq(
    "a successful text command emits started then completed",
    text.lifecycle.map((event) => event.phase),
    ["started", "completed"],
  );
  eq(
    "a text artifact retains its generic type",
    text.result.commandResult.artifact.shape.type,
    "string",
  );
  eq("a text artifact records its line count", text.result.commandResult.artifact.lines, 2);
  eq(
    "a text artifact preview is readable text",
    text.result.commandResult.artifact.preview,
    "alpha\nbeta",
  );

  const json = await execute({
    id: "json-artifact",
    run: `printf '{"items":[1,2],"ok":true}'`,
    parse: "json",
    produces: "facts",
  });
  eq(
    "a JSON artifact retains object shape",
    json.result.commandResult.artifact.shape.type,
    "object",
  );
  eq(
    "a JSON artifact preview remains structural",
    json.result.commandResult.artifact.preview.items,
    [1, 2],
  );

  const plain = await execute({
    id: "plain-output",
    run: "printf 'plain output'",
    parse: "text",
    produces: null,
  });
  eq(
    "a command without produces has no invented artifact",
    plain.result.commandResult.artifact,
    null,
  );
  eq(
    "a command without produces still retains stdout",
    plain.result.commandResult.stdout.preview,
    "plain output",
  );

  const failed = await execute({
    id: "failed-command",
    run: "printf 'bad news' >&2; exit 7",
    parse: "text",
    produces: null,
  });
  eq("a failed command emits failed status", failed.result.commandResult.status, "failed");
  eq("a failed command retains its exit code", failed.result.commandResult.exitCode, 7);
  eq(
    "a failed command retains bounded stderr",
    failed.result.commandResult.stderr.preview,
    "bad news",
  );

  const bounded = await execute({
    id: "bounded-output",
    run: `node -e "process.stdout.write('x'.repeat(13050))"`,
    parse: "text",
    produces: null,
  });
  eq(
    "command stdout previews are bounded",
    bounded.result.commandResult.stdout.preview.length,
    12000,
  );
  eq(
    "bounded command stdout is marked truncated",
    bounded.result.commandResult.stdout.truncated,
    true,
  );

  const broadJson = await execute({
    id: "bounded-json",
    run: `node -e "console.log(JSON.stringify(Array.from({length:30},()=>Array.from({length:30},()=>Array(30).fill('')))))"`,
    parse: "json",
    produces: "matrix",
  });
  eq(
    "structural JSON previews stay inside their serialized bound",
    JSON.stringify(broadJson.result.commandResult.artifact.preview).length <= 10000,
    true,
  );
  eq(
    "a structurally bounded JSON preview is marked truncated",
    broadJson.result.commandResult.artifact.truncated,
    true,
  );

  const deepJson = await execute({
    id: "deep-json",
    run: `node -e "process.stdout.write('['.repeat(20000) + '0' + ']'.repeat(20000))"`,
    parse: "json",
    produces: "deep",
  });
  eq("deep valid JSON still completes", deepJson.result.ok, true);
  eq(
    "deep valid JSON still emits terminal telemetry",
    deepJson.lifecycle.map((event) => event.phase),
    ["started", "completed"],
  );
  eq(
    "deep JSON shape is reported without recursive traversal",
    deepJson.result.commandResult.artifact.shape.type,
    "array",
  );

  const parseFailure = await execute({
    id: "parse-failure",
    run: "printf 'not json'",
    parse: "json",
    produces: "facts",
  });
  eq(
    "a parse failure retains the artifact declaration without claiming production",
    parseFailure.result.commandResult.artifact.state,
    "declared",
  );
  const shapeFailure = await execute({
    id: "shape-failure",
    run: `printf '{"pass":"yes"}'`,
    parse: "json",
    produces: "verdict",
    expects: { pass: "boolean" },
  });
  eq(
    "a rejected shaped value is identified as a candidate, not a produced artifact",
    shapeFailure.result.commandResult.artifact.state,
    "candidate",
  );

  const root = path.join(commandRoot, "canvas");
  const id = "commands__live__2026-01-01T00-00-00";
  const dir = path.join(root, "results", "chain-runs", "logs", id);
  mkdirSync(dir, { recursive: true });
  const declarations = [
    { id: "text-artifact", ord: 1, run: "text", parse: "text", produces: "report" },
    { id: "json-artifact", ord: 2, run: "json", parse: "json", produces: "facts" },
    { id: "plain-output", ord: 3, run: "plain", parse: "text", produces: null },
    { id: "failed-command", ord: 4, run: "fail", parse: "text", produces: null },
    {
      id: "foreach-command",
      ord: 5,
      run: "foreach",
      parse: "text",
      produces: "item",
      inForeach: true,
    },
  ];
  writeFileSync(
    path.join(dir, "_chain.json"),
    JSON.stringify({ stages: declarations, foreach: { as: "item" } }),
  );
  const fixtures = [
    { seq: 1, id: "text-artifact", result: text.result.commandResult },
    { seq: 2, id: "json-artifact", result: json.result.commandResult },
    { seq: 3, id: "plain-output", result: plain.result.commandResult },
    { seq: 4, id: "failed-command", result: failed.result.commandResult },
    { seq: 5, id: "foreach-command", iter: 1, result: text.result.commandResult },
    { seq: 6, id: "foreach-command", iter: 2, result: plain.result.commandResult },
  ];
  writeFileSync(
    path.join(dir, "_calls.jsonl"),
    fixtures
      .map(({ seq, id: stage, iter = 0 }) =>
        JSON.stringify({ seq, id: stage, iter, round: 0, attempt: 0 }),
      )
      .join("\n") + "\n",
  );
  writeFileSync(
    path.join(dir, "_events.jsonl"),
    fixtures
      .flatMap(({ seq, id: stage, iter = 0, result }) => [
        {
          type: "command.stage.started",
          timestamp: result.startedAt,
          identity: { stage, seq, iter, round: 0, attempt: 0 },
          command: result.command,
          artifact: result.artifact
            ? { name: result.artifact.name, parse: result.artifact.parse }
            : null,
          startedAt: result.startedAt,
        },
        {
          type: result.ok ? "command.stage.completed" : "command.stage.failed",
          timestamp: result.finishedAt,
          identity: { stage, seq, iter, round: 0, attempt: 0 },
          result,
        },
      ])
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );

  const live = readRun(dir, root);
  const stage = (name, iter = 0) =>
    live.stages.find((row) => row.id === name && (row.iter || 0) === iter);
  eq("command lifecycle renders without a final record", live.summary, null);
  eq("a live successful command is completed", stage("text-artifact").status, "completed");
  eq(
    "a live JSON artifact reaches the generic structural renderer",
    stage("json-artifact").commandRuns[0].artifact.preview.ok,
    true,
  );
  eq(
    "a live command without produces keeps its output",
    stage("plain-output").commandRuns[0].stdout.preview,
    "plain output",
  );
  eq("a live failed command is visibly failed", stage("failed-command").status, "failed");
  eq(
    "foreach command stages remain isolated by iteration",
    live.stages.filter((row) => row.id === "foreach-command").map((row) => row.iter),
    [1, 2],
  );
  eq(
    "command stages preserve journal execution order",
    live.stages.filter((row) => row.commandRuns?.length).map((row) => `${row.id}/${row.iter || 0}`),
    [
      "text-artifact/0",
      "json-artifact/0",
      "plain-output/0",
      "failed-command/0",
      "foreach-command/1",
      "foreach-command/2",
    ],
  );
  eq("command stages never claim measured model cost", stage("text-artifact").aiuKnown, false);

  // A final record is authoritative when an event append was interrupted after the
  // started line, and can also restore command rounds whose event never landed.
  const finalId = "commands__final__2026-01-01T00-00-00";
  const finalDir = path.join(root, "results", "chain-runs", "logs", finalId);
  mkdirSync(finalDir, { recursive: true });
  writeFileSync(
    path.join(finalDir, "_chain.json"),
    JSON.stringify({
      stages: [{ id: "loop-command", ord: 1, run: "loop", parse: "text", inLoop: true }],
    }),
  );
  writeFileSync(
    path.join(finalDir, "_calls.jsonl"),
    [
      { seq: 1, id: "loop-command", iter: 0, round: 1, attempt: 0 },
      { seq: 2, id: "loop-command", iter: 0, round: 2, attempt: 0 },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  writeFileSync(
    path.join(finalDir, "_events.jsonl"),
    JSON.stringify({
      type: "command.stage.started",
      timestamp: text.result.commandResult.startedAt,
      identity: { stage: "loop-command", seq: 1, iter: 0, round: 1, attempt: 0 },
      command: text.result.commandResult.command,
      artifact: null,
      startedAt: text.result.commandResult.startedAt,
    }) + "\n",
  );
  mkdirSync(path.join(root, "results", "chain-runs"), { recursive: true });
  writeFileSync(
    path.join(root, "results", "chain-runs", `${finalId}.json`),
    JSON.stringify({
      completed: true,
      stageLog: [
        {
          id: "loop-command",
          round: 1,
          iter: 0,
          attempt: 0,
          commandResult: text.result.commandResult,
        },
        {
          id: "loop-command",
          round: 2,
          iter: 0,
          attempt: 0,
          commandResult: plain.result.commandResult,
        },
      ],
    }),
  );
  const final = readRun(finalDir, root);
  eq(
    "the final record completes a lifecycle that only journaled started",
    final.stages.find((row) => row.round === 1).status,
    "completed",
  );
  eq(
    "the final record restores command rounds missing from the event journal",
    final.stages.filter((row) => row.id === "loop-command").map((row) => row.round),
    [1, 2],
  );

  const orphanId = "commands__orphan__2026-01-01T00-00-00";
  const orphanDir = path.join(root, "results", "chain-runs", "logs", orphanId);
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(
    path.join(orphanDir, "_chain.json"),
    JSON.stringify({ stages: [{ id: "orphan", ord: 1, run: "sleep", timeoutMs: 1000 }] }),
  );
  writeFileSync(
    path.join(orphanDir, "_events.jsonl"),
    JSON.stringify({
      type: "command.stage.started",
      timestamp: "2026-01-01T00:00:00Z",
      identity: { stage: "orphan", seq: 1, iter: 0, round: 0, attempt: 0 },
      command: { text: "sleep", characters: 5, truncated: false },
      artifact: null,
      startedAt: "2026-01-01T00:00:00Z",
    }) + "\n",
  );
  eq(
    "an orphaned started event expires instead of reporting live forever",
    readRun(orphanDir, root).stages[0].status,
    "interrupted",
  );

  rmSync(commandRoot, { recursive: true, force: true });
}

// TWO ROOTS. Run records live beside the CHAIN that produced them, so a repo has
// more than one results dir: the project's `.chainkit/` and the vendored engine's
// own. Which one a run landed in is an artifact of which chain file was used, not
// something a reader should have to know, so listRuns takes the union. The failure
// this guards is silent and total: pick one root and the other root's runs simply
// do not exist, and the canvas renders an honest-looking empty state.
{
  const rA = mkdtempSync(path.join(tmpdir(), "ck-rootA-"));
  const rB = mkdtempSync(path.join(tmpdir(), "ck-rootB-"));
  const mk = (root, id, stamp) => {
    const d = path.join(root, "results", "chain-runs", "logs", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "_calls.jsonl"), "");
    utimesSync(d, stamp, stamp);
  };
  mk(rA, "proj__a__2026-01-01T00-00-00", 2000);
  mk(rB, "engine__b__2026-01-02T00-00-00", 3000);

  const both = listRuns([rA, rB]);
  eq("listRuns unions every root", both.length, 2);
  eq("union is sorted newest-first across roots", both[0].id, "engine__b__2026-01-02T00-00-00");
  eq("newest run carries its own root", both[0].root, rB);
  eq("older run carries its own root", both[1].root, rA);
  eq("a bare root string still works", listRuns(rA).length, 1);
  eq("a missing root is skipped, not fatal", listRuns([path.join(rA, "nope"), rB]).length, 1);

  rmSync(rA, { recursive: true, force: true });
  rmSync(rB, { recursive: true, force: true });
}

// THE PAGE'S OWN SCRIPT. `node --check render.mjs` only proves the template
// literal is a valid string -- the browser JS inside it is never parsed by
// anything until it reaches a browser, where a syntax error renders a blank
// panel with no error anywhere the operator will look. Parse it here.
{
  const html = page();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  eq("the page ships exactly one inline script", scripts.length, 1);
  let syntaxError = null;
  try {
    new vm.Script(scripts[0] || "");
  } catch (e) {
    syntaxError = e.message;
  }
  eq("the page's inline script parses", syntaxError, null);

  // The spend legend is an interactive index into the bar. Exercise the emitted
  // browser helpers so this proves behavior rather than only matching source text.
  const spendFrom = scripts[0].indexOf("const spendKey =");
  const spendTo = scripts[0].indexOf("\nlet hoveredSpendKey =", spendFrom);
  const spendCtx = {
    out: null,
    esc: (s) =>
      String(s ?? "").replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      ),
  };
  vm.createContext(spendCtx);
  new vm.Script(
    scripts[0].slice(spendFrom, spendTo) + "\nout = { spendKey, spendHtml };",
  ).runInContext(spendCtx);
  const unusualStage = 'odd stage/"<& 😈';
  const unusualKey = spendCtx.out.spendKey(unusualStage);
  const spendMarkup = spendCtx.out.spendHtml(
    [
      { id: unusualStage, aiu: 3 },
      { id: "plain", aiu: 1 },
    ],
    4,
    (id) => (id === unusualStage ? "#123456" : "#abcdef"),
  );
  const spendKeys = [...spendMarkup.matchAll(/data-spend-key="([^"]+)"/g)].map((m) => m[1]);
  eq("each legend item shares a data-safe key with its matching spend segment", spendKeys, [
    unusualKey,
    spendCtx.out.spendKey("plain"),
    unusualKey,
    spendCtx.out.spendKey("plain"),
  ]);
  eq("unusual stage ids do not become selector fragments", /^[a-z0-9.-]+$/.test(unusualKey), true);
  eq(
    "unusual stage ids remain escaped in the spend tooltip",
    spendMarkup.includes('title="odd stage/&quot;&lt;&amp; 😈"'),
    true,
  );
  eq(
    "each legend item is keyboard focusable",
    (spendMarkup.match(/class="legend-item" tabindex="0"/g) || []).length,
    2,
  );
  eq(
    "active spend styling dims nonmatching segments and restores the selected segment",
    html.includes(".spend.has-spend-active .split [data-spend-key] { opacity: .3;") &&
      html.includes("[data-spend-key].spend-active {\n    opacity: 1;"),
    true,
  );

  class FakeClassList {
    constructor() {
      this.names = new Set();
    }
    toggle(name, force) {
      if (force) this.names.add(name);
      else this.names.delete(name);
      return this.names.has(name);
    }
    contains(name) {
      return this.names.has(name);
    }
  }
  class FakeSpendItem {
    constructor(kind, key) {
      this.kind = kind;
      this.dataset = { spendKey: key };
      this.classList = new FakeClassList();
    }
    closest(selector) {
      return this.kind === "legend" && selector === ".legend-item[data-spend-key]" ? this : null;
    }
  }
  const segmentA = new FakeSpendItem("segment", unusualKey);
  const segmentB = new FakeSpendItem("segment", spendCtx.out.spendKey("plain"));
  const legendA = new FakeSpendItem("legend", unusualKey);
  const legendB = new FakeSpendItem("legend", spendCtx.out.spendKey("plain"));
  const spendItems = [segmentA, segmentB, legendA, legendB];
  const spendListeners = {};
  const fakeSpend = {
    classList: new FakeClassList(),
    contains: (item) => spendItems.includes(item),
    querySelectorAll: () => spendItems,
    addEventListener: (name, listener) => {
      spendListeners[name] = listener;
    },
  };
  const interactionCtx = {
    document: {
      getElementById: (id) => (id === "spend" ? fakeSpend : null),
    },
    out: null,
  };
  const interactionFrom = scripts[0].indexOf("let hoveredSpendKey =");
  const interactionTo = scripts[0].indexOf("\nfunction render(", interactionFrom);
  vm.createContext(interactionCtx);
  new vm.Script(
    scripts[0].slice(interactionFrom, interactionTo) +
      "\nout = { applySpendEmphasis, legendSpendItem };",
  ).runInContext(interactionCtx);

  spendListeners.pointerover({ target: legendA });
  eq(
    "hover activates the linked legend item and spend segment",
    [legendA.classList.contains("spend-active"), segmentA.classList.contains("spend-active")],
    [true, true],
  );
  eq(
    "hover leaves nonmatching segments de-emphasized",
    [fakeSpend.classList.contains("has-spend-active"), segmentB.classList.contains("spend-active")],
    [true, false],
  );
  spendListeners.pointerout({ target: legendA, relatedTarget: null });
  eq(
    "pointer exit restores the full spend bar",
    [fakeSpend.classList.contains("has-spend-active"), segmentA.classList.contains("spend-active")],
    [false, false],
  );

  spendListeners.focusin({ target: legendB });
  eq(
    "keyboard focus activates the linked legend item and spend segment",
    [legendB.classList.contains("spend-active"), segmentB.classList.contains("spend-active")],
    [true, true],
  );
  spendListeners.focusout({ target: legendB, relatedTarget: null });
  eq(
    "focus exit restores the full spend bar",
    [fakeSpend.classList.contains("has-spend-active"), segmentB.classList.contains("spend-active")],
    [false, false],
  );
  eq(
    "spend emphasis is delegated from the persistent container",
    ["pointerover", "pointerout", "focusin", "focusout"].every((name) => spendListeners[name]),
    true,
  );
  eq(
    "spend repaint reapplies active state after replacing markup",
    /set spend\(h\)[\s\S]*applySpendEmphasis\(\);/.test(scripts[0]),
    true,
  );

  eq("the page renders the non-model channels", html.includes("chans"), true);
  eq(
    "declared completion is visible as an upfront exit criterion",
    html.includes("<b>Exit criterion</b>") &&
      html.includes("up to ${attempts} attempt") &&
      html.includes("completion.run"),
    true,
  );
  eq(
    "bounded completion failure output renders in a capped scrollable detail",
    html.includes("completion-failures") &&
      html.includes("max-height: 180px") &&
      html.includes("check.output || check.tail"),
    true,
  );
  eq(
    "command cards expose command, result, artifact, diagnostics, and absent metrics",
    html.includes("command-runs") &&
      html.includes("Produced artifact") &&
      html.includes("stdout") &&
      html.includes("stderr") &&
      html.includes("model · AiU · tokens: not applicable") &&
      html.includes('class="tag">attempt') &&
      html.includes('a.parse === "json"') &&
      html.includes("jsonHtml(a.preview, 0)"),
    true,
  );
  eq(
    "call disclosure uses a keyboard-accessible button",
    html.includes('<button type="button" class="chead"') &&
      html.includes('aria-expanded="') &&
      html.includes('aria-controls="'),
    true,
  );
  eq(
    "each model call can disclose the exact prompt sent",
    html.includes('<details class="prompt" data-prompt-key="${esc(key)}"') &&
      html.includes("Prompt sent · ${call.prompt.length.toLocaleString()} characters") &&
      html.includes('<div class="prompt-body">${promptMarkdownHtml(call.prompt)}</div>'),
    true,
  );
  eq(
    "open prompt disclosures survive live redraws",
    html.includes("const openPrompts = new Set()") &&
      html.includes('openPrompts.has(key) ? " open" : ""') &&
      html.includes('document.querySelectorAll("details.prompt")') &&
      html.includes("openPrompts.add(key)") &&
      html.includes("openPrompts.delete(key)"),
    true,
  );
  eq(
    "adjacent parallel groups get one dense spacing break",
    html.includes(".step.pgrp-end + .step.pgrp-start { margin-top: 4px; }"),
    true,
  );
  eq(
    "refresh failures visibly mark retained telemetry as stale",
    html.includes("RECONNECTING · data ") &&
      html.includes("last successful snapshot remains visible"),
    true,
  );
  // A stage's status must reach the STYLESHEET, not just its right-hand label:
  // a stage's calls run tall, so which stage you are inside has to be legible
  // from the card, and "running now" has to look different from "finished an
  // hour ago" without reading the text.
  eq("each stage card carries its status as a class", html.includes('class="stage s-'), true);
  eq("the stylesheet distinguishes the running stage", html.includes(".stage.s-running"), true);
  eq("a live run is classified separately", runState(null, true), "live");
  eq("a successful terminal run says delivered", runState({ delivered: true }, false), "delivered");
  eq(
    "an unverified successful run says completed",
    runState({ delivered: false, completed: true, completionStatus: "absent" }, false),
    "completed",
  );
  eq(
    "a verified run that failed the delivery oracle stays visibly verified",
    runState({ delivered: false, completed: true, verified: true }, false),
    "verified",
  );
  eq(
    "an unsuccessful terminal run says failed",
    runState({ delivered: false, gate: { ok: false } }, false),
    "failed",
  );
  eq(
    "a halted terminal run says halted",
    runState({ delivered: false, halted: { kind: "appeal" } }, false),
    "halted",
  );
  eq("the sticky header carries the terminal state", html.includes('id="runstate"'), true);
  eq("terminal failure changes the whole header", html.includes("#top.failed"), true);
  eq(
    "a preserved legacy gate record still says how far it got and why",
    runHeadline(
      {
        delivered: false,
        foreach: {
          count: 4,
          iterations: [
            { gate: { ok: true } },
            { gate: { ok: true } },
            { gate: { ok: true } },
            { gate: { ok: true } },
          ],
        },
        gate: {
          ok: false,
          tail: "Unused exported types (1)\nCachedWidget  type  src/cache.ts:4:13",
        },
      },
      "chunk",
    ),
    "Completed 4/4 chunks; 4/4 gates passed, but the final gate failed: unused exported type CachedWidget.",
  );
  eq(
    "a new completion record renders completed and unverified",
    runHeadline({ completed: true, delivered: false, completionStatus: "absent" }, "chunk"),
    "Completed without declared chain completion; unverified.",
  );
  eq(
    "a halt says where and why",
    runHeadline(
      { delivered: false, halted: { stage: "fix-review", reason: "repair list reopened F1" } },
      "chunk",
    ),
    "Stopped at fix-review: repair list reopened F1.",
  );
  eq("the one-line outcome sits beside the badge", html.includes('id="runsummary"'), true);

  // ONE SCROLLING REGION, NOT A SCROLLING PAGE. The run totals must stay on screen
  // while the chain is scrolled -- they are what a stage's numbers get compared
  // against. Asserted structurally because the failure mode is silent: drop the
  // min-height and the layout renders identically until you scroll.
  eq(
    "the summary sits in a header outside the scrolling region",
    html.includes('<div id="top">'),
    true,
  );
  eq(
    "the run picker is inside that header",
    html.indexOf('<div id="top">') < html.indexOf('id="runs"'),
    true,
  );
  eq(
    "the totals are inside that header",
    html.indexOf('id="cards"') < html.indexOf('<div id="body">'),
    true,
  );
  eq("only the chain scrolls", /#body \{[^}]*overflow: auto/.test(html), true);
  eq("and it is allowed to shrink enough to do so", /#body \{[^}]*min-height: 0/.test(html), true);
  eq("the page itself does not scroll", /body \{[^}]*overflow: hidden/.test(html), true);
  // The chunk headers were already sticky. They now stick to the top of that
  // region rather than to a viewport the header has scrolled out of.
  eq(
    "chunk headers are still sticky inside it",
    /\.ghead \{[^}]*position: sticky/.test(html),
    true,
  );

  // The resume note sits with the other stage facts -- "reasons only", the expects
  // contract -- at their weight. It was a bordered YELLOW pill on a line of its own,
  // which gave a routine property of a resumed round the visual weight of a defect.
  // Pinned in both directions so "quiet" cannot silently become "deleted".
  eq(
    "the resume note carries no warning styling",
    /class="chan warn"[^>]*resumes/.test(html),
    false,
  );
  eq("it sits with the other stage facts", /if \(rsm\) bits\.push\(rsm\)/.test(html), true);
  eq(
    "it names the stage with the chain's own word",
    html.includes("resumes ${esc(source)} context"),
    true,
  );

  // A CUT-OFF stage must show the WHOLE answer, not its tail. The motivating
  // panel opened mid-word at "undred ms" because only the last assistant
  // message survived; the earlier calls existed but were never read.
  const cutRoot = mkdtempSync(path.join(tmpdir(), "ck-canvas-cut-"));
  const cutDir = path.join(cutRoot, "results", "chain-runs", "logs", runId);
  const call = (content, reason) => ({
    type: "model.model_call_success",
    data: {
      maxOutputTokens: 32000,
      responseChunk: { choices: [{ finish_reason: reason, delta: { content } }] },
    },
  });
  mkdirSync(path.join(cutDir, "01-x"), { recursive: true });
  writeFileSync(
    path.join(cutDir, "01-x", "x.jsonl"),
    [
      call("BEGINNING of the answer", "length"),
      call("the TAIL of it", "stop"),
      // Only the final, non-truncated turn produces an assistant message --
      // which is exactly the shape that lost the earlier text.
      { type: "assistant.message", data: { model: "m", content: "the TAIL of it" } },
      { type: "result", data: {} },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  const cutStage = readRun(cutDir, cutRoot).stages[0];
  const cutSay = cutStage.rounds
    .flatMap((p) => p.steps)
    .filter((x) => x.kind === "say")
    .pop();
  eq("a cut-off stage is counted as truncated", cutStage.truncated, 1);
  eq("the panel shows the beginning, not just the tail", cutSay.text.startsWith("BEGINNING"), true);
  eq("the panel still shows the tail", cutSay.text.includes("the TAIL of it"), true);
  // Marked, never silently merged: a cut-off call is sometimes an attempt the
  // model abandoned, so the seam must not be presented as a continuation.
  eq("the cut is marked at the seam", cutSay.text.includes("cut off here"), true);
  // The no-regression half, in its OWN fixture: the shared one above is removed
  // long before this point, and reading a deleted directory would have made this
  // pass for the wrong reason.
  mkdirSync(path.join(cutDir, "02-y"), { recursive: true });
  writeFileSync(
    path.join(cutDir, "02-y", "y.jsonl"),
    [
      call("a whole answer, uninterrupted", "stop"),
      { type: "assistant.message", data: { model: "m", content: "a whole answer, uninterrupted" } },
      { type: "result", data: {} },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  const plain = readRun(cutDir, cutRoot).stages.find((x) => x.id === "y");
  const plainSay = plain.rounds
    .flatMap((p) => p.steps)
    .filter((x) => x.kind === "say")
    .pop();
  eq("an untruncated stage is not counted as truncated", plain.truncated, 0);
  eq("an untruncated stage is untouched", plainSay.text, "a whole answer, uninterrupted");
  rmSync(cutRoot, { recursive: true, force: true });

  // Parsing is not behaviour. `sayText` is written inside a template literal, so
  // its regexes pass through one round of escape processing before a browser
  // ever sees them -- a level I got wrong first try, which parsed cleanly at the
  // .mjs level and produced a regex containing a real newline in the page. Run
  // the EMITTED function, not the source.
  // Only this declaration -- the surrounding script talks to `document`, which
  // does not exist here and is not what is under test.
  const src = scripts[0];
  const from = src.indexOf("const sayText =");
  const decl = src.slice(from, src.indexOf("\n};", from) + 3);
  const ctx = { out: null };
  vm.createContext(ctx);
  new vm.Script(decl + "\nout = sayText;").runInContext(ctx);
  const sayText = ctx.out;
  eq("an escaped-newline payload is unescaped for display", sayText("a\\nb\\nc"), "a\nb\nc");
  eq("ordinary multi-line prose is left alone", sayText("a\nb"), "a\nb");

  // Same reasoning for `sayHtml`: run the EMITTED function. Its regexes carry an
  // \x60 escape precisely because a literal backtick cannot appear in that file,
  // and whether that survives escape processing is only answerable by running it.
  const hFrom = src.indexOf("const sayHtml =");
  const hDecl = src.slice(hFrom, src.indexOf(";\n//", hFrom) + 1);
  const hCtx = {
    out: null,
    esc: (s) =>
      String(s ?? "").replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      ),
  };
  vm.createContext(hCtx);
  new vm.Script(hDecl + "\nout = sayHtml;").runInContext(hCtx);
  const sayHtml = hCtx.out;
  eq(
    "a heading becomes a heading",
    sayHtml("## Issue: limiter"),
    '<b class="mdh">Issue: limiter</b>',
  );
  eq("bold becomes bold", sayHtml("**File:** x"), "<strong>File:</strong> x");
  eq(
    "inline code becomes code",
    sayHtml("call " + String.fromCharCode(96) + "esc()" + String.fromCharCode(96)),
    "call <code>esc()</code>",
  );
  const stepFrom = src.indexOf("const stepHtml =");
  const stepDecl = src.slice(stepFrom, src.indexOf(";\n// Render a stage", stepFrom) + 1);
  const stepCtx = { out: null, esc: hCtx.esc, sayHtml, sayText };
  vm.createContext(stepCtx);
  new vm.Script(stepDecl + "\nout = stepHtml;").runInContext(stepCtx);
  const stepHtml = stepCtx.out;
  const adjacentGroups = [
    { kind: "tool", name: "a", detail: "", status: "ok", par: 2, parFirst: true },
    { kind: "tool", name: "b", detail: "", status: "ok", par: 2, parLast: true },
    { kind: "tool", name: "c", detail: "", status: "ok", par: 2, parFirst: true },
    { kind: "tool", name: "d", detail: "", status: "ok", par: 2, parLast: true },
  ].map((x) => stepHtml(x, false));
  eq(
    "parallel group rows render explicit start and end boundaries",
    adjacentGroups.map((row) => row.match(/class="([^"]+)"/)[1]),
    ["step pgrp pgrp-start", "step pgrp pgrp-end", "step pgrp pgrp-start", "step pgrp pgrp-end"],
  );
  eq("the first-row parallel marker stays unchanged", adjacentGroups[0].includes("∥2"), true);
  // The whole reason markup is applied AFTER escaping.
  eq(
    "model output cannot inject html",
    sayHtml("<img src=x onerror=alert(1)>"),
    "&lt;img src=x onerror=alert(1)&gt;",
  );
  eq(
    "an unmatched asterisk is left alone",
    sayHtml("2 * 3 and **real** bold"),
    "2 * 3 and <strong>real</strong> bold",
  );

  const promptFrom = src.indexOf("const promptMarkdownHtml =");
  const promptDecl = src.slice(promptFrom, src.indexOf("\n};", promptFrom) + 3);
  const promptCtx = { out: null, esc: hCtx.esc, sayHtml };
  vm.createContext(promptCtx);
  new vm.Script(promptDecl + "\nout = promptMarkdownHtml;").runInContext(promptCtx);
  const promptMarkdownHtml = promptCtx.out;
  const ticks = String.fromCharCode(96).repeat(3);
  eq(
    "prompt Markdown preserves safe block structure",
    promptMarkdownHtml(
      [
        "## Title",
        "",
        "**Bold** and " + String.fromCharCode(96) + "code" + String.fromCharCode(96),
        "",
        "- one",
        "- two",
        "",
        ticks + "js",
        "const ok = true;",
        ticks,
      ].join("\n"),
    ),
    '<h2>Title</h2><p><strong>Bold</strong> and <code>code</code></p><ul><li>one</li><li>two</li></ul><pre><code class="language-js">const ok = true;</code></pre>',
  );
  eq(
    "prompt Markdown escapes HTML and fence-language injection",
    promptMarkdownHtml(
      [
        '<img src=x onerror="alert(1)">',
        "",
        ticks + '"><script>',
        "<script>alert(2)</script>",
        ticks,
      ].join("\n"),
    ),
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p><pre><code class="language-&quot;&gt;&lt;script&gt;">&lt;script&gt;alert(2)&lt;/script&gt;</code></pre>',
  );

  // The container renderer, also EXECUTED. It calls sayHtml on leaves, so the
  // context needs both.
  const ok = (label, got) => eq(label, got, true);
  const jFrom = src.indexOf("const jsonHtml =");
  const jDecl = src.slice(jFrom, src.indexOf("\n};", jFrom) + 3);
  const jCtx = { out: null, esc: hCtx.esc, sayHtml };
  vm.createContext(jCtx);
  new vm.Script(jDecl + "\nout = jsonHtml;").runInContext(jCtx);
  const jsonHtml = jCtx.out;
  ok(
    "an array of strings is laid out as items, not as bracketed json",
    (() => {
      const h = jsonHtml(["first", "second"], 0);
      return (
        h.includes("jitem") &&
        h.includes("first") &&
        h.includes("second") &&
        !h.includes("[") &&
        !h.includes('"first"')
      );
    })(),
  );
  ok(
    "an object becomes labelled rows",
    (() => {
      const h = jsonHtml({ id: "c1", files: ["a.ts"] }, 0);
      return h.includes("jkey") && h.includes("id") && h.includes("c1") && h.includes("a.ts");
    })(),
  );
  // The unification: a leaf string is prose, and reads as prose wherever it sits.
  ok(
    "markdown inside a leaf string is rendered",
    jsonHtml(["see " + String.fromCharCode(96) + "api.ts" + String.fromCharCode(96)], 0).includes(
      "<code>api.ts</code>",
    ),
  );
  ok(
    "a leaf string cannot inject html",
    jsonHtml(["<script>x</script>"], 0).includes("&lt;script&gt;"),
  );
  eq(
    "an empty array says so rather than rendering nothing",
    jsonHtml([], 0),
    '<span class="jnull">empty</span>',
  );
  ok(
    "runaway nesting falls back to serialised json rather than recursing forever",
    (() => {
      let deep = "leaf";
      for (let i = 0; i < 12; i++) deep = { next: deep };
      return jsonHtml(deep, 0).includes("<pre>");
    })(),
  );

  // The repaint guard, EXECUTED. A parse check would not have caught what it
  // shipped first: the setter body was rewritten to assign through itself, an
  // infinite recursion that is perfectly valid syntax.
  const from2 = src.indexOf("const painted = {};");
  const writes = [];
  const ctx2 = {
    document: {
      getElementById: (id) => ({
        set innerHTML(h) {
          writes.push([id, h]);
        },
      }),
    },
    out: null,
  };
  vm.createContext(ctx2);
  new vm.Script(src.slice(from2, src.indexOf("\n};", from2) + 3) + "\nout = el;").runInContext(
    ctx2,
  );
  ctx2.out.body = "<p>same</p>";
  ctx2.out.body = "<p>same</p>";
  eq("identical markup is written once, not twice", writes.length, 1);
  ctx2.out.body = "<p>different</p>";
  eq("changed markup is written", writes.length, 2);
  eq("each pane is guarded independently", ((ctx2.out.cards = "x"), writes.length), 3);
  // The guard that keeps it from mangling real content: text with one mention of
  // an escape but many real newlines is prose, not a JSON payload.
  eq("prose that merely mentions an escape is untouched", sayText("a\nb\nc\\nd"), "a\nb\nc\\nd");
}

// A tool call with no label is the same row repeated N times. The property that
// matters is not "repo_read is handled" -- it is that a tool this reader has never
// been taught still gets SOMETHING, because new extensions are added all the time
// and the failure is silent: the panel renders, it just says nothing.
{
  eq(
    "a batch reader names its targets and its size",
    describeTool("repo_read", {
      targets: [
        { path: ".chainkit/guidance/review.md" },
        { path: "PROJECT.md" },
        { path: "docs/design.md" },
        { path: "src/types/widget.ts" },
      ],
    }),
    "guidance/review.md, PROJECT.md, docs/design.md +1 · 4 targets",
  );
  eq(
    "a small batch is named without a count",
    describeTool("repo_read", { targets: [{ path: "a/b.ts" }, "c/d.ts"] }),
    "a/b.ts, c/d.ts",
  );
  eq(
    "a batch that names one file repeatedly says it once",
    describeTool("repo_read", {
      targets: [
        { path: "docs/design.md", find: ["a"] },
        { path: "docs/design.md", find: ["b"] },
        { path: "docs/design.md", find: ["c"] },
        { path: "src/config.ts" },
      ],
    }),
    "docs/design.md, src/config.ts · 4 targets",
  );
  eq(
    "a change snapshot names its base and scope",
    describeTool("repo_changes", {
      base: "HEAD^",
      paths: ["apps/api/src/a.ts", "packages/core/src/b.ts"],
    }),
    "HEAD^ → src/a.ts, src/b.ts",
  );
  eq(
    "a ref reader names the revision and targets",
    describeTool("repo_read_ref", {
      ref: "main",
      targets: [{ path: "docs/design.md" }, { path: "PROJECT.md" }],
    }),
    "main · docs/design.md, PROJECT.md",
  );
  eq(
    "re-reading a spilled tool result is not shown as a file path",
    describeTool("view", {
      path: "/var/folders/T/1788118695902-copilot-tool-output-e6b6.txt",
      view_range: [1, 500],
    }),
    "(its own tool output):1-500",
  );
  eq(
    "a symbol lookup shows the symbol",
    describeTool("ts_symbol", { symbol: "WidgetStore" }),
    "WidgetStore",
  );
  eq(
    "an UNKNOWN tool falls back to a scalar arg rather than nothing",
    describeTool("some_future_tool", { query: "who calls this" }),
    "who calls this",
  );
  eq(
    "an unknown tool with only an array of paths still names them",
    describeTool("some_future_tool", { files: ["src/a.ts", "src/b.ts"] }),
    "src/a.ts, src/b.ts",
  );
  eq(
    "an unknown tool with no usable value names its keys, not nothing",
    describeTool("some_future_tool", { opts: { deep: true } }),
    "opts",
  );
  eq("genuinely empty args stay empty", describeTool("some_future_tool", {}), "");
}

// Concurrency detection. The CLI runs tool calls in parallel and the flat step list
// hid it entirely; these prove overlap is read off the timestamps and NOT inferred
// from adjacency, which is the tempting shortcut that would call every fast pair
// parallel.
{
  const tool = (at, endAt) => ({ kind: "tool", name: "t", at, endAt });
  const t = (s) => `2026-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;

  {
    const steps = [tool(t(0), t(5)), tool(t(1), t(4))];
    eq("two overlapping calls report peak 2", annotateConcurrency(steps), 2);
    eq("both are marked with the group size", [steps[0].par, steps[1].par], [2, 2]);
    eq(
      "only the first row carries the badge",
      [steps[0].parFirst, steps[1].parFirst],
      [true, false],
    );
    eq(
      "group boundaries mark the first and last row",
      steps.map((step) => [step.parFirst, step.parLast]),
      [
        [true, false],
        [false, true],
      ],
    );
  }

  {
    const steps = [tool(t(0), t(4)), tool(t(1), t(3)), tool(t(5), t(9)), tool(t(6), t(8))];
    annotateConcurrency(steps);
    eq(
      "adjacent parallel groups remain distinct",
      steps.map((step) => step.parGroup),
      [0, 0, 1, 1],
    );
  }

  {
    const steps = [tool(t(0), t(1)), tool(t(2), t(3))];
    eq("calls that merely follow each other are not parallel", annotateConcurrency(steps), 1);
    eq("and are not grouped", [steps[0].par, steps[1].par], [1, 1]);
  }

  {
    // A of 0-9 overlaps B of 5-6 and C of 8-12: one transitive group of 3, but only
    // 2 were ever open at once. Group size and peak are different questions.
    const steps = [tool(t(0), t(9)), tool(t(5), t(6)), tool(t(8), t(12))];
    eq("a transitive group does not inflate the peak", annotateConcurrency(steps), 2);
    eq("but the group still holds all three", steps[2].par, 3);
  }

  {
    // A call with no complete event ends at the last event seen, not at "now" --
    // otherwise the number moves every poll and a live run reads as more parallel
    // the longer you look at it.
    const steps = [tool(t(0), null), tool(t(1), t(2))];
    eq("an unfinished call is bounded by the last event", annotateConcurrency(steps, t(3)), 2);
    eq("with no last event it cannot claim overlap", annotateConcurrency([tool(t(0), null)]), 1);
  }

  eq("say steps are ignored", annotateConcurrency([{ kind: "say", text: "hi" }]), 0);
  eq("no steps is zero, not one", annotateConcurrency([]), 0);
}

if (fails.length) {
  console.error(`canvas telemetry self-test FAIL — ${fails.length} case(s)`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`canvas telemetry self-test PASS — ${pass} case(s)`);
