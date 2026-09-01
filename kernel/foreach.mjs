// FAN-OUT decisions, separated from fan-out execution.
//
// The execution half (await a stage, run a gate, commit) has to live in the driver.
// The DECISIONS -- is this really an array, is it bounded, is the element the shape
// the config declared, which stages run before the inner loop, did every element
// pass -- are pure, and pure logic in the driver is logic nothing tests.
//
// That is not a hypothetical: the working-tree probe lived in the driver, shipped
// with a git parse error, and reported "changed no files" for an entire run that
// wrote the whole deliverable. Same shape of mistake is available here -- an
// off-by-one in the iteration bound, or an `every` over an empty array reading as
// success -- and it would be just as quiet.
//
// Nothing here knows what an element MEANS. It is an array of opaque values.

import { checkShape } from "./stage.mjs";
import { readPath } from "./context.mjs";

// Is the fan-out runnable at all? Every refusal happens BEFORE the first element is
// paid for, and each one is a distinct failure a run would otherwise report as a
// vaguely wrong number rather than a reason.
export function resolveItems(ctx, fe) {
  const items = readPath(ctx, fe.over);
  if (!Array.isArray(items))
    return {
      ok: false,
      items: [],
      error:
        `foreach over "${fe.over}" is ${items === undefined ? "undefined" : typeOfLoose(items)}, not an array. ` +
        `The producing stage did not emit the list this fan-out iterates.`,
    };
  // An EMPTY fan-out is a vacuous pass: "every element succeeded" is trivially true
  // of no elements, so the run reports delivered having built nothing. Same trap as
  // a test gate over an empty directory, which exits 0.
  if (items.length === 0)
    return {
      ok: false,
      items,
      error: `foreach over "${fe.over}" produced 0 elements — nothing to build`,
    };
  // REFUSED, never truncated. Quietly running the first `max` delivers a partial
  // result that the record describes as complete.
  if (items.length > fe.max)
    return {
      ok: false,
      items,
      error: `foreach over "${fe.over}" produced ${items.length} element(s), above max ${fe.max}`,
    };
  return { ok: true, items, error: null };
}

function typeOfLoose(v) {
  if (v === null) return "null";
  return typeof v;
}

// Does one element carry the fields the config declared? Checked per element rather
// than once, because a planner that gets element 3 wrong gets 1 and 2 right.
export function checkElement(item, fe, iter) {
  const problems = checkShape(item, fe.expects);
  if (!problems.length) return { ok: true, error: null };
  return {
    ok: false,
    error:
      `foreach element ${iter}: ${problems.join("; ")} — ` +
      `the plan's element shape does not match the config`,
  };
}

// WHICH SLOT EACH LINEAR STAGE RUNS IN.
//
// A stage that is neither a loop member nor a fan-out member runs in the slot its
// DECLARED POSITION puts it: before the loop, between the loop and the fan-out, or
// after the fan-out.
//
// This used to be a single membership filter, so every linear stage ran before the
// loop regardless of where it was written -- a stage declared last ran second, and
// nothing said so. Worse, "run something after the fan-out" was not expressible at
// all, so that work got folded into the gate, which turns the impartial judge of a
// run into a mutator of the thing it is judging.
export function linearSlots(stages, loopIds, feIds) {
  const idxOf = (ids) => {
    const i = stages.findIndex((s) => ids.has(s.id));
    return i === -1 ? null : i;
  };
  // Only blocks that EXIST bound the slots. Defining `post` as "after the fan-out"
  // would put a stage declared after the loop of a fan-out-less chain into `mid`,
  // which runs it in the right place but names it wrongly -- and a record whose slot
  // names do not match the chain's shape is the kind of small lie that costs an hour
  // the first time someone debugs execution order with it.
  const present = [idxOf(loopIds), idxOf(feIds)].filter((i) => i !== null);
  const firstAt = present.length ? Math.min(...present) : Infinity;
  const lastAt = present.length ? Math.max(...present) : -Infinity;
  const slots = { pre: [], mid: [], post: [] };
  stages.forEach((s, i) => {
    if (loopIds.has(s.id) || feIds.has(s.id)) return;
    slots[i < firstAt ? "pre" : i > lastAt ? "post" : "mid"].push(s);
  });
  return slots;
}

