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
  return iterations.every((it) => (it.gate ? it.gate.ok === true : true));
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
  const g = (ok) => ({ gate: { ok } });
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
    "elements with no gate deliver on having run",
    foreachDelivered([{ gate: null }, { gate: null }], 2) === true,
  ]);

  return CASES;
}
