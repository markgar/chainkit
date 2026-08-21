# chainkit

A generic engine for running **configured chains of model stages**. The kernel calls the CLI, renders prompts, gathers telemetry, records the run, and runs the declared gate. **Which** models, in **which** order, with **which** prompts is config.

Adding a stage is a config edit, not a code change.

## Why it exists

The infrastructure a multi-model process needs — invoking the CLI, keeping a session alive across stages, parsing telemetry, accounting for cost, recording what happened — is real work, and it is the same work every time. The **process** on top of it is not: how many stages, which models, what gets reviewed by whom, how many repair rounds.

Weld the two together and the process becomes code, so every change to it is an engine edit and every experiment costs a rewrite. chainkit keeps the infrastructure and makes the process **data**. Adding a stage, swapping a model, or changing a loop bound is a config edit that costs nothing to validate.

## Design rule

**There are no stage kinds.** A stage is uniform: prompt + model → artifact. The kernel does not know what a "review" is; a review is a stage whose prompt asks for a verdict and whose output parses as JSON. The moment the kernel branches on a stage id, "add a stage is just config" stops being true.

Control flow is exactly two things: stages run in order, and one bounded `loop` repeats a subset until a named artifact field is true.

**A loop that never reaches its condition halts the run.** `until` is the chain's own statement of when the loop's output is fit to use, so exhausting `max` without reaching it is a failed precondition, not a lap counter running out — and continuing spends everything downstream (typically a fan-out, at many times the loop's cost) on an artifact the chain's own reviewer rejected. Set `onExhausted: continue` for the case where continuing is right: a loop whose reviewer is **advisory** because something objective follows it, as in [03-bounded-loop](examples/03-bounded-loop/), where the gate rather than the reviewer decides. An unsatisfied loop is recorded as unsatisfied either way, and blocks `delivered` either way. The key is rejected on a `foreach`'s inner loop, where that element's gate already runs next and stopping early would discard it.

## Layout

    run.mjs              the driver
    models.mjs           probe the CLI for which model ids it actually accepts
    check.mjs            the whole gate: format, lint, deadcode, every selftest
    selftest.mjs         deterministic behaviour gate — run after any kernel change
    kernel/
      config.mjs         load + STATIC validation (fails free, before any spend)
      context.mjs        artifact store + {{placeholder}} rendering
      stage.mjs          run one stage — the only place a model is called
      providers.mjs      how a model is invoked, and what is kept out of its prompt
      telemetry.mjs      JSONL parse, raw persistence, live mirror
      cost.mjs           AiU accounting with the cumulative-snapshot rules
      tree.mjs           working-tree snapshot/delta — a builder's product
      foreach.mjs        fan-out: run a stage list once per element of an array
      models.mjs         the known model roster + the advisory spell-check over it
    examples/NN-name/    one worked chain per directory: chain.yaml, its prompts, a README
    fixtures/<name>/     greenfield graders — the objective definition of done
    extensions/          the two canvases: a live run dashboard and a chain designer
    results/chain-runs/  one JSON record per run + per-stage raw JSONL under logs/

A chain is a `.yaml` file (YAML because it takes comments, and the reasons behind a roster are worth writing down). A prompt is a `.md` file in a `prompts/` directory beside it; `{{artifact}}` is interpolated.

## The gate

    node check.mjs        (or `pnpm chainkit:check` from the host repo)

format + lint + knip + every shipped chain + every selftest, including the two canvases'. This is what CI runs.

The selftests are the load-bearing part: the static checks check shape, the selftests are the only check of behaviour, and they have caught defects the rest waved through. The `chains` step validates every chain it can find and fails on orphan prompts — knip reads `.mjs`, so without it the engine's config would be the one thing the gate never looks at. It treats warnings as failures for shipped chains: a worked example carrying a known wiring mistake teaches that mistake to everyone who copies it.

## Use

    node run.mjs --chain examples/01-single-stage/chain.yaml --validate-only    # free
    node run.mjs --chain examples/01-single-stage/chain.yaml --workdir /abs/path --tag a1

`--validate-only` checks every artifact reference, prompt file, loop bound and stage key without spending anything. It also warns — advisory, never fatal — about the quiet wiring mistakes: a stage whose output nothing reads, an `expects` field the prompt is never asked for (including a `foreach`'s element shape, checked against the prompt of whichever stage produces the array), and a model id that is not in the known roster. All of those otherwise cost a full run to discover.

## Models

A stage names its model as a bare string, and until it is dispatched nothing checks it. For a stage late in a fan-out that means a typo is discovered _after_ every earlier stage has been paid for. `kernel/models.mjs` carries a roster of ids the CLI is known to accept, and `--validate-only` warns (with a nearest-match suggestion) about anything not in it.

It is a **spell-check, not a gate**, and that is deliberate: chainkit does not own the list. `copilot` does, the set moves as models ship and retire, and it varies by account and org. A hard allowlist would eventually reject a chain naming a model that is real and simply newer than this file — so an unknown id warns and the run proceeds. A stale roster costs a spurious warning; a roster trusted as a gate would block working chains.

The CLI has no enumerate command (`/model` is an interactive picker; there is no `--list`), so the roster is refreshed by asking the binary one id at a time:

    node models.mjs                 probe the built-in candidate list
    node models.mjs a b c           probe exactly these ids
    node models.mjs --roster        print a KNOWN_MODELS block to paste into kernel/models.mjs

Every id the probe confirms costs one real inference call, which is exactly why it is a separate tool and **not** part of `--validate-only` — validation is free and must stay that way. The probe reports anything that is not a clean rejection as _inconclusive_ rather than absent, so a network blip is never recorded as a retired model.

`azure:`-prefixed and deepseek ids are routed to Azure Foundry, not the CLI, so the roster check skips them.

## Examples

[`examples/`](examples/) is a **ladder**, not a menu. Four chains, each adding exactly one construct to the one below it, so the difference between two rungs is attributable:

| rung | shape | what it adds |
| --- | --- | --- |
| [01-single-stage](examples/01-single-stage/) | `code` | the whole kernel, minimally |
| [02-review-and-fix](examples/02-review-and-fix/) | `code → review → fix` | artifacts between stages; `expects` |
| [03-bounded-loop](examples/03-bounded-loop/) | `code → (review → fix)*` | `loop` |
| [04-plan-and-fan-out](examples/04-plan-and-fan-out/) | `(plan → plan-review)* → per chunk …` | `foreach` |

Each directory is self-contained: the chain, every prompt it uses, and a README on what that rung is for and how to run it. **Do not tidy them into one** — the redundancy is what makes them measurable.

## What it deliberately does NOT have

**Typed gates.** Domain-aware checks — telling an environment failure from a code failure, proving a test is red before it is built against, vetoing an acceptance command of the wrong shape — are worth having, and they are typed to a specific chain's artifacts. A chain that needs one gets one; none of them are hoisted into the kernel, because the moment the kernel understands what a stage means, "adding a stage is config" stops being true.

**Branching.** Control flow is two things: stages run in order, and one bounded loop repeats a subset until a named field is true. There is no `if` and no stage that decides what runs next.

## Vendoring it into a repo

chainkit is consumed by copying it into a host repo at `vendor/chainkit/`. The split that matters:

- **`vendor/chainkit/`** is the engine and its **examples**. It is replaced wholesale on upgrade and never edited in the host. Verify that by recording a content hash of the copy and checking it in the host's own gate — an in-place edit here is not a small mistake, it is work that disappears later with no error and no diff.
- **`.chainkit/`** in the host is what the host owns: the chains it actually runs, their prompts, and the run records they produce.

The test the split is designed against: **delete `vendor/chainkit/`, drop in a newer copy, lose nothing.** If something you would miss dies in that swap, it was in the wrong directory. Run records follow the same rule — the engine writes them beside the **chain** that produced them (`<chain dir>/../results`), so a host chain records into the host, not into a directory the next upgrade destroys.

Note that the engine's own gate passes happily on a modified vendored copy: it checks whether the engine is **correct**, not whether it is **authentic**. Those are different questions and need two checks.

The two canvases under `extensions/` are part of the engine's surface, so `check.mjs` runs their selftests. A host repo installs them wherever it keeps extensions; the gate looks them up in both places rather than requiring either.

## Developing

    pnpm install
    node check.mjs

**No lockfile is committed yet, deliberately** — see `.gitignore`. The development machine's npm registry is a corporate mirror that rewrites every resolution line to internal, authenticated hosts, and publishing that in a public repo would leak infrastructure and hand contributors URLs they cannot reach. CI installs with `--no-frozen-lockfile` on a runner that reaches public npm; that is where a clean lockfile should come from.

Note that a host repo lints vendored chainkit with **its own** eslint/prettier config, not the one here. Keep the two in agreement, or accept that the gates can disagree — the vendoring test cannot see that.
