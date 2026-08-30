// The iframe document. Polls /state and redraws. Kept as one string so the
// extension stays dependency-free; theme tokens come from the host contract.
//
// THE VIEW HAS NO OPINION ABOUT THE PROCESS. It renders whatever stages the run
// happens to contain, in execution order, and attributes spend to each of them.
// There is no "builder", no "reviewer", no per-dimension score layout -- those
// were inherited from one specific experiment, and they made the dashboard able
// to display exactly one process. In chainkit the process is config, so the view
// must learn the shape from the data every time it paints.
//
// The cost breakdown is per STAGE for the same reason. The old builder-vs-oracle
// bar asserted which stages were supposed to be the cheap ones; a per-stage bar
// shows where the money actually went and lets the reader draw that conclusion.

export function page() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>chainkit runs</title>
<style>
  :root { --ok: var(--true-color-green, #1a7f37); --bad: var(--true-color-red, #cf222e);
          --warn: var(--true-color-yellow, #9a6700); --muted: var(--text-color-muted, #656d76); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 14px 32px;
         background: var(--background-color-default, #fff);
         color: var(--text-color-default, #1f2328);
         font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
         font-size: var(--text-body-medium, 13px); line-height: var(--leading-body-medium, 20px); }
  h1 { font-size: var(--text-title-medium, 16px); font-weight: var(--font-weight-semibold, 600);
       margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
  code, .mono { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
                font-size: var(--text-code-inline, 12px); }
  .sub { color: var(--muted); margin-bottom: 12px; }
  select { font: inherit; max-width: 100%; padding: 3px 6px; border-radius: 6px;
           border: 1px solid var(--border-color-default, #d0d7de);
           background: var(--background-color-default, #fff); color: inherit; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--muted); }
  .dot.live { background: var(--ok); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  .cards { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 6px; }
  .card { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px;
          padding: 7px 11px; min-width: 96px; }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .card .v { font-size: 17px; font-weight: var(--font-weight-semibold, 600); }

  /* Where the money went, per stage. One segment per stage, in execution order. */
  .spend { margin: 4px 0 16px; }
  .split { height: 8px; border-radius: 4px; overflow: hidden; display: flex;
           border: 1px solid var(--border-color-default, #d0d7de); }
  .split i { display: block; height: 100%; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; color: var(--muted); }
  .legend span b { font-weight: 600; color: var(--text-color-default, #1f2328); }
  .swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; }

  /* A stage: its header, then one row per round. */
  .stage { margin-bottom: 14px; }
  /* Element boundary in a fan-out. The rows are element-major, so this is where
     one chunk's work ends and the next begins. */
  .ghead { display: flex; align-items: center; gap: 8px; margin: 18px 0 10px; }
  .ghead:first-child { margin-top: 4px; }
  .gname { font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
           color: var(--muted); white-space: nowrap; }
  .grule { flex: 1; height: 1px; background: var(--border-color-default, #d0d7de); }
  .round { font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 4px;
           background: var(--background-color-muted, #f6f8fa); color: var(--muted);
           border: 1px solid var(--border-color-default, #d0d7de); }
  .shead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 5px; }
  .sord { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
  .sid { font-weight: 600; }
  .call { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px;
          margin-bottom: 6px; overflow: hidden; }
  .chead { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer;
           background: var(--background-color-muted, #f6f8fa); }
  .chead:hover { filter: brightness(0.985); }
  .tag { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px;
         border: 1px solid currentColor; color: var(--muted); }
  .caret { color: var(--muted); font-size: 10px; width: 9px; }
  .grow { flex: 1; }
  .steps { padding: 4px 0; display: none; }
  .call.open .steps { display: block; }
  .step { display: flex; gap: 8px; padding: 2px 10px 2px 14px; align-items: baseline; }
  .step:hover { background: var(--background-color-muted, #f6f8fa); }
  .st { width: 12px; flex: none; text-align: center; }
  .st.ok { color: var(--ok); } .st.failed { color: var(--bad); } .st.running { color: var(--warn); }
  /* min-width, NOT width: this was a fixed 58px column, and every tool name
     longer than that (repo_read, ts_outline, ts_symbol) overflowed its box and
     collided with the detail -- "repo_readgovernance/planning.md". It was
     invisible for as long as those tools rendered no detail at all. */
  .tool { font-weight: 600; min-width: 58px; flex: none; white-space: nowrap; }
  .detail { color: var(--muted); overflow-wrap: anywhere; }
  .chans { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 6px 26px; }
  .chan { font-size: 11px; padding: 1px 7px; border-radius: 999px; cursor: help;
          border: 1px solid var(--line); color: var(--muted); }
  .chan.warn { border-color: #b58900; color: #b58900; }
  .chan.dim { opacity: 0.5; }
  .stage.pending { opacity: 0.45; }
  .stage.pending .sid { font-weight: 500; }
  .say { margin: 6px 10px 8px 14px; padding: 7px 9px; border-radius: 6px; white-space: pre-wrap;
         background: var(--background-color-muted, #f6f8fa);
         border-left: 3px solid var(--true-color-blue-muted, #54aeff); overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 24px 0; }
  .warn { background: #3a2a00; border: 1px solid #7a5a00; color: #ffd479; padding: 8px 10px;
          border-radius: 6px; margin-bottom: 10px; font-size: 12px; line-height: 1.45; }

  /* A stage's structured output, when its final message parsed as JSON. Rendered
     as key/value rows WITHOUT knowing what the keys mean -- any chain's json
     stage gets a readable layout instead of an escaped blob. */
  .out { margin: 8px 10px 10px 14px; }
  .orow { display: grid; grid-template-columns: 150px 1fr; gap: 8px; align-items: baseline; padding: 3px 0; }
  .orow + .orow { border-top: 1px solid var(--border-color-muted, #eaeef2); }
  .okey { color: var(--muted); font-size: 12px; overflow-wrap: anywhere;
          font-family: var(--font-mono, monospace); }
  .oval { font-size: 12px; overflow-wrap: anywhere; }
  .oval pre { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 11px; white-space: pre-wrap;
              overflow-wrap: anywhere; max-height: 260px; overflow: auto;
              background: var(--background-color-muted, #f6f8fa); }
</style>
</head>
<body>
  <h1><span id="dot" class="dot"></span> chainkit<span id="tagname" style="color:var(--muted);font-weight:400"></span></h1>
  <div class="sub"><select id="runs"></select></div>
  <div id="warn"></div>
  <div id="cards" class="cards"></div>
  <div id="spend" class="spend"></div>
  <div id="body"></div>

<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// One call open at a time. A null openKey means "follow the newest call", which is
// what makes a live run watchable without clicking; any manual click pins that call.
let openKey = null;
// null means "whatever this canvas was OPENED with" -- the server knows, the
// client does not until it asks. Hardcoding "latest" here silently overrode the
// run id a canvas was opened with, so three canvases opened on three different
// runs all rendered the SAME run and there was no way to tell from the UI.
// NOTE: no backticks in this file. It is one big template literal.
let pinned = null;

// A fixed palette cycled by stage INDEX. Deliberately not a map from stage name
// to colour: the view must not know any stage names, and a chain with stages
// nobody has seen before still has to render.
const PALETTE = ["#0969da", "#8250df", "#bc4c00", "#1a7f37", "#cf222e", "#0e7490", "#9a6700", "#a21caf"];
const hue = (i) => PALETTE[i % PALETTE.length];

function card(k, v, extra="") { return \`<div class="card"><div class="k">\${k}</div><div class="v">\${v}</div>\${extra}</div>\`; }

function render(s) {
  const run = s.run;
  // Adopt the server's view on first paint so the selector reflects what this
  // canvas is actually showing.
  if (pinned == null && s.viewing) pinned = s.viewing;
  const sel = document.getElementById("runs");
  if (sel.dataset.n !== String(s.runs.length)) {
    sel.dataset.n = String(s.runs.length);
    // Offer each tag as a stable target. Under concurrency "latest" hops between
    // concurrent runs, so following a tag is the only safe live view.
    const tags = [...new Set(s.runs.map(r => (r.id.split("__")[1] || "")).filter(Boolean))];
    sel.innerHTML = '<option value="latest">latest run (follows)</option>' +
      tags.map(t => \`<option value="tag:\${esc(t)}">tag: \${esc(t)} (follows)</option>\`).join("") +
      s.runs.map(r => \`<option value="\${esc(r.id)}">\${esc(r.id)}</option>\`).join("");
    sel.value = pinned;
  }
  document.getElementById("dot").className = "dot" + (run && run.live ? " live" : "");
  // Three panels of the same canvas are otherwise indistinguishable.
  const tagName = pinned && pinned.startsWith("tag:") ? pinned.slice(4) : (run ? (run.id.split("__")[1] || "") : "");
  document.getElementById("tagname").textContent = tagName ? " · " + tagName : "";
  // An instrument that cannot be trusted must say so rather than render a
  // confident blend of two runs.
  document.getElementById("warn").innerHTML = s.ambiguous
    ? \`<div class="warn">⚠ \${esc(s.ambiguous)}</div>\`
    : "";

  if (!run) {
    document.getElementById("cards").innerHTML = "";
    document.getElementById("spend").innerHTML = "";
    document.getElementById("body").innerHTML =
      \`<div class="empty">No runs found under <code>\${esc((s.roots || [s.root]).join(" or "))}</code>.<br>Run <code>node vendor/chainkit/run.mjs --chain .chainkit/chains/&lt;name&gt;.yaml</code> and this will populate live.</div>\`;
    return;
  }

  const t = run.totals;
  document.getElementById("cards").innerHTML =
    card("stages", t.stages) +
    card("calls", t.calls) +
    card("tool calls", t.tools) +
    card("out tokens", t.outputTokens.toLocaleString()) +
    card(t.unmetered ? "AiU (floor)" : "AiU", t.aiu.toFixed(2) + (t.unmetered ? " +?" : ""),
      t.unmetered ? \`<div class="k" style="margin-top:3px;color:#ffd479">\${t.unmetered} call(s) not metered — this is a FLOOR</div>\` : "");

  // Colour BY STAGE, not by row. Rows are per call now, so colouring by row index
  // gives "review · 1" and "review · 2" different colours and makes one stage look
  // like several. The eye should be able to find every code row at a glance.
  const stageIds = [];
  for (const st of run.stages) if (!stageIds.includes(st.id)) stageIds.push(st.id);
  const idHue = (id) => hue(Math.max(0, stageIds.indexOf(id)));

  // Per-stage spend. The generic replacement for the old builder-vs-oracle bar:
  // it reports where the money went without asserting where it should have gone.
  // Aggregated by stage id: with a fan-out over N elements the per-row legend was
  // 12+ entries of the same four names.
  const tot = t.aiu || 0;
  const byStage = stageIds
    .map((id) => ({
      id,
      aiu: run.stages.filter((s) => s.id === id).reduce((n, s) => n + s.aiu, 0),
    }))
    .filter((s) => s.aiu > 0);
  document.getElementById("spend").innerHTML = tot > 0
    ? \`<div class="split">\${byStage.map((s) =>
         \`<i style="width:\${(s.aiu / tot) * 100}%;background:\${idHue(s.id)}" title="\${esc(s.id)}"></i>\`).join("")}</div>
       <div class="legend">\${byStage.map((s) =>
         \`<span><i class="swatch" style="background:\${idHue(s.id)}"></i>\${esc(s.id)} <b>\${s.aiu.toFixed(2)}</b> (\${Math.round((s.aiu / tot) * 100)}%)</span>\`).join("")}</div>\`
    : "";

  // While a run is live and the user hasn't pinned a call, follow the last one --
  // that's the call currently being written, so the view tracks the work.
  const allKeys = run.stages.flatMap(st => st.rounds.map(r => (st.key || st.id) + "/" + r.label));
  const activeKey = openKey && allKeys.includes(openKey) ? openKey : allKeys[allKeys.length - 1];

  // A stage's structured output. The view does not interpret the keys -- it just
  // makes them legible. A nested value is shown as formatted JSON rather than
  // guessed at, because guessing is how a reader acquires an opinion.
  function outputHtml(rows) {
    if (!rows || !rows.length) return "";
    return \`<div class="out">\${rows.map(r =>
      \`<div class="orow"><div class="okey">\${esc(r.key)}</div><div class="oval">\${
        r.scalar ? esc(r.value) : \`<pre>\${esc(r.value)}</pre>\`
      }</div></div>\`).join("")}</div>\`;
  }

  // The handoffs that are NOT model calls. A stage's files and its inherited
  // session are how most work actually moves between stages, and until now the
  // view showed neither -- so a chain could look like a tidy sequence of prompts
  // while the real coupling was invisible.
  function channels(st) {
    const bits = [];
    // A stage that never ran has no channels to report. Its DECLARED resume/expects
    // would otherwise render as if the handoff had happened -- a skipped stage
    // claiming it inherited a conversation is a straight-up false statement.
    if (st.status === "skipped") return "";
    if (st.declared && st.declared.tools === false)
      bits.push('<span class="chan">reasons only</span>');
    if (st.declared?.inLoop) bits.push('<span class="chan">in loop</span>');
    const inherits = st.resume || st.declared?.resume;
    if (inherits)
      bits.push(
        \`<span class="chan warn" title="this stage inherited another stage's whole conversation">↩ resumes \${esc(inherits === true ? "previous round" : inherits)}</span>\`,
      );
    if (st.expects)
      bits.push(
        \`<span class="chan" title="declared key contract">⊨ \${esc(Object.keys(st.expects).join(", "))}</span>\`,
      );
    if (st.filesChanged && st.filesChanged.length)
      bits.push(
        \`<span class="chan" title="\${esc(st.filesChanged.join("\\n"))}">✎ \${st.filesChanged.length} file\${st.filesChanged.length === 1 ? "" : "s"}</span>\`,
      );
    else if (st.filesChanged) bits.push('<span class="chan dim">✎ no files</span>');
    return bits.length ? \`<div class="chans">\${bits.join("")}</div>\` : "";
  }

  // GROUP HEADERS. With a fan-out the rows are element-major -- everything for
  // element 1, then element 2 -- and a flat list of 12 rows hides that structure.
  // A header is emitted whenever the element changes, so the block boundaries are
  // the elements. Emitted only when the run HAS a fan-out; a linear chain gets no
  // decoration it doesn't need.
  const hasElements = run.stages.some((st) => (st.iter || 0) > 0);
  let lastGroup = null;
  function groupHead(st) {
    if (!hasElements) return "";
    // A declared stage that never started belongs to no element -- it was skipped
    // in ALL of them. Filing it under the last element would claim it ran there.
    const unrun = st.status === "pending" || st.status === "skipped";
    const g = unrun ? "unrun" : st.iter || 0;
    if (g === lastGroup) return "";
    lastGroup = g;
    const name = g === "unrun" ? "not run" : g ? "element " + g : "chain";
    return \`<div class="ghead"><span class="gname">\${esc(name)}</span><span class="grule"></span></div>\`;
  }

  document.getElementById("body").innerHTML = run.stages.map((st) => groupHead(st) + \`
    <div class="stage \${st.status === "pending" || st.status === "skipped" ? "pending" : ""}">
      <div class="shead">
        <span class="sord">\${String(st.seq ?? st.ord).padStart(2, "0")}</span>
        <span class="swatch" style="background:\${idHue(st.id)}"></span>
        <span class="sid">\${esc(hasElements ? st.id : st.label || st.id)}</span>
        \${st.round ? \`<span class="round" title="loop round">r\${st.round}</span>\` : ""}
        <span class="detail mono">\${esc(st.model || "")}</span>
        <span class="grow"></span>
        <span class="detail">\${st.status === "pending" || st.status === "skipped"
          ? (st.status === "skipped" ? "skipped \u2014 never needed" : "not started")
          : \`\${st.rounds.length > 1 ? st.rounds.length + " calls · " : ""}\${st.tools} tools · \${st.aiu.toFixed(2)} AiU\${st.unmetered ? " +?" : ""}\`}</span>
      </div>
      \${channels(st)}
      \${st.rounds.map((p) => {
        const key = (st.key || st.id) + "/" + p.label;
        const isOpen = key === activeKey;
        const flight = p.inFlight ? '<span class="dot live" title="call in flight"></span>' : "";
        const out = outputHtml(p.output);
        const steps = p.steps.map(x => x.kind === "say"
          ? \`<div class="say">\${esc(x.text)}</div>\`
          : \`<div class="step"><span class="st \${x.status}">\${x.status === "ok" ? "✓" : x.status === "failed" ? "✗" : x.status === "running" ? "◐" : "·"}</span><span class="tool">\${esc(x.name)}</span><span class="detail mono">\${esc(x.detail)}</span></div>\`
        ).join("") || (out ? "" : '<div class="step"><span class="detail">no tool calls recorded</span></div>');
        return \`<div class="call \${isOpen ? "open" : ""}" data-key="\${esc(key)}">
          <div class="chead">
            <span class="caret">\${isOpen ? "▾" : "▸"}</span>
            \${st.rounds.length > 1
              ? \`<span class="tag" title="\${esc(p.label)}">\${p.round ? "round " + p.round : "call"}</span>\`
              : ""}
            \${flight}
            <span class="detail">\${p.steps.length} step\${p.steps.length === 1 ? "" : "s"}\${out ? " · output" : ""}</span>
            <span class="grow"></span>
            \${st.rounds.length > 1
              ? \`<span class="detail">\${p.toolCount} tools · \${p.aiu == null ? "AiU not reported yet" : p.aiu.toFixed(2) + " AiU"}</span>\`
              : \`<span class="detail">\${p.aiu == null ? "AiU not reported yet" : ""}</span>\`}
          </div>
          <div class="steps">\${out}\${steps}</div>
        </div>\`;
      }).join("")}
    </div>\`).join("");

  for (const el of document.querySelectorAll(".chead")) {
    el.onclick = () => {
      const k = el.parentElement.dataset.key;
      // Clicking the open call collapses it and hands follow-the-newest back.
      openKey = k === activeKey ? null : k;
      render(s);
    };
  }
}

async function tick() {
  try {
    const r = await fetch("/state" + (pinned == null ? "" : "?run=" + encodeURIComponent(pinned)));
    render(await r.json());
  } catch (e) { /* transient: the extension may be reloading */ }
}
document.getElementById("runs").onchange = (e) => { pinned = e.target.value; tick(); };
tick();
setInterval(tick, 1500);
</script>
</body>
</html>`;
}
