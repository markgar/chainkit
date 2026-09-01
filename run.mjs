#!/usr/bin/env node
// chainkit — run a chain defined entirely by config.
//
//   node run.mjs --chain examples/01-single-stage/chain.yaml --workdir /abs/path [--tag t1]
//
// The kernel is generic: it calls the CLI, renders prompts from an artifact store,
// gathers telemetry, records the run, and runs declared completion. WHICH models, in
// WHICH order, with WHICH prompts is config. Adding a stage is a config edit.

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadChain, resolveStages, warnChain } from "./kernel/config.mjs";
import { makeContext, render, summarize } from "./kernel/context.mjs";
import { runStage, runCommandStage, readPath } from "./kernel/stage.mjs";
import {
  resolveItems,
  checkElement,
  passOrder,
  labelOf,
  foreachDelivered,
  scopedNames,
  conditionMet,
  exhaustedHalt,
  noProgressHalt,
  unusedToolsWarning,
  appealHalt,
  linearSlots,
} from "./kernel/foreach.mjs";
import { reduceCumulative } from "./kernel/cost.mjs";
import { treeSnapshot, treeDelta, repositorySnapshot } from "./kernel/tree.mjs";
import { runCompletion } from "./kernel/completion.mjs";
import { makeSessionLedger } from "./kernel/session.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);
// Repeatable flags. `arg` returns the FIRST match, which silently discards the
// rest -- fine for --tag, wrong for anything a caller can legitimately pass twice.
const args = (n) => {
  const out = [];
  for (let i = 0; i < process.argv.length; i++)
    if (process.argv[i] === `--${n}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  return out;
};

const chainFile = arg("chain");
if (!chainFile) die("--chain is required");
const tag = arg("tag", "run");

// A malformed chain file is a user error, not a crash: yaml's message carries the
// line and column, and a stack trace would bury the one useful line.
let loaded;
try {
  loaded = loadChain(chainFile);
} catch (e) {
  die(e.message);
}
const { chain, promptRoot, errors } = loaded;

// FAIL FREE. Every one of these is knowable before the first model call, so a
// chain that cannot possibly work must never cost anything to discover that.
if (errors.length) {
  console.error(`\n✗ chain config is invalid (${errors.length} problem(s)) — nothing was spent:\n`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(2);
}

// --workdir is REQUIRED and is validated below, after --validate-only returns.

const stages = resolveStages(chain);
const byId = new Map(stages.map((s) => [s.id, s]));
const completionSpec = chain.completion || null;
const completionRepairIds = new Set(completionSpec?.repair?.stages || []);
const foreachRepairIds = new Set(chain.foreach?.completion?.repair?.stages || []);
const repairIds = new Set([...completionRepairIds, ...foreachRepairIds]);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runId = `${chain.name}__${tag}__${stamp}`;
// WHERE A RUN IS RECORDED. Beside the CHAIN, not beside the engine.
//
// The engine is meant to be vendored -- dropped in and replaced wholesale by a
// newer copy. Anything written inside it is therefore destroyed on the next
// upgrade, and a run record is project data: it is the only evidence a run ever
// happened, and the accounting we most depend on. So results follow the config
// that produced them (`<chain dir>/../results`), which puts the engine's own
// example chains in the engine's results and a project's chains in the project's.
// --results overrides, and CHAINKIT_RESULTS covers a wrapper that cannot pass a
// flag.
const resultsRoot = path.resolve(
  arg("results") ||
    process.env.CHAINKIT_RESULTS ||
    path.join(path.dirname(path.resolve(chainFile)), "..", "results"),
);
// THE ON-DISK LAYOUT IS FIXED AND WORTH KNOWING: results/chain-runs/logs/<runId>/
// <stageDir>/<label>.jsonl for the raw per-stage streams, plus one
// results/chain-runs/<runId>.json record per run. The run canvas and the AiU
// accounting inside it read exactly this. That accounting is the subtlest code
// here -- cumulative snapshots that are easy to sum twice -- so anything that
// changes the layout also buys a reader rewrite and a fresh chance to get the
// arithmetic wrong.
const logRoot = path.join(resultsRoot, "chain-runs", "logs", runId);

// SEEDS are the artifacts the chain starts with. A seed whose value is a path is
// read from disk, so a spec lives in a file rather than being pasted into JSON.
//
// Resolved BEFORE --validate-only returns, on purpose. A seed pointing at a file
// that isn't there is a guaranteed runtime death, and it is detectable for free;
// letting `--validate-only` print a clean bill of health for a chain that cannot
// possibly start would make the check actively misleading.
const seeds = {};
// A chain that names its own input can only ever build one thing. `--seed k=v`
// (repeatable) overrides a DECLARED seed, so the same pipeline can be pointed at a
// different spec without editing -- or forking -- the chain. Overriding a seed the
// chain never declared is a typo, not a feature: it would sit in the store unread
// while the real seed still held its old value, so it is an error.
const overrides = new Map();
for (const spec of args("seed")) {
  const eq = spec.indexOf("=");
  if (eq < 1) die(`--seed expects name=value, got: ${spec}`);
  const k = spec.slice(0, eq);
  if ((chain.seeds || {})[k] === undefined)
    die(
      `--seed "${k}" is not declared in the chain's seeds: ${Object.keys(chain.seeds || {}).join(", ") || "(none)"}`,
    );
  overrides.set(k, spec.slice(eq + 1));
}
for (const [k, v0] of Object.entries(chain.seeds || {})) {
  const overridden = overrides.has(k);
  const v = overridden ? overrides.get(k) : v0;
  // An @path in the chain file is relative to the chain (promptRoot); one typed on
  // the command line is relative to where the operator is standing.
  const base = overridden ? process.cwd() : promptRoot;
  const resolved =
    typeof v === "string" && v.startsWith("@") ? path.resolve(base, v.slice(1)) : null;
  if (resolved) {
    if (!existsSync(resolved)) die(`seed "${k}" points at a missing file: ${resolved}`);
    seeds[k] = readFileSync(resolved, "utf8");
  } else {
    seeds[k] = v;
  }
}
const ctx = makeContext(seeds);

