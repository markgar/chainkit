// The model ids the CLI is known to accept, and the advisory check over them.
//
// WHAT THIS IS FOR. A chain names its models as bare strings. Nothing checks them
// until the kernel spawns that stage, so `claude-opus-4.8` misspelled as
// `claude-opus-48` is discovered at dispatch -- and for a stage late in a fan-out,
// that is after every earlier stage has already been paid for. Catching it at
// validate time costs nothing and saves the whole prefix of the run.
//
// WHY IT IS A WARNING AND NOT AN ERROR. chainkit does not own this list. `copilot`
// does, and the set moves as models ship and retire, and it differs by account and
// org. A hard allowlist in the engine would therefore do the one unforgivable
// thing: reject a chain naming a model that is perfectly real, just newer than this
// file. So an unrecognised id is reported as "not in the roster, check the
// spelling" and the run proceeds. The roster is a spell-checker, not a gate.
//
// Which direction to be wrong in, when this rots: a stale roster that misses a NEW
// model produces a spurious warning, which is annoying. A roster trusted as a gate
// would block the run entirely. Warning is the survivable failure.
//
// HOW TO REFRESH IT. Run the probe at the repo root, which asks the real binary:
//
//     node models.mjs --roster
//
// and paste its output over KNOWN_MODELS below. The probe is deliberately NOT run
// from here: every id it confirms costs one real inference call, and validation is
// supposed to be free.

import { providerFor } from "./providers.mjs";

// Probed with `node models.mjs` on 2026-08-17.
// "auto" is in the list because it is a real accepted value, not a model -- it asks
// the CLI to choose. A chain may legitimately use it.
const KNOWN_MODELS = new Set([
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
]);

// Cheap nearest-match, so the warning can say what was probably meant. Levenshtein
// over the roster is fine at this size (tens of entries, once per validate).
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function nearestModel(id, roster = KNOWN_MODELS) {
  let best = null;
  let bestD = Infinity;
  for (const cand of roster) {
    const d = distance(id, cand);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  // Only volunteer a suggestion when it is close enough to be plausible. A wrong
  // guess ("did you mean auto?") is worse than none -- it sends the reader after
  // the wrong fix.
  return bestD <= Math.max(2, Math.floor(id.length / 3)) ? best : null;
}

// The models a chain will actually ask the CLI for. Stages with no model use the
// chain default; an Azure-routed id is not the CLI's to validate, so it is skipped
// (asking providerFor rather than re-deriving the rule -- see its comment).
function cliModelsOf(chain) {
  const ids = new Set();
  const add = (m) => {
    if (m && providerFor(m).kind === "cli") ids.add(m);
  };
  add(chain?.model);
  for (const s of chain?.stages || []) add(s.model);
  return ids;
}

export function modelWarnings(chain, roster = KNOWN_MODELS) {
  const out = [];
  for (const id of cliModelsOf(chain)) {
    if (roster.has(id)) continue;
    const near = nearestModel(id, roster);
    out.push(
      `model "${id}" is not in the known roster` +
        (near ? ` (did you mean "${near}"?)` : "") +
        `. The roster is a spell-check, not a completion contract: if the id is real and just newer ` +
        `than kernel/models.mjs, refresh it with \`node models.mjs --roster\`. ` +
        `An id the CLI does not accept fails at dispatch, after earlier stages are paid for.`,
    );
  }
  return out;
}

export function selfTest() {
  const CASES = [];
  const roster = new Set(["claude-opus-5", "claude-sonnet-5", "gpt-5.3-codex", "auto"]);
  const warn = (chain) => modelWarnings(chain, roster);

  CASES.push([
    "a roster model is not warned about",
    warn({ stages: [{ id: "a", model: "claude-opus-5" }] }).length === 0,
  ]);
  CASES.push([
    "an unknown model is warned about",
    warn({ stages: [{ id: "a", model: "claude-opus-77" }] }).length === 1,
  ]);
  CASES.push([
    "the warning suggests the nearest match",
    warn({ stages: [{ id: "a", model: "claude-opus5" }] })[0].includes(
      'did you mean "claude-opus-5"',
    ),
  ]);
  // The failure that motivated this: the version-bump typo. It must be CAUGHT, and
  // it must point at the right neighbour, or the warning sends the reader wrong.
  CASES.push([
    "a version typo is caught, not waved through",
    warn({ stages: [{ id: "a", model: "claude-opus-48" }] }).length === 1,
  ]);
  CASES.push([
    "a wild id gets no misleading suggestion",
    !warn({ stages: [{ id: "a", model: "zzzzzzzzzzzzzzzz" }] })[0].includes("did you mean"),
  ]);
  // Azure is not the CLI's to validate. Warning here would be a false positive on a
  // perfectly good deployment name.
  CASES.push([
    "an azure: id is not checked against the CLI roster",
    warn({ stages: [{ id: "a", model: "azure:my-deployment" }] }).length === 0,
  ]);
  CASES.push([
    "a deepseek id is not checked against the CLI roster",
    warn({ stages: [{ id: "a", model: "DeepSeek-R1" }] }).length === 0,
  ]);
  CASES.push([
    "the chain-level default model is checked too",
    warn({ model: "gpt-5.3-codexx", stages: [{ id: "a" }] }).length === 1,
  ]);
  CASES.push([
    "a stage with no model inherits and is not double-reported",
    warn({ model: "claude-opus-5", stages: [{ id: "a" }, { id: "b" }] }).length === 0,
  ]);
  // Two stages naming the SAME bad id is one mistake, not two warnings.
  CASES.push([
    "a repeated bad id warns once",
    warn({
      stages: [
        { id: "a", model: "bogus-model-x" },
        { id: "b", model: "bogus-model-x" },
      ],
    }).length === 1,
  ]);
  CASES.push([
    "'auto' is accepted as a real value",
    warn({ stages: [{ id: "a", model: "auto" }] }).length === 0,
  ]);
  CASES.push(["an empty chain warns about nothing", warn({}).length === 0]);

  return CASES;
}
