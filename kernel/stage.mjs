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
import { complete, lastErrorLine } from "./providers.mjs";
import { render, readPath } from "./context.mjs";

function renderCompletionPreview(template, ctx, produced) {
  if (!produced) return render(template, ctx);
  const deferred = [];
  const masked = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => {
    if (String(name).split(".")[0] !== produced) return match;
    const token = `__CHAINKIT_DEFERRED_COMPLETION_${deferred.length}__`;
    deferred.push({ token, match });
    return token;
  });
  let preview = render(masked, ctx);
  for (const { token, match } of deferred) preview = preview.replaceAll(token, match);
  return preview;
}

// Pull a JSON object out of a model's prose. Models reliably wrap JSON in fences or
// preface it with a sentence, and treating that as a parse failure would throw away
// a good answer over formatting.
//
// Every candidate span is tried and the LONGEST one that parses wins. Preferring a
// fenced candidate outright is what broke: a plan's own string values quoted code in
// ``` fences, so the fence regex matched a pair INSIDE the JSON, and a 503-char scrap
// of TypeScript yielded a parseable `[]`. A whole, correct 59KB plan was thrown away
// for an empty array -- valid JSON, so nothing failed; only the stage's `expects`
// contract caught it. Longest-span selection keeps the fence as the recovery it was
// meant to be (prose containing braces) without letting a fragment outrank the whole.
//
// Spans are found by MATCHING each opening delimiter to its own close, rather than
// pairing the first `{` with the last `}`. Pairing by outermost index means a single
// stray brace anywhere in the prose makes the object span unparseable, and then the
// only span left to win is a nested one. A reviewer wrote "coalesce per `{orgId,
// siteId}`" while narrating, and its verdict `{"pass":false,"findings":[...]}` was
// extracted as the seven-element findings ARRAY -- valid JSON, wrong value, and the
// run halted at chunk 6 of 7 after real spend. Same class as the fence bug above, and
// the same thing caught it: only `expects` stood between a nested value and the chain
// carrying it forward as a verdict.
function matchingSpan(s, i) {
  const open = s[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    // A delimiter inside a string value is data, not structure.
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(i, k + 1);
  }
  return null;
}

function extractJson(text) {
  if (!text) return { ok: false, error: "empty output" };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean);
  let best = null;
  for (const c of candidates) {
    const trimmed = c.trim();
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch !== "{" && ch !== "[") continue;
      const span = matchingSpan(trimmed, i);
      // Longest wins, so a nested value can never outrank the whole it sits in.
      if (!span || (best && span.length <= best.length)) continue;
      try {
        best = { length: span.length, value: JSON.parse(span) };
      } catch {
        /* try the next span */
      }
    }
  }
  if (best) return { ok: true, value: best.value };
  return { ok: false, error: "no parseable JSON in output" };
}

