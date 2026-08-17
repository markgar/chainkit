#!/usr/bin/env node
// Ask the CLI which model ids it will actually accept.
//
// WHY THIS EXISTS. A chain names its models as bare strings, and a typo in one is
// not discovered until the kernel spawns that stage -- which, for a stage late in a
// fan-out, is after every earlier stage has been paid for. The engine cannot check
// the id itself, because it does not own the list: `copilot` does, the set moves as
// models ship and retire, and it varies by account and org. So the only honest
// answer to "is this id real" comes from the binary.
//
// The CLI has no enumerate command -- `/model` is an interactive picker, and there
// is no `--list`. What it DOES have is a clean rejection: an unavailable id fails
// with `Model "x" from --model flag is not available` before anything is generated.
// This tool turns that into an answer by probing candidates one at a time.
//
// THE PROBE IS NOT FREE. An id that IS available runs the prompt, so each accepted
// model costs one tiny inference call. That is why this is a separate tool you run
// deliberately, and NOT part of `--validate-only`, whose whole promise is that it
// costs nothing. Keep it that way.
//
// Usage:
//   node models.mjs                 probe the built-in candidate list
//   node models.mjs a b c           probe exactly these ids
//   node models.mjs --roster        print a kernel/models.mjs roster block to paste
//
// The candidate list below is only a list of ids worth ASKING about. It is not a
// claim that any of them exist -- the output is the claim.

import { spawnSync } from "node:child_process";

const CANDIDATES = [
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5-mini",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "grok-4.6",
  "grok-4.5",
  "mai-code-1.1-flash",
  "mai-code-1-flash-picker",
  "auto",
];

// The CLI's rejection sentence. Matched loosely on purpose: the wording around it
// has changed before, and the failure mode of matching too tightly is that every
// model reads as available -- a false GREEN, which is the direction that hurts.
const REJECTED = /is not available/i;

function probe(model) {
  const r = spawnSync("copilot", ["-p", "ok", "--model", model, "--available-tools", ""], {
    encoding: "utf8",
  });
  if (r.error) return { model, ok: false, reason: `could not spawn copilot: ${r.error.message}` };
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (REJECTED.test(out)) return { model, ok: false, reason: "rejected by the CLI" };
  // Anything else -- including a non-zero exit for an unrelated reason -- is NOT
  // evidence of an unavailable model. Report it as inconclusive rather than
  // recording a network blip as a retired model.
  if (r.status !== 0)
    return {
      model,
      ok: null,
      reason: `inconclusive (exit ${r.status}): ${out.trim().slice(0, 120)}`,
    };
  return { model, ok: true, reason: "accepted" };
}

function main() {
  const args = process.argv.slice(2);
  const wantRoster = args.includes("--roster");
  const ids = args.filter((a) => !a.startsWith("--"));
  const list = ids.length ? ids : CANDIDATES;

  const results = [];
  for (const m of list) {
    const r = probe(m);
    results.push(r);
    const mark = r.ok === true ? "✓" : r.ok === false ? "✗" : "?";
    console.error(`${mark} ${m.padEnd(26)} ${r.reason}`);
  }

  const good = results.filter((r) => r.ok === true).map((r) => r.model);
  const unsure = results.filter((r) => r.ok === null);
  console.error(
    `\n${good.length} available, ${results.length - good.length - unsure.length} rejected, ${unsure.length} inconclusive`,
  );
  if (unsure.length) console.error("inconclusive ids were NOT counted either way -- re-run them.");

  if (wantRoster) {
    console.log(`// Probed with \`node models.mjs\` on ${new Date().toISOString().slice(0, 10)}.`);
    console.log("export const KNOWN_MODELS = new Set([");
    for (const m of good) console.log(`  "${m}",`);
    console.log("]);");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