// Which stages run once at the top of an element, and which are the inner loop's.
// A stage in `stages` but not in `loop.stages` runs exactly once per element.
export function passOrder(fe) {
  const inner = new Set(fe.loop?.stages || []);
  return {
    firstPass: (fe.stages || []).filter((id) => !inner.has(id)),
    loopStages: fe.loop?.stages || [],
  };
}

// Which artifact names must be CLEARED before each element runs.
//
// This exists because of a real, silent failure in the first fan-out run ever
// executed. The store is one flat namespace for the whole chain, so `verdict` --
// written by chunk 1's reviewer with pass=true -- was still there when chunk 2
// began. Chunk 2's inner loop reads `until: verdict.pass`, saw true before running
// anything, and broke at round 0. Chunks 2, 3 and 4 were never reviewed. The run
// reported "delivered YES, 4/4 passed their gate", which was true and useless: half
// the declared process did not run for 75% of the work, and nothing said so.
//
// An element must start with none of the previous element's results. What carries
// over is what was produced OUTSIDE the fan-out (the spec, the plan) -- those are
// the same for every element by construction.
export function scopedNames(stages, fe) {
  const ids = new Set(fe?.stages || []);
  return (stages || []).filter((s) => ids.has(s.id) && s.produces).map((s) => s.produces);
}

// Should the current round stop before running its remaining stages?
//
// A loop body is a SEQUENCE, not an atom. `[review, fix] until verdict.pass` plainly
// means "review, and fix it if it did not pass" -- but checking the condition only
// between rounds runs `fix` every single time, including right after a review that
// passed. In the first fan-out run that sent a builder to "repair" code its reviewer
// had just approved: a paid call whose best case is no change and whose worst case
// is editing working code.
export function conditionMet(ctx, until) {
  return until ? readPath(ctx, until) === true : false;
}

// A human-readable name for an element, for logs and the record. Falls back rather
// than throwing: a label is not load-bearing and must never stop a run.
export function labelOf(item, iter) {
  if (item && typeof item === "object") {
    if (typeof item.id === "string" && item.id) return item.id;
    if (typeof item.name === "string" && item.name) return item.name;
  }
  return `element ${iter}`;
}

// Did the fan-out as a whole deliver?
//
// `expected` is the element count the plan produced. Comparing against it is the
// point: `every()` over the iterations that RAN is trivially true when the run
// halted at element 2 of 5, which is how a partial build reports as a success.
export function foreachDelivered(iterations, expected) {
  if (!Array.isArray(iterations) || iterations.length === 0) return false;
  if (expected != null && iterations.length !== expected) return false;
  return iterations.every((it) => {
    const completion = it.completion || it.gate; // Legacy records retain `.gate`.
    return completion ? completion.ok === true : true;
  });
}

// Did the CHAIN loop exhaust its budget without reaching its condition, and if so is
// that a reason to stop? Returns a halt record or null.
//
// An exhausted loop is a FAILED PRECONDITION, not a lap counter running out. The chain
// declared `until` as the condition under which the loop's output is fit to use, so a
// loop that spends its whole budget without reaching it has said, in the only way it
// can, that the artifact is not ready. Continuing spends the rest of the chain on an
// input the chain's own reviewer rejected -- and a fan-out is what typically sits
// downstream, so that is the expensive direction in which to be wrong.
//
// Observed: a plan loop exhausted 2/2 with its reviewer naming the exact defect (a
// chunk whose declared file ownership omitted a file its own blueprint required), the
// fan-out built on the rejected plan anyway, and the chunk died on precisely that
// fault. The finding was free; rediscovering it cost a fan-out.
//
// `onExhausted: continue` is for the case where continuing is right: a loop whose
// reviewer is ADVISORY because something objective follows it. Then the gate, not the
// reviewer, decides, and stopping early would discard the deciding check.
export function exhaustedHalt(loop, satisfied) {
  if (!loop) return null;
  if (satisfied === true) return null;
  if (loop.onExhausted === "continue") return null;
  return {
    stage: "loop",
    kind: "exhausted",
    reason:
      `loop ran its full budget of ${loop.max} round(s) without "${loop.until}" becoming ` +
      `true — halting rather than spending the rest of the chain on an artifact the loop ` +
      `itself did not ratify (set loop.onExhausted: continue to override)`,
  };
}

