// Parse the Copilot CLI's `--output-format json` stream (JSONL, one event per
// line) into a rich, durable telemetry record. Telemetry is the oxygen of AI:
// we keep the FULL raw stream on disk (persistRaw) and parse everything we can
// name here, so no run is ever a black box. Nothing is thrown away — unknown
// event types still land in `eventTypeCounts`.
//
// The single most valuable event is `result`, which carries:
//   usage.premiumRequests, usage.totalApiDurationMs, usage.sessionDurationMs,
//   usage.codeChanges.{linesAdded, linesRemoved, filesModified[]}, sessionId, exitCode
// `assistant.message` events carry per-turn model, phase, outputTokens, and
// toolRequests[] (what the model asked to run).

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";

export function parseCopilotJsonl(raw) {
  const events = [];
  for (const ln of String(raw || "").split("\n")) {
    const s = ln.trim();
    if (!s || s[0] !== "{") continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* a non-JSON line (rare) — ignore; raw stream is persisted anyway */
    }
  }

  const eventTypeCounts = {};
  const messages = [];
  const toolCalls = [];
  const reads = [];
  const toolCallsByName = {};
  const models = new Set();
  const errors = [];
  const finalParts = [];
  let result = null;
  let usageCheckpoint = null;
  let outputTokensTotal = 0;
  // A response the model was CUT OFF from finishing. The provider says so
  // explicitly (`finish_reason: "length"`), and throwing that away is how a
  // truncated answer arrives downstream looking like a badly-behaved model:
  // JSON extraction fails and the run halts on "no parseable JSON in output",
  // which names the symptom and hides the cause. Observed for real -- a stage
  // whose final message began mid-word, with a closing fence and no opening one.
  let truncatedCalls = 0;
  let maxOutputTokens = null;
  // The text of EVERY model call, in order. A turn that was cut off never emits
  // an `assistant.message`, so its output exists only here -- and a cut-off
  // answer is precisely the case where the model then CONTINUES in the next
  // call. Keeping only the assistant messages therefore keeps only the last
  // fragment of a long answer, which is how a complete, valid reply was
  // discarded as unparseable while sitting whole in the log.
  const callTexts = [];

  for (const e of events) {
    const t = e.type || "?";
    eventTypeCounts[t] = (eventTypeCounts[t] || 0) + 1;

    if (t === "result") result = e;

    // The billed cost of the run. `totalNanoAiu` is the authoritative number
    // the service charges — it is cumulative for the session, so the LAST
    // checkpoint wins. Before this existed we regexed the human-readable
    // "AI Credits" line out of stdout, which is a display string, not data.
    if (t === "session.usage_checkpoint" && e.data) usageCheckpoint = e.data;

    if (t === "model.model_call_success" && e.data) {
      const choice = e.data.responseChunk?.choices?.[0];
      if (choice?.finish_reason === "length") truncatedCalls++;
      const partial = choice?.delta?.content;
      if (partial)
        callTexts.push({
          turn: e.data.turn ?? null,
          text: String(partial),
          truncated: choice?.finish_reason === "length",
        });
      if (typeof e.data.maxOutputTokens === "number") maxOutputTokens = e.data.maxOutputTokens;
    }

    if (t === "assistant.message") {
      const d = e.data || {};
      if (d.model) models.add(d.model);
      if (typeof d.outputTokens === "number") outputTokensTotal += d.outputTokens;
      const reqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
      for (const tr of reqs) {
        const name = tr.name || tr.toolName || tr.tool || tr.type || "?";
        toolCalls.push({ name, turnId: d.turnId });
        toolCallsByName[name] = (toolCallsByName[name] || 0) + 1;
      }
      messages.push({
        turnId: d.turnId ?? null,
        phase: d.phase ?? null,
        model: d.model ?? null,
        outputTokens: d.outputTokens ?? null,
        toolRequestCount: reqs.length,
        contentPreview: (d.content || "").slice(0, 240),
      });
      if (d.phase === "final_answer" && d.content) finalParts.push(d.content);
    }

    // Any tool.* lifecycle event (execution_start/complete/...) — count by name
    // so we still see tool activity even if a CLI version doesn't echo it back
    // on the assistant.message.
    if (t.startsWith("tool.")) {
      const d = e.data || {};
      const name = d.name || d.toolName || d.tool || t;
      const key = `${t}:${name}`;
      toolCallsByName[key] = (toolCallsByName[key] || 0) + 1;

      // Record what the builder ACTUALLY ingested, not what it was asked to.
      // Measured hazard: told to read a 2,828-line file "in full", flash ran
      // `sed -n '1,220p' file | tail -n 50` and read ~2% of it, then answered
      // confidently. Nothing in the reply admits the file was sampled. We keep
      // the arguments so `auditReads()` can catch that before we trust an answer.
      if (t === "tool.execution_start") {
        const a = d.arguments || {};
        reads.push({
          callId: d.toolCallId ?? null,
          tool: name,
          // `view`-style reads name a path directly; bash reads are inferred by
          // the CLI itself into shellToolInfo.possiblePaths, which is more
          // reliable than us re-parsing a shell pipeline.
          paths: a.path
            ? [a.path]
            : Array.isArray(d.shellToolInfo?.possiblePaths)
              ? d.shellToolInfo.possiblePaths
              : [],
          command: a.command ?? null,
          range: a.view_range ?? null,
          resultBytes: null,
        });
      }
      // Pair the result size back onto its call so truncation is visible: tool
      // results are hard-capped (responseTokenLimit 32000, truncateStyle
      // "middle"), so a large file silently arrives with its middle removed.
      if (t === "tool.execution_complete") {
        const id = d.toolCallId ?? null;
        const body = d.result?.content ?? d.result ?? null;
        const bytes =
          body == null
            ? null
            : String(typeof body === "string" ? body : JSON.stringify(body)).length;
        const slot = id ? reads.find((r) => r.callId === id) : reads[reads.length - 1];
        if (slot && bytes != null) slot.resultBytes = bytes;
      }
    }

    if (/error|failed|rejected/i.test(t)) errors.push({ type: t, data: e.data ?? null });
  }

  const usage = (result && result.usage) || {};
  const cc = usage.codeChanges || {};
  const uc = usageCheckpoint || {};
  const nanoAiu = typeof uc.totalNanoAiu === "number" ? uc.totalNanoAiu : null;
  // Prompt-cache TTL per model. Directly relevant to warm-vs-cold economics:
  // a resumed turn inside the TTL is billed very differently from a cold one.
  const cache = Array.isArray(uc.modelCacheState) ? uc.modelCacheState : [];
  // If no final_answer message was tagged, fall back to the last assistant
  // message with any content so the reviewer/decomposer text is never lost.
  let finalText = finalParts.join("\n").trim();
  if (!finalText) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "assistant.message" && e.data && e.data.content) {
        finalText = e.data.content;
        break;
      }
    }
  }

  return {
    parsed: events.length > 0,
    eventCount: events.length,
    eventTypeCounts,
    exitCode: result?.exitCode ?? null,
    sessionId: result?.sessionId ?? null,
    usage: {
      // Billed cost. `aiu` is the real currency; `premiumRequests` is a
      // different (and coarser) meter that is null for non-premium models.
      totalNanoAiu: nanoAiu,
      aiu: nanoAiu != null ? nanoAiu / 1e9 : null,
      billedPremiumRequests:
        typeof uc.totalPremiumRequests === "number" ? uc.totalPremiumRequests : null,
      premiumRequests: usage.premiumRequests ?? null,
      totalApiDurationMs: usage.totalApiDurationMs ?? null,
      sessionDurationMs: usage.sessionDurationMs ?? null,
    },
    modelCache: cache.map((c) => ({
      modelId: c.modelId ?? null,
      cacheExpiresAt: c.cacheExpiresAt ?? null,
      cacheTtlSeconds: c.cacheTtlSeconds ?? null,
    })),
    codeChanges: {
      linesAdded: cc.linesAdded ?? null,
      linesRemoved: cc.linesRemoved ?? null,
      filesModified: Array.isArray(cc.filesModified) ? cc.filesModified : [],
    },
    turns: eventTypeCounts["assistant.turn_end"] || 0,
    messageCount: messages.length,
    outputTokensTotal,
    truncatedCalls,
    maxOutputTokens,
    callTexts,
    toolCallCount: toolCalls.length,
    reads,
    toolCallsByName,
    models: [...models],
    errors,
    messages,
    finalText,
  };
}

