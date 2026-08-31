// CHAIN CONFIG: load and validate.
//
// The config IS the interface. A stage is uniform -- prompt + model -> artifact --
// and there are deliberately NO stage kinds. The kernel does not know what a
// "review" is; a review is simply a stage whose prompt asks for a verdict and
// whose output parses as JSON. That is the property that makes "add a stage" a
// config edit rather than a code change, and it is worth protecting: the moment
// the kernel special-cases a stage id, adding a new KIND of stage needs code again.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { placeholders, rootOf } from "./context.mjs";
import { modelWarnings } from "./models.mjs";

// Every key a stage may carry. An unknown key is a HARD ERROR, not a warning.
//
// A misspelled `modle` would otherwise silently fall back to the default model and
// produce a complete, plausible, entirely wrong experiment -- the arm you thought
// you were running never ran, and nothing in the record says so. Typo protection is
// cheap here and the failure it prevents is undetectable downstream.
const STAGE_KEYS = new Set([
  "id",
  "prompt",
  "run",
  "produces",
  "parse",
  "model",
  "effort",
  "tools",
  "resume",
  "timeoutMs",
  "optional",
  "expects",
  "completion",
  "note",
]);

// The keys that only mean something for a MODEL stage. A `run` stage carrying one
// is not a harmless extra: `run: pnpm format` with `model: claude-opus-5` is a
// config whose author believes a model is involved. Ignoring it silently would let
// that belief survive, and the run record would then show a stage with a model that
// never ran -- unreadable next to a real one. Same reasoning as requiring every
// model stage to name its model, inverted.
const MODEL_ONLY_KEYS = ["model", "effort", "tools", "resume"];

// The types an `expects` declaration may name. Deliberately tiny: this exists to
// catch a broken key contract, not to be a schema language.
const EXPECT_TYPES = new Set(["string", "number", "boolean", "object", "array"]);

const CHAIN_KEYS = new Set([
  "name",
  "defaults",
  "stages",
  "loop",
  "foreach",
  "gate",
  "preflight",
  "seeds",
  "note",
]);
const LOOP_KEYS = new Set(["stages", "until", "max", "note"]);
// `onExhausted` exists ONLY on the chain-level loop, which is why this is a separate
// set rather than a member of LOOP_KEYS. A foreach's inner loop is always followed by
// that element's own gate -- the objective signal that overrides the reviewer's
// opinion -- so stopping before the gate would discard the very check that decides
// the element. The chain loop has no such guarantee: what follows it may be a fan-out
// that spends many times the loop's own cost on the artifact the loop just failed to
// ratify. So the question "is running on regardless acceptable?" is only meaningful
// here, and only here is it answerable in config.
const CHAIN_LOOP_KEYS = new Set([...LOOP_KEYS, "onExhausted"]);
const ON_EXHAUSTED = new Set(["halt", "continue"]);
// FOREACH is the second control-flow construct, and like `loop` the kernel knows
// nothing about what it is iterating. `over` names an artifact that happens to be
// an array; `as` binds each element under a name the prompts render. That the
// elements are "chunks of work" is a fact about the prompt, never about the engine.
const FOREACH_KEYS = new Set(["over", "as", "stages", "loop", "gate", "expects", "max", "note"]);
const COMPLETION_KEYS = new Set(["run", "max", "note"]);
const PREFLIGHT_KEYS = new Set(["run", "note"]);
const GATE_KEYS = new Set(["run", "repair", "note"]);
const GATE_REPAIR_KEYS = new Set(["stages", "max", "note"]);
const PARSE_MODES = new Set(["text", "json"]);

