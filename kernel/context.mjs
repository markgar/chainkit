// The ARTIFACT STORE and prompt templating.
//
// A chain is a sequence of stages that exchange named artifacts: `plan` produces
// a plan, `code` consumes it, `code-review` judges the diff.
//
// This store is ONE of three channels between stages, and honestly not the widest.
// The others:
//   - the FILESYSTEM. Every tool-enabled stage shares one workdir, so a builder's
//     real output is the tree it wrote. A reviewer usually reads the repo, not the
//     builder's account of it. That handoff is invisible here, which is why the
//     runner records per-stage `filesChanged` -- otherwise the main channel carries
//     no evidence at all.
//   - the CLI SESSION. A stage may `resumeFrom` an earlier stage's session and inherit
//     its whole conversation. That is a large, unnamed handoff; the runner records
//     the sessionId so at least it is visible in the record.
//
// What the store alone buys is that the pipeline can be config rather than code:
// a stage does not know what ran before it, only which artifact names it asked for.
// Anything flowing through the other two channels is real but unnamed, so a chain
// that depends on them cannot be reasoned about from the YAML alone.

export function makeContext(seed = {}) {
  const artifacts = new Map(Object.entries(seed));
  const history = [];
  return {
    get(name) {
      return artifacts.get(name);
    },
    has(name) {
      return artifacts.has(name);
    },
    set(name, value, by, round = 0) {
      artifacts.set(name, value);
      // The VALUE is retained, not just the fact that a name was written.
      //
      // The store is last-write-wins by name, so in a loop round 2's verdict
      // destroys round 1's. Without the value here, the record cannot answer the
      // one question a bounded loop exists to answer -- is this converging, or is
      // the reviewer saying the same thing three times? -- because the earlier
      // verdicts are gone by the time anyone reads the record.
      history.push({ name, by, round, at: new Date().toISOString(), value });
    },
    // FORGET a name. The store is one flat namespace for a whole chain, which is
    // wrong at a fan-out boundary: the previous element's verdict is still readable
    // when the next element starts, and a loop condition reading it skips the loop
    // entirely. The clear is RECORDED like any other write, so the history still
    // explains why a stage saw no prior value.
    clear(name, by, round = 0) {
      if (!artifacts.has(name)) return false;
      artifacts.delete(name);
      history.push({ name, by, round, at: new Date().toISOString(), cleared: true });
      return true;
    },
    names() {
      return [...artifacts.keys()].sort();
    },
    snapshot() {
      return Object.fromEntries(artifacts);
    },
    history,
  };
}

// Read a dotted path (`verdict.pass`, `chunk.acceptance`) out of the store.
//
// Lives HERE rather than beside its first caller because three things now walk
// artifact paths -- the loop condition, prompt rendering, and the per-chunk gate --
// and two independent walkers with slightly different ideas about a missing
// intermediate is exactly how a config defect turns into a silent empty string.
export function readPath(ctx, dotted) {
  const [name, ...rest] = String(dotted).split(".");
  let v = ctx.has(name) ? ctx.get(name) : undefined;
  for (const k of rest) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[k];
  }
  return v;
}

// The artifact a reference is ROOTED at. `chunk.files` is produced by whatever
// produces `chunk`; reachability is a question about the root, never the field.
export function rootOf(ref) {
  return String(ref).split(".")[0];
}

// Render `{{name}}` against the artifact store.
//
// A MISSING placeholder is a hard error, never an empty string. A prompt that
// silently loses its SPEC section still looks like a well-formed prompt and still
// returns a plausible answer -- the model just invents the missing part. That is
// the single most expensive class of bug in this kind of harness, because nothing
// downstream can tell it happened: the run completes, the record looks normal, and
// the result is measuring something other than what the config says.
export function render(template, ctx) {
  const missing = [];
  const out = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name) => {
    // A dotted reference resolving to undefined is treated exactly like an absent
    // artifact. `{{chunk.acceptance}}` on a chunk that has no `acceptance` is the
    // per-chunk gate silently becoming an empty command -- which passes.
    const v = readPath(ctx, name);
    if (v === undefined) {
      missing.push(name);
      return "";
    }
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  });
  if (missing.length) {
    throw new Error(
      `prompt references artifact(s) no stage produced: ${[...new Set(missing)].join(", ")}. ` +
        `Available: ${ctx.names().join(", ") || "(none)"}`,
    );
  }
  return out;
}