// One-line human summary for the console/run log.
function summarizeTelemetry(t, gitStat = null) {
  if (!t || !t.parsed) return "no telemetry";
  const bits = [];
  bits.push(`${t.turns}t`);
  if (t.toolCallCount) bits.push(`${t.toolCallCount} tool`);
  if (t.outputTokensTotal) bits.push(`${t.outputTokensTotal} out-tok`);
  if (t.usage.aiu != null) bits.push(`${t.usage.aiu.toFixed(4)} AiU`);
  else if (t.usage.premiumRequests != null) bits.push(`${t.usage.premiumRequests} req`);
  if (t.usage.totalApiDurationMs != null)
    bits.push(`api ${(t.usage.totalApiDurationMs / 1000).toFixed(1)}s`);
  // Prefer git's answer over the builder's self-report. The self-report has been
  // measured undercounting to ZERO on a chunk that really landed 54 insertions
  // across 2 files, and an undercount reads as "the builder did nothing" — the
  // single most misleading thing this line can say, because it invites you to
  // debug a build that in fact worked.
  const cc = gitStat
    ? { linesAdded: gitStat.added, linesRemoved: gitStat.removed, filesModified: gitStat.files }
    : t.codeChanges;
  if (cc.linesAdded != null || cc.linesRemoved != null) {
    bits.push(
      `+${cc.linesAdded ?? 0}/-${cc.linesRemoved ?? 0} in ${cc.filesModified.length} file${cc.filesModified.length === 1 ? "" : "s"}${gitStat ? "" : " (self-reported)"}`,
    );
  }
  if (t.errors.length) bits.push(`⚠${t.errors.length} err`);
  return bits.join(" · ");
}

