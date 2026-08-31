// Reads chainkit's on-disk telemetry into a shape the canvas can render.
//
// Pure read: this NEVER writes into results/, so opening the dashboard can't
// perturb a run it is watching. That matters more than usual here -- this repo
// has repeatedly been burned by instruments that changed what they measured.
//
// THE READER HAS NO OPINION ABOUT THE PROCESS. It knows a run is an ordered list
// of stages, and a stage is one or more rounds. It does not know what a stage
// MEANS -- there is no "build", no "review", no "fix", no builder-vs-reviewer
// split. That is the whole point of chainkit: the process is config, so a reader
// that hardcodes a vocabulary of stage kinds can only display the one process it
// was written for, and every new stage is invisible or misfiled by default.
//
// This was learned the expensive way. The previous reader classified phases into
// a closed set of labels and split spend into "builder" vs "oracle" -- both
// inherited from one specific experiment. A phase nobody remembered to name fell
// through and was silently dropped from the view, and later silently misfiled on
// the wrong side of the cost split. Twice. The fix is not a longer allow-list; it
// is having no list at all.
//
// Layout written by run.mjs:
//   results/chain-runs/logs/<runId>/<nn>-<stageId>/<stageId>.jsonl        (round 0)
//                                                 /<stageId>.r1.jsonl ... (loop rounds)
//   results/chain-runs/<runId>.json               (final record, end of run only)
//
// The `<nn>-` prefix is the stage's execution index, so plain directory sort is
// execution order -- the reader never has to re-derive the pipeline from config.
//
// LIVENESS -- measured, not assumed. An earlier version of this comment claimed the
// .jsonl files are "appended live as each agent works". That was wrong, and it was
// wrong in the way this project keeps getting burned by: plausible, convenient, and
// never checked. Watching a phase file from the instant of creation at 1s
// resolution (run 2026-08-14T18-03-54, c2/build.jsonl) shows it appear with all 220
// lines already present and never grow. The CLI writes the whole stream when its
// process EXITS.
//
// So the real granularity is PER CALL, not per line: a new round pops into the
// dashboard complete, every 30-120s or so, and you watch the run advance stage by
// stage. You cannot watch a single agent think. The sibling process-*.log files do
// grow during a call, but they carry the CLI's own INFO logging, not tool events,
// so they buy nothing here.
//
// The record .json only exists once the run finishes -- so everything here is
// derived from the per-call streams, and the record is optional enrichment,
// never a precondition.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// Tools whose arguments carry the interesting bit in different fields.
//
// The `default` branch matters more than the named cases. A tool this function
// has never heard of is the normal state of affairs — extensions get added — and
// the old default returned "" for anything without a top-level path/command/
// pattern. The visible result was a run's most informative calls rendered as the
// least: twenty consecutive unlabelled `repo_read` rows, each of which had in
// fact named eight files. An unknown tool must degrade to a worse label, never to
// no label.
function shortPath(p) {
  const s = String(p);
  // The CLI spills a large tool result to a temp file and the model then `view`s
  // it back. Rendered as a path this is actively misleading -- it reads as the
  // model opening a repo file, when it is re-reading something it already had.
  if (/copilot-tool-output/.test(s)) return "(its own tool output)";
  return s.split("/").slice(-2).join("/");
}

// "a.ts, b.ts +3" — enough to tell two batches apart without wrapping the row.
function summarizeList(items, render, max = 3) {
  const shown = items.slice(0, max).map(render).filter(Boolean);
  if (!shown.length) return "";
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` +${rest}` : "");
}

// Last resort: say something true about args we have no rule for, rather than
// nothing. Prefers a short scalar; falls back to naming the keys, which at least
// distinguishes two calls to the same unknown tool.
function describeUnknown(args) {
  const entries = Object.entries(args).filter(([, v]) => v != null && v !== "");
  if (!entries.length) return "";
  const scalar = entries.find(
    ([, v]) => (typeof v === "string" && v.length <= 120) || typeof v === "number",
  );
  if (scalar) return String(scalar[1]);
  const arr = entries.find(([, v]) => Array.isArray(v) && v.length);
  if (arr) {
    const summary = summarizeList(arr[1], (el) =>
      typeof el === "string"
        ? shortPath(el)
        : el && typeof el === "object" && el.path
          ? shortPath(el.path)
          : "",
    );
    if (summary) return summary;
    return `${arr[0]}[${arr[1].length}]`;
  }
  return entries
    .map(([k]) => k)
    .join(", ")
    .slice(0, 120);
}