function unknownKeys(obj, allowed, where) {
  return Object.keys(obj || {})
    .filter((k) => !allowed.has(k))
    .map((k) => `${where}: unknown key "${k}"`);
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

// Validate WITHOUT spending anything. Every one of these is knowable before the
// first model call, and a chain that cannot possibly work should never cost money
// to discover that.
function validateChain(chain, { promptRoot, readPrompt = defaultReadPrompt } = {}) {
  const errors = [];
  errors.push(...unknownKeys(chain, CHAIN_KEYS, "chain"));

  const stages = chain.stages || [];
  if (!stages.length) errors.push("chain: no stages");

  const seen = new Set();
  for (const s of stages) {
    errors.push(...unknownKeys(s, STAGE_KEYS, `stage "${s.id || "(no id)"}"`));
    if (!s.id) errors.push("stage: missing id");
    else if (seen.has(s.id)) errors.push(`stage "${s.id}": duplicate id`);
    seen.add(s.id);
    if (!s.prompt && !s.run) errors.push(`stage "${s.id}": missing prompt or run`);
    // EXACTLY ONE KIND. Both keys present is not a stage that does two things, it is
    // an author who does not know which one runs -- and whichever the engine picked
    // would be a silent choice about what the run actually measured.
    if (s.prompt && s.run) errors.push(`stage "${s.id}": has both prompt and run -- pick one`);
    if (s.run !== undefined && typeof s.run !== "string")
      errors.push(`stage "${s.id}": run must be a string (a shell command)`);
    if (s.run) {
      for (const k of MODEL_ONLY_KEYS)
        if (s[k] !== undefined)
          errors.push(`stage "${s.id}": run stages take no "${k}" -- no model is called`);
    }

    if (s.completion !== undefined) {
      if (s.run) {
        errors.push(
          `stage "${s.id}": run stages cannot have completion -- there is no agent session to resume`,
        );
      } else if (
        typeof s.completion !== "object" ||
        s.completion === null ||
        Array.isArray(s.completion)
      ) {
        errors.push(`stage "${s.id}": completion must be a mapping`);
      } else {
        errors.push(...unknownKeys(s.completion, COMPLETION_KEYS, `stage "${s.id}".completion`));
        if (typeof s.completion.run !== "string" || !s.completion.run.trim())
          errors.push(`stage "${s.id}".completion: run must be a non-empty shell command`);
        if (!positiveInteger(s.completion.max))
          errors.push(
            `stage "${s.id}".completion: max must be a positive safe integer (bound the retries)`,
          );
      }
    }

    // EVERY MODEL STAGE NAMES ITS MODEL. Not defaulted by the kernel, on purpose: an
    // absent model is not "the sensible one", it is whatever the CLI happens to
    // pick that day, and a run whose record says `model: undefined` cannot be
    // compared to any other run. The chain may still say it once in `defaults`
    // -- this only requires that the config, not the tool, decided. A `run` stage
    // is exempt because it calls no model at all.
    if (!s.run && !s.model && !(chain.defaults || {}).model)
      errors.push(`stage "${s.id}": no model (set stage.model, or chain defaults.model)`);
    // `produces` is OPTIONAL, deliberately. A builder's product is the tree it
    // wrote, not a citable value, and forcing it to name an artifact nothing reads
    // manufactures a dead artifact -- and then a permanent warning on a correct
    // chain, which is how people learn to ignore warnings. A stage with no
    // `produces` still has its output recorded; it just does not enter the store.
    if (s.parse && !PARSE_MODES.has(s.parse))
      errors.push(`stage "${s.id}": parse must be one of ${[...PARSE_MODES].join(", ")}`);
    // Parsing an output nothing stores is a no-op that reads like a contract.
    if (s.parse === "json" && !s.produces)
      errors.push(`stage "${s.id}": parse: json without produces -- the parsed value goes nowhere`);

    // `tools` is a boolean OR an allowlist of tool names. The allowlist exists
    // because "prefer the repo tools" as PROSE does not work: a planner handed a
    // governance doc saying so still made 80 shell calls, and every one of them
    // was a read the repo tools already answered -- identical counts before and
    // after the missing capability was shipped. Tool choice is a reflex, and the
    // only thing that reliably changes a reflex is removing the alternative.
    //
    // An EMPTY list is refused. It means "no tools", which is `false`, and a list
    // that silently equals a different setting is how a chain ends up measuring
    // something nobody configured.
    if (s.tools !== undefined && typeof s.tools !== "boolean") {
      if (!Array.isArray(s.tools)) {
        errors.push(`stage "${s.id}": tools must be true, false, or a list of tool names`);
      } else if (s.tools.length === 0) {
        errors.push(`stage "${s.id}": tools is an empty list -- write tools: false`);
      } else if (!s.tools.every((t) => typeof t === "string" && t.trim())) {
        errors.push(`stage "${s.id}": tools list must hold non-empty tool names`);
      }
    }

    // `expects` declares the KEY CONTRACT of a structured artifact. Prompts are the
    // part of a chain people edit most, and a reworded reviewer prompt that starts
    // answering {"passed": true} instead of {"pass": true} is invisible today: a
    // loop reads the condition as undefined and burns a round discovering it, and a
    // chain with no loop never notices at all -- the next stage just renders a
    // verdict of the wrong shape and carries on.
    if (s.expects !== undefined) {
      if (typeof s.expects !== "object" || s.expects === null || Array.isArray(s.expects)) {
        errors.push(`stage "${s.id}": expects must be a mapping of field -> type`);
      } else {
        if (s.parse !== "json")
          errors.push(
            `stage "${s.id}": expects requires parse: json (a text artifact has no fields)`,
          );
        for (const [field, type] of Object.entries(s.expects)) {
          if (!EXPECT_TYPES.has(type))
            errors.push(
              `stage "${s.id}": expects.${field} names type "${type}", ` +
                `which is not one of ${[...EXPECT_TYPES].join(", ")}`,
            );
        }
      }
    }
  }

  if (chain.preflight !== undefined) {
    if (
      typeof chain.preflight !== "object" ||
      chain.preflight === null ||
      Array.isArray(chain.preflight)
    ) {
      errors.push("preflight: must be a mapping");
    } else {
      errors.push(...unknownKeys(chain.preflight, PREFLIGHT_KEYS, "preflight"));
      if (typeof chain.preflight.run !== "string" || !chain.preflight.run.trim())
        errors.push("preflight: run must be a non-empty shell command");
      else {
        for (const ref of placeholders(chain.preflight.run)) {
          const root = rootOf(ref);
          if (!(root in (chain.seeds || {})))
            errors.push(`preflight: run references {{${ref}}}, which is not a seed`);
          else {
            const value = chain.seeds[root];
            if (ref !== root)
              errors.push(`preflight: run references field {{${ref}}} on scalar seed "${root}"`);
            else if (
              (typeof value === "string" && value.startsWith("@")) ||
              (value !== null && typeof value === "object")
            )
              errors.push(
                `preflight: run interpolates {{${ref}}}, which is not a scalar literal seed`,
              );
          }
        }
      }
    }
  }

  if (chain.gate !== undefined && typeof chain.gate !== "string") {
    if (typeof chain.gate !== "object" || chain.gate === null || Array.isArray(chain.gate)) {
      errors.push("gate: must be a shell-command string or a mapping");
    } else {
      errors.push(...unknownKeys(chain.gate, GATE_KEYS, "gate"));
      if (typeof chain.gate.run !== "string" || !chain.gate.run.trim())
        errors.push("gate: run must be a non-empty shell command");
      const repair = chain.gate.repair;
      if (repair !== undefined) {
        if (typeof repair !== "object" || repair === null || Array.isArray(repair)) {
          errors.push("gate.repair: must be a mapping");
        } else {
          errors.push(...unknownKeys(repair, GATE_REPAIR_KEYS, "gate.repair"));
          if (!repair.stages?.length) errors.push("gate.repair: stages must be a non-empty list");
          else {
            for (const id of repair.stages) {
              if (!seen.has(id))
                errors.push(`gate.repair: names stage "${id}", which does not exist`);
              const stage = stages.find((candidate) => candidate.id === id);
              if (stage?.produces)
                errors.push(
                  `gate.repair: stage "${id}" must not produce an artifact -- it runs only after a failed final gate`,
                );
              if ((chain.loop?.stages || []).includes(id))
                errors.push(`gate.repair: stage "${id}" is also in the chain loop`);
              if ((chain.foreach?.stages || []).includes(id))
                errors.push(`gate.repair: stage "${id}" is also in the foreach`);
            }
          }
          if (!positiveInteger(repair.max))
            errors.push("gate.repair: max must be a positive safe integer (bound the retries)");
        }
      }
    }
  }

  // ARTIFACT REACHABILITY. Every {{placeholder}} must have a producer.
  //
  // Checked statically because the alternative is discovering it mid-run, after
  // paying for every earlier stage. Stages inside the loop may reference artifacts
  // the loop produces later (a `fix` stage reads the verdict that `code-review`
  // writes at the end of the previous pass), so loop members see the whole loop.
  // Foreach stages get the same treatment for the same reason, plus the bound
  // element name -- `as` is produced by the ENGINE at each iteration, not by a stage.
  const loopIds = new Set(chain.loop?.stages || []);
  const fe = chain.foreach || null;
  const feIds = new Set(fe?.stages || []);
  const feLoopIds = new Set(fe?.loop?.stages || []);
  const gateRepairIds = new Set(
    typeof chain.gate === "object" ? chain.gate.repair?.stages || [] : [],
  );
  const available = new Set(Object.keys(chain.seeds || {}));
  const loopProduces = stages.filter((s) => loopIds.has(s.id) && s.produces).map((s) => s.produces);
  const feProduces = stages.filter((s) => feIds.has(s.id) && s.produces).map((s) => s.produces);
  const firstPassProducesBefore = new Map();
  const firstPassProduces = [];
  for (const id of fe?.stages || []) {
    if (feLoopIds.has(id)) continue;
    firstPassProducesBefore.set(id, [...firstPassProduces]);
    const produced = stages.find((s) => s.id === id)?.produces;
    if (produced) firstPassProduces.push(produced);
  }

  const visibleFor = (stage, { after = false } = {}) => {
    const visible = new Set(available);
    if (loopIds.has(stage.id)) for (const p of loopProduces) visible.add(p);
    if (feIds.has(stage.id)) {
      // Declaration order is not execution order inside a foreach. Loop members do
      // not run during the first pass, so a first-pass stage cannot read an artifact
      // that only a loop member produces, even when that producer is declared above
      // it. Loop members may read the whole foreach set because later rounds consume
      // artifacts written by earlier rounds.
      for (const p of feProduces) visible.delete(p);
      const reachable = feLoopIds.has(stage.id)
        ? feProduces
        : firstPassProducesBefore.get(stage.id) || [];
      for (const p of reachable) visible.add(p);
      if (fe?.as) visible.add(fe.as);
    }
    if (after && stage.produces) visible.add(stage.produces);
    return visible;
  };

  // WHICH REFERENCES ARE NON-SCALAR, and therefore must never be interpolated into a
  // shell command.
  //
  // `render` serialises an object as pretty-printed multi-line JSON. Inside a prompt
  // that is exactly right. Inside `bash -c` it is a defect with three outcomes, and
  // only the first is survivable: the command dies on a quote (loud), the value is
  // silently mangled (a command that runs against the wrong thing and exits 0), or
  // the content is EXECUTED. A run stage reads structured artifacts from
  // CHAINKIT_ARTIFACTS instead, so there is no remaining reason to splice one -- and
  // this is knowable from the config alone, so it is refused before anything is spent
  // rather than discovered by a corrupted command mid-run.
  const nonScalar = new Set();
  for (const s of stages) {
    if (s.produces && s.parse === "json") nonScalar.add(s.produces);
    if (s.produces && s.expects && typeof s.expects === "object")
      for (const [k, t] of Object.entries(s.expects))
        if (t === "array" || t === "object") nonScalar.add(`${s.produces}.${k}`);
  }
  if (fe?.as) {
    // The bound element is whatever the plan's array holds -- an object in every
    // fan-out that declares `expects`, which is the only shape the engine can check.
    nonScalar.add(fe.as);
    if (fe.expects && typeof fe.expects === "object")
      for (const [k, t] of Object.entries(fe.expects))
        if (t === "array" || t === "object") nonScalar.add(`${fe.as}.${k}`);
  }

  for (const s of stages) {
    // A run stage's "body" is its command string: the same placeholder reachability
    // check applies, because `run: pnpm test {{chunk.id}}` is exactly as capable of
    // referencing an artifact nothing produces as a prompt is -- and it is knowable
    // statically, so it must not cost a run to discover.
    let body = null;
    if (s.run) {
      // Only a STRING command is a renderable body. A malformed `run` is already an
      // error above; letting it through here would throw out of the validator, which
      // turns a clear config error into a stack trace.
      body = typeof s.run === "string" ? s.run : null;
    } else {
      try {
        body = readPrompt(promptRoot, s.prompt);
      } catch {
        errors.push(`stage "${s.id}": prompt file not found: ${s.prompt}`);
      }
    }
    if (body != null) {
      const visible = visibleFor(s);
      for (const ref of placeholders(body)) {
        // Rooted, not literal: `{{chunk.files}}` is satisfied by whatever provides
        // `chunk`. Comparing the whole dotted string would make every field access
        // look unreachable, which trains people to stop believing the checker.
        if (!visible.has(rootOf(ref)))
          errors.push(
            `stage "${s.id}": ${s.run ? "run command" : "prompt"} references {{${ref}}}, which no earlier stage produces ` +
              `(available: ${[...visible].sort().join(", ") || "none"})`,
          );
        else if (s.run && nonScalar.has(ref))
          errors.push(
            `stage "${s.id}": run command interpolates {{${ref}}}, which is structured (not a scalar). ` +
              `render() emits it as multi-line JSON, which a shell will mangle or execute -- ` +
              `read it from the file at $CHAINKIT_ARTIFACTS instead, or interpolate a scalar field of it`,
          );
      }
    }
    if (s.completion && typeof s.completion === "object" && typeof s.completion.run === "string") {
      const visible = visibleFor(s, { after: true });
      for (const ref of placeholders(s.completion.run)) {
        if (!visible.has(rootOf(ref)))
          errors.push(
            `stage "${s.id}".completion: run references {{${ref}}}, which is unavailable after the stage`,
          );
        else if (nonScalar.has(ref))
          errors.push(
            `stage "${s.id}".completion: run interpolates {{${ref}}}, which is structured (not a scalar). ` +
              `Read it from $CHAINKIT_ARTIFACTS instead, or interpolate a scalar field`,
          );
      }
    }
    if (s.produces) available.add(s.produces);
  }

  if (chain.loop) {
    errors.push(...unknownKeys(chain.loop, CHAIN_LOOP_KEYS, "loop"));
    for (const id of chain.loop.stages || [])
      if (!seen.has(id)) errors.push(`loop: names stage "${id}", which does not exist`);
    if (!chain.loop.stages?.length) errors.push("loop: no stages");
    // An UNBOUNDED loop is not allowed. A review that never passes would otherwise
    // spend until something else stops it, and "something else" is a human noticing.
    if (!positiveInteger(chain.loop.max)) errors.push("loop: max must be a positive safe integer");
    if (!chain.loop.until) errors.push("loop: missing until");
    else {
      const art = rootOf(chain.loop.until);
      if (!available.has(art)) errors.push(`loop: until reads "${art}", which no stage produces`);
    }
    if (chain.loop.onExhausted !== undefined && !ON_EXHAUSTED.has(chain.loop.onExhausted))
      errors.push(
        `loop: onExhausted must be one of ${[...ON_EXHAUSTED].join(", ")} ` +
          `(got "${chain.loop.onExhausted}")`,
      );
  }

  if (fe) {
    errors.push(...unknownKeys(fe, FOREACH_KEYS, "foreach"));

    if (!fe.over) errors.push("foreach: missing over");
    else if (!available.has(rootOf(fe.over)))
      errors.push(`foreach: over reads "${rootOf(fe.over)}", which no stage produces`);
    // ...and it must come from OUTSIDE the fan-out. An array produced by a foreach
    // stage does not exist until the iteration it is meant to drive has begun.
    else if (feProduces.includes(rootOf(fe.over)))
      errors.push(
        `foreach: over reads "${rootOf(fe.over)}", which is produced inside the foreach itself`,
      );

    if (!fe.as) errors.push("foreach: missing as (the name each element binds to)");
    // A binding that shadows a real artifact makes the store ambiguous for the
    // whole iteration, and the shadowed value silently reappears afterwards.
    else if (available.has(fe.as) || (chain.seeds || {})[fe.as] !== undefined)
      errors.push(`foreach: as "${fe.as}" collides with an existing artifact of that name`);

    if (!fe.stages?.length) errors.push("foreach: no stages");
    for (const id of fe.stages || [])
      if (!seen.has(id)) errors.push(`foreach: names stage "${id}", which does not exist`);

    // A stage cannot be both a chain-level loop member and a foreach member: which
    // one owns its rounds would be undefined, and the record could not say either.
    for (const id of fe.stages || [])
      if (loopIds.has(id)) errors.push(`foreach: stage "${id}" is also in the chain-level loop`);

    // Same rule as the loop, same reason: an unbounded fan-out is a planner emitting
    // 500 chunks and a bill nobody authorised.
    if (!positiveInteger(fe.max))
      errors.push("foreach: max must be a positive safe integer (bound the fan-out)");

    if (fe.loop) {
      errors.push(...unknownKeys(fe.loop, LOOP_KEYS, "foreach.loop"));
      if (!fe.loop.stages?.length) errors.push("foreach.loop: no stages");
      for (const id of fe.loop.stages || [])
        if (!feIds.has(id))
          errors.push(`foreach.loop: stage "${id}" is not one of the foreach stages`);
      if (!positiveInteger(fe.loop.max))
        errors.push("foreach.loop: max must be a positive safe integer");
      if (!fe.loop.until) errors.push("foreach.loop: missing until");
      else if (!feProduces.includes(rootOf(fe.loop.until)))
        errors.push(
          `foreach.loop: until reads "${rootOf(fe.loop.until)}", which no foreach stage produces`,
        );
    }

    // The per-chunk gate is a COMMAND TEMPLATE. It is optional in the kernel, but a
    // foreach with no gate has no objective signal per element -- the inner loop is
    // then graded only by a model's opinion of its own work.
    if (fe.gate !== undefined && typeof fe.gate !== "string")
      errors.push("foreach: gate must be a string (a shell command, may use {{...}})");
    if (typeof fe.gate === "string") {
      for (const ref of placeholders(fe.gate)) {
        const r = rootOf(ref);
        if (r !== fe.as && !available.has(r))
          errors.push(`foreach: gate references {{${ref}}}, which nothing produces`);
      }
    }

    // ELEMENT SHAPE. Same argument as a stage's `expects`: a planner that emits
    // `paths` where the chain reads `files` is a config defect, and without this it
    // surfaces as a builder that mysteriously edits the wrong files.
    if (fe.expects !== undefined) {
      if (typeof fe.expects !== "object" || fe.expects === null || Array.isArray(fe.expects)) {
        errors.push("foreach: expects must be a mapping of field -> type");
      } else {
        for (const [field, type] of Object.entries(fe.expects))
          if (!EXPECT_TYPES.has(type))
            errors.push(
              `foreach: expects.${field} names type "${type}", ` +
                `which is not one of ${[...EXPECT_TYPES].join(", ")}`,
            );
      }
    }
  }

  return errors;
}

// ADVISORY, not fatal. Everything here is a probable wiring mistake rather than a
// certain one, so it must not stop a run -- but each is the quiet kind of mistake:
// you believe something is connected and it is not, and nothing says otherwise.
// (In the first p2 run, `code` produced `buildNotes` and nothing ever read it;
// the review stage inspected the repo instead. Nothing said so.)
//
// The last stage is exempt from the dead-artifact check: a chain's final output
// legitimately has no consumer.
export function warnChain(chain, { promptRoot, readPrompt = defaultReadPrompt } = {}) {
  const warnings = [];
  const stages = chain.stages || [];
  const referenced = new Set();
  for (const s of stages) {
    let body = null;
    if (s.run) {
      // A run stage consumes artifacts through its command, so it counts as a reader.
      // Without this, `run: pnpm test {{chunk.id}}` would leave its producer looking
      // dead and earn a permanent warning on a correct chain -- which is how people
      // learn to ignore warnings.
      body = typeof s.run === "string" ? s.run : null;
      // A run stage also names artifacts WITHOUT braces -- it is handed the
      // artifact store as a file and told which entry to read, as in
      // `plan-check.mjs buildPlan --strict`. Only `{{...}}` was counted, so a
      // correct chain earned a permanent warning about a producer that is very
      // much read, which is precisely how a warning becomes noise. Match on the
      // word so a substring cannot claim a read it does not perform.
      if (body)
        for (const s2 of stages)
          if (s2.produces && new RegExp(`\\b${s2.produces}\\b`).test(body))
            referenced.add(s2.produces);
    } else {
      try {
        body = readPrompt(promptRoot, s.prompt);
      } catch {
        /* absence is an ERROR, reported by validateChain; not a warning */
      }
    }
    if (body != null)
      // A prompt that reads `{{verdict.findings}}` has read `verdict`. Root the
      // reference, or every consumer that drills into a field looks like a
      // non-consumer and its producer is reported as unread.
      for (const ref of placeholders(body)) referenced.add(rootOf(ref));
  }
  // A loop condition is a real consumer too -- BOTH loops. The foreach's inner
  // `until` is the one that matters most in practice: it is the condition that ends
  // a per-element review round, so missing it made every reviewer stage in a
  // fanned-out chain look like it produced something nobody read.
  if (chain.loop?.until) referenced.add(rootOf(chain.loop.until));
  if (chain.foreach?.loop?.until) referenced.add(rootOf(chain.foreach.loop.until));
  if (chain.foreach?.over) referenced.add(rootOf(chain.foreach.over));

  const lastId = stages.at(-1)?.id;
  for (const s of stages) {
    if (!s.produces || s.id === lastId) continue;
    if (!referenced.has(s.produces))
      warnings.push(
        `stage "${s.id}" produces "${s.produces}", which no prompt or loop condition reads. ` +
          `It is recorded but does not reach any stage.`,
      );
  }

  // A DECLARED FIELD THE PROMPT NEVER ASKS FOR. `expects` is the other half of a
  // contract whose first half is the prompt text, and the two are edited in
  // different files -- so they drift. Today that drift costs a full call to find:
  // the shape check runs on the answer, after the money is spent, and reports a
  // missing field as if the model had disobeyed. Naming the field is the cheapest
  // possible evidence that the prompt actually asks for it.
  //
  // Advisory, and it has to be: a prompt may legitimately delegate its output shape
  // to a doc it pulls in by placeholder, and this only sees the prompt file itself.
  // A false positive that BLOCKED a working chain would be worse than the drift.
  const namesField = (body, field) =>
    new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body);
  const bodyOf = (s) => {
    try {
      return readPrompt(promptRoot, s.prompt);
    } catch {
      return null; // absence is an ERROR, reported by validateChain
    }
  };

  for (const s of stages) {
    if (!s.expects || typeof s.expects !== "object") continue;
    const body = bodyOf(s);
    if (body == null) continue;
    for (const field of Object.keys(s.expects))
      if (!namesField(body, field))
        warnings.push(
          `stage "${s.id}" expects field "${field}", which its prompt (${s.prompt}) never names. ` +
            `Either the prompt does not ask for it, or the two have drifted apart.`,
        );
  }

  // A LOOP CONDITION THAT READS A FIELD THE CONTRACT DOES NOT DECLARE. `until:
  // verdict.pass` and `expects: {pass: boolean}` are two statements about the same
  // field, written in different places, and nothing made them agree. Rename the
  // field in one and the loop silently tests `undefined` -- which is falsy, so the
  // loop never breaks early and simply runs to `max` every time, looking like a
  // model that could not converge rather than a typo.
  //
  // Only checked when the producer DECLARES `expects`: without it there is no
  // stated contract to contradict, and guessing at an artifact's shape would
  // produce warnings on chains that are perfectly correct.
  for (const until of [chain.loop?.until, chain.foreach?.loop?.until].filter(Boolean)) {
    const [art, ...rest] = String(until).split(".");
    const field = rest.join(".");
    if (!field) continue;
    const producer = stages.find((s) => s.produces === art);
    if (!producer?.expects || typeof producer.expects !== "object") continue;
    if (!(field in producer.expects))
      warnings.push(
        `loop until reads "${until}", but stage "${producer.id}" declares expects ` +
          `{${Object.keys(producer.expects).join(", ")}} — no "${field}". The loop would ` +
          `test undefined and run to max every time.`,
      );
  }

  // A foreach's `expects` is the same contract one level down -- it describes the
  // ELEMENTS of the array being iterated, so the prompt that has to ask for those
  // fields belongs to whichever stage produces that array, not to the foreach.
  // This is the more expensive drift of the two: a fan-out that cannot bind its
  // element has already paid for the plan before it finds out.
  const fe = chain.foreach;
  if (fe?.expects && typeof fe.expects === "object" && fe.over) {
    const producer = stages.find((s) => s.produces === String(fe.over).split(".")[0]);
    const body = producer ? bodyOf(producer) : null;
    if (body != null)
      for (const field of Object.keys(fe.expects))
        if (!namesField(body, field))
          warnings.push(
            `foreach expects element field "${field}", which the prompt that produces ` +
              `"${fe.over}" (stage "${producer.id}", ${producer.prompt}) never names.`,
          );
  }
  // A MODEL ID NOTHING WILL ACCEPT. Free to check here; expensive to discover at
  // dispatch, which for a late fan-out stage is after the whole prefix of the run
  // has been paid for. Advisory only -- the roster is not ours to be authoritative
  // about. See kernel/models.mjs.
  warnings.push(...modelWarnings(chain));

  return warnings;
}

