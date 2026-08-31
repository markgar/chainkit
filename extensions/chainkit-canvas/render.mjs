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
  /* Why the run stopped, stated once at the top rather than left in the JSON. */
  .halt { margin: 8px 10px; padding: 8px 10px; border-left: 3px solid var(--bad, #cf222e);
          background: var(--background-color-muted, #f6f8fa); border-radius: 4px; }
  .haltkind { font-weight: 600; color: var(--bad, #cf222e); text-transform: uppercase;
              letter-spacing: .04em; font-size: 11px; }
  .haltwhere { font-size: 11px; opacity: .75; margin-left: 6px; }
  .haltwhy { margin-top: 4px; font-size: 12px; line-height: 1.45; }
  .warnbox { margin: 8px 10px; padding: 8px 10px; border-left: 3px solid var(--warn, #bf8700);
             background: var(--background-color-muted, #f6f8fa); border-radius: 4px;
             font-size: 12px; line-height: 1.45; }
  .warnbox b { display: block; margin-bottom: 3px; color: var(--warn, #bf8700); }
  .step:hover { background: var(--background-color-muted, #f6f8fa); }
  .st { width: 12px; flex: none; text-align: center; }
  /* Concurrency. The CLI fires tool calls in parallel and a flat list hides it, so
     rows that provably overlapped in time share a left rule and the first carries
     the group size. Fixed-width even when empty, so the status column never shifts. */
  .par { width: 22px; flex: none; text-align: right; font-size: 11px; color: var(--accent, #0969da); }
  .step.pgrp { border-left: 2px solid var(--accent, #0969da); padding-left: 12px; }
  .st.ok { color: var(--ok); } .st.failed { color: var(--bad); } .st.running { color: var(--warn); }
  /* min-width, NOT width: this was a fixed 58px column, and every tool name
     longer than that (repo_read, ts_outline, ts_symbol) overflowed its box and
     collided with the detail -- "repo_readgovernance/planning.md". It was
     invisible for as long as those tools rendered no detail at all. */
  /* One shared column per round, sized to the widest tool name in that round, so
     details line up instead of stepping in and out as names change length.
     Monospace makes the ch unit exact; --toolw is set per .steps from the data. */
  .tool { font-weight: 600; font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); white-space: nowrap;
          flex: none; width: calc(var(--toolw, 10) * 1ch); }
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
  /* A response the provider CUT OFF. Rendering the surviving fragment as if it
     were the answer is the failure this badge exists to prevent: the text reads
     as a normal reply while being, literally, the tail of one. */
  .cut { font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
         color: #ffd479; background: #3a2a00; border: 1px solid #7a5a00;
         border-radius: 4px; padding: 1px 5px; margin-left: 6px; }
  .say.cut-body { border-left-color: #7a5a00; }
  /* A long final message used to render as one unbounded wall, pushing the rest
     of the run off screen. Cap it and let it scroll in place. */
  .say { max-height: 260px; overflow: auto; }
  .say .mdh { display: block; margin: 8px 0 3px; font-size: 12px; }
  .say .mdh:first-child { margin-top: 0; }
  .say code { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
              font-size: 11px; padding: 0 3px; border-radius: 3px;
              background: var(--background-color-neutral, rgba(127,127,127,.18)); }
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
  .oval { font-size: 12px; overflow-wrap: anywhere; max-height: 340px; overflow: auto; }
  .oval pre { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 11px; white-space: pre-wrap;
              overflow-wrap: anywhere; max-height: 260px; overflow: auto;
              background: var(--background-color-muted, #f6f8fa); }
  /* Structured output, laid out as structure. ONE scroll region per row -- capping
     each nested level instead would nest scrollbars inside scrollbars. */
  .jitem { display: flex; gap: 8px; padding: 3px 0; }
  .jitem + .jitem { border-top: 1px solid var(--border-color-muted, #eaeef2); }
  .jidx { flex: 0 0 auto; min-width: 16px; text-align: right; color: var(--muted);
          font-size: 10px; font-family: var(--font-mono, monospace); padding-top: 2px; }
  .jbody { flex: 1 1 auto; min-width: 0; }
  .jrow { display: grid; grid-template-columns: 110px 1fr; gap: 8px; padding: 2px 0; align-items: baseline; }
  .jkey { color: var(--muted); font-size: 11px; font-family: var(--font-mono, monospace);
          overflow-wrap: anywhere; }
  .jval { min-width: 0; overflow-wrap: anywhere; }
  .jstr { white-space: pre-wrap; }
  .jnum { font-family: var(--font-mono, monospace); }
  .jnull { color: var(--muted); font-style: italic; }
  .jbool { font-family: var(--font-mono, monospace); font-weight: 600; }
  .jbool.yes { color: var(--true-color-green, #3fb950); }
  .jbool.no { color: var(--true-color-red, #f85149); }
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
// A model that answers with JSON writes newlines ESCAPED. Normally the text is
// parsed and the escapes vanish; when it cannot be parsed -- a cut-off fragment,
// most of all -- the raw string reaches the screen and every line break shows as
// a literal backslash-n, which is the least readable form of the one thing you
// most want to read. Only rewrite when the escapes clearly outnumber real
// newlines, so ordinary prose that happens to mention a newline escape is
// left alone.
// Assigning innerHTML tears down and rebuilds the subtree even when the markup is
// IDENTICAL, which resets the scroll position of everything inside it. The panel
// repaints every 1.5s, so a long output block scrolled back to the top a moment
// after you stopped scrolling -- on a FINISHED run, whose content cannot have
// changed at all. Write only when the markup actually differs.
//
// Setters rather than a paint() call so the assignment sites stay assignments;
// each is a multi-line template expression and wrapping them in calls is a
// paren-balancing exercise with no upside.
const painted = {};
const el = {
  set cards(h) {
    if (painted.cards !== h) document.getElementById("cards").innerHTML = painted.cards = h;
  },
  set spend(h) {
    if (painted.spend !== h) document.getElementById("spend").innerHTML = painted.spend = h;
  },
  set body(h) {
    if (painted.body !== h) document.getElementById("body").innerHTML = painted.body = h;
  },
};
const sayText = (t) => {
  const str = String(t ?? "");
  const escaped = (str.match(/\\\\n/g) || []).length;
  const real = (str.match(/\\n/g) || []).length;
  return escaped > real ? str.replace(/\\\\n/g, "\\n") : str;
};
// Render the small markdown subset models actually emit -- headings, bold, and
// inline code. A reviewer's verdict is written as markdown, and shown raw it reads
// as a wall of asterisks and hashes exactly where the emphasis was meant to help.
//
// Escaping happens FIRST and the markup is applied to already-escaped text, so no
// model output can inject HTML. Note \x60 rather than a literal backtick: this file
// is one big template literal.
const sayHtml = (t) =>
  esc(t)
    .replace(/^(#{1,6})\\s+(.*)$/gm, (_m, _h, s) => '<b class="mdh">' + s + "</b>")
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\\x60([^\\x60\\n]+)\\x60/g, "<code>$1</code>");
// Render a stage's structured output as STRUCTURE rather than a wall of JSON.
// The view still does not interpret keys -- it lays out objects, arrays and
// scalars and nothing else -- so it stays correct for any chain. What it removes
// is the punctuation a reader has to look past: a verdict's findings were shown
// as a bracketed list of quoted strings, which is the exact content you most need
// to read and the hardest form to read it in.
//
// Depth is capped. A pathologically nested value falls back to serialised JSON,
// because an unbounded recursion in the renderer would take the whole panel down
// and the panel is the instrument.
const jsonHtml = (v, depth) => {
  const d = depth || 0;
  if (v === null || v === undefined) return '<span class="jnull">none</span>';
  if (d > 6) return "<pre>" + esc(JSON.stringify(v, null, 1)) + "</pre>";
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="jnull">empty</span>';
    return (
      '<div class="jarr">' +
      v
        .map(
          (el, i) =>
            '<div class="jitem"><span class="jidx">' +
            (i + 1) +
            '</span><div class="jbody">' +
            jsonHtml(el, d + 1) +
            "</div></div>",
        )
        .join("") +
      "</div>"
    );
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return '<span class="jnull">empty</span>';
    return (
      '<div class="jobj">' +
      keys
        .map(
          (k) =>
            '<div class="jrow"><span class="jkey">' +
            esc(k) +
            '</span><div class="jval">' +
            jsonHtml(v[k], d + 1) +
            "</div></div>",
        )
        .join("") +
      "</div>"
    );
  }
  if (typeof v === "boolean")
    return '<span class="jbool ' + (v ? "yes" : "no") + '">' + v + "</span>";
  if (typeof v === "number") return '<span class="jnum">' + v + "</span>";
  // A leaf string is PROSE -- a finding, a blueprint, a reason -- written in the
  // same markdown as a stage's message. Escaping it here would leave literal
  // backticks and asterisks inside an otherwise structured layout, which is the
  // same defect one level down. One renderer, both surfaces.
  return '<span class="jstr">' + sayHtml(v) + "</span>";
};
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
    el.cards = "";
    el.spend = "";
    el.body =
      \`<div class="empty">No runs found under <code>\${esc((s.roots || [s.root]).join(" or "))}</code>.<br>Run <code>node vendor/chainkit/run.mjs --chain .chainkit/chains/&lt;name&gt;.yaml</code> and this will populate live.</div>\`;
    return;
  }

  const t = run.totals;
  el.cards =
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
  el.spend = tot > 0
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
        r.scalar ? sayHtml(r.value) : jsonHtml(r.value, 0)
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
    if (st.status === "skipped" || st.status === "unreached") return "";
    if (st.declared && st.declared.tools === false)
      bits.push('<span class="chan">reasons only</span>');
    if (st.declared?.inLoop) bits.push('<span class="chan">in loop</span>');
    const inherits = st.resume || st.declared?.resume;
    if (inherits)
      bits.push(
        \`<span class="chan warn" title="this stage inherited another stage's whole conversation">↩ resumes \${esc(inherits === true ? "previous round" : inherits)}</span>\`,
      );
    if (st.declaredToolsUnused)
      bits.push(
        \`<span class="chan warn" title="this stage was given tools and called none — its output was not checked against the repo">⚠ tools unused</span>\`,
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
    const unrun = st.status === "pending" || st.status === "skipped" || st.status === "unreached";
    const g = unrun ? "unrun" : st.iter || 0;
    if (g === lastGroup) return "";
    lastGroup = g;
    const name = g === "unrun" ? "not run" : g ? "element " + g : "chain";
    return \`<div class="ghead"><span class="gname">\${esc(name)}</span><span class="grule"></span></div>\`;
  }

  // WHY THE RUN STOPPED, at the top, in words.
  //
  // The record has always held this and the canvas has never shown it: a halted run
  // rendered as a run that simply had fewer stages, so "is it dead, and why" was a
  // question you could only answer by reading JSON on disk. Every halt kind is
  // treated the same way here -- the kernel names the kind and writes the sentence,
  // and this prints it, so a kind added later needs no change on this side.
  const H = run.summary?.halted;
  const W = Array.isArray(run.summary?.warnings) ? run.summary.warnings : [];
  const banner = !H
    ? ""
    : \`<div class="halt"><span class="haltkind">\${esc(H.kind || "halted")}</span>
       <span class="haltwhere">at <b>\${esc(H.stage || "?")}</b>\${H.round ? " round " + H.round : ""}\${H.iter ? " · element " + H.iter : ""}</span>
       <div class="haltwhy">\${esc(H.reason || "no reason recorded")}</div></div>\`;
  const warnBox = !W.length
    ? ""
    : \`<div class="warnbox"><b>\${W.length} warning\${W.length === 1 ? "" : "s"}</b>\${W.map((w) => \`<div>\${esc(w)}</div>\`).join("")}</div>\`;

  el.body = banner + warnBox + run.stages.map((st) => groupHead(st) + \`
    <div class="stage \${st.status === "pending" || st.status === "skipped" || st.status === "unreached" ? "pending" : ""}">
      <div class="shead">
        <span class="sord">\${String(st.seq ?? st.ord).padStart(2, "0")}</span>
        <span class="swatch" style="background:\${idHue(st.id)}"></span>
        <span class="sid">\${esc(hasElements ? st.id : st.label || st.id)}</span>
        \${st.round ? \`<span class="round" title="loop round">r\${st.round}</span>\` : ""}
        <span class="detail mono">\${esc(st.model || "")}</span>
        \${st.truncated ? \`<span class="cut" title="the provider stopped this response at the output ceiling\${
          st.outputCeiling ? " of " + st.outputCeiling.toLocaleString() + " tokens" : ""
        }, so the text below is a fragment">cut off\${st.truncated > 1 ? " \u00d7" + st.truncated : ""}</span>\` : ""}
        <span class="grow"></span>
        <span class="detail">\${
          st.status === "pending" ? "not started"
          : st.status === "skipped" ? "skipped \u2014 never needed"
          : st.status === "unreached" ? "never reached \u2014 the run halted first"
          : st.status === "running" && st.noModelCalls ? "running now"
          : st.noModelCalls ? "ran \u2014 no model call" + (st.wallMs ? " \u00b7 " + (st.wallMs >= 1000 ? (st.wallMs / 1000).toFixed(1) + "s" : st.wallMs + "ms") : "")
          : \`\${st.rounds.length > 1 ? st.rounds.length + " calls · " : ""}\${st.tools} tools · \${
              st.aiuKnown === false ? "AiU not reported yet"
              : st.aiu.toFixed(2) + " AiU" + (st.unmetered ? " +?" : "")
            }\`}</span>
      </div>
      \${channels(st)}
      \${st.rounds.map((p) => {
        const key = (st.key || st.id) + "/" + p.label;
        const isOpen = key === activeKey;
        const flight = p.inFlight ? '<span class="dot live" title="call in flight"></span>' : "";
        const out = outputHtml(p.output);
        const toolw = Math.max(10, ...p.steps.filter(x => x.kind !== "say").map(x => (x.name || "").length + 1));
        const steps = p.steps.map(x => x.kind === "say"
          ? \`<div class="say\${st.truncated ? " cut-body" : ""}">\${sayHtml(sayText(x.text))}</div>\`
          : \`<div class="step\${x.par > 1 ? " pgrp" : ""}"><span class="par">\${x.par > 1 && x.parFirst ? "\\u2225" + x.par : ""}</span><span class="st \${x.status}">\${x.status === "ok" ? "✓" : x.status === "failed" ? "✗" : x.status === "running" ? "◐" : "·"}</span><span class="tool">\${esc(x.name)}</span><span class="detail mono">\${esc(x.detail)}</span></div>\`
        ).join("") || (out ? "" : '<div class="step"><span class="detail">no tool calls recorded</span></div>');
        return \`<div class="call \${isOpen ? "open" : ""}" data-key="\${esc(key)}">
          <div class="chead">
            <span class="caret">\${isOpen ? "▾" : "▸"}</span>
            \${st.rounds.length > 1
              ? \`<span class="tag" title="\${esc(p.label)}">\${p.round ? "round " + p.round : "call"}</span>\`
              : ""}
            \${flight}
            <span class="detail">\${p.steps.length} step\${p.steps.length === 1 ? "" : "s"}\${out ? " · output" : ""}\${p.peakParallel > 1 ? " · up to " + p.peakParallel + " at once" : ""}</span>
            <span class="grow"></span>
            \${st.rounds.length > 1
              ? \`<span class="detail">\${p.toolCount} tools · \${p.aiu == null ? "AiU not reported yet" : p.aiu.toFixed(2) + " AiU"}</span>\`
              : \`<span class="detail">\${p.aiu == null ? "AiU not reported yet" : ""}</span>\`}
          </div>
          <div class="steps" style="--toolw:\${toolw}">\${out}\${steps}</div>
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