// Which artifacts a template actually asks for. Used to validate a chain config
// BEFORE spending anything: if stage 3's prompt wants `plan` and no earlier stage
// produces it, that is knowable statically and should not cost a model call.
export function placeholders(template) {
  return [...new Set([...template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))];
}

// A one-line summary of an artifact, for the run's own console output.
//
// It used to print the KEYS alone, which for a review verdict read
// `verdict <- pass, problems` -- indistinguishable from a claim that the verdict
// WAS pass. That misread a failing review as a passing one twice in five minutes,
// which is the same read-side defect class as every other bug this project has
// found: a wrong reader returns something plausible instead of failing.
//
// Generic on purpose. It shows the value of anything scalar and the SIZE of
// anything else; it knows nothing about what a key means.
export function summarize(value) {
  if (typeof value === "string") return `${value.length} char(s)`;
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  const parts = Object.entries(value).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}[${v.length}]`;
    if (v !== null && typeof v === "object") return `${k}{…}`;
    if (typeof v === "string") return v.length <= 12 ? `${k}="${v}"` : `${k}=${v.length}ch`;
    return `${k}=${String(v)}`;
  });
  const line = parts.join(", ");
  return line.length <= 72 ? line : line.slice(0, 71) + "…";
}

export function selfTest() {
  const CASES = [];
  const ctx = makeContext({ spec: "S", plan: { a: 1 } });

  // --- summarize -----------------------------------------------------------
  // The bug this covers: a summary that showed only key NAMES made a failing
  // review read exactly like a passing one.
  CASES.push([
    "a boolean field shows its value, not just its name",
    summarize({ pass: false, problems: ["x"] }) === "pass=false, problems[1]",
  ]);
  CASES.push([
    "a passing verdict is distinguishable from a failing one",
    summarize({ pass: true, problems: [] }) !== summarize({ pass: false, problems: [] }),
  ]);
  CASES.push(["a string artifact reports its length", summarize("abcd") === "4 char(s)"]);
  CASES.push(["a short string field is shown inline", summarize({ k: "hi" }) === 'k="hi"']);
  CASES.push([
    "a long string field reports its length instead",
    summarize({ k: "x".repeat(40) }) === "k=40ch",
  ]);
  CASES.push([
    "a nested object is shown as a size, not expanded",
    summarize({ k: { a: 1 } }) === "k{…}",
  ]);
  CASES.push(["a top-level array reports its length", summarize([1, 2, 3]) === "[3]"]);
  CASES.push(["null is printed, not crashed on", summarize(null) === "null"]);
  CASES.push([
    "a long summary is truncated rather than flooding the line",
    summarize(Object.fromEntries([...Array(30)].map((_, i) => [`k${i}`, i]))).length <= 72,
  ]);

  // --- clear ---------------------------------------------------------------
  const c = makeContext({ keep: 1 });
  c.set("verdict", { pass: true }, "review", 1);
  CASES.push(["clear removes the artifact", c.clear("verdict", "foreach") === true]);
  CASES.push(["a cleared artifact is absent", c.has("verdict") === false]);
  CASES.push(["a cleared path reads undefined", readPath(c, "verdict.pass") === undefined]);
  CASES.push(["clearing an absent name is a no-op", c.clear("nope", "foreach") === false]);
  CASES.push(["clear does not touch other artifacts", c.get("keep") === 1]);
  // The clear must be VISIBLE. Otherwise the history shows a verdict written and
  // then a later stage behaving as though it never existed, with nothing in between.
  CASES.push([
    "the clear is recorded in history",
    c.history.some((h) => h.name === "verdict" && h.cleared === true),
  ]);
  CASES.push([
    "the cleared entry does not claim a value",
    c.history.find((h) => h.cleared)?.value === undefined,
  ]);

  CASES.push(["renders a string artifact", render("x {{spec}} y", ctx) === "x S y"]);
  CASES.push(["renders an object as JSON", render("{{plan}}", ctx).includes('"a": 1')]);
  CASES.push(["tolerates inner whitespace", render("{{ spec }}", ctx) === "S"]);

  let threw = null;
  try {
    render("{{spec}} {{nope}}", ctx);
  } catch (e) {
    threw = e.message;
  }
  CASES.push(["a missing artifact THROWS, never renders empty", threw !== null]);
  CASES.push(["the error names the missing artifact", (threw || "").includes("nope")]);
  CASES.push(["the error lists what IS available", (threw || "").includes("spec")]);

  CASES.push([
    "placeholders() finds every reference",
    placeholders("{{a}} {{b}} {{a}}").join(",") === "a,b",
  ]);

  // An artifact set later must be visible to a later stage -- the entire point of
  // the store.
  ctx.set("code", "diff", "code");
  CASES.push(["a produced artifact becomes renderable", render("{{code}}", ctx) === "diff"]);
  CASES.push(["history records the producer", ctx.history.at(-1).by === "code"]);

  // LOOP MEMORY. The store is last-write-wins, so round 2 destroys round 1's value.
  // History must keep both, or "is this converging or thrashing?" is unanswerable
  // from the record -- which is the only reason to bill loop rounds separately.
  ctx.set("verdict", { pass: false, note: "first" }, "review", 1);
  ctx.set("verdict", { pass: false, note: "second" }, "review", 2);
  const verdicts = ctx.history.filter((h) => h.name === "verdict");
  CASES.push(["every round is retained, not just the last", verdicts.length === 2]);
  CASES.push([
    "an overwritten VALUE survives in history",
    verdicts[0].value.note === "first" && verdicts[1].value.note === "second",
  ]);
  CASES.push(["history records which round wrote it", verdicts[1].round === 2]);
  CASES.push([
    "the store itself still reads last-write-wins",
    ctx.get("verdict").note === "second",
  ]);

  // DOTTED PATHS. The per-chunk gate renders `{{chunk.acceptance}}` into a shell
  // command, so a field must render as its RAW value, not as JSON.
  const c2 = makeContext({ chunk: { id: "c1", acceptance: "node --test t.js", files: ["a.js"] } });
  CASES.push([
    "a dotted path renders the field",
    render("{{chunk.acceptance}}", c2) === "node --test t.js",
  ]);
  CASES.push([
    "a string field renders raw, not quoted",
    !render("{{chunk.acceptance}}", c2).includes('"'),
  ]);
  CASES.push([
    "a non-string field still renders as JSON",
    render("{{chunk.files}}", c2).includes("a.js"),
  ]);
  CASES.push(["the whole object still renders", render("{{chunk}}", c2).includes('"id"')]);

  let threw2 = null;
  try {
    render("{{chunk.missing}}", c2);
  } catch (e) {
    threw2 = e.message;
  }
  // The failure this guards: a chunk with no `acceptance` renders the gate as an
  // empty command, and an empty command passes.
  CASES.push(["an absent FIELD throws like an absent artifact", threw2 !== null]);
  CASES.push(["the error names the full path", (threw2 || "").includes("chunk.missing")]);

  CASES.push(["readPath walks a dotted path", readPath(c2, "chunk.id") === "c1"]);
  CASES.push(["readPath on an absent root is undefined", readPath(c2, "nope.x") === undefined]);
  CASES.push([
    "readPath through a non-object is undefined, not a throw",
    readPath(c2, "chunk.id.deeper") === undefined,
  ]);
  CASES.push(["rootOf strips the field", rootOf("chunk.files") === "chunk"]);
  CASES.push(["rootOf leaves a bare name alone", rootOf("plan") === "plan"]);

  return CASES;
}