// Rebuild an answer that arrived in pieces.
//
// A response the provider CUT OFF at the output ceiling is continued in the next
// call, and a truncated turn emits no assistant message -- so a long reply
// reaches us as its final fragment only, beginning mid-word. Observed: a valid
// 8-chunk plan spread over two calls, reported as unparseable while sitting
// whole in the log.
//
// Try the trailing calls, shortest suffix first, and accept the first join that
// parses. The parse is an ORACLE, which is what makes this safe: it recovers a
// real answer or changes nothing, and cannot invent one. Blind concatenation
// would not do -- in the motivating run an earlier cut-off call was an abandoned
// attempt the model restarted rather than continued, and including it parses as
// nothing at all.
function stitchJson(callTexts) {
  const calls = Array.isArray(callTexts) ? callTexts : [];
  for (let i = calls.length - 2; i >= 0; i--) {
    const joined = calls
      .slice(i)
      .map((c) => c?.text || "")
      .join("");
    const retry = extractJson(joined);
    if (retry.ok) return { ok: true, value: retry.value, calls: calls.length - i };
  }
  return { ok: false };
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

// THE APPEAL AFFORDANCE IS THE ENGINE'S TO STATE, not the prompt author's.
//
// A stage cannot use a way out it was never told about, so `appeal` is worth nothing
// until something puts it in the prompt. The question is who. Writing it into each
// repo's prompt files would put process knowledge -- how this engine handles a
// disputed finding -- into the part of the chain that is supposed to describe only
// the work, and it would have to be repeated in every prompt of every chain, drift
// between them, and silently go missing from the one stage that needed it.
//
// So the kernel appends it, uniformly. This is not the kernel learning about stage
// kinds: it does not ask what a stage is for, only whether the stage can express an
// appeal at all. `parse: json` is exactly that set -- a text stage's artifact has no
// field for the kernel to read, so telling it about `appeal` would be an offer it
// cannot take. The affordance is coextensive with the ability to use it.
//
// Deliberately understated: it is a last resort, it requires evidence, and it stops
// the run rather than continuing it. A stage that reads this as an easy exit from
// hard work would be worse than one that never appeals.
const APPEAL_NOTE = `

---

## If the finding you were given is wrong

You are expected to comply with the check you were asked to satisfy. Occasionally you
cannot, because the finding itself is incorrect — the check misread the repo, or it
asserts something contradicted by the evidence, and every action open to you would
make the work worse rather than better.

In that case do not comply, and do not pretend to. Return your normal JSON object
with one extra top-level field:

"appeal": { "reason": "<what the check got wrong, in one or two sentences>", "evidence": ["<concrete, checkable facts — file paths, chunk ids, what you actually looked at>"] }

This STOPS the run and hands your argument to a human. It is not a way to decline
work you find difficult, and it is not a way to proceed: nothing continues after it.
Use it only when you have looked, and the check is wrong. If you can comply, comply.`;

function appendAppealNote(prompt, stage) {
  if (stage.parse !== "json") return prompt;
  return prompt + APPEAL_NOTE;
}

function composeStagePrompt(
  stage,
  renderedTemplate,
  deterministicFailure = null,
  completionCommand = stage.completion?.run,
) {
  const completionRequirement = stage.completion
    ? [
        "",
        "## Deterministic completion requirement",
        "",
        "This stage is not complete until this command succeeds:",
        "",
        `\`${completionCommand}\``,
        "",
        "Run it yourself and fix every failure before returning. Chainkit will run it independently",
        `after your turn and resume this stage if it is still red (${stage.completion.attempts} total attempt(s), including this one).`,
      ].join("\n")
    : "";
  const failedCheck = deterministicFailure
    ? [
        "",
        "## Deterministic check failed",
        "",
        deterministicFailure.context ||
          "Your previous turn did not satisfy the command Chainkit requires.",
        "Repair the repository, run the check yourself, and do not return until it passes.",
        "",
        `Command: \`${deterministicFailure.command}\``,
        deterministicFailure.attempt && (deterministicFailure.attempts || deterministicFailure.max)
          ? `Attempt: ${deterministicFailure.attempt}/${deterministicFailure.attempts || deterministicFailure.max}`
          : "",
        "",
        "```text",
        deterministicFailure.tail || deterministicFailure.error || "(no output captured)",
        "```",
      ].join("\n")
    : "";
  return appendAppealNote(`${renderedTemplate}${completionRequirement}${failedCheck}`, stage);
}

function completionContinuation(stage, failure, command) {
  const attempts = failure.attempts || failure.max || stage.completion?.attempts;
  return [
    "Continue the same task in this existing conversation.",
    "",
    failure.context || "Your previous answer did not satisfy the deterministic completion check.",
    `The exact frozen command is: \`${command}\``,
    `This is attempt ${failure.attempt}/${attempts}.`,
    "",
    "Bounded captured failure output:",
    "```text",
    failure.output || failure.tail || failure.error || "(no output captured)",
    "```",
    "",
    "Do not repeat repository discovery already completed in this conversation.",
    "Repair the failure, run the exact command yourself, and return the complete replacement answer",
    "in the original requested format rather than a patch, addendum, or partial continuation.",
  ].join("\n");
}

function selectStagePrompt({
  stage,
  initialTemplate,
  resumeTemplate = null,
  ctx,
  deterministicFailure = null,
  completionCommand = stage.completion?.run,
  continued = false,
  attempt = 0,
}) {
  if (stage.resume && continued && deterministicFailure) {
    return {
      prompt: completionContinuation(
        stage,
        deterministicFailure,
        deterministicFailure.command || completionCommand,
      ),
      promptMode: "completion-continuation",
    };
  }
  if (stage.resume && continued && !deterministicFailure && resumeTemplate != null) {
    return { prompt: render(resumeTemplate, ctx), promptMode: "round-continuation" };
  }
  const prompt = composeStagePrompt(
    stage,
    render(initialTemplate, ctx),
    deterministicFailure,
    completionCommand,
  );
  if (deterministicFailure) return { prompt, promptMode: "fresh-retry" };
  return { prompt, promptMode: continued ? "repeated-full" : "initial" };
}

export async function runStage({
  stage,
  ctx,
  promptRoot,
  workDir,
  logRoot,
  round = 0,
  iter = 0,
  attempt = 0,
  deterministicFailure = null,
  sessions = new Map(),
  maxCredits,
}) {
  const template = readFileSync(path.resolve(promptRoot, stage.prompt), "utf8");
  // render() THROWS on a placeholder no stage produced. That is deliberate: a
  // prompt that silently loses its spec section still looks well-formed and still
  // returns a plausible answer, and nothing downstream can tell.
  const completionCommand = stage.completion
    ? renderCompletionPreview(stage.completion.run, ctx, stage.produces)
    : null;
  const label =
    `${stage.id}${iter ? `.i${iter}` : ""}${round ? `.r${round}` : ""}` +
    `${attempt ? `.a${attempt + 1}` : ""}`;
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
  let continued = false;
  if (stage.resume) {
    const key = `${stage.id}#${iter}`;
    continued = sessions.has(key);
    if (!sessions.has(key)) sessions.set(key, randomId());
    sessionId = sessions.get(key);
  }
  const resumeTemplate = stage.resumePrompt
    ? readFileSync(path.resolve(promptRoot, stage.resumePrompt), "utf8")
    : null;
  const { prompt, promptMode } = selectStagePrompt({
    stage,
    initialTemplate: template,
    resumeTemplate,
    ctx,
    deterministicFailure,
    completionCommand,
    continued,
    attempt,
  });
  const invocation = {
    promptChars: prompt.length,
    promptMode,
    sessionId: sessionId || null,
  };

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
      ...invocation,
    };
  }

  // A NON-ZERO EXIT IS NOT AN ANSWER EITHER. Same family as the timeout above: the
  // child resolves through the normal close path, so its stderr becomes the stage's
  // "text" and everything downstream diagnoses the wrong thing -- or, for a stage
  // with no `produces` to parse, nothing checks it at all and the run records ok.
  // A probe stage whose model rejected a flag was recorded ok:true, error:null,
  // halted:null, having made no model call whatsoever.
  if (r.exitCode) {
    return {
      ok: false,
      error:
        `stage "${stage.id}" failed: the CLI exited ${r.exitCode}` +
        (r.exitReason ? ` -- ${r.exitReason}` : ""),
      kind: "exit",
      telemetry: r.telemetry,
      rawPath: r.rawPath,
      wallMs: Date.now() - started,
      ...invocation,
    };
  }

  let value = r.text;
  let recoveredFrom = 0;
  if (stage.parse === "json") {
    const p = extractJson(r.text);
    stitch: if (!p.ok) {
      // A cut-off answer is CONTINUED in the next call, so a long reply is spread
      // across several calls while only the last reaches us as an assistant
      // message -- a truncated turn emits none. Keeping only assistant messages
      // therefore keeps only the final fragment, which is how a complete, valid
      // reply was reported as unparseable while sitting whole in the log.
      //
      // So stitch the trailing calls back together, shortest suffix first, and
      // accept the first join that parses. The parse IS the point: it is an
      // oracle, so this either recovers a real answer or changes nothing, and it
      // cannot invent one. Blind concatenation would not do -- in the run that
      // motivated this, an earlier cut-off call was an abandoned attempt the
      // model restarted rather than continued, and including it parses as nothing.
      const st = stitchJson(r.telemetry?.callTexts);
      if (st.ok) {
        value = st.value;
        recoveredFrom = st.calls;
      }
      if (recoveredFrom) break stitch;

      // Nothing stitched. "No parseable JSON" is then the symptom, and when the
      // provider said it cut the response off that is the cause -- reporting only
      // the symptom sends the reader to debug a prompt or a model's formatting.
      const cut = r.telemetry?.truncatedCalls || 0;
      const why = cut
        ? `${p.error} — the model was cut off at the output limit${
            r.telemetry?.maxOutputTokens ? ` (${r.telemetry.maxOutputTokens} tokens)` : ""
          } on ${cut} call(s), so the text is a fragment. Ask for a smaller answer, or raise the limit.`
        : p.error;
      return {
        ok: false,
        error: `stage "${stage.id}": ${why}`,
        kind: "parse",
        raw: (r.text || "").slice(-2000),
        telemetry: r.telemetry,
        rawPath: r.rawPath,
        wallMs: Date.now() - started,
        ...invocation,
      };
    }
    if (!recoveredFrom) value = p.value;
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
      ...invocation,
    };
  }

  return {
    ok: true,
    value,
    // A silent recovery is its own blind spot: the run would look ordinary while
    // the answer had in fact arrived in pieces after hitting the output ceiling,
    // which is a thing the operator should go fix rather than keep paying for.
    recoveredFromCalls: recoveredFrom || undefined,
    telemetry: r.telemetry,
    rawPath: r.rawPath,
    ...invocation,
    wallMs: Date.now() - started,
  };
}