// Is this round a repeat of the last one? Returns a halt record or null.
//
// The decision, stated once so it can be tested: a loop that produced a
// byte-identical condition artifact AND touched no file has nothing new to act on.
// Both halves are required. The artifact alone is not enough -- a terse verdict
// ("{"pass": false}") repeats verbatim while a fixer does real work in the tree, and
// halting there would kill a converging loop. An untouched tree alone is not enough
// either: a reasoning-only loop never touches the tree and can still be making
// progress in its artifacts.
//
// `exhausted` answers "the budget ran out". This answers "the budget did not
// matter", which is a different fault with a different fix -- one is a config that
// needs more rounds, the other is a repair stage that cannot move.
export function noProgressHalt({ condRoot, previous, current, filesTouched, round }) {
  if (previous === null || previous === undefined) return null;
  if (current !== previous) return null;
  if (filesTouched !== 0) return null;
  return {
    stage: "loop",
    kind: "no-progress",
    reason:
      `loop made no progress: "${condRoot}" is byte-identical to round ${round - 1} and no ` +
      `file changed. The repair stage is not moving anything the check reads — rerunning ` +
      `it would repeat this round exactly.`,
  };
}

// Was a stage given tools it never used? Returns a warning string or null.
//
// A stage is given tools because its job needs evidence. Zero calls means the answer
// was produced from the prompt alone -- a guess wearing the shape of a verdict, and
// indistinguishable downstream from a checked one. `run` stages are exempt: they
// carry no `tools` key at all.
export function unusedToolsWarning(stage, toolCallCount, round = 0) {
  if (stage.run) return null;
  if (!(stage.tools === true || Array.isArray(stage.tools))) return null;
  if (toolCallCount !== 0) return null;
  const declared = Array.isArray(stage.tools) ? ` (${stage.tools.join(", ")})` : "";
  return (
    `stage "${stage.id}"${round ? ` round ${round}` : ""} was given tools${declared} and ` +
    `called none — its output was not checked against the repo`
  );
}

// Did a stage contest the check instead of complying? Returns a halt record or null.
//
// `appeal` is reserved on any json artifact, belongs to no particular stage, and is
// the only way a chain can say "the finding is wrong" -- without it a false positive
// leaves a repair stage with no legal move at all. It HALTS on purpose: an appeal
// that let the run continue would be a model overruling its own gate.
export function appealHalt(stage, value, { round = 0, iter = 0 } = {}) {
  const appeal = value && typeof value === "object" ? value.appeal : null;
  if (!appeal) return null;
  const text = typeof appeal === "string" ? appeal : appeal.reason || JSON.stringify(appeal);
  return {
    stage: stage.id,
    round,
    iter,
    kind: "appeal",
    reason: `stage "${stage.id}" contests the check it was asked to satisfy: ${text}`,
    appeal,
  };
}

