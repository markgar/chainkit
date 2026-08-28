// THE EXECUTOR: run one stage.
//
// Uniform by construction. A stage turns input into an artifact, and this function
// is the ONLY place a model gets called. It does not know or care whether the stage
// is planning, coding or reviewing -- that distinction lives entirely in the prompt
// file and the config. Keeping it that way is what makes "add a stage" a config
// edit; the moment this function branches on a stage id, it stops being true.
//
// There are exactly TWO kinds of stage, and the difference is what decides the
// output, not what the stage is "for":
//
//   prompt + model -> artifact   (runStage)        a judgement, priced in AiU
//   run (a command) -> artifact  (runCommandStage) a fact, priced at nothing
//
// The second exists because a chain always contains steps with no judgement in
// them -- format the tree, install after a dependency edit, run codegen, read the
// diff. Expressing those as a model call is worse in every measurable way: it
// costs a premium request, it can fail nondeterministically, and it can decline.
// A run stage is deliberately NOT a lesser stage: it produces artifacts, declares
// its shape, and can be a loop member like any other, so a chain can branch on a
// measured fact and not only on an opinion.

import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { complete } from "./providers.mjs";
import { render, readPath } from "./context.mjs";

// Pull a JSON object out of a model's prose. Models reliably wrap JSON in fences or
// preface it with a sentence, and treating that as a parse failure would throw away
// a good answer over formatting.
function extractJson(text) {
  if (!text) return { ok: false, error: "empty output" };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean);
  for (const c of candidates) {
    const trimmed = c.trim();
    // Take the outermost brace/bracket span, so trailing commentary is ignored.
    for (const [open, close] of [
      ["{", "}"],
      ["[", "]"],
    ]) {
      const i = trimmed.indexOf(open);
      const j = trimmed.lastIndexOf(close);
      if (i >= 0 && j > i) {
        try {
          return { ok: true, value: JSON.parse(trimmed.slice(i, j + 1)) };
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  return { ok: false, error: "no parseable JSON in output" };
}

// Read a dotted path off an artifact, e.g. "code-verdict.pass". Used by the loop's
// `until`. A missing field is UNDEFINED, never false -- the caller decides what an
// unanswerable condition means, because silently reading it as "not done" would
// spend the entire loop budget on a typo.
//
// The implementation moved to context.mjs (three callers now walk paths); this
// re-export keeps `import { readPath } from "./stage.mjs"` working.
export { readPath };

// Does a produced artifact carry the fields its stage declared?
//
// This runs at the moment of production, before anything downstream is paid for.
// A contract breach is not a soft problem: every later stage is reasoning about a
// value that does not mean what the config says it means.
export function checkShape(value, expects) {
  if (!expects) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [`expected an object with ${Object.keys(expects).join(", ")}, got ${typeOf(value)}`];
  const problems = [];
  for (const [field, want] of Object.entries(expects)) {
    if (!(field in value)) {
      problems.push(
        `missing "${field}" (declared ${want}); got keys: ${Object.keys(value).join(", ") || "none"}`,
      );
      continue;
    }
    const got = typeOf(value[field]);
    if (got !== want) problems.push(`"${field}" is ${got}, declared ${want}`);
  }
  return problems;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export async function runStage({
  stage,
  ctx,
  promptRoot,
  workDir,
  logRoot,
  round = 0,
  iter = 0,
  sessions = new Map(),
  maxCredits,
}) {
  const template = readFileSync(path.resolve(promptRoot, stage.prompt), "utf8");
  // render() THROWS on a placeholder no stage produced. That is deliberate: a
  // prompt that silently loses its spec section still looks well-formed and still
  // returns a plausible answer, and nothing downstream can tell.
  const prompt = render(template, ctx);

  const label = `${stage.id}${iter ? `.i${iter}` : ""}${round ? `.r${round}` : ""}`;
  // ONE LOG DIR PER ITERATION. Under a fan-out the same stage id runs N times, and
  // a shared dir would collapse "code, three chunks" into one stage in every view --
  // the exact per-chunk attribution the fan-out exists to give. Iteration 0 (no
  // fan-out) keeps the original name so earlier runs still read.
  const logDir = path.join(
    logRoot,
    `${String(stage.ord ?? 0).padStart(2, "0")}-${stage.id}${iter ? `__i${iter}` : ""}`,
  );

  // SESSION CONTINUITY. With `resume`, a stage's later rounds continue the SAME
  // conversation rather than starting cold: the author still has its context, and
  // the re-sent input is served as cache-read. This is a capability of driving the
  // CLI directly and it is per-stage config, so "resume vs fresh" is an experiment
  // you can run without touching code.
  //
  // Keyed by iteration too: resuming chunk 1's conversation to build chunk 2 would
  // silently carry the previous chunk's context into a fresh piece of work.
  let sessionId;
  if (stage.resume) {
    const key = `${stage.id}#${iter}`;
    if (!sessions.has(key)) sessions.set(key, randomId());
    sessionId = sessions.get(key);
  }

  const started = Date.now();
  const r = await complete({
    prompt,
    model: stage.model,
    effort: stage.effort,
    tools: stage.tools,
    cwd: workDir,
    timeoutMs: stage.timeoutMs,
    logDir,
    label,
    maxCredits,
    sessionId,
  });

  // A TIMEOUT IS NOT AN ANSWER. The child is killed and resolves through the normal
  // close path, so without this the caller sees only partial text and reports
  // whatever that text fails to be. A predecessor of this engine once reported
  // "could not parse chunks: Unexpected token 'G'" for a stage that had simply hit
  // its time cap -- a diagnosis that sent the reader to the prompt instead of the
  // clock.
  if (r.timedOut) {
    return {
      ok: false,
      error: `stage "${stage.id}" timed out after ${stage.timeoutMs}ms`,
      kind: "timeout",
      telemetry: r.telemetry,
      rawPath: r.rawPath,
      wallMs: Date.now() - started,
    };
  }

  let value = r.text;
  if (stage.parse === "json") {
    const p = extractJson(r.text);
    if (!p.ok) {
      return {
        ok: false,
        error: `stage "${stage.id}": ${p.error}`,
        kind: "parse",
        raw: (r.text || "").slice(-2000),
        telemetry: r.telemetry,
        rawPath: r.rawPath,
        wallMs: Date.now() - started,
      };
    }
    value = p.value;
  }

  const shapeProblems = checkShape(value, stage.expects);
  if (shapeProblems.length) {
    return {
      ok: false,
      error: `stage "${stage.id}" broke its declared shape: ${shapeProblems.join("; ")}`,
      kind: "shape",
      raw: JSON.stringify(value).slice(0, 2000),
      telemetry: r.telemetry,
      rawPath: r.rawPath,
      wallMs: Date.now() - started,
    };
  }

  return {
    ok: true,
    value,
    telemetry: r.telemetry,
    rawPath: r.rawPath,
    promptChars: prompt.length,
    sessionId: sessionId || null,
    wallMs: Date.now() - started,
  };
}

// THE COMMAND EXECUTOR: run one `run:` stage.
//
// Returns the SAME result contract as runStage, so run.mjs's execute() treats both
// identically -- artifact store, tree-delta accounting, halting, `optional`. That
// symmetry is the point: a run stage is a first-class stage, not a side channel.
export async function runCommandStage({ stage, ctx, workDir, logRoot, round = 0, iter = 0 }) {
  // The command is RENDERED, exactly like a prompt, so it can close over artifacts:
  // `run: pnpm test {{chunk.id}}`. render() throws on a placeholder no stage
  // produced -- the same hard failure a prompt gets, and for the same reason. A
  // command that silently loses a path argument does not fail; it runs against the
  // wrong target and exits 0.
  const command = render(stage.run, ctx);

  const label = `${stage.id}${iter ? `.i${iter}` : ""}${round ? `.r${round}` : ""}`;
  const logDir = path.join(
    logRoot,
    `${String(stage.ord ?? 0).padStart(2, "0")}-${stage.id}${iter ? `__i${iter}` : ""}`,
  );

  // ARTIFACTS REACH A COMMAND AS A FILE, NEVER AS INTERPOLATED TEXT.
  //
  // `{{...}}` is the right channel for a scalar -- `pnpm test {{chunk.id}}`. It is
  // the WRONG one for a structured artifact: render() serialises an object as
  // pretty-printed multi-line JSON, which is perfect inside a prompt and unsafe
  // inside `bash -c`. A plan whose blueprint contains an apostrophe, a backtick or
  // a `$` does not fail loudly when spliced into a command -- it is silently
  // mangled, or it executes. So a stage that needs to READ an artifact gets a path
  // to the whole store and parses it itself, with no shell in the middle.
  //
  // It is written even when the command ignores it, because it costs nothing and it
  // makes the log dir answer "what could this command actually see?" -- which is not
  // reconstructable afterwards once the store has moved on.
  let artifactsPath;
  try {
    mkdirSync(logDir, { recursive: true });
    artifactsPath = path.join(logDir, `${label}.artifacts.json`);
    const snap = typeof ctx?.snapshot === "function" ? ctx.snapshot() : {};
    writeFileSync(artifactsPath, JSON.stringify(snap, null, 2));
  } catch {
    artifactsPath = null; // never fail a run over an observability aid
  }

  const started = Date.now();
  const r = spawnSync("bash", ["-o", "pipefail", "-c", command], {
    cwd: workDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: stage.timeoutMs,
    // The stage's own identity travels with it, so a script shared by several
    // stages can tell which one invoked it without being told twice in config.
    env: {
      ...process.env,
      ...(artifactsPath ? { CHAINKIT_ARTIFACTS: artifactsPath } : {}),
      CHAINKIT_STAGE: String(stage.id),
      CHAINKIT_ROUND: String(round),
      CHAINKIT_ITER: String(iter),
    },
  });
  const wallMs = Date.now() - started;
  const stdout = r.stdout || "";
  const output = `${stdout}\n${r.stderr || ""}`.trim();

  // The transcript is written on EVERY path, including failure, because the reason a
  // command failed is in its output and nowhere else. A run stage that halts a chain
  // while its stderr lives only in a dead child process is exactly the "the failure's
  // reason was available but not captured" gap.
  let rawPath = null;
  try {
    mkdirSync(logDir, { recursive: true });
    rawPath = path.join(logDir, `${label}.run.txt`);
    writeFileSync(
      rawPath,
      `$ ${command}\n` +
        (artifactsPath ? `# CHAINKIT_ARTIFACTS=${path.basename(artifactsPath)}\n` : "") +
        `\n${output}\n`,
    );
  } catch {
    /* the transcript is an observability aid; never fail a run over it */
  }

  // A TIMEOUT IS NOT A FAILING COMMAND. spawnSync reports it as a killing signal
  // with a null status, which would otherwise read as the generic non-zero path and
  // send the reader to the command instead of the clock.
  if (r.error?.code === "ETIMEDOUT" || (r.status === null && r.signal)) {
    return {
      ok: false,
      error: `stage "${stage.id}" (run) timed out after ${stage.timeoutMs}ms: ${command}`,
      kind: "timeout",
      rawPath,
      wallMs,
    };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      // The exit code alone is not a diagnosis. The tail carries the actual reason,
      // which is the whole point of capturing it.
      error:
        `stage "${stage.id}" (run) exited ${r.status}: ${command}` +
        (output ? `\n${output.slice(-2000)}` : ""),
      kind: "run",
      raw: output.slice(-2000),
      rawPath,
      wallMs,
    };
  }

  // STDOUT ONLY when producing an artifact. stderr is where well-behaved tools put
  // progress and warnings, and folding it into a value a later stage reads would
  // make a chain's data depend on a tool's chattiness.
  let value = stdout.trim();
  if (stage.parse === "json") {
    const p = extractJson(stdout);
    if (!p.ok) {
      return {
        ok: false,
        error: `stage "${stage.id}" (run): ${p.error}`,
        kind: "parse",
        raw: stdout.slice(-2000),
        rawPath,
        wallMs,
      };
    }
    value = p.value;
  }

  const shapeProblems = checkShape(value, stage.expects);
  if (shapeProblems.length) {
    return {
      ok: false,
      error: `stage "${stage.id}" (run) broke its declared shape: ${shapeProblems.join("; ")}`,
      kind: "shape",
      raw: JSON.stringify(value).slice(0, 2000),
      rawPath,
      wallMs,
    };
  }

  // No `telemetry` row on purpose: there is no model call to price. A run stage is
  // free, and inventing a zero-cost row would put it in the per-stage cost table as
  // though it had been billed and merely come back cheap.
  return { ok: true, value, rawPath, wallMs, promptChars: command.length, sessionId: null };
}

function randomId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function selfTest() {
  const CASES = [];

  CASES.push(["bare JSON parses", extractJson('{"a":1}').value.a === 1]);
  CASES.push([
    "fenced JSON parses",
    extractJson('here you go:\n```json\n{"a":2}\n```').value.a === 2,
  ]);
  CASES.push([
    "JSON with trailing prose parses",
    extractJson('{"a":3}\n\nHope that helps!').value.a === 3,
  ]);
  CASES.push(["a JSON array parses", extractJson("[1,2,3]").value.length === 3]);
  CASES.push(["prose with no JSON fails", extractJson("no json here").ok === false]);
  CASES.push(["empty output fails", extractJson("").ok === false]);
  // Malformed JSON must FAIL, not half-parse into something plausible.
  CASES.push(["malformed JSON fails", extractJson('{"a": }').ok === false]);

  const ctx = {
    _m: new Map([["v", { pass: true, score: 0.9 }]]),
    has(n) {
      return this._m.has(n);
    },
    get(n) {
      return this._m.get(n);
    },
  };
  CASES.push(["readPath reads a nested field", readPath(ctx, "v.pass") === true]);
  CASES.push(["readPath on a missing field is undefined", readPath(ctx, "v.nope") === undefined]);
  CASES.push([
    "readPath on a missing artifact is undefined, NOT false",
    readPath(ctx, "ghost.pass") === undefined,
  ]);

  // DECLARED SHAPE. The failure this guards is a reworded prompt that starts
  // answering {"passed": true} instead of {"pass": true} -- which today makes a
  // loop condition undefined and, in a chain with no loop, is never noticed.
  const shape = { pass: "boolean", findings: "array" };
  CASES.push([
    "a conforming artifact has no shape problems",
    checkShape({ pass: true, findings: [] }, shape).length === 0,
  ]);
  CASES.push([
    "a renamed key is caught",
    checkShape({ passed: true, findings: [] }, shape).some((p) => p.includes('missing "pass"')),
  ]);
  CASES.push([
    "the error says which keys DID arrive, so the fix is obvious",
    checkShape({ passed: true }, shape).some((p) => p.includes("passed")),
  ]);
  CASES.push([
    "a wrong type is caught, not coerced",
    checkShape({ pass: "yes", findings: [] }, shape).some((p) => p.includes("declared boolean")),
  ]);
  CASES.push(["an array is not mistaken for an object", checkShape([], shape).length > 0]);
  CASES.push(["no declaration means no check", checkShape("anything at all", null).length === 0]);
  // `false` is a legitimate value: presence is what is checked, not truthiness.
  CASES.push([
    "a declared field that is present and false passes",
    checkShape({ pass: false, findings: [] }, shape).length === 0,
  ]);

  return CASES;
}
