// Provider seam for the no-tools reasoning roles (planner + reviewer).
//
// Two backends, chosen per model id:
//   • CLI  — spawn `copilot -p … --available-tools ""` (GitHub Copilot models).
//   • azure-openai — a direct OpenAI-compatible /chat/completions call to an
//     Azure AI Foundry deployment (e.g. DeepSeek-V4-Pro). No API key: auth is
//     Entra ID, so we mint a bearer token with `az` and cache it in-process.
//
// The builder (flash) is NOT routed here — it needs the full agent tool loop
// and stays on the CLI (see lib/flash.mjs). This seam is completions only.
//
// Both backends return { text, usage } where usage is { input, output, total }
// or null (the CLI doesn't expose structured token counts).

import { spawn, execFileSync } from "node:child_process";
import { parseCopilotJsonl, persistRaw, appendLive } from "./telemetry.mjs";
import fs from "node:fs";
import path from "node:path";

// A model id is treated as an Azure Foundry deployment when it looks like one
// (contains "deepseek") OR the caller passes an explicit provider prefix
// "azure:<deployment>". Everything else goes to the Copilot CLI.
//
// Exported because the roster warning in kernel/models.mjs has to ask the same
// question -- "is this id one the CLI will be asked for?" -- and a second copy of
// this rule would drift from this one silently, which shows up as a chain warning
// about a perfectly good Azure deployment.
export function providerFor(model) {
  if (!model) return { kind: "cli", model };
  if (model.startsWith("azure:")) return { kind: "azure", model: model.slice(6) };
  if (/deepseek/i.test(model)) return { kind: "azure", model };
  return { kind: "cli", model };
}

