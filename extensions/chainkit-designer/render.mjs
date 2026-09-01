// The design-time picture of a chain. Deliberately a VERTICAL PIPELINE rather than
// a free-form graph: a chain is an ordered list with one bounded loop, and drawing
// it as a graph would imply a generality the engine does not have.
//
// What it must make obvious at a glance, because these are the decisions someone is
// actually making while designing a process:
//   - the ORDER of stages
//   - WHICH MODEL runs each one (the most consequential line in any chain)
//   - which stages can TOUCH THE REPO (tools) vs only reason
//   - what flows into what (artifacts), including a break in the flow
//   - where the LOOP is, what breaks it, and its bound
//   - what the GATE is

export function page() {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<title>chainkit chain</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0d1117);
    --fg: var(--vscode-editor-foreground, #e6edf3);
    --muted: #8b949e;
    --line: #30363d;
    --panel: #161b22;
    --accent: #58a6ff;
    --good: #3fb950;
    --bad: #f85149;
    --warn: #d29922;
    --loop: #bc8cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.55 var(--vscode-font-family, ui-sans-serif, -apple-system, "Segoe UI", sans-serif);
    padding: 14px 16px 40px;
  }
  .mono { font-family: var(--vscode-editor-font-family, ui-monospace, "SF Mono", Menlo, monospace); }
  h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 11.5px; margin-bottom: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  select {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 3px 7px; font-size: 11.5px;
  }
  .intent {
    white-space: pre-wrap; color: var(--muted); font-size: 11.5px;
    border-left: 2px solid var(--line); padding: 2px 0 2px 10px; margin: 0 0 14px;
  }

  /* ---- seeds ---- */
  .seeds { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
  .seed {
    border: 1px dashed var(--line); border-radius: 999px; padding: 2px 10px;
    font-size: 11px; color: var(--muted); background: #0f141b;
  }
  .seed b { color: var(--accent); font-weight: 600; }
  .seed.missing { border-color: var(--bad); color: var(--bad); }

  /* ---- the pipeline ---- */
  .flow { position: relative; margin-top: 10px; }
  .arrow { height: 16px; margin-left: 22px; border-left: 2px solid var(--line); }
  .arrow.brk { border-left-style: dashed; border-left-color: var(--bad); }

  .stage {
    border: 1px solid var(--line); border-radius: 9px; background: var(--panel);
    padding: 9px 12px; position: relative;
  }
  .stage.loop { border-color: var(--loop); }
  .stage.err  { border-color: var(--bad); }
  .srow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .ord {
    width: 20px; height: 20px; border-radius: 50%; background: #21262d; color: var(--muted);
    font-size: 10.5px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  }
  .sid { font-weight: 650; font-size: 13.5px; }
  .pill {
    font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
  }
  .pill.model { color: var(--accent); border-color: #1f6feb66; background: #1f6feb14; }
  .pill.tools { color: var(--warn); border-color: #d2992255; background: #d2992214; }
  .pill.think { color: var(--muted); }
  .pill.resume { color: var(--loop); border-color: #bc8cff55; }
  .pill.opt { color: var(--muted); border-style: dashed; }

  .io { display: flex; gap: 10px; align-items: baseline; margin-top: 7px; font-size: 11.5px; flex-wrap: wrap; }
  .io .lbl { color: var(--muted); min-width: 52px; }
  .art { color: var(--accent); }
  .art.bad { color: var(--bad); text-decoration: underline wavy var(--bad); }
  .prod { color: var(--good); }
  .pfile { color: var(--muted); font-size: 11px; }
  .pfile.missing { color: var(--bad); }

  /* ---- loop bracket ---- */
  .loopwrap { position: relative; border-left: 2px solid var(--loop); padding-left: 14px; margin-left: 21px; }
  .loopwrap > .stage, .loopwrap > .arrow { margin-left: 0; }
  .loophead, .loopfoot {
    color: var(--loop); font-size: 11px; margin: 8px 0 8px -14px; display: flex; gap: 8px; align-items: center;
  }
  .loopfoot { margin-top: 8px; }

  .completion {
    margin-top: 16px; border: 1px solid var(--line); border-radius: 9px;
    background: #0f141b; padding: 9px 12px;
  }
  .completion .k { color: var(--muted); font-size: 11px; margin-bottom: 3px; }

  .prob { border: 1px solid var(--bad); background: #f8514912; border-radius: 8px; padding: 9px 12px; margin: 12px 0; }
  .prob .h { color: var(--bad); font-weight: 600; font-size: 12px; margin-bottom: 5px; }
  .prob ul { margin: 0; padding-left: 17px; }
  .prob li { color: #ffb4ae; font-size: 11.5px; }
  .ok { color: var(--good); font-size: 11.5px; margin: 10px 0; }
  .empty { color: var(--muted); padding: 26px 0; }
</style></head>
<body>
  <h1>chainkit <span id="cname" style="color:var(--muted);font-weight:400"></span></h1>
  <div class="sub">
    <select id="pick"></select>
    <span id="meta"></span>
  </div>
  <div id="root"></div>

<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let picked = null;

function stageHtml(s, n) {
  const pills = [
    \`<span class="pill model">\${esc(s.model || "(no model)")}</span>\`,
    // An allowlist is named, not collapsed to "writes repo". Which tools a stage
    // may reach is a design decision the reader is here to see, and it is the one
    // thing that distinguishes a shell-free stage from an unrestricted one.
    Array.isArray(s.tools)
      ? \`<span class="pill tools">✎ only \${esc(s.tools.join(", "))}</span>\`
      : s.tools
        ? '<span class="pill tools">✎ writes repo</span>'
        : '<span class="pill think">reasons only</span>',
    s.parse === "json" ? '<span class="pill">json</span>' : "",
    s.resume ? '<span class="pill resume">↻ same session</span>' : "",
    s.resumeFrom ? \`<span class="pill resume">↩ from \${esc(s.resumeFrom)}</span>\` : "",
    s.optional ? '<span class="pill opt">optional</span>' : "",
    s.effort ? \`<span class="pill">\${esc(s.effort)}</span>\` : "",
    s.expects
      ? \`<span class="pill" title="declared key contract — a reworded prompt that drops one of these fails the stage">⊨ \${esc(Object.keys(s.expects).join(", "))}</span>\`
      : "",
    s.completion
      ? \`<span class="pill resume" title="\${esc(s.completion.run)}">✓ completion · \${esc(s.completion.attempts)} attempt(s)</span>\`
      : "",
    s.inCompletionRepair ? '<span class="pill resume">chain completion repair</span>' : "",
    s.inForeachCompletionRepair
      ? '<span class="pill resume">item completion repair</span>'
      : "",
  ].join("");

  const uses = (s.uses || []).length
    ? s.uses.map(u => \`<span class="art \${(s.unresolved||[]).includes(u) ? "bad" : ""}">{{\${esc(u)}}}</span>\`).join(" ")
    : '<span style="color:var(--muted)">nothing</span>';

  return \`<div class="stage \${s.inLoop ? "loop" : ""} \${(s.unresolved||[]).length || s.promptMissing || s.resumePromptMissing ? "err" : ""}">
    <div class="srow">
      <span class="ord">\${n}</span>
      <span class="sid">\${esc(s.id)}</span>
      \${pills}
    </div>
    <div class="io"><span class="lbl">reads</span><span>\${uses}</span></div>
    \${s.resumeFrom ? \`<div class="io"><span class="lbl">session</span><span class="art">← \${esc(s.resumeFrom)}</span></div>\` : ""}
    <div class="io"><span class="lbl">writes</span><span class="prod">\${
      // A stage need not name an artifact. When it does not, its product is the
      // working tree -- say that, rather than rendering {{undefined}}.
      s.produces
        ? \`{{\${esc(s.produces)}}}\`
        : '<span style="color:var(--muted)">the working tree — no named artifact</span>'
    }</span></div>
    <div class="io"><span class="lbl">\${s.run ? "command" : "prompt"}</span>
      <span class="pfile mono \${s.promptMissing ? "missing" : ""}">\${esc(s.run || s.prompt)}\${s.promptMissing ? " — FILE NOT FOUND" : \` · \${s.promptChars} chars\`}</span>
    </div>
    \${s.resumePrompt ? \`<div class="io"><span class="lbl">resume prompt</span>
      <span class="pfile mono \${s.resumePromptMissing ? "missing" : ""}">\${esc(s.resumePrompt)}\${s.resumePromptMissing ? " — FILE NOT FOUND" : \` · \${s.resumePromptChars} chars\`}</span>
    </div>\` : ""}
  </div>\`;
}

function render(st) {
  const d = st.design || {};
  document.getElementById("cname").textContent = d.name ? "· " + d.name : "";

  const pick = document.getElementById("pick");
  const opts = (st.chains || []).map(c => \`<option \${c === st.viewing ? "selected" : ""}>\${esc(c)}</option>\`).join("");
  if (pick.innerHTML !== opts) pick.innerHTML = opts;

  const root = document.getElementById("root");

  if (!d.exists) {
    root.innerHTML = \`<div class="empty">No chain file. Create one at <code class="mono">\${esc(st.root)}/&lt;name&gt;/chain.yaml</code>.</div>\`;
    document.getElementById("meta").textContent = "";
    return;
  }
  if (d.parseError) {
    root.innerHTML = \`<div class="prob"><div class="h">the file does not parse yet</div><pre class="mono" style="margin:0;white-space:pre-wrap;color:#ffb4ae;font-size:11.5px">\${esc(d.parseError)}</pre></div>\`;
    document.getElementById("meta").textContent = "unparseable";
    return;
  }

  const nStage = d.stages.length;
  document.getElementById("meta").textContent =
    \`\${nStage} stage\${nStage === 1 ? "" : "s"}\` +
    (d.loop ? \` · loop ×\${d.loop.max}\` : "") +
    (d.completion ? " · completion declared" : " · completed/unverified");

  const problems = (d.errors || []).length
    ? \`<div class="prob"><div class="h">\${d.errors.length} problem(s) — this chain will refuse to run</div><ul>\${d.errors.map(e => \`<li>\${esc(e)}</li>\`).join("")}</ul></div>\`
    : '<div class="ok">✓ valid — chainkit would run this</div>';

  const seeds = d.seeds.length
    ? \`<div class="seeds">\${d.seeds.map(s => \`<span class="seed \${s.missing ? "missing" : ""}"><b>{{\${esc(s.name)}}}</b>\${s.from ? " ← " + esc(s.from) + (s.missing ? " (missing)" : "") : ""}</span>\`).join("")}</div>\`
    : '<div class="seeds"><span class="seed">no seeds</span></div>';

  // Render in order, bracketing the contiguous run of loop stages. The loop is the
  // only control flow there is, so it is drawn as structure rather than a label.
  let html = "", i = 0, openedLoop = false;
  while (i < d.stages.length) {
    const s = d.stages[i];
    if (s.inLoop && !openedLoop) {
      html += \`<div class="loophead">┌ repeat while <b class="mono">\${esc(d.loop?.until || "?")}</b> is not met — at most \${esc(d.loop?.max ?? "?")}×</div><div class="loopwrap">\`;
      openedLoop = true;
    }
    if (!s.inLoop && openedLoop) {
      html += \`</div><div class="loopfoot">└ then continue</div>\`;
      openedLoop = false;
    }
    if (i > 0) html += \`<div class="arrow \${(s.unresolved||[]).length ? "brk" : ""}"></div>\`;
    html += stageHtml(s, i + 1);
    i++;
  }
  if (openedLoop) html += \`</div><div class="loopfoot">└ then completion</div>\`;

  const completion = d.completion
    ? \`<div class="completion"><div class="k">CHAIN COMPLETION\${d.completion.repair ? " · repairs via " + esc(d.completion.repair.stages.join(", ")) : ""} · \${esc(d.completion.attempts)} attempt(s)</div><div class="mono">\${esc(d.completion.run)}</div></div>\`
    : \`<div class="completion"><div class="k" style="color:var(--warn)">NO CHAIN COMPLETION — a successful run is completed but unverified and cannot be delivered</div></div>\`;
  const itemCompletion = d.foreach?.completion
    ? \`<div class="completion"><div class="k">FOREACH ITEM COMPLETION\${d.foreach.completion.repair ? " · repairs via " + esc(d.foreach.completion.repair.stages.join(", ")) : ""} · \${esc(d.foreach.completion.attempts)} attempt(s)</div><div class="mono">\${esc(d.foreach.completion.run)}</div></div>\`
    : "";

  root.innerHTML = problems +
    (d.intent ? \`<div class="intent">\${esc(d.intent)}</div>\` : "") +
    seeds + \`<div class="flow">\${html}</div>\` + itemCompletion + completion;
}

async function tick() {
  try {
    const q = picked ? "?chain=" + encodeURIComponent(picked) : "";
    const r = await fetch("/state" + q);
    render(await r.json());
  } catch {}
}
document.getElementById("pick").addEventListener("change", (e) => { picked = e.target.value; tick(); });
tick();
setInterval(tick, 1500);
</script>
</body></html>`;
}