// THE COMMAND EXECUTOR: run one `run:` stage.
//
// Returns the SAME result contract as runStage, so run.mjs's execute() treats both
// identically -- artifact store, tree-delta accounting, halting, `optional`. That
// symmetry is the point: a run stage is a first-class stage, not a side channel.
export async function runCommandStage({
  stage,
  ctx,
  workDir,
  logRoot,
  round = 0,
  iter = 0,
  attempt = 0,
}) {
  // The command is RENDERED, exactly like a prompt, so it can close over artifacts:
  // `run: pnpm test {{chunk.id}}`. render() throws on a placeholder no stage
  // produced -- the same hard failure a prompt gets, and for the same reason. A
  // command that silently loses a path argument does not fail; it runs against the
  // wrong target and exits 0.
  const command = render(stage.run, ctx);

  const label =
    `${stage.id}${iter ? `.i${iter}` : ""}${round ? `.r${round}` : ""}` +
    `${attempt ? `.a${attempt + 1}` : ""}`;
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
      command,
      output: output.slice(-12000),
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
      command,
      code: r.status,
      output: output.slice(-12000),
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
        command,
        output: output.slice(-12000),
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
      command,
      output: output.slice(-12000),
      raw: JSON.stringify(value).slice(0, 2000),
      rawPath,
      wallMs,
    };
  }

  // No `telemetry` row on purpose: there is no model call to price. A run stage is
  // free, and inventing a zero-cost row would put it in the per-stage cost table as
  // though it had been billed and merely come back cheap.
  return {
    ok: true,
    value,
    command,
    code: 0,
    output: output.slice(-12000),
    rawPath,
    wallMs,
    promptChars: command.length,
    sessionId: null,
  };
}

