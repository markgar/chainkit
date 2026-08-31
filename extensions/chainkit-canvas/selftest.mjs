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
import { readRun, listRuns, describeTool } from "./telemetry.mjs";
import { page } from "./render.mjs";
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
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 2e9 } },
  { type: "result", data: {} },
]);
write("02-review", "review.r1.jsonl", [
  {
    type: "assistant.message",
    data: { model: "model-b", outputTokens: 100, content: '{"pass":true}' },
  },
  { type: "session.usage_checkpoint", data: { totalNanoAiu: 1e9 } },
  { type: "result", data: {} },
]);
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

// The run record. It is the ONLY source for the two handoffs that leave no trace
// in the call logs: the shared working tree, and a resumed CLI session.
mkdirSync(path.join(root, "results", "chain-runs"), { recursive: true });
writeFileSync(
  path.join(root, "results", "chain-runs", `${runId}.json`),
  JSON.stringify({
    stageLog: [
      { id: "plan", round: 0, filesChanged: [], sessionId: "s-plan", resume: null },
      {
        id: "review",
        round: 0,
        filesChanged: ["src/a.ts"],
        sessionId: "s-rev",
        resume: "plan",
        expects: { pass: "boolean" },
      },
      { id: "review", round: 1, filesChanged: ["src/b.ts"], sessionId: "s-rev", resume: "plan" },
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
      { id: "plan", ord: 1, model: "model-a", tools: true, produces: "plan", parse: "text" },
      { id: "review", ord: 2, model: "model-b", tools: false, produces: "verdict", parse: "json" },
      {
        id: "nobody-has-ever-seen-this",
        ord: 3,
        model: "mystery-9000",
        tools: true,
        parse: "text",
      },
      { id: "never-ran", ord: 4, model: "model-z", tools: true, resume: true, parse: "text" },
    ],
  }),
);

const run = readRun(runDir, root);
// ONE ROW PER CALL. `review` ran twice, so it is two rows -- that is the point of
// the row model: a fix loop's interleaving is only visible if each round is a row.
const [s1, s2, s2b, s3] = run.stages;

// THE 9x BUG. Checkpoints are cumulative: 3 then 5 means the call cost 5, not 8.
eq("cumulative checkpoints collapse to max", s1.aiu, 5);
eq("run total sums per-call maxima", run.totals.aiu, 8);

eq(
  "stages are in execution order",
  run.stages.map((s) => s.id),
  ["plan", "review", "review", "nobody-has-ever-seen-this", "never-ran"],
);
eq(
  "ord comes from the dir prefix, or from the manifest for a stage with no dir yet",
  run.stages.map((s) => s.ord),
  [1, 2, 2, 3, 4],
);
eq("an unknown stage name still renders", s3.id, "nobody-has-ever-seen-this");

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

eq("tool status survives", s1.rounds[0].steps.filter((x) => x.status === "failed").length, 1);
eq(
  "totals count calls, and stages counts what the chain DECLARED (incl. not-yet-run)",
  [run.totals.calls, run.totals.stages],
  [4, 4],
);
eq("output tokens sum", run.totals.outputTokens, 1300);

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
eq("an inherited session is surfaced", s2.resume, "plan");
eq("a stage that inherited nothing says so", s1.resume, null);
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
eq("a declared stage that has not started still appears", run.stages.length, 5);
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
eq("a run with no manifest still reads", legacy.stages.length, 4);
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
  eq("the page renders the non-model channels", html.includes("chans"), true);

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
        { path: ".chainkit/governance/planning.md" },
        { path: "CONSTITUTION.md" },
        { path: "docs/architecture.md" },
        { path: "packages/domain/src/attendee.ts" },
      ],
    }),
    "governance/planning.md, CONSTITUTION.md, docs/architecture.md +1 · 4 targets",
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
        { path: "docs/architecture.md", find: ["a"] },
        { path: "docs/architecture.md", find: ["b"] },
        { path: "docs/architecture.md", find: ["c"] },
        { path: "src/config.ts" },
      ],
    }),
    "docs/architecture.md, src/config.ts · 4 targets",
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
    describeTool("ts_symbol", { symbol: "EventsStore" }),
    "EventsStore",
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

if (fails.length) {
  console.error(`canvas telemetry self-test FAIL — ${fails.length} case(s)`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`canvas telemetry self-test PASS — ${pass} case(s)`);
