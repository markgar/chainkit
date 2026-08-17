// Extension: chainkit-designer
//
// A DESIGN-TIME view of a chainkit chain. Not a run dashboard -- there is no run.
// This is for the moment BEFORE anything is built, when someone is describing the
// process they want and deciding whether it is the right shape: what the stages
// are, which model runs each one, what each produces, what flows into what, where
// the loop is and what breaks it, and what the gate is.
//
// It renders the chain FILE, and re-reads it on a poll, so an agent editing the
// YAML and a human watching the panel see the same thing without a reload.
//
// Two deliberate properties:
//
//  1. It VALIDATES with chainkit's own kernel (kernel/config.mjs), not with a
//     second copy of the schema. A designer that draws a pretty picture of a chain
//     the engine would reject is worse than no picture, and any schema duplicated
//     in a viewer drifts from the engine the first time a key is added.
//  2. It is READ-ONLY. It never writes the chain file. Editing is the agent's job
//     through the normal file tools, which keeps one writer and keeps the change
//     reviewable in the diff.

import { createServer } from "node:http";
import path from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { page } from "./render.mjs";
// The read side lives next door so it can be tested without the extension host.
import { engineRoot, chainRoots, listChains, resolveChainFile, readDesign } from "./design.mjs";

const servers = new Map(); // instanceId -> { server, url, roots, engine, chain }

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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/state") {
      const want = url.searchParams.get("chain") || entry.chain;
      try {
        const file = resolveChainFile(entry.roots, want);
        const design = await readDesign(entry.engine, file);
        return json(res, {
          roots: entry.roots,
          chains: listChains(entry.roots).map((c) => c.name),
          viewing: file ? path.basename(file) : null,
          design,
        });
      } catch (err) {
        return json(res, { error: String(err?.message || err) }, 500);
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, server };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "chainkit-chain",
      displayName: "chainkit chain",
      description:
        "Design-time view of a chainkit chain config: the stage pipeline, the model and tool access per stage, how artifacts flow between stages, the bounded loop and what breaks it, and the declared gate. Use while DECIDING what a process should be — it renders the chain YAML and re-reads it as it is edited, and validates with chainkit's own kernel so what it shows is what the engine would run. Not a run dashboard; for a live build use the 'chainkit runs' canvas.",
      inputSchema: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description:
              "chainkit dir. Defaults to <workspace>/.chainkit, falling back to vendor/chainkit.",
          },
          chain: {
            type: "string",
            description:
              "Chain file to show: a name or path relative to a chain root (e.g. '04-plan-and-fan-out'), or an absolute path. Defaults to the first chain found.",
          },
        },
        additionalProperties: false,
      },
      open: async (ctx) => {
        const roots = chainRoots(session?.workspacePath, ctx.input);
        const engine = engineRoot(session?.workspacePath);
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = { roots, engine, chain: ctx.input?.chain || null };
          const started = await startServer(entry);
          entry.server = started.server;
          entry.url = started.url;
          servers.set(ctx.instanceId, entry);
        } else {
          entry.roots = roots;
          entry.engine = engine;
          if (ctx.input?.chain) entry.chain = ctx.input.chain;
        }
        const file = resolveChainFile(entry.roots, entry.chain);
        const design = await readDesign(entry.engine, file);
        return {
          url: entry.url,
          title: "chainkit chain",
          status: design.exists
            ? `${design.name || path.basename(file)} · ${design.parseError ? "unparseable" : design.errors?.length ? `${design.errors.length} problem(s)` : `${design.stages.length} stage(s)`}`
            : "no chain",
        };
      },
      actions: [
        {
          name: "show",
          description:
            "Switch the panel to a different chain file, and return its resolved design (stages, models, artifact flow, loop, gate, validation errors).",
          inputSchema: {
            type: "object",
            properties: { chain: { type: "string" } },
            additionalProperties: false,
          },
          handler: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (!entry)
              throw new CanvasError("not_open", `canvas instance ${ctx.instanceId} is not open`);
            if (ctx.input?.chain) entry.chain = ctx.input.chain;
            const file = resolveChainFile(entry.roots, entry.chain);
            const d = await readDesign(entry.engine, file);
            if (!d.exists) throw new CanvasError("no_chain", `no chain file at ${file}`);
            return {
              name: d.name,
              file: d.file,
              parseError: d.parseError ?? null,
              errors: d.errors ?? [],
              seeds: (d.seeds || []).map((s) => s.name),
              stages: (d.stages || []).map((s) => ({
                id: s.id,
                model: s.model,
                tools: s.tools,
                produces: s.produces,
                uses: s.uses,
                inLoop: s.inLoop,
              })),
              loop: d.loop,
              gate: d.gate,
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
