# chainkit

A generic engine for running **configured chains of model stages**. The kernel calls the CLI, renders prompts, gathers telemetry, records the run, and runs the declared gate. **Which** models, in **which** order, with **which** prompts is config.

Adding a stage is a config edit, not a code change.

## Why it exists

flash-chain proved the infrastructure — CLI invocation, session continuity, AiU accounting, run records — but its process (decompose → contract → build → review) is welded into a 2200-line driver. Changing the process means changing code, so every experiment costs an engine edit. chainkit keeps the infrastructure and makes the process data.

## Design rule

**There are no stage kinds.** A stage is uniform: prompt + model → artifact. The kernel does not know what a "review" is; a review is a stage whose prompt asks for a verdict and whose output parses as JSON. The moment the kernel branches on a stage id, "add a stage is just config" stops being true.

Control flow is exactly two things: stages run in order, and one bounded `loop` repeats a subset until a named artifact field is true.

## Layout

    run.mjs              the driver
    check.mjs            the whole gate: format, lint, deadcode, every selftest
    selftest.mjs         deterministic behaviour gate — run after any kernel change
    kernel/
      config.mjs         load + STATIC validation (fails free, before any spend)
      context.mjs        artifact store + {{placeholder}} rendering
      stage.mjs          run one stage — the only place a model is called
      providers.mjs      \ copied from flash-chain, unmodified:
      telemetry.mjs       | JSONL parse, raw persistence, live mirror
      cost.mjs           / AiU accounting with the cumulative-snapshot rules
      tree.mjs           working-tree snapshot/delta — a builder's product
      foreach.mjs        fan-out: run a stage list once per element of an array
    chains/<name>.yaml   a chain: seeds, stages, loop, gate (YAML: it takes comments)
    prompts/<name>.md    a stage's prompt; {{artifact}} is interpolated
    fixtures/<name>/     greenfield graders used to measure the engine itself
    extensions/          the two canvases: a live run dashboard and a chain designer
    results/chain-runs/  one JSON record per run + per-stage raw JSONL under logs/

## The gate

    node check.mjs        (or `pnpm chainkit:check` from the host repo)

format + lint + knip + every shipped chain + every selftest, including the two canvases'. This is what CI runs. The selftests are the load-bearing part: the static checks check shape, the selftests are the only check of behaviour, and they have caught defects the rest waved through. The `chains` step validates every chain in `chains/` and fails on orphan prompts — knip reads `.mjs`, so without it the engine's config is the one thing the gate never looks at.

Run output deliberately uses flash-chain's on-disk layout so the canvas — and the AiU accounting inside it — reads chainkit runs unmodified.

## Use

    node run.mjs --chain chains/solo-code.yaml --validate-only     # free
    node run.mjs --chain chains/solo-code.yaml --workdir /abs/path --tag a1

`--validate-only` checks every artifact reference, prompt file, loop bound and stage key without spending anything. It also warns — advisory, never fatal — about the two quiet wiring mistakes: a stage whose output nothing reads, and an `expects` field the prompt is never asked for (including a `foreach`'s element shape, checked against the prompt of whichever stage produces the array). Both of those otherwise cost a full run to discover.

## What it deliberately does NOT have

flash-chain's typed gates (env-vs-code triage, red-before-build, acceptance-shape veto) are its best work, but they are typed to ITS artifacts. They get copied in when a chain needs one — not ported wholesale to run four stages.

## Vendoring it into a repo

chainkit is consumed by copying it into a host repo at `vendor/chainkit/`. The split that matters:

- **`vendor/chainkit/`** is the engine and its **examples**. It is replaced wholesale on upgrade and never edited in the host.
- **`.chainkit/`** in the host is what the host owns: the chains it actually runs, their prompts, and the run records they produce.

The test the split is designed against: **delete `vendor/chainkit/`, drop in a newer copy, lose nothing.** If something you would miss dies in that swap, it was in the wrong directory. Run records follow the same rule — the engine writes them beside the **chain** that produced them (`<chain dir>/../results`), so a host chain records into the host, not into a directory the next upgrade destroys.

The chains here are examples on purpose. `p1-code` → `p2-code-review-fix` → `fanout-code` is a deliberate ablation ladder: each adds exactly one construct on the same builder, so the difference between them is attributable. Do not "tidy" them into one.

The two canvases under `extensions/` are part of the engine's surface, so `check.mjs` runs their selftests. A host repo installs them wherever it keeps extensions; the gate looks them up in both places rather than requiring either.

## Developing

    pnpm install
    node check.mjs

**No lockfile is committed yet, deliberately** — see `.gitignore`. The development machine's npm registry is a corporate mirror that rewrites every resolution line to internal, authenticated hosts, and publishing that in a public repo would leak infrastructure and hand contributors URLs they cannot reach. CI installs with `--no-frozen-lockfile` on a runner that reaches public npm; that is where a clean lockfile should come from.

Note that a host repo lints vendored chainkit with **its own** eslint/prettier config, not the one here. Keep the two in agreement, or accept that the gates can disagree — the vendoring test cannot see that.