// Persist the full raw JSONL stream to disk — durable, greppable, never lost.
// Returns the file path (or null if no logDir/label given).
export function persistRaw(logDir, label, raw) {
  if (!logDir || !label) return null;
  try {
    mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${label}.jsonl`);
    writeFileSync(file, String(raw || ""));
    // The phase is over, so the partial stream has served its purpose and would
    // now only be a second, staler copy of the same bytes for a reader to pick
    // the wrong one of.
    try {
      rmSync(path.join(logDir, `${label}.live.jsonl`), { force: true });
    } catch {
      /* best effort: a leftover .live file is cosmetic, never a correctness problem */
    }
    return file;
  } catch {
    return null;
  }
}

// Append a chunk of a still-running phase's stdout, so the run is observable
// WHILE it happens rather than only after.
//
// Measured, because the obvious assumption was wrong: the `.jsonl` that the CLI
// writes via --log-dir appears complete at process EXIT (watched from creation at
// 1s resolution -- 220 lines present in the first sample, zero growth after). But
// the CLI's stdout under `--output-format json` genuinely does stream: a trivial
// prompt produced 25 chunks over 7.3s, all well before close. The harness already
// had live data in hand and was accumulating it in memory until the end.
//
// So this writes what we already receive, as we receive it. It is deliberately a
// SEPARATE file from `${label}.jsonl`: the final artifact stays byte-identical and
// written exactly once, so nothing downstream has to reason about a file that
// might be half-written. Readers treat `.live.jsonl` as "this phase is in flight"
// and the plain `.jsonl` as the settled record.
export function appendLive(logDir, label, chunk) {
  if (!logDir || !label || !chunk) return;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, `${label}.live.jsonl`), String(chunk));
  } catch {
    /* liveness is a convenience; never let it break a run */
  }
}

// This parser decides what every downstream reader sees, and until now it had no
// suite: a field it silently stops capturing looks exactly like a field the run
// never produced. The cases below are the ones with teeth -- a truncation signal
// that must be seen, and the false-positive side (a normal stop is NOT a
// truncation), which is the half that rots quietly.
export function selfTest() {
  const cases = [];
  const line = (type, data) => JSON.stringify({ type, data });
  const call = (reason, max = 32000) =>
    line("model.model_call_success", {
      maxOutputTokens: max,
      responseChunk: { choices: [{ finish_reason: reason }] },
    });

  const cut = parseCopilotJsonl([call("tool_calls"), call("length"), call("stop")].join("\n"));
  cases.push(["a cut-off response is counted", cut.truncatedCalls === 1]);
  cases.push(["the output ceiling is captured", cut.maxOutputTokens === 32000]);

  const clean = parseCopilotJsonl([call("tool_calls"), call("stop")].join("\n"));
  cases.push(["a normal stop is not a truncation", clean.truncatedCalls === 0]);

  // Every truncated call counts, not just the first: the real run that motivated
  // this hit the ceiling twice, and "was it truncated" and "how badly" are
  // different questions.
  const twice = parseCopilotJsonl([call("length"), call("length")].join("\n"));
  cases.push(["every cut-off call counts", twice.truncatedCalls === 2]);

  // A provider that reports no finish_reason must read as "not truncated" rather
  // than throwing -- an unknown is not evidence of a fault.
  const quiet = parseCopilotJsonl(line("model.model_call_success", { responseUsage: {} }));
  cases.push(["a missing finish_reason is not a truncation", quiet.truncatedCalls === 0]);

  return cases;
}