export function selfTest() {
  const CASES = [];
  const ctxOf = (o) => ({ has: (n) => n in o, get: (n) => o[n] });

  const fe = { over: "plan.chunks", as: "chunk", stages: ["code", "review", "fix"], max: 5 };

  // --- scopedNames: the per-element clear list -----------------------------
  // Regression cover for the defect the first real fan-out run exposed: chunk 1's
  // verdict survived into chunk 2, whose loop then broke at round 0 and skipped
  // review entirely, for three of four chunks, reporting success throughout.
  const allStages = [
    { id: "plan", produces: "plan" },
    { id: "plan-review", produces: "planVerdict" },
    { id: "code", produces: "buildNotes" },
    { id: "review", produces: "verdict" },
    { id: "fix", produces: "fixNotes" },
  ];
  const scoped = scopedNames(allStages, fe);
  CASES.push(["the fan-out's own artifacts are scoped", scoped.includes("verdict")]);
  CASES.push(["every fan-out stage is scoped", scoped.length === 3]);
  CASES.push([
    "artifacts produced OUTSIDE the fan-out survive the element boundary",
    !scoped.includes("plan") && !scoped.includes("planVerdict"),
  ]);
  CASES.push([
    "a fan-out stage that produces nothing contributes no name",
    scopedNames([{ id: "code" }], { stages: ["code"] }).length === 0,
  ]);
  CASES.push(["no foreach means nothing to clear", scopedNames(allStages, null).length === 0]);

  // --- conditionMet: stop mid-round once the condition holds ---------------
  CASES.push([
    "a satisfied condition is met",
    conditionMet(ctxOf({ verdict: { pass: true } }), "verdict.pass") === true,
  ]);
  CASES.push([
    "an unsatisfied condition is not met",
    conditionMet(ctxOf({ verdict: { pass: false } }), "verdict.pass") === false,
  ]);
  // An ABSENT condition must not read as met, or the first stage of every round
  // would end it -- the loop would silently become a single stage.
  CASES.push(["an absent condition is not met", conditionMet(ctxOf({}), "verdict.pass") === false]);
  // Truthiness is not enough: a reviewer returning "pass": "yes" is a malformed
  // verdict, and treating it as success is how a broken reviewer reads as a clean one.
  CASES.push([
    "a truthy non-true value is not met",
    conditionMet(ctxOf({ verdict: { pass: "yes" } }), "verdict.pass") === false,
  ]);
  CASES.push(["no condition at all is not met", conditionMet(ctxOf({}), null) === false]);

  const good = ctxOf({ plan: { chunks: [{ id: "a" }, { id: "b" }] } });
  CASES.push(["a real array resolves", resolveItems(good, fe).ok === true]);
  CASES.push(["it returns the elements", resolveItems(good, fe).items.length === 2]);

  const missing = ctxOf({ plan: {} });
  CASES.push(["an absent array is refused", resolveItems(missing, fe).ok === false]);
  CASES.push([
    "the refusal blames the producing stage, not the array",
    resolveItems(missing, fe).error.includes("did not emit"),
  ]);

  const notArray = ctxOf({ plan: { chunks: { id: "a" } } });
  CASES.push(["a non-array is refused", resolveItems(notArray, fe).ok === false]);
  CASES.push([
    "the refusal names what it got instead",
    resolveItems(notArray, fe).error.includes("object"),
  ]);

  // The vacuous pass. This is the case that reads as success everywhere else.
  const empty = ctxOf({ plan: { chunks: [] } });
  CASES.push([
    "an EMPTY fan-out is refused, not silently green",
    resolveItems(empty, fe).ok === false,
  ]);
  CASES.push([
    "the refusal says there was nothing to build",
    resolveItems(empty, fe).error.includes("0 elements"),
  ]);

  const many = ctxOf({ plan: { chunks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}` })) } });
  CASES.push(["an over-max fan-out is refused", resolveItems(many, fe).ok === false]);
  CASES.push([
    "it is REFUSED, not truncated to max",
    resolveItems(many, fe).error.includes("above max"),
  ]);
  // Exactly max is allowed -- the bound is inclusive, and an off-by-one here would
  // refuse a correct plan.
  const exact = ctxOf({ plan: { chunks: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })) } });
  CASES.push(["exactly max is allowed", resolveItems(exact, fe).ok === true]);

  // ---- element shape ---------------------------------------------------------
  const feE = { ...fe, expects: { id: "string", files: "array" } };
  CASES.push(["a conforming element passes", checkElement({ id: "a", files: [] }, feE, 1).ok]);
  const wrong = checkElement({ id: "a", paths: [] }, feE, 2);
  CASES.push(["a renamed field is caught", wrong.ok === false]);
  CASES.push(["the error names the element index", wrong.error.includes("element 2")]);
  CASES.push(["the error names the missing field", wrong.error.includes("files")]);
  // The whole point of catching it: this is a CONFIG defect, and unattributed it
  // looks like a builder that mysteriously edited the wrong files.
  CASES.push([
    "the error blames the plan's shape",
    wrong.error.includes("does not match the config"),
  ]);
  CASES.push([
    "with no expects, any element passes",
    checkElement({ anything: 1 }, fe, 1).ok === true,
  ]);

  // ---- pass order ------------------------------------------------------------
  const feL = { ...fe, loop: { stages: ["review", "fix"], until: "v.pass", max: 3 } };
  CASES.push([
    "stages outside the inner loop run once",
    passOrder(feL).firstPass.join(",") === "code",
  ]);
  CASES.push([
    "inner loop stages are the loop's",
    passOrder(feL).loopStages.join(",") === "review,fix",
  ]);
  CASES.push([
    "with no inner loop, every stage runs once",
    passOrder(fe).firstPass.join(",") === "code,review,fix",
  ]);

  // ---- labels ----------------------------------------------------------------
  CASES.push(["id is preferred as the label", labelOf({ id: "c1", name: "x" }, 1) === "c1"]);
  CASES.push(["name is the fallback", labelOf({ name: "x" }, 1) === "x"]);
  CASES.push(["a shapeless element still gets a label", labelOf(42, 3) === "element 3"]);
  CASES.push(["a null element does not throw", labelOf(null, 2) === "element 2"]);

  // ---- delivered -------------------------------------------------------------
  const g = (ok) => ({ completion: { ok } });
  CASES.push(["all green delivers", foreachDelivered([g(true), g(true)], 2) === true]);
  CASES.push(["one red does not deliver", foreachDelivered([g(true), g(false)], 2) === false]);
  // The partial-build trap: every iteration that RAN was green, but two of five
  // never ran. `every()` alone says true.
  CASES.push([
    "a run that halted part-way does NOT deliver",
    foreachDelivered([g(true), g(true)], 5) === false,
  ]);
  CASES.push(["no iterations does not deliver", foreachDelivered([], 0) === false]);
  CASES.push([
    "elements with no completion deliver on having run",
    foreachDelivered([{ completion: null }, { completion: null }], 2) === true,
  ]);
  CASES.push([
    "legacy gate records remain readable",
    foreachDelivered([{ gate: { ok: true } }], 1) === true,
  ]);

  // THE EXHAUSTED-LOOP HALT. The regression these lock down is a run that spent a
  // whole fan-out on a plan its own reviewer had already rejected in writing.
  const L = { stages: ["plan", "plan-review"], until: "planVerdict.pass", max: 2 };
  CASES.push(["a satisfied loop does not halt", exhaustedHalt(L, true) === null]);
  CASES.push(["an exhausted loop halts by default", exhaustedHalt(L, false) !== null]);
  CASES.push([
    "the halt names the condition, so the record says WHAT was not ratified",
    exhaustedHalt(L, false).reason.includes("planVerdict.pass"),
  ]);
  CASES.push([
    "the halt is tagged kind=exhausted, distinguishable from a stage failure",
    exhaustedHalt(L, false).kind === "exhausted",
  ]);
  CASES.push([
    "onExhausted: continue keeps the advisory-reviewer case running",
    exhaustedHalt({ ...L, onExhausted: "continue" }, false) === null,
  ]);
  CASES.push([
    "onExhausted: halt is the default spelled out, and still halts",
    exhaustedHalt({ ...L, onExhausted: "halt" }, false) !== null,
  ]);
  // `satisfied` is null when the chain HAS no loop, and undefined when the condition
  // never materialized. Neither is `true`, and neither should be read as ratified.
  CASES.push(["no loop is not a halt", exhaustedHalt(null, null) === null]);
  CASES.push([
    "an undefined condition counts as unsatisfied, not as passing",
    exhaustedHalt(L, undefined) !== null,
  ]);

  // ---- linear slots: declared position decides when a linear stage runs --------
  const S = (...ids) => ids.map((id) => ({ id }));
  const ids = (arr) => arr.map((s) => s.id).join(",");
  {
    // The shape that was silently wrong: a stage declared AFTER the loop.
    const sl = linearSlots(S("before", "a", "b", "after"), new Set(["a", "b"]), new Set());
    CASES.push(["a stage declared before the loop runs pre", ids(sl.pre) === "before"]);
    CASES.push(["a stage declared after the loop runs post, not pre", ids(sl.post) === "after"]);
  }
  {
    // The slot that did not exist at all, and the reason gates were doing tree work.
    const sl = linearSlots(S("plan", "code", "normalize"), new Set(), new Set(["code"]));
    CASES.push(["a stage after the fan-out runs post", ids(sl.post) === "normalize"]);
    CASES.push(["a stage before the fan-out still runs pre", ids(sl.pre) === "plan"]);
  }
  {
    // Between the two blocks: after the loop, before the fan-out.
    const sl = linearSlots(
      S("p", "pr", "mid", "code", "tail"),
      new Set(["p", "pr"]),
      new Set(["code"]),
    );
    CASES.push(["a stage between loop and fan-out runs mid", ids(sl.mid) === "mid"]);
    CASES.push(["and the one after the fan-out still runs post", ids(sl.post) === "tail"]);
    CASES.push(["nothing lands in pre when nothing precedes the loop", sl.pre.length === 0]);
  }
  {
    // REGRESSION GUARD: every existing chain declares its linear stages first, and
    // must keep running exactly as before.
    const sl = linearSlots(
      S("seedcheck", "p", "pr", "code"),
      new Set(["p", "pr"]),
      new Set(["code"]),
    );
    CASES.push([
      "the pre-existing shape (linear stages first) is unchanged",
      ids(sl.pre) === "seedcheck" && sl.mid.length === 0 && sl.post.length === 0,
    ]);
  }
  CASES.push([
    "members are never scheduled as linear stages",
    (() => {
      const sl = linearSlots(S("a", "b"), new Set(["a"]), new Set(["b"]));
      return sl.pre.length === 0 && sl.mid.length === 0 && sl.post.length === 0;
    })(),
  ]);

  // NO PROGRESS. Both halves are load-bearing; each case below fails if either is
  // dropped.
  {
    const np = (o) => noProgressHalt({ condRoot: "v", round: 2, ...o });
    CASES.push([
      "an identical verdict with an untouched tree is no progress",
      np({ previous: '{"pass":false}', current: '{"pass":false}', filesTouched: 0 })?.kind ===
        "no-progress",
    ]);
    CASES.push([
      "an identical verdict is fine if the round changed files",
      np({ previous: '{"pass":false}', current: '{"pass":false}', filesTouched: 3 }) === null,
    ]);
    CASES.push([
      "a changed verdict is progress even with an untouched tree",
      np({ previous: '{"pass":false,"n":1}', current: '{"pass":false,"n":2}', filesTouched: 0 }) ===
        null,
    ]);
    CASES.push([
      "the first round has nothing to compare against",
      np({ previous: null, current: '{"pass":false}', filesTouched: 0 }) === null,
    ]);
    CASES.push([
      "no-progress names the round it repeated",
      np({ previous: "x", current: "x", filesTouched: 0 }).reason.includes("round 1"),
    ]);
  }

  // DECLARED TOOLS, NEVER USED.
  {
    const S = (o) => ({ id: "gate-fix", ...o });
    CASES.push([
      "a stage that declares tools and calls none is flagged",
      unusedToolsWarning(S({ tools: ["repo_read", "grep"] }), 0).includes("called none"),
    ]);
    CASES.push([
      "the flag names the tools it was given",
      unusedToolsWarning(S({ tools: ["repo_read", "grep"] }), 0).includes("repo_read, grep"),
    ]);
    CASES.push([
      "tools: true with no calls is flagged too",
      unusedToolsWarning(S({ tools: true }), 0) !== null,
    ]);
    CASES.push([
      "a stage that used its tools is not flagged",
      unusedToolsWarning(S({ tools: true }), 4) === null,
    ]);
    CASES.push([
      "a reasoning stage is not flagged for having no tools",
      unusedToolsWarning(S({ tools: false }), 0) === null,
    ]);
    CASES.push([
      "a command stage is exempt",
      unusedToolsWarning({ id: "check", run: "node x.mjs" }, 0) === null,
    ]);
    CASES.push([
      "an unknown tool-call count is not evidence of anything",
      unusedToolsWarning(S({ tools: true }), null) === null,
    ]);
  }

  // APPEAL.
  {
    const st = { id: "gate-fix" };
    CASES.push([
      "an appeal halts the run",
      appealHalt(st, { appeal: "the checker judges every chunk against base" })?.kind === "appeal",
    ]);
    CASES.push([
      "the appeal's argument is carried in the halt",
      appealHalt(st, { appeal: "judged against base" }).reason.includes("judged against base"),
    ]);
    CASES.push([
      "an object appeal is read for its reason",
      appealHalt(st, { appeal: { reason: "c7 verifies earlier chunks" } }).reason.includes(
        "c7 verifies earlier chunks",
      ),
    ]);
    CASES.push([
      "the evidence survives on the halt record",
      appealHalt(st, { appeal: { reason: "r", evidence: ["c1"] } }).appeal.evidence[0] === "c1",
    ]);
    CASES.push(["an ordinary verdict is not an appeal", appealHalt(st, { pass: false }) === null]);
    CASES.push(["a text artifact is not an appeal", appealHalt(st, "some prose") === null]);
    CASES.push(["a null artifact is not an appeal", appealHalt(st, null) === null]);
  }

  return CASES;
}