function randomId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function selfTest() {
  const CASES = [];

  const completionPrompt = composeStagePrompt(
    { parse: "text", completion: { run: "pnpm check", attempts: 3 } },
    "Do the work.",
  );
  CASES.push([
    "the initial model prompt names its enforced completion command",
    completionPrompt.includes("pnpm check") &&
      completionPrompt.includes("Run it yourself") &&
      completionPrompt.includes("3 total attempt(s)"),
  ]);
  CASES.push([
    "the initial completion instruction uses the rendered command",
    composeStagePrompt(
      { parse: "text", completion: { run: "pnpm test {{chunk.id}}", attempts: 2 } },
      "Build it.",
      null,
      "pnpm test c7",
    ).includes("pnpm test c7"),
  ]);
  const retryPrompt = composeStagePrompt({ parse: "text" }, "Repair.", {
    command: "pnpm check",
    attempt: 2,
    attempts: 3,
    tail: "Type error in src/a.ts",
  });
  CASES.push([
    "deterministic failure feedback carries the exact command, bound, and output",
    retryPrompt.includes("pnpm check") &&
      retryPrompt.includes("Attempt: 2/3") &&
      retryPrompt.includes("Type error in src/a.ts"),
  ]);
  const resumedRetry = selectStagePrompt({
    stage: {
      parse: "text",
      resume: true,
      completion: { run: "pnpm check", attempts: 3 },
    },
    initialTemplate: "ORIGINAL DISCOVERY PROMPT",
    ctx: {},
    deterministicFailure: {
      context: "The exact heading reference is wrong.",
      command: "pnpm check",
      attempt: 2,
      attempts: 3,
      output: "line one\nline two",
    },
    completionCommand: "pnpm check changed-context",
    continued: true,
    attempt: 1,
  });
  CASES.push([
    "a resumed deterministic retry sends only compact continuation context",
    resumedRetry.promptMode === "completion-continuation" &&
      !resumedRetry.prompt.includes("ORIGINAL DISCOVERY PROMPT") &&
      resumedRetry.prompt.includes("The exact heading reference is wrong.") &&
      resumedRetry.prompt.includes("pnpm check") &&
      !resumedRetry.prompt.includes("changed-context") &&
      resumedRetry.prompt.includes("attempt 2/3") &&
      resumedRetry.prompt.includes("line one\nline two") &&
      resumedRetry.prompt.includes("Do not repeat repository discovery"),
  ]);
  const freshRetry = selectStagePrompt({
    stage: { parse: "text", resume: false },
    initialTemplate: "ORIGINAL DISCOVERY PROMPT",
    ctx: {},
    deterministicFailure: {
      context: "The check failed.",
      command: "pnpm check",
      attempt: 2,
      attempts: 3,
      output: "failure",
    },
    completionCommand: "pnpm check",
    attempt: 1,
  });
  CASES.push([
    "a fresh deterministic retry retains the original authored context",
    freshRetry.promptMode === "fresh-retry" &&
      freshRetry.prompt.includes("ORIGINAL DISCOVERY PROMPT") &&
      freshRetry.prompt.includes("The check failed."),
  ]);
  const resumedCompositeRepair = selectStagePrompt({
    stage: { parse: "text", resume: true },
    initialTemplate: "ORIGINAL REPAIR PROMPT",
    ctx: {},
    deterministicFailure: {
      context: "The assembled repository failed.",
      command: "pnpm integration",
      attempt: 2,
      attempts: 3,
      output: "integration failure",
    },
    continued: true,
    attempt: 0,
  });
  CASES.push([
    "a resumed composite repair also receives compact failure context",
    resumedCompositeRepair.promptMode === "completion-continuation" &&
      !resumedCompositeRepair.prompt.includes("ORIGINAL REPAIR PROMPT") &&
      resumedCompositeRepair.prompt.includes("pnpm integration"),
  ]);
  const roundContinuation = selectStagePrompt({
    stage: { parse: "text", resume: true },
    initialTemplate: "ORIGINAL DISCOVERY PROMPT",
    resumeTemplate: "Continue {{item}} only.",
    ctx: { has: (name) => name === "item", get: () => "c7" },
    continued: true,
  });
  CASES.push([
    "a resumed loop invocation uses the authored resume prompt",
    roundContinuation.promptMode === "round-continuation" &&
      roundContinuation.prompt === "Continue c7 only.",
  ]);

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

  // The defect this guards: a plan whose own string values quote code in ``` fences.
  // The fence regex matches a pair INSIDE the JSON, and that fragment can yield a
  // parseable-but-wrong value. Preferring the fenced candidate returned `[]` here
  // and threw away the whole object.
  const fenceInString = JSON.stringify({
    chunks: [{ id: "c1", acceptance: "add:\n```ts\nconst a = [];\n```\nthen build" }],
  });
  CASES.push([
    "a fence inside a JSON string does not outrank the whole object",
    extractJson(fenceInString).value?.chunks?.[0]?.id === "c1",
  ]);
  CASES.push([
    "prose containing braces still falls back to the fenced block",
    extractJson('I tried {a} first:\n```json\n{"a":9}\n```').value.a === 9,
  ]);

  // Reassembling a cut-off answer. The shapes here are taken from the real run
  // that motivated it: an abandoned prose attempt, then the answer itself split
  // across a cut-off call and its continuation.
  const T = (text, truncated = false) => ({ text, truncated });
  CASES.push([
    "a reply split across a cut-off call is rejoined",
    stitchJson([T('```json\n{"chunks":[1,2', true), T(",3]}\n```")]).value.chunks.length === 3,
  ]);
  CASES.push([
    "the rejoin reports how many calls it took",
    stitchJson([T('{"a":1', true), T("}")]).calls === 2,
  ]);
  // The one that makes blind concatenation wrong: an earlier cut-off call the
  // model ABANDONED and restarted. Prepending it must not break the recovery.
  CASES.push([
    "an abandoned earlier attempt is skipped, not concatenated",
    stitchJson([T("I will now write {the plan", true), T('{"a":1', true), T("}")]).value.a === 1,
  ]);
  // The safety property: no stitching can invent an answer.
  CASES.push([
    "calls with no JSON anywhere recover nothing",
    stitchJson([T("hello", true), T(" world")]).ok === false,
  ]);
  CASES.push(["a single call has no suffix to stitch", stitchJson([T('{"a":1}')]).ok === false]);
  CASES.push(["no calls at all is not an error", stitchJson(undefined).ok === false]);
  // Malformed JSON must FAIL, not half-parse into something plausible.
  CASES.push(["malformed JSON fails", extractJson('{"a": }').ok === false]);

  // A stray brace in narration used to poison the object span, leaving a nested
  // array as the only thing that parsed. Halted a real run at chunk 6 of 7.
  const strayBrace =
    "Coalesce in-flight builds per `{orgId, siteId}` before returning.\n" +
    '{"pass":false,"findings":["a","b"]}';
  CASES.push([
    "a stray brace in prose does not yield a nested value",
    extractJson(strayBrace).value?.pass === false &&
      extractJson(strayBrace).value?.findings?.length === 2,
  ]);
  CASES.push([
    "a brace inside a string value is data, not structure",
    extractJson(String.raw`{"note":"use {a} here","ok":true}`).value?.ok === true,
  ]);
  CASES.push([
    "an escaped quote does not end the string scan",
    extractJson('{"note":"say \\"hi\\" {x}","ok":true}').value?.ok === true,
  ]);

  // The reason a failed CLI run gave. Discarding it leaves an exit code, which
  // sends the reader to the logs for something the process already said aloud.
  CASES.push([
    "a fatal CLI error line is recovered",
    lastErrorLine('{"type":"x"}\nError: Model "m" does not support reasoning effort.') ===
      'Error: Model "m" does not support reasoning effort.',
  ]);
  CASES.push([
    "the LAST error line wins over earlier recoverable noise",
    lastErrorLine("Error: first\nsome output\nError: second") === "Error: second",
  ]);
  CASES.push(["clean output yields no error line", lastErrorLine('{"type":"x"}\nok') === null]);
  CASES.push(["empty output yields no error line", lastErrorLine("") === null]);

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

  // THE APPEAL NOTE reaches exactly the stages that can act on it.
  {
    const p = "Do the work.";
    CASES.push([
      "a json stage is told it may appeal",
      appendAppealNote(p, { parse: "json" }).includes('"appeal"'),
    ]);
    CASES.push([
      "a text stage is not offered a field it cannot express",
      appendAppealNote(p, { parse: "text" }) === p,
    ]);
    CASES.push(["an unparsed stage is left alone", appendAppealNote(p, {}) === p]);
    CASES.push([
      "the original prompt survives verbatim ahead of the note",
      appendAppealNote(p, { parse: "json" }).startsWith(p),
    ]);
    // The note must not read as an easy exit, or it becomes one.
    CASES.push([
      "the note says an appeal stops the run",
      /STOPS the run/.test(APPEAL_NOTE) && /not a way to proceed/.test(APPEAL_NOTE),
    ]);
    CASES.push([
      "the note demands evidence",
      /evidence/.test(APPEAL_NOTE) && /If you can comply, comply/.test(APPEAL_NOTE),
    ]);
  }

  return CASES;
}
