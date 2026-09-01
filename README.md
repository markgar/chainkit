# chainkit

A generic engine for running **configured chains of model stages**. The kernel calls the CLI, renders prompts, gathers telemetry, records the run, and enforces optional completion contracts. **Which** models, in **which** order, with **which** prompts is config.

Adding a stage is a config edit, not a code change.

## Why it exists

The infrastructure a multi-model process needs — invoking the CLI, keeping a session alive across stages, parsing telemetry, accounting for cost, recording what happened — is real work, and it is the same work every time. The **process** on top of it is not: how many stages, which models, what gets reviewed by whom, how many repair rounds.

Weld the two together and the process becomes code, so every change to it is an engine edit and every experiment costs a rewrite. chainkit keeps the infrastructure and makes the process **data**. Adding a stage, swapping a model, or changing a loop bound is a config edit that costs nothing to validate.

## Design rule

**The kernel never branches on what a stage is _for_.** The kernel does not know what a "review" is; a review is a stage whose prompt asks for a verdict and whose output parses as JSON. The moment the kernel branches on a stage id, "add a stage is just config" stops being true.

There are exactly **two stage kinds**, and the split is mechanical — what decides the output, not what the stage means:

| kind      | shape                     | cost |
| --------- | ------------------------- | ---- |
| `prompt:` | prompt + model → artifact | AiU  |
| `run:`    | shell command → artifact  | free |

A `run` stage exists because every real chain contains steps with no judgement in them — format the tree, install after a dependency edit, run codegen, read the diff, commit. Expressing those as a model call is worse in every measurable way: it costs a premium request, it can fail nondeterministically, and it can decline. It is deliberately **not** a lesser stage: its command is rendered with `{{artifact}}` like a prompt, it can `produce` a parsed artifact and declare its `expects` shape, and it can be a loop member — so a chain can branch on a **measured fact** and not only on an opinion:

```yaml
- id: probe
  run: 'printf ''{"clean": %s}'' "$(git diff --quiet && echo true || echo false)"'
  parse: json
  produces: probe
  expects: { clean: boolean }
loop:
  stages: [fix, probe]
  until: probe.clean
  max: 3
```

A `run` stage takes no `model`, `effort`, `tools`, `resume`, `resumeFrom`, or `resumePrompt`, and the config is **rejected** if it carries one rather than ignoring it: `run: pnpm format` alongside `model: claude-opus-5` is an author who believes a model is involved, and a run record showing a model that never ran is unreadable next to one that did. For the same reason chain `defaults.model` is not folded into it.

When a command exists only to decide whether a model stage has finished its own work, it is **not a stage**. Attach it as that stage's bounded completion rule:

```yaml
- id: code
  prompt: prompts/code.md
  model: gpt-5.6-sol
  tools: true
  resume: true
  completion:
    run: pnpm test && pnpm check
    attempts: 3
```

Chainkit appends this requirement to the stage's initial prompt, then runs the command independently after every turn. A failure is captured and sent back to the same stage. With `resume: true`, later completion attempts continue the same CLI conversation with only a compact message containing the exact frozen command, attempt number, bounded failure output, and an instruction to return a complete replacement answer without repeating discovery. With `resume: false`, each retry is fresh and therefore receives the full initial prompt plus the failure context. Provider transport retries remain identical request retries because they have no intervening answer or tool context. The stage cannot finish until the command passes. It halts on the declared bound, on a repeated failure with no file change, or if the supposedly read-only completion command changes the repository, index, or HEAD.

A stage may instead continue a compatible earlier model stage:

```yaml
- id: plan-fix
  prompt: prompts/plan-fix.md
  model: gpt-5.6-sol
  resumeFrom: plan
```

`resumeFrom` sends only `plan-fix`'s own rendered prompt while continuing the latest successful `plan` invocation's CLI conversation. The original planner prompt, repository discoveries, tool results, and answer are already in that session and are not replayed. The source and target must use the same resolved CLI model, the source must be an earlier model stage, and both must occupy the same logical execution scope. Top-level stages may resume top-level stages. A foreach stage may resume only a stage from the same item; top-level-to-item, item-to-top-level, and cross-item session sharing are rejected.