function defaultReadPrompt(root, rel) {
  const p = path.resolve(root || ".", rel);
  if (!existsSync(p)) throw new Error(`no such prompt: ${p}`);
  return readFileSync(p, "utf8");
}

// Fold chain-level defaults into each stage, so the executor reads ONE resolved
// object and never re-implements precedence. The resolved values are what gets
// written to the run record -- recording the config as authored would leave the
// record ambiguous about which model actually ran.
export function resolveStages(chain) {
  const d = chain.defaults || {};
  return (chain.stages || []).map((s, i) => {
    const common = {
      id: s.id,
      // Execution order, carried so the log dir can be named `<nn>-<id>`. The
      // canvas lists a run's sub-dirs with a plain lexical sort, so without the
      // ordinal a five-stage chain would render alphabetically -- reading as a
      // sequence that never happened.
      ord: i + 1,
      produces: s.produces,
      parse: s.parse || "text",
      timeoutMs: s.timeoutMs ?? d.timeoutMs ?? 900000,
      optional: !!s.optional,
      expects: s.expects || null,
      completion: s.completion || null,
    };
    // A RUN STAGE TAKES NO MODEL DEFAULTS. Folding in `defaults.model` here would
    // put a model on a stage that never calls one, and the run record is the thing
    // people compare across runs -- a stage listing `claude-opus-5` beside a shell
    // command is a record that lies about what was spent and what decided.
    if (s.run) return { ...common, run: s.run };
    return {
      ...common,
      prompt: s.prompt,
      model: s.model || d.model,
      effort: s.effort || d.effort || "high",
      tools: s.tools ?? d.tools ?? false,
      resume: s.resume ?? d.resume ?? false,
    };
  });
}