const warnings = warnChain(chain, { promptRoot });
for (const w of warnings) console.log(`⚠ ${w}`);

if (has("validate-only")) {
  console.log(`✓ chain "${chain.name}" is valid — ${stages.length} stage(s), nothing was run`);
  process.exit(0);
}

// --workdir is REQUIRED, with no default. It used to fall back to process.cwd(),
// which is the same abdication as a stage with no model: it looks like a
// convenience and is actually the engine picking, silently, something the operator
// never named. A run pointed at the current directory builds in whatever repo you
// happen to be standing in, and `git add -A && git commit` after the first green
// chunk is not recoverable by noticing quickly. The preflight below cannot catch
// it either -- a real repo with a real base commit is exactly what it asks for.
//
// Checked AFTER --validate-only returns: validating a chain spends nothing and
// touches no tree, so demanding a workdir for it would just train people to
// conjure one.
const workDirArg = arg("workdir");
if (!workDirArg)
  die(
    "--workdir is required (there is no default — a run writes code and commits it).\n" +
      "  Build one with:  node prep-workdir.mjs --fixture <name> --workdir <path>",
  );
const workDir = path.resolve(workDirArg);
if (!existsSync(workDir)) die(`--workdir does not exist: ${workDir}`);

function sh(cmd, cwd) {
  // `-o pipefail` is load-bearing: without it a pipeline's exit code is the LAST
  // command's, so a check like `test | grep -q ok` returns 0 when the test itself
  // crashed and grep matched earlier output -- a green verdict for a suite that
  // never ran, which is the worst thing a harness can produce because it is silent.
  const r = spawnSync("bash", ["-o", "pipefail", "-c", cmd], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: `${r.stdout || ""}\n${r.stderr || ""}`.trim() };
}

// BUILT-IN PREFLIGHT -- not optional, and deliberately in code rather than in a prompt.
// Delivery is proven by `git diff <base>..HEAD` being non-empty. With no git repo
// there is no base, the diff check silently drops out, and `delivered` degenerates
// to "completion exited 0" -- which proves nothing, because a judge can pass
// vacuously (`node --test` on an empty directory exits 0). That failure is silent
// and produces a confident false green, so it is refused up front, not warned about.
const headProbe = sh("git rev-parse HEAD", workDir);
const baseSha = headProbe.out.trim();
if (headProbe.code !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
  const isRepo = sh("git rev-parse --git-dir", workDir).code === 0;
  console.error(
    `\n✗ PREFLIGHT: workdir is not a git repository with a base commit.\n` +
      `    workdir ${workDir}\n` +
      `    ${isRepo ? "It is a git repo but HEAD resolves to no commit (no commits yet)." : "It is not a git repo."}\n\n` +
      `  A run cannot be judged without a base commit: delivery is "the diff since base\n` +
      `  is non-empty", and completion alone can pass vacuously. Initialise the workdir first:\n\n` +
      `    git -C ${workDir} init -q && git -C ${workDir} commit -q --allow-empty -m base\n`,
  );
  process.exit(2);
}
const initialStatus = sh("git status --porcelain=v1 --untracked-files=all", workDir).out.trim();
if (initialStatus) {
  console.error(
    `\n✗ PREFLIGHT: workdir must be clean before a run starts.\n` +
      initialStatus.replace(/^/gm, "    "),
  );
  process.exit(2);
}
if (chain.requires) {
  const command = render(chain.requires.run, ctx);
  const before = repositorySnapshot(workDir);
  const treeBefore = treeSnapshot(workDir);
  const p = sh(command, workDir);
  const after = repositorySnapshot(workDir);
  const filesChanged = treeDelta(treeBefore, treeSnapshot(workDir));
  if (filesChanged.length || before.head !== after.head || before.status !== after.status) {
    console.error(
      `\n✗ REQUIRES: command mutated the repository instead of checking it: ${command}\n` +
        (filesChanged.length
          ? `    changed: ${filesChanged.join(", ")}`
          : "    repository HEAD or index changed"),
    );
    process.exit(2);
  }
  if (p.code !== 0) {
    console.error(
      `\n✗ REQUIRES: ${command}\n` + (p.out ? p.out.replace(/^/gm, "    ") : "    (no output)"),
    );
    process.exit(2);
  }
}
// Only now that the run will actually proceed: a refused run must not leave a
// directory behind, or `results/` fills with empty runs the canvas renders as live.
mkdirSync(logRoot, { recursive: true });