Within a bounded loop, matching is deterministic: the latest successful prior source invocation in the same scope wins. A source earlier in the loop body is available in the current round; a source later than the target is rejected because the target's first round would have nothing to resume. If a repeated source produced no successful invocation or no usable session id, the target fails with structured continuation telemetry — Chainkit never falls back to a fresh conversation.

`resume: true` and `resumeFrom` are mutually exclusive. The former continues the same stage's own latest successful invocation; the latter selects another stage's lineage. Completion retries treat either inherited session identically and send compact failure feedback. A resumed stage may also declare `resumePrompt: prompts/continue.md`; on a later ordinary invocation that is already on the same target lineage, Chainkit renders this smaller authored prompt instead of replaying the target's initial prompt. `resumePrompt` requires either `resume: true` or `resumeFrom` and uses the same placeholder validation as `prompt`.

Output-token telemetry uses the current CLI's `model.model_call_success.data.responseUsage.completion_tokens` as the authoritative source, with legacy `assistant.message.data.outputTokens` only as a fallback. Mixed streams are therefore counted once, while streams with no token telemetry remain explicitly unreported rather than appearing as zero.

**A command READS artifacts from a file, not from `{{...}}`.** Interpolation is right for a scalar (`pnpm test {{chunk.id}}`) and wrong for a structured artifact: `render` serialises an object as pretty-printed multi-line JSON, which is exactly what a prompt wants and is unsafe inside `bash -c` — a value containing an apostrophe, a backtick or a `$` is not rejected, it is silently mangled or executed. So every run stage is handed the whole store as a file instead:

| env var              | is                                                            |
| -------------------- | ------------------------------------------------------------- |
| `CHAINKIT_ARTIFACTS` | path to a JSON object of every artifact visible to this stage |
| `CHAINKIT_STAGE`     | the stage's `id`                                              |
| `CHAINKIT_ROUND`     | loop round, `0` outside a loop                                |
| `CHAINKIT_ITER`      | fan-out element index, `0` outside a fan-out                  |

```js
const all = JSON.parse(readFileSync(process.env.CHAINKIT_ARTIFACTS, "utf8"));
```

The file is written into the stage's own log directory on every path, including failure, so the run's record answers "what could this command actually see?" — which cannot be reconstructed afterwards, once the store has moved on.

**A stage that MEASURES should exit 0 when the answer is bad.** A non-zero exit means _the measurement itself failed_; encoding "the thing I measured is failing" the same way conflates "I could not look" with "I looked, and it is red" — and the second is a finding a later stage should read, not a reason to halt. Have the command emit its verdict as an artifact (`{"pass": false, ...}`) and let a reviewer or a `loop` condition act on it.

It is also the honest way to declare a deterministic **write**. A model stage with `tools: false` halts the run if the tree moves, because the config claimed it only reasons; a `run` stage is exempt, since writing is its job and its command is stated in the config in full — "what may this change" is answered by reading it, not by trusting a flag.

Control flow is explicit and bounded: stages run in order; `loop` repeats a subset until an artifact field is true; and the same optional `completion` contract judges an agent stage, each `foreach` item, or the assembled chain. `attempts` always means total checks, including the initial check. Agent retries automatically resume the owning stage; composite retries require ordinary stages under `repair.stages`.

**Declared position decides when a linear stage runs.** A stage that is neither a loop nor a fan-out member runs in the slot its position in `stages` puts it — before the blocks, between them, or after. This makes a post-fan-out transformation explicit instead of hiding mutation inside a completion judge.

**A loop that never reaches its condition halts the run.** `until` is the chain's own statement of when the loop's output is fit to use, so exhausting `max` without reaching it is a failed precondition, not a lap counter running out. Set `onExhausted: continue` when an objective completion command follows and should decide. `loop.until` remains artifact-driven control flow; it is not a completion check.

The worktree must always be a clean git repository with a base commit. This built-in preflight cannot be disabled. Repository-specific refusals belong in `requires`; it runs after those built-in checks but before logs or model spend, may interpolate only scalar literal seeds, cannot repair, and may not mutate the repository:

```yaml
requires:
  run: test "{{target}}" = supported
```

Composite completion uses the same shape at `foreach.completion` and top-level `completion`:

```yaml
completion:
  run: pnpm check
  attempts: 2
  repair:
    stages: [integration-fix]
```

