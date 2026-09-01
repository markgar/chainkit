// Extension: chainkit-canvas
//
// A live view of what chainkit is doing, read from the telemetry it already
// writes to disk. Built because the run output scrolls past in a terminal and the
// interesting part -- watching each stage actually work -- was invisible.
//
// It has NO opinion about what the stages are. A run is an ordered list of stages
// and it renders whatever it finds, so a chain nobody has written yet displays
// correctly the first time it runs.
//
// Read-only by construction: it opens files under <root>/results and
// never writes there, so watching a run cannot perturb the run.

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { listRuns, readRun } from "./telemetry.mjs";
import { page } from "./render.mjs";

const servers = new Map(); // instanceId -> { server, url, root, runId }

// Anchor on this file, not on session.workspacePath -- workspacePath is the
// session-state dir, not the repo. A project extension lives at
// <repo>/.github/extensions/<name>/, so three levels up is the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

// EVERY root that could hold runs, in display order. There are two now: `.chainkit/`
// is what this repo owns (its chains and the runs they produced), `vendor/chainkit/`
// is the vendored engine, whose own example chains record into its own results.
// Which one a run landed in is an artifact of which chain file produced it, so the
// canvas reads BOTH rather than making the reader pick -- an empty `.chainkit/`
// scaffold must never blank out the engine's runs.
function resolveRoots(workspacePath, input) {
  if (input?.root) {
    return [path.isAbsolute(input.root) ? input.root : path.join(repoRoot, input.root)];
  }
  const out = [];
  for (const base of [repoRoot, workspacePath, process.cwd()]) {
    if (!base) continue;
    for (const rel of [".chainkit", path.join("vendor", "chainkit")]) {
      const cand = path.join(base, rel);
      if (!existsSync(cand) || out.includes(cand)) continue;
      out.push(cand);
    }
  }
  return out.length ? out : [path.join(repoRoot, ".chainkit")];
}

// Resolve which run to show. "latest" FOLLOWS the newest run, which is what makes
// this useful during a run -- pinning an id would show a stale run the moment a
// new one starts.
// Run ids are `<chain>__<tag>__<stamp>`. Three ways to address a run:
//
//   "latest"      newest by mtime -- fine for ONE run at a time
//   "tag:<tag>"   newest run carrying that tag
//   "<full id>"   pinned exactly
//
// The tag form exists because "latest" is actively wrong under concurrency.
// Two runs at once both write JSONL continuously, so whichever touched a file
// most recently wins mtime, and a "latest" view FLIPS BETWEEN THEM every poll --
// silently rendering two different runs as one. It never errors; it just shows a
// blend. Following a tag is stable no matter how many runs are in flight.
function pickRun(roots, runId) {
  const runs = listRuns(roots);
  if (!runs.length) return { runs, run: null };
  let chosen;
  if (runId && runId.startsWith("tag:")) {
    const t = runId.slice(4);
    // runs is already sorted newest-first, so the first match is that tag's
    // current run.
    chosen = runs.find((r) => r.id.includes(`__${t}__`));
  } else if (runId && runId !== "latest") {
    chosen = runs.find((r) => r.id === runId);
  } else {
    chosen = runs[0];
  }
  if (!chosen) return { runs, run: null };
  return { runs, run: readRun(chosen.dir, chosen.root) };
}

function json(res, body, code = 200) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(s),
  });
  res.end(s);
}

async function startServer(entry) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/state") {
      const runId = url.searchParams.get("run") || entry.runId;
      try {
        const { runs, run } = pickRun(entry.roots, runId);
        // Integrity guard: if more than one run is actively being written and
        // the viewer is on "latest", the view is NOT a stable window onto one
        // run -- it will hop to whichever wrote most recently. Say so, rather
        // than rendering a confident blend of two runs.
        const LIVE_MS = 60_000;
        const now = Date.now();
        const live = runs.filter((r) => now - r.mtime < LIVE_MS);
        const ambiguous =
          (!runId || runId === "latest") && live.length > 1
            ? `${live.length} runs are live (${live.map((r) => r.id).join(", ")}). "latest" follows whichever wrote most recently, so this view may hop between runs. Pin one with run=tag:<tag>.`
            : null;
        return json(res, {
          roots: entry.roots,
          exists: entry.roots.some((r) => existsSync(r)),
          runs: runs.slice(0, 40).map((r) => ({ id: r.id, mtime: r.mtime })),
          viewing: runId || "latest",
          ambiguous,
          run,
        });
      } catch (err) {
        return json(res, { error: String(err?.message || err) }, 500);
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/`, server };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "chainkit-runs",
      displayName: "chainkit runs",
      description:
        "Live dashboard for a chainkit run: every stage in execution order, each stage's model and tool calls as it works, any structured output it produced, and where the run's AiU actually went stage by stage. Knows nothing about what the stages mean, so it renders any chain. Reads telemetry from .chainkit/results, or vendor/chainkit/results for the engine's own example chains.",
      inputSchema: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description:
              "chainkit dir to read exclusively. Omit to read every root: <workspace>/.chainkit and vendor/chainkit.",
          },
          run: {
            type: "string",
            description: "Run id to pin, or 'latest' (default) to follow the newest run.",
          },
        },
        additionalProperties: false,
      },
      open: async (ctx) => {
        const roots = resolveRoots(session?.workspacePath, ctx.input);
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = { roots, runId: ctx.input?.run || "latest" };
          const started = await startServer(entry);
          entry.server = started.server;
          entry.url = started.url;
          servers.set(ctx.instanceId, entry);
        } else {
          // Re-open / rehydrate: refresh config, keep the port stable.
          entry.roots = roots;
          if (ctx.input?.run) entry.runId = ctx.input.run;
        }
        const { run } = pickRun(entry.roots, entry.runId);
        return {
          url: entry.url,
          title: "chainkit runs",
          status: run ? `${run.id}${run.live ? " · live" : ""}` : "no runs yet",
        };
      },
      actions: [
        {
          name: "summary",
          description:
            "Return a compact summary of a chainkit run: run totals, and per stage its model, rounds, tool count and AiU. No process-specific fields — the same shape for every chain.",
          inputSchema: {
            type: "object",
            properties: { run: { type: "string" } },
            additionalProperties: false,
          },
          handler: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (!entry)
              throw new CanvasError("not_open", `canvas instance ${ctx.instanceId} is not open`);
            const { run } = pickRun(entry.roots, ctx.input?.run || entry.runId);
            if (!run)
              throw new CanvasError(
                "no_runs",
                `no chainkit runs found under ${entry.roots.join(", ")}`,
              );
            return {
              id: run.id,
              live: run.live,
              totals: run.totals,
              stages: run.stages.map((st) => ({
                ord: st.ord,
                id: st.id,
                model: st.model,
                tools: st.tools,
                aiu: Number(st.aiu.toFixed(4)),
                unmetered: st.unmetered,
                resumedFrom: st.resumedFrom || null,
                rounds: st.rounds.map((r) => ({
                  label: r.label,
                  round: r.round,
                  model: r.model,
                  tools: r.toolCount,
                  // `?? null` matters: a call with no usage checkpoint yet has a
                  // null aiu, and .toFixed on null would throw and take the whole
                  // summary with it.
                  aiu: r.aiu == null ? null : Number(r.aiu.toFixed(4)),
                  inFlight: r.inFlight,
                  resumedFrom: r.resumedFrom || null,
                })),
              })),
            };
          },
        },
      ],
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) return;
        servers.delete(ctx.instanceId);
        await new Promise((r) => entry.server.close(() => r()));
      },
    }),
  ],
});