// THE PLAN, WRITTEN BEFORE ANY OF IT HAPPENS.
//
// The canvas otherwise discovers a stage only when that stage starts writing, so a
// five-stage chain renders as a one-stage chain for the first minute and grows.
// That is not just cosmetic: while a run is in flight the reader cannot tell a
// chain that is one stage in from a chain that HALTED at stage one, because both
// look like a chain with one stage. Declaring the whole pipeline up front makes
// "not yet run" a state the view can show, distinct from "not there".
//
// Written into the log dir rather than the record because the record only exists
// after the run ends -- which is exactly when this stops being useful.
writeFileSync(
  path.join(logRoot, "_chain.json"),
  JSON.stringify(
    {
      name: chain.name,
      tag,
      startedAt: new Date().toISOString(),
      completion: completionSpec,
      requires: chain.requires || null,
      loop: chain.loop || null,
      foreach: chain.foreach || null,
      workDir,
      baseSha,
      // The RESOLVED stages, not the authored ones: defaults are already folded in,
      // so this says which model will really run, not which one the YAML implies.
      stages: stages.map((s) => ({
        id: s.id,
        ord: s.ord,
        model: s.model,
        effort: s.effort ?? null,
        // The LIST survives here, not a boolean. `tools` is a per-stage independent
        // variable in every experiment this record exists to support, and collapsing
        // an allowlist to `true` makes a restricted run indistinguishable from an
        // unrestricted one in the only artifact anybody compares afterwards.
        tools: Array.isArray(s.tools) ? [...s.tools] : !!s.tools,
        resume: s.resume ?? null,
        resumeFrom: s.resumeFrom ?? null,
        resumePrompt: s.resumePrompt ?? null,
        produces: s.produces ?? null,
        parse: s.parse ?? "text",
        expects: s.expects ?? null,
        completion: s.completion ?? null,
        inLoop: (chain.loop?.stages || []).includes(s.id),
        // Declared up front so the canvas can show "runs once per element" before
        // the element count is known -- N only exists once the producing stage ends.
        inForeach: (chain.foreach?.stages || []).includes(s.id),
        inCompletionRepair: completionRepairIds.has(s.id),
        inForeachCompletionRepair: foreachRepairIds.has(s.id),
      })),
    },
    null,
    2,
  ),
);

const telemRows = [];
const stageLog = [];
const sessionLedger = makeSessionLedger();
let halted = null;

console.log(`\n=== ${chain.name} [${tag}] — ${stages.length} stage(s) ===`);
console.log(`    workdir ${workDir}`);
console.log(`    base    ${baseSha.slice(0, 8)}\n`);

