// Cost aggregation across model calls.
//
// THE BUG THIS EXISTS TO PREVENT, because it corrupted every number the project
// had produced up to run 5:
//
// The service reports `totalNanoAiu` as a CUMULATIVE session counter. Telemetry
// correctly takes the last checkpoint from each captured stream. But a warm loop
// -- the builder's fix rounds, or a `--warm-judge` reviewer -- issues several
// calls against ONE session, and each call's stream reports the running total
// for the whole session so far. The rollup then SUMMED those snapshots.
//
// Run 5's builder, measured (all four attempts on session 2357e4c5):
//
//     build   4.4551      <- cumulative
//     fix-1   5.5271      <- cumulative
//     fix-2   6.5431      <- cumulative
//     fix-3   6.8430      <- cumulative, and the TRUE session cost
//     ------
//     summed 23.3683      <- what the harness reported
//
// The builder was reported as costing 3.4x what it actually cost, and the run
// total was overstated by 16.5253 AiU.
//
// The local billing ledger DID catch this: it reported `COST DRIFT -16.5253`,
// the exact overcount. That disagreement was explained away as "billing rows
// hadn't landed yet". An independent instrument disagreed with the primary one
// and the primary one was believed. That is the whole failure this project
// exists to study, committed against itself.
//
// So: a counter that is cumulative per session must be REDUCED, never summed.
// Group by sessionId, take the maximum within each session, then add across
// sessions. Max rather than last, because ordering is not guaranteed and a
// cumulative counter cannot legitimately decrease.
//
// Single-call phases are unaffected: one session, one row, max == the value.
// That is why run 5's decompose (127.29) and contract (101.47) were correct
// while the builder's number was not.

// Fields the service reports as cumulative-per-session. Anything NOT listed here
// is treated as per-call and summed.
const CUMULATIVE_FIELDS = new Set(["aiu", "premiumRequests", "totalApiDurationMs"]);

// Reduce one cumulative field across telemetry rows.
//
// Returns { value, unmetered, sessions } where `unmetered` counts rows the CLI
// never reported the field for. Unmetered must stay distinguishable from zero:
// a call whose cost was never reported is not a free call, and folding the two
// together is how a reviewer with no usage checkpoint once appeared to cost
// nothing while returning a perfect score.
export function reduceCumulative(rows, field, opts = {}) {
  // `pick` generalises the reducer beyond `usage.*`. The cumulative-snapshot bug
  // is not specific to cost: the builder's self-reported diffstat has exactly the
  // same shape (each warm attempt reports the whole working tree, not its own
  // delta), and run 5 summed it to +229/-49 for a real staged tree of +61/-11.
  // One reducer, so a second cumulative field cannot be summed by a second
  // hand-rolled loop that nobody re-audits.
  const pick = opts.pick || ((t) => t?.usage?.[field]);
  const bySession = new Map();
  let unmetered = 0;
  let orphans = 0;

  for (const t of rows || []) {
    const v = pick(t);
    if (v == null || Number.isNaN(Number(v))) {
      unmetered++;
      continue;
    }
    // A row with no session id cannot be de-duplicated against any other row.
    // Summing it is the only safe reading -- it may be a distinct call -- but it
    // is counted so an unattributable total can never look authoritative.
    const key = t?.sessionId ?? null;
    if (key == null) {
      orphans++;
      bySession.set(`__orphan_${orphans}`, Number(v));
      continue;
    }
    bySession.set(key, Math.max(bySession.get(key) ?? 0, Number(v)));
  }

  let value = 0;
  for (const v of bySession.values()) value += v;
  return { value, unmetered, orphans, sessions: bySession.size };
}

// Sum a genuinely per-call field (output tokens, tool calls) across rows.
function sumPerCall(rows, pick) {
  return (rows || []).reduce((n, t) => n + (Number(pick(t)) || 0), 0);
}