// ---- Azure Entra token (cached in-process; refreshed before expiry) ----------
let _tok = null; // { value, exp }
function azureToken() {
  const now = Date.now();
  if (_tok && _tok.exp - now > 5 * 60_000) return _tok.value;
  const value = execFileSync(
    "az",
    [
      "account",
      "get-access-token",
      "--scope",
      "https://ai.azure.com/.default",
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!value)
    throw new Error("azure token: `az account get-access-token` returned empty — run `az login`");
  // Tokens are ~60–90 min; cache conservatively for 45 min.
  _tok = { value, exp: now + 45 * 60_000 };
  return value;
}

async function azureComplete({ prompt, model, effort, json, timeoutMs }) {
  const base = process.env.DEEPSEEK_BASE_URL;
  if (!base) {
    throw new Error(
      "azure provider: set DEEPSEEK_BASE_URL to the Foundry endpoint " +
        "(e.g. https://<res>.services.ai.azure.com/openai/v1)",
    );
  }
  const url = base.replace(/\/$/, "") + "/chat/completions";
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
  };
  if (json) body.response_format = { type: "json_object" };
  if (effort) body.reasoning_effort = effort; // tolerated; ignored if unsupported

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${azureToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok)
      return { text: "", usage: null, error: `HTTP ${res.status}: ${raw.slice(0, 300)}` };
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      return { text: raw, usage: null };
    }
    const text = j.choices?.[0]?.message?.content ?? "";
    const u = j.usage || {};
    const usage = {
      input: u.prompt_tokens ?? null,
      output: u.completion_tokens ?? null,
      total: u.total_tokens ?? null,
    };
    // Azure reports tokens but never AI credits -- there is no billing checkpoint
    // in this API. Returning no `telemetry` at all made the call VANISH from the
    // run record, so an Azure-served role contributed exactly 0 AiU and nothing
    // said why. Zero is a measurement; absent is not, and presenting one as the
    // other is the bug this whole audit is about.
    //
    // `usage.aiu` is deliberately left null rather than set to 0: lib/cost.mjs
    // counts a null as `unmetered` and surfaces it, whereas a 0 would silently
    // sum into a total that then looks complete.
    return {
      text,
      usage,
      telemetry: {
        provider: "azure",
        model,
        sessionId: null,
        metered: false,
        unmeteredReason: "azure chat-completions reports tokens but no AI-credit checkpoint",
        usage: { ...usage, aiu: null, premiumRequests: null },
      },
    };
  } catch (e) {
    return { text: "", usage: null, error: `azure fetch failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// `sessionId`: when supplied, successive spawns CONTINUE ONE conversation
// instead of each starting cold. This is a cost lever, not a convenience. The
// ledger shows a one-shot judge call billing 100% of its ~30K-token input at
// the cache-WRITE rate -- for gpt-5.6-sol that is $6.25/M, HIGHER than its own
// uncached input rate -- and reading the cache back exactly zero times. Reusing
// the session lets that input be served as cache-read instead.
//
// It is not free: a warm judge also carries prior turns, so context grows, and
// Gate 0 showed a contract can be silently evicted under window saturation. So
// this is measured, never assumed -- judge-bench.mjs runs warm and cold over
// diffs with known answers precisely so a cost win that quietly costs accuracy
// cannot be mistaken for a free one.
// Pull the reason a failed CLI run gave, out of its combined output. The CLI
// prints its own fatal errors as a plain `Error: ...` line rather than as
// stream JSON, so this looks for the LAST such line -- earlier ones can be
// recoverable noise from a subsystem that carried on.
export function lastErrorLine(out) {
  if (!out) return null;
  const lines = String(out)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(Error|error):/i.test(l) && !l.startsWith("{"));
  return lines.length ? lines[lines.length - 1] : null;
}

function cliComplete({
  prompt,
  model,
  effort,
  timeoutMs,
  logDir,
  label = "call",
  maxCredits,
  sessionId,
  resumedFrom,
  tools = false,
  cwd,
}) {
  // ---- REPLAY SEAM -------------------------------------------------------
  //
  // Every wiring bug found in the 2026-08-15 audit lived BETWEEN tested leaf
  // functions -- the rollup that summed cumulative counters, the driver that
  // dropped paid calls, the summary that divided by the wrong denominator.
  // selftest.mjs is green and could not have caught any of them, because it
  // tests leaves in isolation. The untested surface is exactly where the
  // defects concentrated, which is structural, not bad luck.
  //
  // The seam is at the RAW STDOUT BYTES rather than at complete()'s return
  // value, deliberately: everything downstream -- parseCopilotJsonl, the usage
  // derivation, persistRaw, the rollup, the run record -- then runs completely
  // untouched, and the ONLY thing faked is the subprocess. A seam any higher up
  // would stub out the very code the calibration needs to exercise.
  //
  // Replayed streams are recorded real ones, so the fixture asserts against
  // ground truth rather than against invented numbers.
  const replayDir = process.env.FLASH_CHAIN_REPLAY;
  if (replayDir) {
    return replayFromDisk({ replayDir, label, logDir, timeoutMs });
  }

  return new Promise((resolve) => {
    // JSONL machine output so we get the SAME rich telemetry as the builder —
    // tokens, api time, premium requests — for the reviewer and the chunker,
    // not just flash. The model's actual answer is inside the assistant.message
    // events; we hand back `telemetry.finalText` as `text` so downstream JSON
    // extraction (firstJson) still finds the model's reply, with a raw fallback.
    const args = ["-p", prompt, "--no-color", "--output-format", "json"];
    // MEASURED FIXED OVERHEAD, paid by every reasoning call before it reads a
    // single line of the thing it was asked about.
    //
    // Same trivial prompt ("Reply with exactly: OK"), gpt-5.6-sol, three reps,
    // variance under 0.02% -- this is deterministic, not noisy:
    //
    //   as-shipped                            16.90 AiU
    //   --no-custom-instructions              12.09 AiU   (-28%)
    //   + --disable-builtin-mcps              11.19 AiU   (-34%, -5.71 AiU/call)
    //
    // 5.71 AiU per call, buying nothing. Against a review phase measured at
    // ~61 AiU per run, the overhead alone is roughly a third of judge spend.
    //
    // What was being loaded: the host repo's own agent instructions file -- in the
    // measured case ~30KB of dev-loop ports, seeding commands and deploy
    // discipline. None of that helps partition a spec, author an acceptance
    // command, or grade a diff. And it is not merely wasted: it COMPETES. A
    // reviewer carrying a second, unrelated doctrine is being pulled away from the
    // rubric it was actually handed. Loaded alongside it are the built-in MCP
    // servers, whose tool definitions land in the system prompt of a call that
    // runs with `--available-tools ""` and therefore cannot invoke a single one.
    //
    // A stage prompt should be the ONLY instruction a stage receives. Anything the
    // environment injects is a second, invisible prompt that no chain declared.
    args.push("--no-custom-instructions", "--disable-builtin-mcps");
    // Tools are OFF by default: a pure reasoning call that cannot read the repo
    // is cheaper and has no side effects. But a call asked to guarantee something
    // about the tree MUST be able to look at the tree -- the contract author was
    // previously asked to promise its command fails on the current tree while
    // blindfolded, which is not a hard task, it is an unobservable one. It named
    // an existing passing test file and killed the run.
    //
    // A LIST narrows which tools exist. Note the two flags are orthogonal:
    // --allow-all-tools is auto-approval (required non-interactively), while
    // --available-tools is the allowlist, so a restricted stage needs BOTH.
    //
    // Scope worth knowing before trusting a list: --available-tools filters the
    // CLI's BUILT-IN tools only. Extension-provided tools stay available whatever
    // the list says -- verified by probe, where naming two tools still left the
    // repo's own extensions callable and removed bash, view and grep. So a list is
    // a way to take the shell away, not a way to enumerate everything a stage has.
    if (Array.isArray(tools)) {
      args.push("--allow-all-tools");
      for (const t of tools) args.push(`--available-tools=${t}`);
    } else if (!tools) args.push("--available-tools", "");
    else args.push("--allow-all-tools");
    if (model) args.push("--model", model);
    if (effort) args.push("--reasoning-effort", effort);
    if (sessionId) args.push("--session-id", sessionId);
    if (logDir) args.push("--log-dir", logDir);
    if (maxCredits != null) args.push("--max-ai-credits", String(maxCredits));
    const child = spawn("copilot", args, cwd ? { cwd } : undefined);
    // Provenance: record the EXACT argv (prompt elided, length kept) beside the
    // raw stream. A silently-dropped flag is otherwise undetectable — a
    // --reasoning-effort that never reached the subprocess produced five arms
    // of flat, entirely plausible cost data. Also gives prompt size, which is
    // the denominator every cost claim here needs.
    const callMeta = {
      model,
      effort,
      sessionId: sessionId || null,
      resumedFrom: resumedFrom || null,
      tools: Array.isArray(tools) ? [...tools] : !!tools,
      cwd: cwd || null,
      promptChars: prompt ? prompt.length : 0,
      argv: args.map((a) => (a === prompt ? `<prompt:${prompt.length}chars>` : a)),
    };
    persistRaw(logDir, `${label}.argv`, JSON.stringify(callMeta, null, 2));
    let out = "";
    // A timeout kills the child and then resolves through the normal `close` path,
    // so without this flag the caller sees only whatever partial text the model had
    // emitted -- and reports whatever that text fails to be. The decompose phase
    // reported "could not parse chunks: Unexpected token 'G'" for a run that had
    // simply hit its 7-minute cap mid-exploration. The reason was available and
    // thrown away, which is the exact failure the observability rule exists to stop.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      // Mirror to a .live.jsonl so the run is watchable in flight; the settled
      // .jsonl is still written once, at close, byte-identical.
      appendLive(logDir, label, d);
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const telemetry = parseCopilotJsonl(out);
      const rawPath = persistRaw(logDir, label, out);
      persistRaw(
        logDir,
        `${label}.argv`,
        JSON.stringify(
          {
            ...callMeta,
            sessionId: telemetry.sessionId || sessionId || null,
          },
          null,
          2,
        ),
      );
      const usage = telemetry.parsed
        ? {
            input: null,
            output: telemetry.outputTokensTotal ?? null,
            total: null,
            premiumRequests: telemetry.usage.premiumRequests,
            apiMs: telemetry.usage.totalApiDurationMs,
          }
        : null;
      // THE EXIT CODE IS AN ANSWER, and it used to be thrown away here. A stage
      // whose model call never happened -- the CLI rejected the flags and exited
      // non-zero, printing the reason to stderr -- resolved with that error text
      // as its "output" and was recorded ok:true, no error, no halt. Observed: a
      // model that does not accept --reasoning-effort produced a run whose record
      // said the stage succeeded and the chain simply delivered nothing.
      //
      // The reason is on stderr and already in `out`, so keep it: an exit code
      // alone sends the reader to the logs for something the process said aloud.
      resolve({
        text: telemetry.finalText || out,
        usage,
        telemetry,
        rawPath,
        timedOut,
        timeoutMs,
        exitCode: exitCode ?? null,
        exitReason: exitCode ? lastErrorLine(out) : null,
      });
    });
  });
}

// Resolve a recorded stream, MIRRORING the real run-log layout: a chunk's calls
// live in `<logs>/<chunk>/<label>.jsonl`, so a fixture directory has the exact
// shape of a real run's log dir. That is deliberate -- it means FLASH_CHAIN_REPLAY
// can be pointed at ANY past run's logs to re-drive the harness against real
// recorded data, not only at hand-built fixtures. Labels like "build" repeat
// across chunks, so the chunk segment is what disambiguates them.
function resolveReplayFile(replayDir, logDir, label) {
  const seg = logDir ? path.basename(logDir) : null;
  const scoped = seg ? path.join(replayDir, seg, `${label}.jsonl`) : null;
  if (scoped && fs.existsSync(scoped)) return scoped;
  return path.join(replayDir, `${label}.jsonl`);
}

// Replay a recorded CLI stream instead of spawning one. Used ONLY by the
// calibration fixture (inttest.mjs) via FLASH_CHAIN_REPLAY.
//
// SAFETY: a replayed run must be impossible to mistake for a measurement. A
// test backdoor that can silently produce a plausible-looking run record would
// be the worst instance of the exact bug class this whole seam exists to catch.
// So every replayed result is stamped `replayed: true` at both the result and
// the telemetry level, and the driver refuses to present such a run as data.
function replayFromDisk({ replayDir, label, logDir, timeoutMs }) {
  const file = resolveReplayFile(replayDir, logDir, label);
  if (!fs.existsSync(file)) {
    // Fail LOUDLY. A missing fixture must not fall through to a real (paid)
    // call, and must not resolve to an empty stream that reads as "the model
    // said nothing" -- both would turn a fixture gap into a fake result.
    return Promise.resolve({
      text: "",
      usage: null,
      telemetry: { parsed: false, replayed: true, replayMissing: file },
      replayed: true,
      error: `FLASH_CHAIN_REPLAY is set but no recorded stream exists for label "${label}" (looked for ${file}). Refusing to make a real call while replaying.`,
    });
  }
  const out = fs.readFileSync(file, "utf8");
  // Identical to the live close-path below -- same parser, same persistence.
  const telemetry = parseCopilotJsonl(out);
  const rawPath = persistRaw(logDir, label, out);
  const usage = telemetry.parsed
    ? {
        input: null,
        output: telemetry.outputTokensTotal ?? null,
        total: null,
        premiumRequests: telemetry.usage.premiumRequests,
        apiMs: telemetry.usage.totalApiDurationMs,
      }
    : null;
  return Promise.resolve({
    text: telemetry.finalText || out,
    usage,
    telemetry: { ...telemetry, replayed: true },
    rawPath,
    timedOut: false,
    timeoutMs,
    exitCode: 0,
    exitReason: null,
    replayed: true,
  });
}

// Unified completion. Returns { text, usage, telemetry?, error? }.
export async function complete({
  prompt,
  model,
  effort = "high",
  json = false,
  timeoutMs = 240000,
  logDir,
  label,
  maxCredits,
  sessionId,
  resumedFrom,
  tools = false,
  cwd,
}) {
  const p = providerFor(model);
  if (p.kind === "azure") return azureComplete({ prompt, model: p.model, effort, json, timeoutMs });
  return cliComplete({
    prompt,
    model: p.model,
    effort,
    timeoutMs,
    logDir,
    label,
    maxCredits,
    sessionId,
    resumedFrom,
    tools,
    cwd,
  });
}