// WHICH FILES DID THIS STAGE TOUCH?
//
// The artifact store is not the channel that carries the work -- the working tree
// is. A stage writes code, and the next stage reads it with its own tools, entirely
// outside the store. That means the load-bearing handoff is the one the config
// cannot see and the record never described: nothing in a finished run said whether
// the reviewer read anything, or whether the fix stage changed a single byte.
//
// The observation itself lives in kernel/tree.mjs so it can be self-tested against
// a real repo. It was wrong for a whole run while it lived here, untested.
const snap = () => treeSnapshot(workDir);
// THE ORDER OF THE RUN, WRITTEN DOWN AS IT HAPPENS.
//
// A reader used to reconstruct it from (element, round, declared index). That is a
// guess, and it is wrong the moment a non-loop stage sits AFTER a loop: its round
// is 0, so it sorts ahead of every loop round and appears to have run first. The
// driver knows the true order at the instant it calls, and writing one line costs
// nothing -- so it writes it, live, rather than leaving the reader to infer it.
let callSeq = 0;
function journalCall(stage, round, iter, attempt = 0) {
  callSeq += 1;
  try {
    appendFileSync(
      path.join(logRoot, "_calls.jsonl"),
      JSON.stringify({
        seq: callSeq,
        id: stage.id,
        iter,
        round,
        attempt,
        at: new Date().toISOString(),
      }) + "\n",
    );
  } catch {
    /* the journal is an observability aid; never fail a run over it */
  }
  return callSeq;
}
function journalCompletion(scope, check, identity = {}) {
  const event = {
    type: "completion.checked",
    timestamp: new Date().toISOString(),
    scope,
    identity,
    check: {
      command: check.command,
      status: check.ok ? "passed" : "failed",
      exitCode: check.code ?? null,
      output: check.ok ? "" : String(check.output || check.tail || "").slice(-12000),
      attempt: check.attempt,
      attempts: check.attempts,
      ok: check.ok,
    },
  };
  try {
    appendFileSync(path.join(logRoot, "_events.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    /* additive observability must never change run behavior */
  }
}
function journalSession(type, detail) {
  try {
    appendFileSync(
      path.join(logRoot, "_events.jsonl"),
      JSON.stringify({
        type,
        timestamp: new Date().toISOString(),
        ...detail,
      }) + "\n",
    );
  } catch {
    /* additive observability must never change run behavior */
  }
}
async function executeOnce(stage, round = 0, iter = 0, attempt = 0, deterministicFailure = null) {
  const t0 = Date.now();
  const treeBefore = snap();
  const repoBefore = repositorySnapshot(workDir);
  const invocationSeq = journalCall(stage, round, iter, attempt);
  process.stdout.write(
    `→ ${stage.id}${iter ? ` [${iter}]` : ""}${round ? ` (round ${round})` : ""}${attempt ? ` (completion attempt ${attempt + 1})` : ""} … ${stage.run ? `$ ${stage.run}` : stage.model}${stage.tools ? " +tools" : ""}${stage.resume ? " +resume" : ""}${stage.resumeFrom ? ` +resume:${stage.resumeFrom}` : ""}\n`,
  );
  const res = stage.run
    ? await runCommandStage({ stage, ctx, workDir, logRoot, round, iter })
    : await runStage({
        stage,
        ctx,
        promptRoot,
        workDir,
        logRoot,
        round,
        iter,
        attempt,
        deterministicFailure,
        sessionLedger,
        maxCredits: arg("max-credits"),
      });
  if (res.resumeFailure) {
    journalSession("session.resume_failed", {
      identity: { stage: stage.id, iter, round, attempt, callSeq: invocationSeq },
      failure: res.resumeFailure,
    });
  } else if (res.resumed) {
    journalSession("session.resumed", {
      identity: { stage: stage.id, iter, round, attempt, callSeq: invocationSeq },
      sessionId: res.sessionId,
      resumedFrom: res.resumedFrom,
    });
  }
  if (res.telemetry) telemRows.push(res.telemetry);
  const filesChanged = treeDelta(treeBefore, snap());
  const repoAfter = repositorySnapshot(workDir);
  const repositoryChanged =
    repoBefore.head !== repoAfter.head || repoBefore.status !== repoAfter.status;
  stageLog.push({
    id: stage.id,
    round,
    iter,
    attempt,
    ok: res.ok,
    error: res.error || null,
    kind: res.kind || null,
    model: stage.model,
    run: stage.run || null,
    effort: stage.effort,
    tools: stage.tools,
    resume: stage.resume,
    resumeFrom: stage.resumeFrom || null,
    resumed: res.resumed || false,
    resumedFrom: res.resumedFrom || null,
    resumeFailure: res.resumeFailure || null,
    expects: stage.expects,
    completion: null,
    completionStatus: stage.completion ? "pending" : "absent",
    filesChanged,
    repositoryChanged,
    sessionId: res.sessionId || null,
    promptChars: res.promptChars ?? null,
    promptMode: res.promptMode ?? null,
    wallMs: res.wallMs ?? Date.now() - t0,
    rawPath: res.rawPath || null,
    recoveredFromCalls: res.recoveredFromCalls ?? null,
    // WHICH tools a stage reached for, not just whether it had any. The parser
    // has always computed this and the record has always dropped it, so the one
    // question a tool experiment turns on -- "did it use the tool we built, or
    // fall back to the shell?" -- could only be answered by re-parsing the raw
    // logs with a throwaway script. Persist it: the record is the durable
    // artifact, the logs are raw material that a `--results` move leaves behind.
    toolCalls: res.telemetry?.toolCallCount ?? null,
    toolCallsByName: res.telemetry?.toolCallsByName ?? null,
  });

  // A MODEL stage configured WITHOUT tools cannot write, so the designer canvas
  // labels it "reasons only". If the tree moved anyway, that label is a lie and every
  // later conclusion rests on a run that did something other than what the config
  // says. A `run` stage is exempt: writing IS its job, it carries no `tools` key at
  // all (validation rejects one), and its command is stated in the config in full --
  // so "what may this stage change" is answered by reading it, not by a flag.
  if (!stage.run && !stage.tools && repositoryChanged) {
    console.log(`   ✗ stage "${stage.id}" has tools: false but the tree changed`);
    halted = {
      stage: stage.id,
      round,
      iter,
      kind: "tools",
      reason: filesChanged.length
        ? `stage "${stage.id}" is configured tools: false but ${filesChanged.length} file(s) ` +
          `changed while it ran: ${filesChanged.slice(0, 10).join(", ")}`
        : `stage "${stage.id}" is configured tools: false but changed the repository index or HEAD`,
    };
    return false;
  }

  // THE MIRROR IMAGE, and the one that stayed invisible: a stage GIVEN tools that
  // never picks one up.
  //
  // Tools are declared on a stage because the job needs evidence -- "confirm the
  // file this guards on is one the chunk creates" cannot be answered from the
  // prompt text alone. A stage that answers it with zero tool calls did not check
  // anything; it produced a confident guess in the shape of a verdict. That output
  // is indistinguishable from a verified one downstream, which is what makes this
  // worth recording rather than leaving to a reader of the logs.
  //
  // Measured: a repair stage declared four read tools, called none of them, twice,
  // and rewrote the artifact blind both times to a byte-identical result. Nothing in
  // the record said so -- the stage was `ok`, so it read as a stage that worked.
  //
  // A warning, not a halt: a stage may legitimately have nothing to look up, and a
  // rule that stops the run over an unused affordance would be worse than the gap.
  // The record carries the fact; the operator decides what it means.
  const note = unusedToolsWarning(stage, res.telemetry?.toolCallCount ?? null, round);
  if (note) {
    stageLog[stageLog.length - 1].declaredToolsUnused = true;
    warnings.push(note);
    console.log(`   ⚠ ${note}`);
  }

  if (!res.ok) {
    console.log(`   ✗ ${res.error}`);
    if (!stage.optional)
      halted = {
        stage: stage.id,
        round,
        iter,
        kind: res.kind,
        reason: res.error,
        raw: res.raw || null,
        resumeFailure: res.resumeFailure || null,
      };
    return false;
  }
  // APPEAL — the move a chain could not make, and the reason a false positive was
  // unsurvivable.
  //
  // chainkit's whole vocabulary between stages is {pass, halt}. A repair stage is
  // scoped to the ARTIFACT, never to the CHECK: it may rewrite the plan, and it may
  // not say "the plan is fine, the checker is wrong". So when a check produces a
  // finding that is false, the repair stage has no legal move. Measured, twice, in
  // one run: a plan check raised six impossible problems, the fixer was forbidden
  // from deleting the checks (anti-widening) and from claiming the files
  // (ownership), so it burned the loop to exhaustion changing nothing, and the run
  // ended reading like the plan was bad. It was not.
  //
  // `appeal` is a reserved field on any stage's json artifact. It belongs to no
  // particular stage -- there are no stage kinds here, so this is available to every
  // stage in every chain, and the kernel never learns which one used it.
  //
  // WHAT IT DELIBERATELY DOES NOT DO: it does not let the run continue. An appeal
  // that grants permission to proceed is a model overruling its own check, which is
  // the manufactured green this project has already watched happen once. So it
  // halts -- but as its own recorded outcome, with the argument attached, costing
  // one round instead of the whole budget, and pointing the operator at the checker
  // rather than at the work. Whether a sustained appeal may then resume is a
  // separate decision, made by a human, on evidence this halt is what produces.
  const appealed = appealHalt(stage, res.value, { round, iter });
  if (appealed && !halted) {
    console.log(`   ⚖ stage "${stage.id}" contests the finding rather than complying`);
    halted = appealed;
    if (stage.produces) ctx.set(stage.produces, res.value, stage.id, round);
    return false;
  }

  // A stage with no `produces` still ran and still changed the tree -- that is its
  // product. Only the store entry is skipped.
  if (stage.produces) ctx.set(stage.produces, res.value, stage.id, round);
  if (!stage.run) {
    sessionLedger.record({
      stage: stage.id,
      iter,
      round,
      attempt,
      callSeq: invocationSeq,
      sessionId: res.sessionId,
      model: stage.model,
      provider: res.provider,
    });
  }
  const summary = summarize(res.value);
  const touched = filesChanged.length ? `, ✎ ${filesChanged.length} file(s)` : ", ✎ none";
  const produced = stage.produces ? `${stage.produces} ← ${summary}` : `(no artifact)`;
  // Say so when the answer had to be reassembled. It means the stage hit its
  // output ceiling and only just survived, which is a thing to go fix.
  const stitched = res.recoveredFromCalls
    ? `, ⚠ reassembled from ${res.recoveredFromCalls} cut-off calls`
    : "";
  console.log(`   ✓ ${produced}${touched}${stitched}  [${Math.round((res.wallMs || 0) / 1000)}s]`);
  return true;
}

// A MODEL TURN IS NOT COMPLETION. When a stage declares a deterministic
// postcondition, the command -- not the model's claim -- decides whether that stage
// may finish. A failure is fed back into the SAME stage and the same CLI session
// whenever that stage uses either continuation mode. This is deliberately generic:
// the kernel knows neither what the command checks nor how the agent should repair it.
async function execute(stage, round = 0, iter = 0, deterministicFailure = null) {
  if (!stage.completion) return executeOnce(stage, round, iter, 0, deterministicFailure);

  const result = await runCompletion({
    spec: stage.completion,
    scope: `stage "${stage.id}"`,
    ctx,
    workDir,
    logRoot,
    round,
    iter,
    ord: stage.ord,
    timeoutMs: stage.timeoutMs,
    failureContext: "Your previous turn did not satisfy this stage's completion requirement.",
    beforeAttempt: async ({ attempt, previous, command }) => {
      const ok = await executeOnce(
        stage,
        round,
        iter,
        attempt - 1,
        previous
          ? { ...previous, command, attempt, attempts: stage.completion.attempts }
          : deterministicFailure,
      );
      return {
        ok,
        changed: ok ? stageLog.at(-1).repositoryChanged : false,
      };
    },
    onCheck: (check) => {
      stageLog.at(-1).completion = check;
      stageLog.at(-1).completionStatus = check.ok ? "passed" : "failed";
      journalCompletion("stage", check, {
        stage: stage.id,
        iter,
        round,
        callAttempt: check.attempt - 1,
      });
      console.log(
        check.ok
          ? `   ✓ ${stage.id} completion clean`
          : `   ✗ ${stage.id} completion FAILED (attempt ${check.attempt}/${check.attempts})`,
      );
    },
  });
  if (!result.ok && !result.aborted) halted = result.halt;
  return result.ok;
}

const loopIds = new Set(chain.loop?.stages || []);
const fe = chain.foreach || null;
const feIds = new Set(fe?.stages || []);
// THE LINEAR PART, SPLIT BY DECLARED POSITION. A stage that is neither a loop nor a
// fan-out member runs in the slot its position in `stages` puts it: before the loop,
// between the loop and the fan-out, or after the fan-out.
//
// It used to be one list, filtered by MEMBERSHIP alone, so every linear stage ran
// before the loop no matter where it was written. A stage declared last ran second,
// silently -- and "run something after the fan-out" (normalise the tree, collect a
// report, commit the result) was not expressible at all, which is what pushed that
// work into completion, where a judge quietly becomes a mutator of what it judges.
//
// Existing chains are unaffected: they declare their linear stages first, which is
// still `pre`.
const slots = linearSlots(stages, loopIds, feIds);
for (const name of ["pre", "mid", "post"])
  slots[name] = slots[name].filter((stage) => !repairIds.has(stage.id));

for (const stage of slots.pre) {
  if (halted) break;
  await execute(stage);
}

// THE LOOP is bounded and VISIBLE. Each round is executed and billed separately, so
// the record shows how many rounds a config actually needed -- the number that says
// whether a process is converging or thrashing, and the one an engine that hides
// its rounds inside a sub-agent can never report.
let rounds = 0;
if (chain.loop && !halted) {
  const cond = chain.loop.until;
  // NO PROGRESS IS A REASON TO STOP, and the engine already holds the evidence.
  //
  // A loop is `[check, fix]`. If the check's verdict comes back byte-identical to
  // last round's AND the round changed no file, the fix stage did not move anything
  // the check can see. Every remaining round is a rerun of one that already failed,
  // at full price, and the run ends on `exhausted` -- a reason that describes the
  // budget rather than the failure and sends the reader to the logs to find out
  // what actually happened.
  //
  // Measured: a run whose two rounds produced an identical six-item problem list.
  // The repair stage had no legal move -- the finding was a false positive, and the
  // rules forbade both fixes available to it -- so it rewrote the plan blind and
  // changed nothing. The engine had both facts in hand and drew no conclusion.
  //
  // The file check is what makes this safe. A terse verdict (`{"pass": false}`)
  // repeats verbatim while real repair work happens in the tree, and halting there
  // would kill a healthy loop. Identical verdict AND an untouched tree is the case
  // where there is genuinely nothing new.
  //
  // Honest about the value: in a `max: 2` loop this saves no money, because both
  // rounds have already run by the time it can fire. What it buys is the diagnosis
  // -- "no progress" names a stuck repair stage, `exhausted` names a spent budget.
  // In any longer loop it saves the rest of the budget as well.
  const condRoot = String(cond).split(".")[0];
  let lastCond = null;
  while (rounds < chain.loop.max) {
    const done = readPath(ctx, cond);
    if (done === true) break;
    // An UNANSWERABLE condition is not a reason to keep spending. If the field is
    // absent the config is wrong, and burning the loop budget would hide that.
    if (done === undefined && rounds > 0) {
      halted = {
        stage: "loop",
        reason: `loop condition "${cond}" is undefined — no stage produced it`,
      };
      break;
    }
    rounds++;
    const logMark = stageLog.length;
    console.log(`\n--- loop round ${rounds}/${chain.loop.max} (until ${cond}) ---`);
    for (const id of chain.loop.stages) {
      if (halted) break;
      if (!(await execute(byId.get(id), rounds))) break;
      // Re-check WITHIN the round. The body is a sequence, not an atom: once the
      // condition holds, the remaining stages exist to fix something that is no
      // longer broken.
      if (conditionMet(ctx, cond)) break;
    }
    if (halted) break;
    if (conditionMet(ctx, cond)) break;

    const thisCond = JSON.stringify(readPath(ctx, condRoot) ?? null);
    const touched = stageLog.slice(logMark).reduce((n, s) => n + (s.filesChanged?.length || 0), 0);
    const stuck = noProgressHalt({
      condRoot,
      previous: lastCond,
      current: thisCond,
      filesTouched: touched,
      round: rounds,
    });
    if (stuck) {
      console.log(`   ⚠ ${stuck.reason}`);
      halted = stuck;
      break;
    }
    lastCond = thisCond;
  }
}

const loopSatisfied = chain.loop ? readPath(ctx, chain.loop.until) === true : null;

// An exhausted loop stops the run by default — see `exhaustedHalt`. This is the
// guard that keeps a rejected plan from being fanned out at many times its cost.
if (!halted) halted = exhaustedHalt(chain.loop, loopSatisfied) || halted;

// THE FAN-OUT. The chain's second control-flow construct: run a stage list once per
// element of an artifact array, with its own bounded inner loop and completion per
// element.
//
// The kernel does not know what the elements are. `over` names an array, `as` binds
// each element, and the prompts decide what that means -- the same rule that keeps
// stages typeless. What the engine DOES own is the part a prompt cannot enforce:
// the iteration is bounded, the element shape is checked before it is used, each
// element gets an objective pass/fail, and a failing element stops the run.
const iterations = [];
let feExpected = null;
// Linear stages declared BETWEEN the loop and the fan-out.
for (const stage of slots.mid) {
  if (halted) break;
  await execute(stage);
}
if (fe && !halted) {
  const resolved = resolveItems(ctx, fe);
  feExpected = resolved.ok ? resolved.items.length : null;
  if (!resolved.ok) halted = { stage: "foreach", kind: "foreach", reason: resolved.error };

  const items = resolved.ok ? resolved.items : [];
  const { firstPass, loopStages } = passOrder(fe);
  // Names the fan-out's own stages write. Cleared at the top of every element so no
  // element can read the previous one's results -- see scopedNames().
  const scoped = scopedNames(stages, fe);

  for (let i = 0; !halted && i < items.length; i++) {
    const iter = i + 1;
    const item = items[i];

    for (const n of scoped) ctx.clear(n, "foreach", 0);

    const shape = checkElement(item, fe, iter);
    if (!shape.ok) {
      halted = { stage: "foreach", iter, kind: "shape", reason: shape.error };
      break;
    }

    // The binding is a normal artifact write, so it lands in history like any other:
    // the record can say which element each stage was working on.
    ctx.set(fe.as, item, "foreach", 0);
    const label = labelOf(item, iter);
    console.log(`\n### ${fe.as} ${iter}/${items.length} — ${label} ###`);

    for (const id of firstPass) {
      if (halted) break;
      if (!(await execute(byId.get(id), 0, iter))) break;
    }

    let iterRounds = 0;
    if (fe.loop && !halted) {
      const cond = fe.loop.until;
      while (iterRounds < fe.loop.max) {
        const done = readPath(ctx, cond);
        if (done === true) break;
        if (done === undefined && iterRounds > 0) {
          halted = {
            stage: "foreach.loop",
            iter,
            reason: `foreach loop condition "${cond}" is undefined — no stage produced it`,
          };
          break;
        }
        iterRounds++;
        console.log(`\n--- ${label}: round ${iterRounds}/${fe.loop.max} (until ${cond}) ---`);
        for (const id of loopStages) {
          if (halted) break;
          if (!(await execute(byId.get(id), iterRounds, iter))) break;
          if (conditionMet(ctx, cond)) break;
        }
        if (halted) break;
      }
    }

    let iterCompletion = null;
    if (fe.completion && !halted) {
      iterCompletion = await runCompletion({
        spec: fe.completion,
        scope: `foreach item ${iter} (${label})`,
        ctx,
        workDir,
        logRoot,
        iter,
        failureContext: "This foreach item failed its deterministic completion command.",
        beforeAttempt: async ({ attempt, previous }) => {
          if (attempt === 1) return { ok: true, changed: false };
          const mark = stageLog.length;
          console.log(
            `\n--- ${label}: completion repair ${attempt - 1}/${fe.completion.attempts - 1} ---`,
          );
          for (const id of fe.completion.repair.stages) {
            if (!(await execute(byId.get(id), attempt - 1, iter, previous))) break;
          }
          return {
            ok: !halted,
            changed: stageLog.slice(mark).some((row) => row.repositoryChanged),
          };
        },
        onCheck: (check) => {
          journalCompletion("foreach", check, {
            iter,
            checkAttempt: check.attempt,
          });
          console.log(
            check.ok
              ? "   ✓ item completion clean"
              : `   ✗ item completion FAILED (attempt ${check.attempt}/${check.attempts})`,
          );
        },
      });
      if (!iterCompletion.ok && !iterCompletion.aborted) halted = iterCompletion.halt;
    }

    // A COMMIT PER GREEN ELEMENT. Makes the per-element file attribution exact
    // (the next element's delta starts here) and leaves a rollback point.
    let commit = null;
    if (!halted) {
      sh(`git add -A`, workDir);
      const c = sh(`git commit -q -m "chainkit: ${String(label).replace(/"/g, "'")}"`, workDir);
      // "Nothing to commit" is not an error -- a stage may legitimately have written
      // nothing -- but it IS recorded, because an element that changed no files and
      // still passed completion is a vacuous pass.
      commit = { ok: c.code === 0, sha: sh(`git rev-parse HEAD`, workDir).out.trim() };
    }

    iterations.push({
      iter,
      label,
      item,
      rounds: iterRounds,
      completion: iterCompletion,
      completionStatus: iterCompletion?.status || "absent",
      commit,
      satisfied: fe.loop ? readPath(ctx, fe.loop.until) === true : null,
    });
  }
}

// CHAIN COMPLETION. Its command judges the assembled result and shares the same
// bounded state machine as stage and foreach completion.
//
// Linear stages declared AFTER the fan-out run first -- they are the last chance to
// put the tree in the state completion will judge, which is why they exist: the
// judge never has to mutate anything itself.
for (const stage of slots.post) {
  if (halted) break;
  await execute(stage);
}
let completion = null;
if (completionSpec && !halted) {
  console.log(`\n=== CHAIN COMPLETION (${completionSpec.run}) ===`);
  completion = await runCompletion({
    spec: completionSpec,
    scope: "chain",
    ctx,
    workDir,
    logRoot,
    failureContext: "The assembled repository failed its chain completion command.",
    beforeAttempt: async ({ attempt, previous }) => {
      if (attempt === 1) return { ok: true, changed: false };
      const mark = stageLog.length;
      console.log(
        `\n--- chain completion repair ${attempt - 1}/${completionSpec.attempts - 1} ---`,
      );
      for (const id of completionSpec.repair.stages) {
        if (!(await execute(byId.get(id), attempt - 1, 0, previous))) break;
      }
      return {
        ok: !halted,
        changed: stageLog.slice(mark).some((row) => row.repositoryChanged),
      };
    },
    onCheck: (check) => {
      journalCompletion("chain", check, { checkAttempt: check.attempt });
      if (!check.ok) {
        const touched = sh(`git diff --name-only ${baseSha}`, workDir)
          .out.split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
        check.filesInDiff = touched.filter((file) => check.output.includes(file));
        check.inherited = check.filesInDiff.length === 0;
      }
      console.log(
        check.ok
          ? "   ✓ chain completion clean"
          : check.filesInDiff?.length
            ? `   ✗ chain completion FAILED in files this run wrote: ${check.filesInDiff.join(", ")}`
            : "   ⚠ chain completion failed in NO file this run touched — inherited drift",
      );
    },
    afterPass: async ({ attempt }) => {
      const pending = sh("git status --porcelain=v1 --untracked-files=all", workDir).out.trim();
      if (!pending) return null;
      sh("git add -A", workDir);
      const c = sh(`git commit -q -m "chainkit: chain completion repair ${attempt - 1}"`, workDir);
      if (c.code !== 0)
        return {
          halt: {
            stage: "chain.completion",
            round: attempt,
            kind: "commit",
            reason:
              `chain completion passed, but its repair could not be committed: ` +
              (c.out.trim() || `git commit exited ${c.code}`),
          },
        };
      return {
        repairCommit: {
          attempt,
          sha: sh("git rev-parse HEAD", workDir).out.trim(),
        },
      };
    },
  });
  if (!completion.ok && !completion.aborted) halted = completion.halt;
}

const aiu = reduceCumulative(telemRows, "aiu");
const req = reduceCumulative(telemRows, "premiumRequests");
const apiMs = reduceCumulative(telemRows, "totalApiDurationMs");

// DID THE RUN ACTUALLY CHANGE ANYTHING, and is the workdir still the repo we
// started in? Both halves were learned from run ck1, which reported "delivered
// YES" while neither question had been asked:
//
//   1. Clean completion proves nothing on its own when the BASE was already green --
//      which is the normal case, since a chain starts from a working tree. A run
//      that wrote no code at all satisfies completion exactly as well as one that
//      built the feature. Delivery has to mean completion-clean AND a non-empty diff.
//   2. ck1's model ran `git init` in the workdir, replacing the worktree's .git
//      file with a fresh empty repo. baseSha was recorded at start and never
//      looked at again, so the run reported success while the commit it was
//      measured against had become unreachable and no diff could ever be taken.
//
// A model with tools can do anything to the tree it is given, so the tree's
// identity is checked at the END rather than assumed to have survived.
let diffStat = null;
if (baseSha) {
  const baseAlive = sh(`git cat-file -e ${baseSha}^{commit}`, workDir).code === 0;
  // `git diff <base>` (working tree), not `<base>..HEAD` (committed only): a stage
  // that edits a tracked file and never commits has still changed the tree, and
  // ..HEAD would score that as no work done.
  const d = baseAlive ? sh(`git diff --stat ${baseSha}`, workDir) : null;
  const files = baseAlive
    ? sh(`git diff --name-only ${baseSha}`, workDir)
        .out.split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  // Untracked files count as work: a chain that adds new files and never commits
  // has still changed the tree, and `git diff` alone would call that empty.
  const untracked = sh("git ls-files --others --exclude-standard", workDir)
    .out.split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  diffStat = {
    baseAlive,
    files,
    untracked,
    changed: files.length + untracked.length,
    stat: d ? d.out.trim().split("\n").slice(-1)[0] : null,
  };
  if (!baseAlive)
    console.log(
      `\n⚠ BASE COMMIT ${baseSha.slice(0, 8)} IS UNREACHABLE — the workdir's git identity was destroyed during the run (e.g. \`git init\`). No diff can be taken, so this run is NOT delivered regardless of completion.`,
    );
  else if (!diffStat.changed)
    console.log(
      `\n⚠ NO CHANGE — the run wrote nothing. Clean completion here only means the base was already green.`,
    );
}

const completionStatus = !completionSpec ? "absent" : completion?.status || "not-run";
const completed = !halted && (!completionSpec || completionStatus === "passed");
const verified = completionStatus === "passed";

// Delivery is deliberately narrower than successful execution. Only a declared,
// passing chain completion can verify a non-empty, identity-valid diff.
const delivered =
  completed &&
  verified &&
  (chain.loop ? loopSatisfied === true : true) &&
  // Every element must have RUN and passed its own completion. `feExpected` is the count
  // the plan produced: without comparing against it, a fan-out that halted at
  // element 2 of 5 satisfies "every element that ran was green" and reports
  // delivered on chain completion that has no idea how many there should have been.
  (fe ? foreachDelivered(iterations, feExpected) : true) &&
  diffStat.baseAlive &&
  diffStat.changed > 0;

const record = {
  runId,
  chain: chain.name,
  tag,
  chainFile: path.resolve(chainFile),
  workDir,
  baseSha,
  diffStat,
  startedAt: stamp,
  finishedAt: new Date().toISOString(),
  node: process.version,
  completed,
  verified,
  completionStatus,
  delivered,
  halted,
  warnings,
  completion,
  loop: chain.loop ? { ...chain.loop, rounds, satisfied: loopSatisfied } : null,
  foreach: fe ? { ...fe, expected: feExpected, count: iterations.length, iterations } : null,
  // The RESOLVED stages, not the config as authored: recording the config would
  // leave it ambiguous which model actually ran once defaults were folded in.
  stages: stages.map((s) => ({ ...s })),
  stageLog,
  artifacts: ctx.snapshot(),
  artifactHistory: ctx.history,
  totals: {
    aiu: aiu.value,
    unmetered: aiu.unmetered,
    orphanRows: aiu.orphans,
    premiumRequests: req.value,
    apiMs: apiMs.value,
    stageCalls: stageLog.length,
    loopRounds: rounds,
    // Rounds spent INSIDE the fan-out are billed separately from the chain loop's:
    // "which element cost the rounds" is the question a fan-out exists to answer.
    foreachElements: iterations.length,
    foreachRounds: iterations.reduce((n, it) => n + it.rounds, 0),
  },
  argv: process.argv.slice(2),
};

// Same reason as logRoot: the canvas treats the presence of this file as
// "the run has ENDED" (its `live` flag is `!summary && ...`), so it must land
// exactly where the reader looks or every finished run renders as still running.
mkdirSync(path.join(resultsRoot, "chain-runs"), { recursive: true });
const recPath = path.join(resultsRoot, "chain-runs", `${runId}.json`);
writeFileSync(recPath, JSON.stringify(record, null, 2));

console.log(`\n=== SUMMARY ===`);
console.log(`  completed   ${completed ? "YES" : "NO"}`);
console.log(
  `  verified    ${verified ? "YES" : completionStatus === "absent" ? "NOT DECLARED" : "NO"}`,
);
console.log(`  delivered   ${delivered ? "YES" : "NO"}`);
if (diffStat)
  console.log(
    `  changed     ${diffStat.baseAlive ? `${diffStat.changed} file(s)` : "UNKNOWN — base commit destroyed"}`,
  );
if (halted) console.log(`  halted      ${halted.stage}: ${halted.reason}`);
if (chain.loop)
  console.log(`  loop        ${rounds}/${chain.loop.max} round(s), satisfied=${loopSatisfied}`);
if (fe) {
  const green = iterations.filter((it) => !it.completion || it.completion.ok).length;
  console.log(
    `  ${fe.as.padEnd(11)} ${green}/${feExpected ?? "?"} completed` +
      (feExpected != null && iterations.length !== feExpected
        ? ` (only ${iterations.length} ran)`
        : ""),
  );
  for (const it of iterations)
    console.log(
      `    ${String(it.iter).padStart(2)}. ${it.label} — ${it.rounds} round(s), completion ${it.completion ? (it.completion.ok ? "ok" : "FAILED") : "not declared"}`,
    );
}
console.log(`  calls       ${stageLog.length}`);
console.log(
  `  AiU         ${aiu.value.toFixed(4)}${aiu.unmetered ? ` (${aiu.unmetered} unmetered)` : ""}`,
);
console.log(`  record      ${recPath}`);
process.exit(completed ? 0 : 1);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}