export function selfTest() {
  // The exact shape measured in run 5: four warm attempts, one session.
  const warm = [
    { sessionId: "s1", usage: { aiu: 4.4551, premiumRequests: 1, totalApiDurationMs: 100 } },
    { sessionId: "s1", usage: { aiu: 5.5271, premiumRequests: 2, totalApiDurationMs: 200 } },
    { sessionId: "s1", usage: { aiu: 6.5431, premiumRequests: 3, totalApiDurationMs: 300 } },
    { sessionId: "s1", usage: { aiu: 6.843, premiumRequests: 4, totalApiDurationMs: 400 } },
  ];

  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const cases = [];

  const r = reduceCumulative(warm, "aiu");
  cases.push([
    "run-5 warm builder: cumulative snapshots reduce to the session total",
    near(r.value, 6.843) && r.sessions === 1 && r.unmetered === 0,
  ]);
  cases.push([
    "the overcount it replaces was exactly the reported ledger drift",
    near(warm.reduce((n, t) => n + t.usage.aiu, 0) - r.value, 16.5253),
  ]);
  cases.push([
    "premium requests are cumulative too",
    reduceCumulative(warm, "premiumRequests").value === 4,
  ]);

  // Cold calls: distinct sessions must still ADD.
  const cold = [
    { sessionId: "a", usage: { aiu: 127.29269 } },
    { sessionId: "b", usage: { aiu: 101.47255 } },
  ];
  cases.push([
    "distinct sessions still add (run 5's decompose + contract were correct)",
    near(reduceCumulative(cold, "aiu").value, 228.76524),
  ]);

  // A single call is the degenerate case and must be untouched.
  cases.push([
    "a single call is unchanged",
    near(reduceCumulative([{ sessionId: "x", usage: { aiu: 12.5 } }], "aiu").value, 12.5),
  ]);

  // Unmetered must never read as free.
  const mixed = [
    { sessionId: "x", usage: { aiu: 5 } },
    { sessionId: "y", usage: { aiu: null } },
  ];
  const m = reduceCumulative(mixed, "aiu");
  cases.push([
    "an unreported cost counts as unmetered, not as zero",
    m.value === 5 && m.unmetered === 1,
  ]);

  // A row with no session id cannot be deduplicated; it must still be counted,
  // and flagged.
  const orphan = [
    { sessionId: null, usage: { aiu: 3 } },
    { sessionId: null, usage: { aiu: 4 } },
  ];
  const o = reduceCumulative(orphan, "aiu");
  cases.push(["session-less rows are summed and flagged", o.value === 7 && o.orphans === 2]);

  // Interleaved sessions -- a warm builder and a warm judge in one list.
  const inter = [
    { sessionId: "b1", usage: { aiu: 1 } },
    { sessionId: "j1", usage: { aiu: 10 } },
    { sessionId: "b1", usage: { aiu: 3 } },
    { sessionId: "j1", usage: { aiu: 12 } },
  ];
  cases.push([
    "interleaved warm sessions reduce independently",
    reduceCumulative(inter, "aiu").value === 15,
  ]);

  // Out-of-order snapshots: max, not last.
  const disorder = [
    { sessionId: "z", usage: { aiu: 9 } },
    { sessionId: "z", usage: { aiu: 2 } },
  ];
  cases.push([
    "a cumulative counter cannot decrease, so take the max",
    reduceCumulative(disorder, "aiu").value === 9,
  ]);

  cases.push(["empty input is zero, not NaN", reduceCumulative([], "aiu").value === 0]);

  // The diffstat has the same cumulative shape as the cost counters and is
  // reduced through this same function via `pick`. Run 5's four warm attempts
  // self-reported a growing view of ONE working tree; summing gave +229 while
  // git said the staged tree was +61.
  cases.push([
    "warm diffstat reduces to the tree, not the sum of its snapshots",
    reduceCumulative(
      [
        { sessionId: "s1", codeChanges: { linesAdded: 18 } },
        { sessionId: "s1", codeChanges: { linesAdded: 37 } },
        { sessionId: "s1", codeChanges: { linesAdded: 52 } },
        { sessionId: "s1", codeChanges: { linesAdded: 61 } },
      ],
      null,
      { pick: (t) => t?.codeChanges?.linesAdded },
    ).value === 61,
  ]);

  let ok = true;
  for (const [id, pass] of cases) {
    if (!pass) ok = false;
    console.log(`  ${pass ? "✓" : "✗"} ${id}`);
  }
  console.log(
    ok ? `  cost aggregation: ${cases.length}/${cases.length}` : "  cost aggregation: FAIL",
  );
  return ok;
}