Chainkit appends the failed command and bounded output to each repair stage automatically, then reruns the exact rendered command. Repair stages are isolated from normal scheduling and artifact production. A successful chain repair is committed before verification is recorded.

Completion is optional. A successful chain with no top-level completion exits successfully as **completed / unverified** and can never be `delivered`. Delivery additionally requires a passing declared chain completion, a non-empty diff, and intact repository identity.

## Layout

    run.mjs              the driver
    models.mjs           probe the CLI for which model ids it actually accepts
    check.mjs            the whole project check: format, lint, deadcode, every selftest
    selftest.mjs         deterministic behaviour gate — run after any kernel change
    kernel/
      config.mjs         load + STATIC validation (fails free, before any spend)
      context.mjs        artifact store + {{placeholder}} rendering
      stage.mjs          run one stage — the only place a model is called, and the shell
      providers.mjs      how a model is invoked, and what is kept out of its prompt
      telemetry.mjs      JSONL parse, raw persistence, live mirror
      cost.mjs           AiU accounting with the cumulative-snapshot rules
      tree.mjs           working-tree snapshot/delta — a builder's product
      foreach.mjs        fan-out: run a stage list once per element of an array
      models.mjs         the known model roster + the advisory spell-check over it
    examples/NN-name/    one worked chain per directory: chain.yaml, its prompts, a README
    fixtures/<name>/     greenfield graders — the objective definition of done
    extensions/          the two canvases: a live run dashboard and a chain designer
    results/chain-runs/  one JSON record per run + raw logs and live _calls/_events journals

A chain is a `.yaml` file (YAML because it takes comments, and the reasons behind a roster are worth writing down). A prompt is a `.md` file in a `prompts/` directory beside it; `{{artifact}}` is interpolated.

`_events.jsonl` is append-only additive observability. Immediately after every stage, foreach-item, and chain completion check, Chainkit writes a generic `completion.checked` event with timestamp, scope, stage/iteration/round/attempt identity where applicable, and the bounded check result: exact command, status, exit code, and failure output. Raw provider JSONL, `_calls.jsonl`, and the final run record keep their existing roles. The runs canvas polls the event journal so a failed stage check is visible on its matching attempt before the final record exists; once written, that record remains authoritative.

## The project check

    node check.mjs        (or `pnpm chainkit:check` from the host repo)

format + lint + knip + every shipped chain + every selftest, including the two canvases'. This is what CI runs.

The selftests are the load-bearing part: the static checks check shape, the selftests are the only check of behaviour, and they have caught defects the rest waved through. The `chains` step validates every chain it can find and fails on orphan prompts — knip reads `.mjs`, so without it the engine's config would be the one thing the gate never looks at. It treats warnings as failures for shipped chains: a worked example carrying a known wiring mistake teaches that mistake to everyone who copies it.

## Use

    node run.mjs --chain examples/01-single-stage/chain.yaml --validate-only    # free
    node run.mjs --chain examples/01-single-stage/chain.yaml --workdir /abs/path --tag a1

`--validate-only` checks every artifact reference, prompt file, loop bound and stage key without spending anything. It also warns — advisory, never fatal — about the quiet wiring mistakes: a stage whose output nothing reads, an `expects` field the prompt is never asked for (including a `foreach`'s element shape, checked against the prompt of whichever stage produces the array), and a model id that is not in the known roster. All of those otherwise cost a full run to discover.

## Models

A stage names its model as a bare string, and until it is dispatched nothing checks it. For a stage late in a fan-out that means a typo is discovered _after_ every earlier stage has been paid for. `kernel/models.mjs` carries a roster of ids the CLI is known to accept, and `--validate-only` warns (with a nearest-match suggestion) about anything not in it.

It is a **spell-check, not a completion contract**, and that is deliberate: chainkit does not own the list. `copilot` does, the set moves as models ship and retire, and it varies by account and org. A hard allowlist would eventually reject a chain naming a model that is real and simply newer than this file — so an unknown id warns and the run proceeds. A stale roster costs a spurious warning; a roster trusted as a gate would block working chains.

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

**Typed completion kinds.** Domain-aware checks are worth having, but they remain commands configured against a chain's artifacts. None are hoisted into the kernel, because the moment the kernel understands what a stage means, "adding a stage is config" stops being true.

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