// CHAIN FILES ARE YAML, for one reason above the others: YAML takes COMMENTS.
// A chain config's most valuable line is usually WHY a stage runs the model it
// runs, and JSON cannot hold that -- which is why this schema had grown `note`
// fields on the chain and on every stage, an awkward re-implementation of
// something the format should have provided.
function parseChainFile(file) {
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    // yaml's errors carry the line/column, which is the whole reason to surface
    // the message rather than a bare "could not parse".
    throw new Error(`${path.basename(file)} is not valid YAML: ${e.message}`, { cause: e });
  }
}

export function loadChain(file) {
  const chain = parseChainFile(file);
  const promptRoot = path.dirname(path.resolve(file));
  const errors = validateChain(chain, { promptRoot });
  return { chain, promptRoot, errors };
}

export function selfTest() {
  const CASES = [];
  const prompts = {
    "a.md": "use {{spec}}",
    "b.md": "use {{plan}}",
    "bad.md": "use {{nothing}}",
    "loop.md": "use {{verdict}}",
    "fe-code.md": "build {{chunk}} per {{plan}}",
    "fe-review.md": "judge {{chunk.files}}",
    "fe-facts-review.md": "judge {{facts}}",
    "fe-fix.md": "fix per {{verdict}}",
    "fe-fix-field.md": "fix per {{verdict.findings}}",
    "asks.md": "read {{spec}} and answer with pass (boolean) and findings (array)",
  };
  const readPrompt = (_root, rel) => {
    if (!(rel in prompts)) throw new Error("missing");
    return prompts[rel];
  };
  // A `run:` stage that names an artifact as a bare CLI argument is reading it.
  // This is the correct-config-warned-at case: the check that cries wolf on a
  // right chain is the one that teaches people to ignore every warning it emits.
  const runReads = (cmd) =>
    warnChain(
      {
        seeds: {},
        defaults: { model: "m" },
        stages: [
          { id: "plan", prompt: "x.md", produces: "buildPlan" },
          { id: "check", run: cmd },
          { id: "last", prompt: "x.md" },
        ],
      },
      { promptRoot: ".", readPrompt: () => "no placeholders" },
    ).filter((w) => w.includes("buildPlan"));

  CASES.push([
    "a run stage reading an artifact by bare name is a reader",
    runReads("node plan-check.mjs buildPlan --strict").length === 0,
  ]);
  CASES.push([
    "a run stage that does NOT name it still warns",
    runReads("node plan-check.mjs --strict").length === 1,
  ]);
  // Without a word boundary, `buildPlanner` would silently satisfy `buildPlan`
  // and the dead artifact would go unreported -- the check failing open.
  CASES.push([
    "a longer word containing the name does not count as a read",
    runReads("node plan-check.mjs buildPlanner").length === 1,
  ]);

  const base = {
    seeds: { spec: "" },
    defaults: { model: "m" },
    stages: [
      { id: "plan", prompt: "a.md", produces: "plan" },
      { id: "code", prompt: "b.md", produces: "diff" },
    ],
  };
  const V = (c) => validateChain(c, { readPrompt });

  CASES.push(["a well-formed chain validates clean", V(base).length === 0]);
  CASES.push([
    "a legacy string gate remains valid",
    V({ ...base, gate: "pnpm check" }).length === 0,
  ]);
  CASES.push([
    "a repairable final gate validates",
    V({
      ...base,
      stages: [...base.stages, { id: "integration-fix", prompt: "a.md" }],
      gate: { run: "pnpm check", repair: { stages: ["integration-fix"], max: 2 } },
    }).length === 0,
  ]);
  CASES.push([
    "a repairable gate requires a bounded retry count",
    V({
      ...base,
      gate: { run: "pnpm check", repair: { stages: ["code"] } },
    }).some((e) => e.includes("bound the retries")),
  ]);
  CASES.push([
    "a repairable gate must name real stages",
    V({
      ...base,
      gate: { run: "pnpm check", repair: { stages: ["missing"], max: 2 } },
    }).some((e) => e.includes('stage "missing"')),
  ]);
  CASES.push([
    "a final-gate repair stage cannot produce an artifact",
    V({
      ...base,
      gate: { run: "pnpm check", repair: { stages: ["code"], max: 2 } },
    }).some((e) => e.includes("must not produce an artifact")),
  ]);
  CASES.push([
    "a repairable gate rejects an unsafe retry bound",
    V({
      ...base,
      stages: [...base.stages, { id: "integration-fix", prompt: "a.md" }],
      gate: {
        run: "pnpm check",
        repair: { stages: ["integration-fix"], max: Number.POSITIVE_INFINITY },
      },
    }).some((e) => e.includes("positive safe integer")),
  ]);
  CASES.push([
    "an explicit preflight command validates",
    V({ ...base, preflight: { run: 'test -z "$(git status --porcelain)"' } }).length === 0,
  ]);
  CASES.push([
    "preflight may interpolate a scalar literal seed",
    V({
      ...base,
      seeds: { spec: "", branch: "main" },
      preflight: { run: "test {{branch}} = main" },
    }).length === 0,
  ]);
  CASES.push([
    "preflight cannot interpolate a file-backed seed",
    V({ ...base, seeds: { spec: "@spec.md" }, preflight: { run: "test -n {{spec}}" } }).some((e) =>
      e.includes("not a scalar literal seed"),
    ),
  ]);
  CASES.push([
    "preflight cannot reference a field on a scalar seed",
    V({ ...base, seeds: { spec: "" }, preflight: { run: "test -n {{spec.path}}" } }).some((e) =>
      e.includes("field {{spec.path}}"),
    ),
  ]);

  // "Nothing is fixed" only holds if an omission is caught rather than absorbed.
  CASES.push([
    "a stage with no model anywhere is an error",
    V({ ...base, defaults: {} }).some((e) => e.includes("no model")),
  ]);
  CASES.push([
    "a per-stage model satisfies it without a chain default",
    V({
      ...base,
      defaults: {},
      stages: base.stages.map((s) => ({ ...s, model: "per-stage" })),
    }).length === 0,
  ]);

  CASES.push([
    "a placeholder with no producer is an error",
    V({ ...base, stages: [...base.stages, { id: "x", prompt: "bad.md", produces: "y" }] }).some(
      (e) => e.includes("{{nothing}}"),
    ),
  ]);

  // The ordering half: `plan` runs BEFORE anything produces `plan`, so a prompt
  // that reads it is unreachable even though a producer exists somewhere.
  CASES.push([
    "a forward reference is an error, not just a missing one",
    V({ ...base, stages: [{ id: "code", prompt: "b.md", produces: "diff" }, base.stages[0]] }).some(
      (e) => e.includes("{{plan}}"),
    ),
  ]);

  CASES.push([
    "an unknown stage key is rejected (typo protection)",
    V({ ...base, stages: [{ ...base.stages[0], modle: "x" }, base.stages[1]] }).some((e) =>
      e.includes('unknown key "modle"'),
    ),
  ]);

  CASES.push([
    "a missing prompt file is an error",
    V({ ...base, stages: [{ id: "z", prompt: "nope.md", produces: "q" }] }).some((e) =>
      e.includes("prompt file not found"),
    ),
  ]);

  CASES.push([
    "duplicate stage ids are rejected",
    V({ ...base, stages: [base.stages[0], base.stages[0]] }).some((e) =>
      e.includes("duplicate id"),
    ),
  ]);

  // ---- `run` stages: a stage whose output is a fact, not a judgement -----------
  CASES.push([
    "a run stage validates with no model anywhere",
    V({ ...base, defaults: {}, stages: [{ id: "fmt", run: "pnpm format" }] }).length === 0,
  ]);
  CASES.push([
    "a stage with neither prompt nor run is an error",
    V({ ...base, stages: [{ id: "z", produces: "q" }] }).some((e) =>
      e.includes("missing prompt or run"),
    ),
  ]);
  CASES.push([
    "a stage with BOTH prompt and run is an error",
    V({ ...base, stages: [{ id: "z", prompt: "a.md", run: "ls" }] }).some((e) =>
      e.includes("pick one"),
    ),
  ]);
  // The rule that keeps a run stage honest: a model key on it means the author
  // believes a model runs. Ignoring it would let that belief survive.
  for (const k of MODEL_ONLY_KEYS) {
    CASES.push([
      `a run stage carrying "${k}" is an error`,
      V({ ...base, stages: [{ id: "fmt", run: "pnpm format", [k]: "x" }] }).some((e) =>
        e.includes(`run stages take no "${k}"`),
      ),
    ]);
  }
  CASES.push([
    "a non-string run is an error",
    V({ ...base, stages: [{ id: "fmt", run: ["pnpm", "format"] }] }).some((e) =>
      e.includes("run must be a string"),
    ),
  ]);
  // ---- stage completion: a deterministic postcondition owned by its agent ------
  const withCompletion = (completion) => ({
    ...base,
    stages: [{ ...base.stages[0], completion }, base.stages[1]],
  });
  CASES.push([
    "a bounded completion command is valid",
    V(withCompletion({ run: "pnpm check", max: 3 })).length === 0,
  ]);
  CASES.push([
    "completion is rejected on a command stage because no agent can resume",
    V({
      ...base,
      stages: [{ id: "fmt", run: "pnpm format", completion: { run: "pnpm check", max: 2 } }],
    }).some((e) => e.includes("no agent session to resume")),
  ]);
  CASES.push([
    "completion must be a mapping",
    V(withCompletion("pnpm check")).some((e) => e.includes("completion must be a mapping")),
  ]);
  CASES.push([
    "completion requires a non-empty command",
    V(withCompletion({ run: "", max: 2 })).some((e) => e.includes("non-empty shell command")),
  ]);
  CASES.push([
    "completion retries must be bounded",
    V(withCompletion({ run: "pnpm check" })).some((e) => e.includes("bound the retries")),
  ]);
  for (const badMax of [1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    CASES.push([
      `completion rejects non-safe bound ${badMax}`,
      V(withCompletion({ run: "pnpm check", max: badMax })).some((e) =>
        e.includes("positive safe integer"),
      ),
    ]);
  }
  CASES.push([
    "completion rejects unknown keys",
    V(withCompletion({ run: "pnpm check", max: 2, retries: 2 })).some((e) =>
      e.includes('unknown key "retries"'),
    ),
  ]);
  CASES.push([
    "completion may reference the stage artifact it checks",
    V(withCompletion({ run: "node check.mjs plan", max: 2 })).length === 0,
  ]);
  CASES.push([
    "completion refuses an unavailable artifact",
    V(withCompletion({ run: "node check.mjs {{missing}}", max: 2 })).some((e) =>
      e.includes("unavailable after the stage"),
    ),
  ]);
  CASES.push([
    "resolved stages retain completion configuration",
    resolveStages(withCompletion({ run: "pnpm check", max: 2 })).at(0).completion?.max === 2,
  ]);
  // A command is rendered like a prompt, so it gets the same static reachability
  // check -- knowable before the run, so it must not cost one to discover.
  CASES.push([
    "a run command referencing an unproduced artifact is an error",
    V({ ...base, stages: [...base.stages, { id: "t", run: "pnpm test {{nothing}}" }] }).some(
      (e) => e.includes("{{nothing}}") && e.includes("run command"),
    ),
  ]);
  CASES.push([
    "a run command may reference an artifact an earlier stage produced",
    V({ ...base, stages: [...base.stages, { id: "t", run: "echo {{plan}}" }] }).length === 0,
  ]);
  CASES.push([
    "a run stage may produce a parsed artifact",
    V({
      ...base,
      stages: [...base.stages, { id: "m", run: "cat metrics.json", parse: "json", produces: "m" }],
    }).length === 0,
  ]);

  const looped = {
    ...base,
    stages: [
      ...base.stages,
      { id: "review", prompt: "b.md", produces: "verdict" },
      { id: "fix", prompt: "loop.md", produces: "diff2" },
    ],
    loop: { stages: ["fix", "review"], until: "verdict.pass", max: 3 },
  };
  CASES.push(["a loop over real stages validates", V(looped).length === 0]);
  CASES.push([
    "a loop naming a nonexistent stage is an error",
    V({ ...looped, loop: { ...looped.loop, stages: ["ghost"] } }).some((e) =>
      e.includes('"ghost"'),
    ),
  ]);
  CASES.push([
    "an unbounded loop is rejected",
    V({ ...looped, loop: { stages: ["fix"], until: "verdict.pass" } }).some((e) =>
      e.includes("max must be"),
    ),
  ]);
  CASES.push([
    "a loop rejects a fractional bound",
    V({ ...looped, loop: { ...looped.loop, max: 1.5 } }).some((e) =>
      e.includes("positive safe integer"),
    ),
  ]);
  CASES.push([
    "a loop reading an artifact nobody produces is an error",
    V({ ...looped, loop: { ...looped.loop, until: "ghost.pass" } }).some((e) =>
      e.includes('reads "ghost"'),
    ),
  ]);
  CASES.push([
    "onExhausted: continue is accepted on the chain loop",
    V({ ...looped, loop: { ...looped.loop, onExhausted: "continue" } }).length === 0,
  ]);
  CASES.push([
    "onExhausted: halt is accepted on the chain loop",
    V({ ...looped, loop: { ...looped.loop, onExhausted: "halt" } }).length === 0,
  ]);
  CASES.push(["an omitted onExhausted is accepted (the default is halt)", V(looped).length === 0]);
  CASES.push([
    "a misspelled onExhausted VALUE is rejected, not silently treated as continue",
    V({ ...looped, loop: { ...looped.loop, onExhausted: "proceed" } }).some((e) =>
      e.includes("onExhausted must be one of"),
    ),
  ]);

  const r = resolveStages({
    defaults: { model: "m", effort: "high", tools: true },
    stages: [
      { id: "a", prompt: "p", produces: "x" },
      { id: "b", prompt: "p", produces: "y", model: "other", tools: false },
    ],
  });
  CASES.push(["defaults fold into stages", r[0].model === "m" && r[0].tools === true]);
  CASES.push(["a stage overrides the default", r[1].model === "other" && r[1].tools === false]);
  CASES.push(["parse defaults to text", r[0].parse === "text"]);

  // `tools` as an ALLOWLIST. The list has to survive resolution intact -- it is a
  // per-stage independent variable, and a run record that collapsed it to `true`
  // would make a shell-free arm indistinguishable from an unrestricted one.
  const withTools = (tools) => V({ ...base, stages: [{ id: "plan", prompt: "a.md", tools }] });
  CASES.push(["a tools allowlist validates clean", withTools(["repo_read", "glob"]).length === 0]);
  CASES.push(["tools: true still validates", withTools(true).length === 0]);
  CASES.push([
    "an empty tools list is refused, not read as false",
    withTools([]).some((e) => e.includes("empty list")),
  ]);
  CASES.push([
    "a non-string in the tools list is rejected",
    withTools(["repo_read", 7]).some((e) => e.includes("non-empty tool names")),
  ]);
  CASES.push([
    "a non-list, non-boolean tools is rejected",
    withTools("repo_read").some((e) => e.includes("true, false, or a list")),
  ]);
  const rt = resolveStages({
    defaults: {},
    stages: [{ id: "a", prompt: "p", tools: ["repo_read", "glob"] }],
  });
  CASES.push([
    "an allowlist survives resolution as a list",
    Array.isArray(rt[0].tools) && rt[0].tools.join() === "repo_read,glob",
  ]);

  // `expects` -- the declared key contract for a structured artifact.
  const withExpects = (expects, parse = "json") =>
    V({
      ...base,
      stages: [{ id: "rev", prompt: "a.md", produces: "verdict", parse, expects }],
    });
  CASES.push([
    "a well-formed expects validates clean",
    withExpects({ pass: "boolean" }).length === 0,
  ]);
  CASES.push([
    "an unknown expects type is rejected",
    withExpects({ pass: "bool" }).some((e) => e.includes('type "bool"')),
  ]);
  CASES.push([
    "expects on a text stage is rejected (a text artifact has no fields)",
    withExpects({ pass: "boolean" }, "text").some((e) => e.includes("requires parse: json")),
  ]);
  CASES.push([
    "expects must be a mapping, not a list",
    withExpects(["pass"]).some((e) => e.includes("mapping")),
  ]);
  CASES.push([
    "expects is carried through resolution, not dropped",
    resolveStages({
      stages: [
        { id: "a", prompt: "p", produces: "v", parse: "json", expects: { pass: "boolean" } },
      ],
    })[0].expects.pass === "boolean",
  ]);

  // Produced-but-never-consumed. Advisory: it does not break a run, but it is the
  // quiet wiring mistake -- you believe an output reached the next stage, it did not.
  const W = (c) => warnChain(c, { readPrompt });
  CASES.push([
    "a dead artifact is warned about",
    W({
      seeds: { spec: "" },
      stages: [
        { id: "plan", prompt: "a.md", produces: "unread" },
        { id: "code", prompt: "a.md", produces: "diff" },
      ],
    }).some((w) => w.includes("unread")),
  ]);
  CASES.push(["a consumed artifact is not warned about", W(base).length === 0]);
  CASES.push([
    "the LAST stage's output is exempt -- a chain's final result has no consumer",
    W({ seeds: { spec: "" }, stages: [{ id: "only", prompt: "a.md", produces: "result" }] })
      .length === 0,
  ]);
  CASES.push([
    "a loop condition counts as a consumer",
    W({
      seeds: { spec: "" },
      stages: [
        { id: "rev", prompt: "a.md", produces: "verdict" },
        { id: "fix", prompt: "a.md", produces: "notes" },
      ],
      loop: { stages: ["rev", "fix"], until: "verdict.pass", max: 2 },
    }).length === 0,
  ]);
  // Both of these were false positives on a real fanned-out chain: the reviewer's
  // verdict WAS read, once by a prompt drilling into a field and once by the inner
  // loop condition, and the warning claimed nothing read it. A warning that cries
  // wolf on a correct chain is worse than no warning, because check.mjs fails on
  // warnings -- it would have made a correct chain unshippable.
  CASES.push([
    "a prompt reading one FIELD of an artifact still counts as reading the artifact",
    W({
      seeds: { spec: "" },
      stages: [
        { id: "rev", prompt: "a.md", produces: "verdict" },
        { id: "fix", prompt: "fe-fix-field.md", produces: "notes" },
      ],
    }).length === 0,
  ]);
  CASES.push([
    "the FOREACH loop's until counts as a consumer, not just the outer loop's",
    W({
      seeds: { spec: "" },
      stages: [
        { id: "plan", prompt: "a.md", produces: "plan" },
        { id: "rev", prompt: "a.md", produces: "verdict" },
        { id: "fix", prompt: "a.md", produces: "notes" },
      ],
      foreach: {
        over: "plan.chunks",
        as: "chunk",
        stages: ["rev", "fix"],
        loop: { stages: ["rev", "fix"], until: "verdict.pass", max: 2 },
      },
    }).length === 0,
  ]);
  CASES.push([
    "an artifact NOTHING reads is still warned about once dotted refs are rooted",
    W({
      seeds: { spec: "" },
      stages: [
        { id: "rev", prompt: "fe-fix-field.md", produces: "orphan" },
        { id: "fix", prompt: "a.md", produces: "notes" },
      ],
    }).some((w) => w.includes("orphan")),
  ]);

  // `expects` vs the prompt that is supposed to ask for those fields. The two live
  // in different files and drift; today the drift costs a whole call to discover.
  const wExpects = (expects, prompt = "asks.md") =>
    W({
      seeds: { spec: "" },
      stages: [{ id: "rev", prompt, produces: "verdict", parse: "json", expects }],
    });
  CASES.push([
    "a prompt that names every expected field warns about none of them",
    wExpects({ pass: "boolean", findings: "array" }).length === 0,
  ]);
  CASES.push([
    "an expected field the prompt never names is warned about",
    wExpects({ pass: "boolean", score: "number" }).some(
      (w) => w.includes('"score"') && !w.includes('"pass"'),
    ),
  ]);
  CASES.push([
    "the field name is matched whole -- 'pass' does not satisfy 'passed'",
    wExpects({ passed: "boolean" }).some((w) => w.includes('"passed"')),
  ]);
  CASES.push([
    "an unreadable prompt is left to validateChain, not warned about twice",
    wExpects({ pass: "boolean" }, "gone.md").length === 0,
  ]);

  // `until` vs the `expects` of the stage that produces the artifact it drills into.
  // The failure this catches is quiet by construction: a field that is not there
  // reads as undefined, undefined is falsy, and a loop that never breaks early is
  // indistinguishable from a model that never converged.
  const wUntil = (until, expects = { pass: "boolean" }) =>
    W({
      seeds: { spec: "" },
      stages: [
        { id: "code", prompt: "asks.md" },
        {
          id: "rev",
          prompt: "asks.md",
          produces: "verdict",
          parse: "json",
          ...(expects ? { expects } : {}),
        },
      ],
      loop: { stages: ["rev", "code"], until, max: 3 },
    });
  CASES.push([
    "an until whose field the producer declares is not warned about",
    !wUntil("verdict.pass").some((w) => w.includes("loop until")),
  ]);
  CASES.push([
    "an until reading a field the producer's expects omits is warned about",
    wUntil("verdict.done").some((w) => w.includes('"verdict.done"') && w.includes('no "done"')),
  ]);
  CASES.push([
    "an until on a producer with no expects is not guessed at",
    !wUntil("verdict.done", null).some((w) => w.includes("loop until")),
  ]);
  CASES.push([
    "a bare until with no field is left alone -- there is nothing to contradict",
    !wUntil("verdict").some((w) => w.includes("loop until")),
  ]);

  // The foreach's element contract is checked against the PLANNER's prompt, since
  // that is the stage that has to be told what shape to emit.
  const wForeach = (feExpects) =>
    W({
      seeds: { spec: "" },
      stages: [
        { id: "plan", prompt: "asks.md", produces: "plan", parse: "json" },
        { id: "code", prompt: "fe-code.md" },
      ],
      foreach: { over: "plan.chunks", as: "chunk", stages: ["code"], expects: feExpects },
    });
  CASES.push([
    "a foreach element field the planner's prompt names is not warned about",
    !wForeach({ findings: "array" }).some((w) => w.includes("foreach expects")),
  ]);
  CASES.push([
    "a foreach element field no prompt asks for is warned about, naming the producer",
    wForeach({ acceptance: "string" }).some(
      (w) => w.includes('"acceptance"') && w.includes('stage "plan"'),
    ),
  ]);

  CASES.push([
    "a stage with no produces is legal -- its product is the tree",
    V({ seeds: { spec: "" }, defaults: { model: "m" }, stages: [{ id: "code", prompt: "a.md" }] })
      .length === 0,
  ]);
  CASES.push([
    "parse: json with no produces is rejected -- the parsed value goes nowhere",
    V({ seeds: { spec: "" }, stages: [{ id: "code", prompt: "a.md", parse: "json" }] }).some((e) =>
      e.includes("goes nowhere"),
    ),
  ]);

  // ---- FOREACH: fan-out over an artifact array -------------------------------
  //
  // The kernel must stay ignorant of what the elements MEAN. Every case below is
  // about control flow and reachability; none of them knows what a "chunk" is.
  const feChain = {
    seeds: { spec: "" },
    defaults: { model: "m" },
    stages: [
      { id: "plan", prompt: "a.md", produces: "plan", parse: "json", expects: { chunks: "array" } },
      { id: "code", prompt: "fe-code.md" },
      { id: "review", prompt: "fe-review.md", produces: "verdict", parse: "json" },
      { id: "fix", prompt: "fe-fix.md" },
    ],
    foreach: {
      over: "plan.chunks",
      as: "chunk",
      stages: ["code", "review", "fix"],
      loop: { stages: ["review", "fix"], until: "verdict.pass", max: 3 },
      gate: "{{chunk.acceptance}}",
      expects: { id: "string", files: "array", acceptance: "string" },
      max: 20,
    },
  };
  const FE = (patch) => V({ ...feChain, foreach: { ...feChain.foreach, ...patch } });

  CASES.push(["a foreach chain validates clean", V(feChain).length === 0]);
  CASES.push([
    "the bound element is visible to foreach stages",
    // `{{chunk}}` is produced by the ENGINE, not by any stage -- without the
    // binding, every foreach prompt reads as unreachable.
    !V(feChain).some((e) => e.includes("{{chunk}}")),
  ]);
  CASES.push([
    "a dotted reference is satisfied by its ROOT",
    !V(feChain).some((e) => e.includes("{{chunk.files}}")),
  ]);
  CASES.push([
    "an unknown foreach key is rejected",
    FE({ eachh: 1 }).some((e) => e.includes('unknown key "eachh"')),
  ]);
  CASES.push([
    "foreach over an artifact nothing produces is an error",
    FE({ over: "ghost.items" }).some((e) => e.includes("no stage produces")),
  ]);
  CASES.push([
    "foreach over an array produced INSIDE the fan-out is an error",
    FE({ over: "verdict.items" }).some((e) => e.includes("inside the foreach")),
  ]);
  CASES.push([
    "a binding that shadows an existing artifact is an error",
    FE({ as: "plan" }).some((e) => e.includes("collides")),
  ]);
  CASES.push([
    "foreach naming a stage that does not exist is an error",
    FE({ stages: ["code", "ghost"] }).some((e) => e.includes("does not exist")),
  ]);
  CASES.push([
    "an UNBOUNDED fan-out is an error",
    FE({ max: 0 }).some((e) => e.includes("bound the fan-out")),
  ]);
  CASES.push([
    "a fan-out rejects an unsafe bound",
    FE({ max: Number.POSITIVE_INFINITY }).some((e) => e.includes("positive safe integer")),
  ]);
  CASES.push([
    "an inner loop stage outside the foreach is an error",
    FE({ loop: { stages: ["plan"], until: "verdict.pass", max: 3 } }).some((e) =>
      e.includes("not one of the foreach stages"),
    ),
  ]);
  CASES.push([
    "a first-pass stage cannot read an artifact produced only inside the inner loop",
    V({
      ...feChain,
      stages: [
        feChain.stages[0],
        feChain.stages[1],
        { id: "facts", run: "echo '{}'", parse: "json", produces: "facts" },
        {
          id: "review",
          prompt: "fe-facts-review.md",
          produces: "verdict",
          parse: "json",
        },
        feChain.stages[3],
      ],
      foreach: {
        ...feChain.foreach,
        stages: ["code", "facts", "review", "fix"],
        loop: { stages: ["facts", "fix"], until: "verdict.pass", max: 3 },
      },
    }).some(
      (e) =>
        e.includes('stage "review"') &&
        e.includes("{{facts}}") &&
        e.includes("no earlier stage produces"),
    ),
  ]);
  CASES.push([
    "an inner loop until that no foreach stage produces is an error",
    FE({ loop: { stages: ["review"], until: "plan.pass", max: 2 } }).some((e) =>
      e.includes("no foreach stage produces"),
    ),
  ]);
  CASES.push([
    "an unbounded inner loop is an error",
    FE({ loop: { stages: ["review"], until: "verdict.pass", max: 0 } }).some((e) =>
      e.includes("foreach.loop: max"),
    ),
  ]);
  CASES.push([
    "an inner loop rejects a fractional bound",
    FE({ loop: { stages: ["review"], until: "verdict.pass", max: 1.5 } }).some((e) =>
      e.includes("foreach.loop: max"),
    ),
  ]);
  CASES.push([
    "a gate referencing something nothing provides is an error",
    FE({ gate: "{{ghost.cmd}}" }).some((e) => e.includes("gate references")),
  ]);
  CASES.push([
    "a gate may reference the bound element",
    FE({ gate: "run {{chunk.acceptance}}" }).length === 0,
  ]);
  CASES.push([
    "foreach expects must name real types",
    FE({ expects: { id: "uuid" } }).some((e) => e.includes('names type "uuid"')),
  ]);
  CASES.push([
    "a stage cannot be in both the chain loop and the foreach",
    V({
      ...feChain,
      loop: { stages: ["review"], until: "verdict.pass", max: 2 },
    }).some((e) => e.includes("also in the chain-level loop")),
  ]);
  CASES.push([
    "a foreach with no gate still validates (the kernel does not require one)",
    V({ ...feChain, foreach: { ...feChain.foreach, gate: undefined } }).length === 0,
  ]);
  CASES.push([
    "onExhausted on a FOREACH loop is rejected — it means nothing where a gate follows",
    FE({ loop: { ...feChain.foreach.loop, onExhausted: "halt" } }).some((e) =>
      e.includes("foreach.loop: unknown key"),
    ),
  ]);

  // A run command may interpolate a SCALAR and must not interpolate a structure.
  // render() emits an object as multi-line JSON, which a shell mangles or executes;
  // the file at $CHAINKIT_ARTIFACTS is the channel for those.
  const RUNREF = (cmd) =>
    V({
      ...feChain,
      stages: [...feChain.stages, { id: "probe", run: cmd }],
    });
  CASES.push([
    "a run command interpolating a json artifact is an error",
    RUNREF("echo '{{plan}}'").some((e) => e.includes("which is structured")),
  ]);
  CASES.push([
    "a run command interpolating an array FIELD is an error",
    RUNREF("echo {{plan.chunks}}").some((e) => e.includes("which is structured")),
  ]);
  CASES.push([
    "a run command interpolating the bound element is an error",
    V({
      ...feChain,
      stages: [...feChain.stages, { id: "probe", run: "echo {{chunk}}" }],
      foreach: { ...feChain.foreach, stages: ["code", "review", "fix", "probe"] },
    }).some((e) => e.includes("which is structured")),
  ]);
  CASES.push([
    "a run command interpolating a SCALAR field is fine",
    V({
      ...feChain,
      stages: [...feChain.stages, { id: "probe", run: "run {{chunk.acceptance}}" }],
      foreach: { ...feChain.foreach, stages: ["code", "review", "fix", "probe"] },
    }).length === 0,
  ]);
  CASES.push([
    "a PROMPT interpolating a structure is fine — that is what prompts are for",
    // fe-code.md is "build {{chunk}} per {{plan}}": two structures, both legitimate,
    // because a prompt is the one place multi-line JSON is the desired rendering.
    V(feChain).length === 0,
  ]);
  CASES.push([
    "the error names the file channel, so the fix is in the message",
    RUNREF("echo '{{plan}}'").some((e) => e.includes("CHAINKIT_ARTIFACTS")),
  ]);

  return CASES;
}