export function describeTool(name, args) {
  if (!args || typeof args !== "object") return "";
  const p = args.path || args.file || args.filePath;
  const rel = p ? shortPath(p) : "";
  switch (name) {
    case "view":
      return rel + (Array.isArray(args.view_range) ? `:${args.view_range.join("-")}` : "");
    case "edit":
    case "create":
      return rel;
    case "bash":
      return String(args.command || "").slice(0, 160);
    case "grep":
      return `/${args.pattern || ""}/ ${args.glob || args.type || ""}`.trim();
    case "glob":
      return String(args.pattern || "");
    // A batch reader: one call is many files, so the count is as interesting as
    // the names. Without it every call to it looks identical. Names are deduped
    // because a batch legitimately lists one file several times (same path,
    // different `find` terms), and "architecture.md, architecture.md,
    // architecture.md" spends the whole row saying one thing. The count is left
    // as the true target count, so the two disagreeing is meaningful.
    case "repo_read": {
      const targets = Array.isArray(args.targets) ? args.targets : [];
      const seen = [];
      for (const t of targets) {
        const n = typeof t === "string" ? shortPath(t) : t && t.path ? shortPath(t.path) : "";
        if (n && !seen.includes(n)) seen.push(n);
      }
      const names = summarizeList(seen, (n) => n);
      return targets.length > 3 ? `${names} · ${targets.length} targets` : names;
    }
    case "ts_symbol":
      return String(args.symbol || "");
    default:
      return (
        rel || String(args.command || args.pattern || "").slice(0, 120) || describeUnknown(args)
      );
  }
}

function parseJsonl(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A partially-flushed final line is EXPECTED while tailing a live run:
      // we may read mid-write. Skipping it is correct; it lands on the next poll.
    }
  }
  return out;
}

// The CLI dispatches tool calls in parallel, and that is invisible in a flat list
// of steps -- 38 calls read as 38 sequential ones. It is fully recoverable though:
// every start and every complete carries a timestamp, so two calls whose intervals
// intersect provably ran at the same time. This annotates each tool step with the
// overlapping GROUP it belongs to, and returns the peak concurrency.
//
// WHY A STILL-RUNNING CALL ENDS AT THE LAST EVENT, not at "now". A call with no
// complete event has an unknown end, and inventing one is how this panel has been
// wrong before. What the stream actually proves is that the call was still open as
// of the last event on disk, so that is the end used -- evidence, not a guess. It
// also keeps the number stable: re-reading the same file twice cannot change it.
//
// Grouping is transitive (A overlaps B, B overlaps C => one group), which is the
// honest reading of "these ran concurrently" without asserting the model dispatched
// them as one batch. Peak is a separate sweep, because a group of 8 does not mean 8
// were ever open at once.
export function annotateConcurrency(steps, lastAt = null) {
  const tools = steps.filter((s) => s.kind === "tool" && s.at);
  const end = (s) => Date.parse(s.endAt || lastAt || s.at);
  const iv = tools
    .map((s) => ({ s, a: Date.parse(s.at), b: end(s) }))
    .filter((v) => Number.isFinite(v.a) && Number.isFinite(v.b))
    .sort((x, y) => x.a - y.a);

  let group = null;
  let gid = 0;
  const groups = [];
  for (const v of iv) {
    if (group && v.a < group.end) {
      group.items.push(v);
      group.end = Math.max(group.end, v.b);
    } else {
      group = { id: gid++, items: [v], end: v.b };
      groups.push(group);
    }
  }
  for (const g of groups)
    for (const [i, v] of g.items.entries()) {
      v.s.par = g.items.length;
      v.s.parGroup = g.id;
      v.s.parFirst = i === 0;
    }

  const ev = iv.flatMap((v) => [
    [v.a, 1],
    [v.b, -1],
  ]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  // Starts at 1 whenever there is anything at all. The sweep closes before it opens
  // at an equal timestamp -- deliberate, so two calls that merely touch end-to-start
  // are not called parallel -- but that makes a ZERO-LENGTH interval (an unfinished
  // call with no later event to bound it) sweep to 0, i.e. "no call ever ran". One
  // call ran. Caught by a self-test, not by looking at it.
  let peak = iv.length ? 1 : 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

// version this project paid dearly to get right; the only edit is that a call no
// longer carries a `kind`, because there are no kinds.
function readCall(file, label) {
  const events = parseJsonl(file);
  const steps = [];
  let outputTokens = 0;
  // The provider says outright when it CUT a response off. Without this the
  // canvas renders the surviving fragment as though it were the answer -- the
  // motivating case began mid-word and carried a closing fence with no opening
  // one, and nothing on screen suggested anything was wrong.
  let truncated = 0;
  let outputCeiling = null;
  // Every model call's text, in order. A turn cut off at the output ceiling
  // emits no `assistant.message`, so showing only those shows only the final
  // fragment of a long answer -- which is why this panel opened a reply
  // mid-word, at "undred ms", with no sign that anything preceded it.
  const callTexts = [];
  // null, NOT 0. A call that has not yet emitted a usage checkpoint -- every
  // live call, and any model whose stream does not meter -- would otherwise
  // report a confident `0`, which reads as "this was free" rather than "not
  // measured yet". Same trap already fixed in the grader: 0 sums into a total
  // that looks complete, null cannot.
  let nanoAiu = null;
  let model = "";
  let text = "";
  let done = false;
  const pending = new Map();

  for (const ev of events) {
    const d = ev.data || {};
    switch (ev.type) {
      case "tool.execution_start":
        pending.set(d.toolCallId, steps.length);
        steps.push({
          kind: "tool",
          name: d.toolName,
          detail: describeTool(d.toolName, d.arguments),
          at: ev.timestamp,
          endAt: null,
          status: "running",
        });
        if (d.model) model = d.model;
        break;
      case "tool.execution_complete": {
        const i = pending.get(d.toolCallId);
        if (i != null && steps[i]) {
          steps[i].status = d.success === false ? "failed" : "ok";
          steps[i].endAt = ev.timestamp;
          pending.delete(d.toolCallId);
        }
        break;
      }
      case "model.model_call_success":
        for (const c of d.responseChunk?.choices || [])
          if (c?.finish_reason === "length") truncated++;
        if (typeof d.maxOutputTokens === "number") outputCeiling = d.maxOutputTokens;
        {
          const partial = d.responseChunk?.choices?.[0]?.delta?.content;
          if (partial)
            callTexts.push({
              text: String(partial),
              cut: d.responseChunk?.choices?.[0]?.finish_reason === "length",
            });
        }
        break;
      case "assistant.message":
        if (d.model) model = d.model;
        if (typeof d.outputTokens === "number") outputTokens += d.outputTokens;
        if (d.content && String(d.content).trim()) {
          text = String(d.content);
          steps.push({ kind: "say", at: ev.timestamp, text: text.slice(0, 4000) });
        }
        break;
      case "session.usage_checkpoint":
        if (typeof d.totalNanoAiu === "number") nanoAiu = Math.max(nanoAiu ?? 0, d.totalNanoAiu);
        break;
      case "result":
        done = true;
        break;
      default:
        break;
    }
  }

  // When calls were cut off, the last assistant message is only the tail of the
  // answer -- so show the whole sequence instead, with each cut marked. Joining
  // silently would be worse than the fragment: a cut-off call is sometimes an
  // attempt the model ABANDONED and restarted, so a seam is not always a
  // continuation and the panel must not claim it is. Marking, not merging.
  if (truncated > 0 && callTexts.length > 1) {
    const CAP = 6000;
    const body = callTexts
      .map((c) => {
        const t =
          c.text.length > CAP
            ? c.text.slice(0, CAP) + `\n… ${c.text.length - CAP} more characters`
            : c.text;
        return c.cut ? `${t}\n──── cut off here at the output ceiling ────` : t;
      })
      .join("\n");
    for (let i = steps.length - 1; i >= 0; i--)
      if (steps[i].kind === "say") {
        steps[i].text = body;
        break;
      }
    text = body;
  }

  // Anything still "running" when the stream ended is really unknown, not running.
  // Reporting a stale spinner forever is exactly the kind of plausible-but-wrong
  // readout this project keeps getting bitten by, so mark it explicitly.
  if (done) for (const s of steps) if (s.status === "running") s.status = "unknown";

  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    /* file vanished between readdir and stat */
  }

  const peakParallel = annotateConcurrency(steps, events.at(-1)?.timestamp || null);

  return {
    label,
    model,
    steps,
    peakParallel,
    outputTokens,
    truncated,
    outputCeiling,
    callTexts,
    aiu: nanoAiu == null ? null : nanoAiu / 1e9,
    metered: nanoAiu != null,
    done,
    mtime,
    toolCount: steps.filter((s) => s.kind === "tool").length,
    finalText: text,
  };
}

// Every .jsonl in a stage dir is one call. There is deliberately no allow-list of
// recognised names: a file that is there gets shown, whatever it is called. The
// only structure read out of the name is the loop round (`<stage>.r2.jsonl`), and
// that is a chainkit-wide convention rather than a fact about any one process.
function callFiles(stageDir) {
  const out = [];
  let names;
  try {
    names = readdirSync(stageDir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith(".jsonl") || n.endsWith(".argv.jsonl")) continue;
    // A call in flight has only `<label>.live.jsonl`; a settled one has only
    // `<label>.jsonl` (the harness removes the live file once it writes the final
    // one). Normalise to the label so a call never appears twice, and remember
    // which form we found so the UI can mark the in-flight one.
    const live = n.endsWith(".live.jsonl");
    const stem = n.replace(/\.live\.jsonl$/, ".jsonl");
    if (live && names.includes(stem)) continue; // settled copy wins
    const label = stem.replace(/\.jsonl$/, "");
    out.push({ file: n, label, round: Number(label.match(/\.r(\d+)$/)?.[1] || 0), live });
  }
  return out.sort((a, b) => a.round - b.round || a.label.localeCompare(b.label));
}

// Runs from EVERY root, newest first. There is more than one results dir now --
// the project's `.chainkit/results` and the vendored engine's own -- and which one
// a run landed in is an artifact of which chain file produced it, not something a
// reader should have to know. So the canvas takes the union and each run carries
// the root it came from.
export function listRuns(root) {
  const roots = Array.isArray(root) ? root : [root];
  if (roots.length > 1) {
    return roots.flatMap((r) => listRuns(r)).sort((a, b) => b.mtime - a.mtime);
  }
  const only = roots[0];
  const logsDir = path.join(only, "results", "chain-runs", "logs");
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((n) => {
      try {
        return statSync(path.join(logsDir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((n) => ({
      id: n,
      dir: path.join(logsDir, n),
      root: only,
      mtime: statSync(path.join(logsDir, n)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

// A stage's final message, structured IF it happens to be JSON -- and nothing
// beyond that. The reader does not know what any field means: no `overall`, no
// `criteria`, no `pass`. Any stage declaring `parse: json` gets its output shown
// as readable key/value rows instead of an escaped wall of text, and a stage
// producing prose is left alone.
//
// Parsed in two descending tiers, because a model that wraps its JSON in prose
// still produced usable structure:
//   1. the whole message is JSON (the normal case)
//   2. JSON embedded in prose or a fence -- take the widest brace span
// Neither -> null, and the message renders as ordinary text. There is deliberately
// no third regex tier: the old one existed to rescue one specific reviewer's
// score field, which is exactly the process-specific knowledge this must not have.
function structuredOutput(finalText) {
  if (!finalText) return null;
  const raw = finalText.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        parsed = JSON.parse(raw.slice(a, b + 1));
      } catch {
        /* not JSON; prose is a perfectly good stage output */
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Flattened to rows the view can render without knowing the schema. Scalars
  // print inline; a nested value is passed through INTACT so the view can lay it
  // out as structure. It used to be re-serialised here and truncated at 4000
  // chars, which made every non-scalar a wall of quoted JSON and silently cut the
  // long string values -- a plan's blueprints -- that are the reason to look.
  return Object.entries(parsed).map(([k, v]) => ({
    key: k,
    value: v === null || typeof v !== "object" ? String(v) : v,
    scalar: v === null || typeof v !== "object",
  }));
}

// The structured output also arrives as an assistant "say" step, so rendering
// both would show the same content twice -- once as readable rows, once as the
// wall of text this exists to remove. Drop only the step that IS the output; any
// other prose the stage emitted is real commentary and must survive.
function dropEchoedSay(steps, finalText) {
  if (!finalText) return steps;
  const key = finalText.trim().slice(0, 120);
  return steps.filter((st) => !(st.kind === "say" && st.text.trim().slice(0, 120) === key));
}

// A stage log directory carries three facts in its name: `03-code__i2` is the
// third declared stage, `code`, running for the second fan-out element.
//
// Splitting them matters more than it looks. Treating the whole tail as the stage
// id meant `code__i1` never matched the declared `code`, so (a) the declared-config
// lookup silently missed for every fan-out stage, and (b) the "declared but not
// started" pass re-added `code` as a phantom PENDING row on a run where all four of
// its iterations had finished — a completed run showing stages as pending, which is
// exactly the visual signal for a stuck run.
function parseStageDir(dirName) {
  const m = dirName.match(/^(\d+)-(.+)$/);
  const raw = m ? m[2] : dirName;
  const im = raw.match(/^(.*)__i(\d+)$/);
  return {
    ord: m ? Number(m[1]) : 0,
    id: im ? im[1] : raw,
    iter: im ? Number(im[2]) : 0,
    // Unique per row. The view keys expand-state by it, so sharing the base id
    // across four iterations would make expanding chunk 1 expand all of them.
    key: raw,
  };
}

// True EXECUTION order.
//
// The driver writes `_calls.jsonl` as it goes, one line per call, so the order is
// READ rather than inferred. `order` maps "id/iter/round" to that sequence number.
//
// The fallback matters for runs recorded before the journal existed: element, then
// round, then declared index. It is right for every chain shape seen so far and
// WRONG for a non-loop stage placed AFTER a loop -- its round is 0, so it sorts
// ahead of every loop round and appears to have run first. That is exactly why the
// journal exists; inferring the order is a last resort, not the design.
function runOrder(rows, order = null) {
  const fallback = (r) => [r.sortIter ?? r.iter ?? 0, r.round ?? 0, r.ord ?? 0];
  const keyed = (r) => (order ? order.get(`${r.id}/${r.iter || 0}/${r.round || 0}`) : undefined);
  return [...rows]
    .sort((a, b) => {
      const ka = keyed(a);
      const kb = keyed(b);
      // A row with no journal entry has not run; it sorts by the fallback, after
      // everything the journal placed.
      if (ka !== undefined && kb !== undefined) return ka - kb;
      if (ka !== undefined) return -1;
      if (kb !== undefined) return 1;
      const fa = fallback(a);
      const fb = fallback(b);
      return fa[0] - fb[0] || fa[1] - fb[1] || fa[2] - fb[2];
    })
    .map((s, i) => ({ ...s, seq: i + 1 }));
}

// The call journal, as a lookup. Absent for older runs and for the first instant
// of a new one, in which case the caller falls back.
function readCallOrder(runDir) {
  let text;
  try {
    text = readFileSync(path.join(runDir, "_calls.jsonl"), "utf8");
  } catch {
    return null;
  }
  const order = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      order.set(`${e.id}/${e.iter || 0}/${e.round || 0}`, e.seq);
    } catch {
      /* a half-written final line; the rest still orders */
    }
  }
  return order.size ? order : null;
}

export function readRun(runDir, root) {
  const stages = [];
  let names;
  try {
    names = readdirSync(runDir).filter((n) => {
      try {
        return statSync(path.join(runDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return { id: path.basename(runDir), stages: [], totals: {}, live: false };
  }

  // THE DECLARED PIPELINE. The driver writes this before it runs anything, so the
  // whole chain is visible from the first second instead of appearing one stage at
  // a time as each starts writing. Optional on purpose: a run recorded before this
  // existed still reads, it just shows only what it observed.
  let plan = null;
  try {
    plan = JSON.parse(readFileSync(path.join(runDir, "_chain.json"), "utf8"));
  } catch {
    /* absent, or being written */
  }
  const planned = new Map((plan?.stages || []).map((s) => [s.id, s]));

  // Directory names carry the execution index (`03-review`), so a plain sort is
  // the true order of the run.
  for (const dirName of names.sort()) {
    const dir = path.join(runDir, dirName);
    const { id, ord, iter, key } = parseStageDir(dirName);
    const calls = callFiles(dir).map((c) => {
      const call = readCall(path.join(dir, c.file), c.label);
      const out = structuredOutput(call.finalText);
      if (out) {
        call.output = out;
        call.steps = dropEchoedSay(call.steps, call.finalText);
      }
      call.round = c.round;
      // Reading a .live.jsonl means this call's process has not exited yet, which
      // is a REAL in-flight signal rather than an mtime guess.
      call.inFlight = !!c.live;
      return call;
    });

    // ONE ROW PER ROUND, not one row per stage.
    //
    // A stage row holding all its rounds hid the interleaving that IS a fix loop.
    // The run went code -> review r1 -> fix -> review r2, and the view drew
    // `review (r1, r2)` then `fix` -- the two review rounds adjacent, with the fix
    // that caused the second one sitting after both. The shape of the loop was the
    // one thing that view could not show.
    const byRound = new Map();
    for (const c of calls) {
      const r = c.round || 0;
      if (!byRound.has(r)) byRound.set(r, []);
      byRound.get(r).push(c);
    }
    for (const [round, rounds] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
      stages.push({
        id,
        ord,
        iter,
        round,
        // Unique per ROW now that a stage can appear more than once. The view keys
        // its expand state by this.
        key: round ? `${key}#r${round}` : key,
        // What the row is CALLED on screen. The element is part of the identity of a
        // fan-out row: four rows all reading "code" is not a view of four chunks.
        label: iter ? `${id} · ${iter}` : id,
        rounds,
        // Per-stage spend. This is the generic replacement for the old
        // builder-vs-oracle split: the view shows where the money actually went,
        // stage by stage, without asserting which stages are supposed to be
        // expensive. Which one is "the cheap one" is a question about the config
        // being tested, not a fact the reader should encode.
        aiu: rounds.reduce((n, r2) => n + (r2.aiu ?? 0), 0),
        outputTokens: rounds.reduce((n, r2) => n + r2.outputTokens, 0),
        truncated: rounds.reduce((n, r2) => n + (r2.truncated || 0), 0),
        outputCeiling: rounds.find((r2) => r2.outputCeiling)?.outputCeiling ?? null,
        tools: rounds.reduce((n, r2) => n + r2.toolCount, 0),
        unmetered: rounds.filter((r2) => !r2.metered).length,
        // NOTHING REPORTED IS NOT ZERO. The CLI emits usage only when a call
        // finishes, so an in-flight stage has no cost figure yet. Summing that to 0
        // and showing "0.00 AiU" states a measurement nobody made -- it read as a
        // stage doing 41 tool calls for free, when the real answer, minutes later,
        // was 58.83 AiU. Every call unmetered and nothing totalled means the number
        // is absent, which is a different claim from free.
        aiuKnown: !(rounds.every((r2) => !r2.metered) && !rounds.some((r2) => r2.aiu)),
        // Prefer the model the run DECLARED. A stage that has not produced an
        // assistant message yet has no observed model, and blank is the wrong answer
        // to "which model is this" -- the config already said.
        model: rounds.find((r2) => r2.model)?.model || planned.get(id)?.model || "",
        inFlight: rounds.some((r2) => r2.inFlight),
        status: rounds.some((r2) => r2.inFlight) ? "running" : "ran",
      });
    }
  }

  // Stages the chain declared that have not started. Without these the view cannot
  // distinguish "three stages in" from "halted after three stages" while a run is
  // live -- both look like a chain with three stages.
  //
  // Matched on the BASE id, so a fan-out stage that ran four iterations is not
  // re-added as a fifth, pending, row that never resolves.
  const seen = new Set(stages.map((s) => s.id));
  const maxIter = stages.reduce((n, s) => Math.max(n, s.iter || 0), 0);
  for (const p of plan?.stages || []) {
    if (seen.has(p.id)) continue;
    stages.push({
      id: p.id,
      ord: p.ord ?? 0,
      iter: 0,
      // A fan-out stage that never ran belongs WITH the fan-out, not ahead of it.
      // Sorting it by its declared index alone floats `fix` (stage 5, iteration 0)
      // above `code · 1`, so the one stage that never ran appears first -- which
      // reads as the run being stuck at the top of the chain.
      sortIter: p.inForeach ? maxIter : 0,
      key: p.id,
      label: p.id,
      rounds: [],
      aiu: 0,
      outputTokens: 0,
      truncated: 0,
      outputCeiling: null,
      tools: 0,
      unmetered: 0,
      model: p.model || "",
      inFlight: false,
      status: "pending",
    });
  }
  // Record JSON exists only after the run ends -- optional enrichment. Read BEFORE
  // ordering: its `stageLog` is written in execution order, so a run recorded
  // before the call journal existed still orders exactly rather than by inference.
  let summary = null;
  const base = path.basename(runDir);
  const summaryFile = path.join(root, "results", "chain-runs", `${base}.json`);
  if (existsSync(summaryFile)) {
    try {
      summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    } catch {
      /* mid-write */
    }
  }

  // Order, best source first: the live call journal, then the finished record,
  // then inference.
  let order = readCallOrder(runDir);
  if (!order && Array.isArray(summary?.stageLog)) {
    order = new Map();
    summary.stageLog.forEach((e, i) => {
      order.set(`${e.id}/${e.iter || 0}/${e.round || 0}`, i + 1);
    });
  }
  const ordered = runOrder(stages, order);
  stages.length = 0;
  stages.push(...ordered);

  // Declared config, for every stage -- including ones that already ran. This is
  // what the stage was CONFIGURED to do, as opposed to what it did.
  for (const st of stages) {
    const p = planned.get(st.id);
    if (!p) continue;
    st.declared = {
      tools: p.tools,
      resume: p.resume,
      produces: p.produces,
      parse: p.parse,
      inLoop: p.inLoop,
    };
    if (p.expects) st.expects = p.expects;
  }

  // Record JSON exists only after the run ends -- optional enrichment.
  const all = stages.flatMap((s) => s.rounds);

  // A finished run has no pending stages -- but "did not start" and "produced no
  // model call" are DIFFERENT things, and conflating them made the panel confidently
  // wrong. A `$ command` stage (preflight, plan-check, plan-recheck) never writes a
  // model-call log, so it stayed "pending" forever and then got relabelled
  // "skipped -- never needed" on a run where it had demonstrably run and returned a
  // verdict the whole chain branched on.
  //
  // The run record settles it: stageLog holds exactly the stages that executed. One
  // that is in there RAN, whatever it left in the log directory. One that is not
  // did not -- and WHY it did not is the second distinction. On a halted run the
  // remaining stages were never reached, which is not the same claim as "never
  // needed"; the latter says the chain decided against them, and on build5 it was
  // said about every stage that would have written the actual code.
  if (summary) {
    const ran = new Set((summary.stageLog || []).map((s) => s.id));
    const wall = new Map();
    for (const s of summary.stageLog || []) wall.set(s.id, (wall.get(s.id) || 0) + (s.wallMs || 0));
    for (const st of stages) {
      if (st.status !== "pending") continue;
      if (ran.has(st.id)) {
        st.status = "ran";
        st.noModelCalls = true;
        st.wallMs = wall.get(st.id) || 0;
      } else {
        st.status = summary.halted ? "unreached" : "skipped";
      }
    }
  } else if (order) {
    // WHILE THE RUN IS STILL GOING there is no record to consult, and the fix above
    // does nothing -- which left a live run showing "not started" beside stages the
    // journal proves had already run and returned a verdict the chain branched on.
    //
    // The journal is the right source and it is written at the instant of the call,
    // before the stage does anything, so it is available exactly when the record is
    // not. A stage in it has started; a stage with a LATER call after it has
    // finished, because the driver is sequential and only starts the next stage once
    // the previous one returns. The newest entry with no model calls is the one
    // running right now.
    //
    // Stages absent from the journal are genuinely not started, and saying so is the
    // point of drawing them: the panel shows the declared pipeline so the shape of
    // the run is visible before it happens, not a list that grows from nothing.
    let maxSeq = 0;
    for (const seq of order.values()) if (seq > maxSeq) maxSeq = seq;
    // Match on id and element, NOT on round. A pending row comes from the declared
    // pipeline, so its round is 0, while a stage that ran inside a loop is journalled
    // under the round it ran in -- so an exact key lookup misses precisely the
    // stages a loop exists to re-run. Observed immediately: `plan-recheck` ran as
    // round 1, returned ok, released the fan-out, and still showed "not started"
    // while the build was underway.
    const bestSeq = new Map();
    for (const [key, seq] of order) {
      const [id, it] = key.split("/");
      const k = `${id}/${it}`;
      if (seq > (bestSeq.get(k) || 0)) bestSeq.set(k, seq);
    }
    for (const st of stages) {
      if (st.status !== "pending") continue;
      const seq = bestSeq.get(`${st.id}/${st.iter || 0}`);
      if (!seq) continue;
      st.noModelCalls = true;
      st.status = seq < maxSeq ? "ran" : "running";
    }
  }

  // The log directory only ever knew about MODEL CALLS. The two other handoffs
  // between stages -- the shared working tree, and a resumed CLI session -- leave
  // no trace in it at all, so a reader watching the calls scroll by cannot see the
  // channel most of the work actually travelled through. Fold them in from the run
  // record when it exists. Still no stage names, still generic.
  if (summary && Array.isArray(summary.stageLog)) {
    for (const st of stages) {
      // Match on iteration AND round. A fan-out stage shares its id across every
      // element, so matching on id alone unions all four chunks' files onto all
      // four rows -- every chunk then appears to have touched every file, which is
      // precisely the signal per-chunk file ownership exists to expose. Rows are
      // per-round now, so round is part of the identity too: without it a fix
      // loop's round 1 and round 2 would each claim both rounds' files.
      const entries = summary.stageLog.filter(
        (e) =>
          e.id === st.id && (e.iter || 0) === (st.iter || 0) && (e.round || 0) === (st.round || 0),
      );
      if (!entries.length) continue;
      const files = new Set();
      for (const e of entries) for (const f of e.filesChanged || []) files.add(f);
      st.filesChanged = [...files].sort();
      // A stage inheriting another's conversation is a large unnamed handoff. Name it.
      st.resume = entries.find((e) => e.resume)?.resume || null;
      st.sessionIds = [...new Set(entries.map((e) => e.sessionId).filter(Boolean))];
      st.expects = entries.find((e) => e.expects)?.expects || null;
      // A stage that was handed tools and used none verified nothing, and its output
      // is otherwise indistinguishable from a checked one. The run record carries the
      // fact; without this the canvas would show a normal green stage.
      st.declaredToolsUnused = entries.some((e) => e.declaredToolsUnused) || false;
    }
  }
  // Round-over-round artifact values, so a loop can be read as converging or
  // thrashing rather than just as N billable rounds.
  const artifactHistory = Array.isArray(summary?.artifactHistory) ? summary.artifactHistory : [];

  // The manifest counts as activity: a run that has declared its pipeline but not
  // yet produced a first assistant message is starting, not stale.
  let planMtime = 0;
  try {
    planMtime = statSync(path.join(runDir, "_chain.json")).mtimeMs;
  } catch {
    /* pre-manifest run */
  }
  const newest = Math.max(0, planMtime, ...all.map((c) => c.mtime));
  const totals = {
    // Safe to sum here: totalNanoAiu is session-cumulative, but each call is its
    // own CLI session, and readCall already collapsed a call to its max (see the
    // session.usage_checkpoint case above). Summing the per-call maxima is the
    // run total. Summing the raw checkpoints instead would multiply the cost by
    // the number of checkpoints -- which is how this harness previously reported
    // a 9x-inflated number.
    aiu: all.reduce((n, c) => n + (c.aiu ?? 0), 0),
    // How much of the total is missing. A cost figure with unmetered calls in
    // it is a FLOOR, not the bill, and the view must be able to say so.
    unmetered: all.filter((c) => !c.metered).length,
    outputTokens: all.reduce((n, c) => n + c.outputTokens, 0),
    tools: all.reduce((n, c) => n + c.toolCount, 0),
    calls: all.length,
    // DISTINCT stages, not rows. A row is one call now, so a fan-out over four
    // elements with a fix loop has 13 rows and still only five stages -- reporting
    // 13 would double-count the pipeline as if the chain were far longer than the
    // config says.
    stages: new Set(stages.map((s) => s.id)).size,
  };

  return {
    id: base,
    stages,
    totals,
    summary,
    artifactHistory,
    plan,
    // Prefer the REAL signal: a .live.jsonl exists only while its call's process
    // is running, so an in-flight call is proof the run is alive. The mtime
    // window is the fallback for the gaps between calls (gate, install, diff),
    // where no model process is writing anything.
    live: !summary && (all.some((c) => c.inFlight) || Date.now() - newest < 90_000),
    updatedAt: newest,
  };
}
