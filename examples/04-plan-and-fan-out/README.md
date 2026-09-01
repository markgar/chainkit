# 04 — plan and fan out

```
(plan → plan-review)*                      until planVerdict.pass, at most 2 times
  then, once per chunk:
    code → (review → fix)*                 until verdict.pass, at most 3 times
    completion: that chunk's own grader command
```

The last rung. One construct added to [rung 03](../03-bounded-loop/): `foreach` — run a list of stages once per element of an array another stage produced.

## The job changes here

Rungs 01–03 build `todos`, a single module. This one builds [`../../fixtures/scaffold-todo-cli`](../../fixtures/scaffold-todo-cli/) — the same todo list behind a command-line front end, in four modules (parse → store → render → app). Same domain, so the step up is the partition, not the subject matter.

That is deliberate, not incidental: **there is nothing to fan out over in a one-file job.** Rungs 01–03 could not demonstrate this construct, and this chain cannot be run against their spec.

## Files

| file | what it is |
| --- | --- |
| [`chain.yaml`](chain.yaml) | outer loop, five stages, `foreach`, item + chain completion |
| [`prompts/plan.md`](prompts/plan.md) | partitions the spec into chunks, as JSON |
| [`prompts/plan-review.md`](prompts/plan-review.md) | critiques the plan; blocking vs advisory |
| [`prompts/code.md`](prompts/code.md) | builds ONE chunk, reading `{{chunk.*}}` |
| [`prompts/review.md`](prompts/review.md) | judges ONE chunk |
| [`prompts/fix.md`](prompts/fix.md) | repairs ONE chunk |
| [`docs/conventions.md`](docs/conventions.md) | the standard, seeded as `{{conventions}}` — same document rungs 02 and 03 use |
| [`docs/review-rubric.md`](docs/review-rubric.md) | what counts as a finding, seeded as `{{rubric}}` |

The two docs are copied in rather than linked out, so this rung is readable and runnable without leaving its directory. Copying is the deliberate choice for the whole ladder; see [`../README.md`](../README.md).

## Run it

```bash
node prep-workdir.mjs --fixture scaffold-todo-cli --workdir /tmp/ck-04
node run.mjs --chain examples/04-plan-and-fan-out/chain.yaml --workdir /tmp/ck-04
```

This rung spends materially more than the others — it runs a design phase and then up to four build/review/fix loops. Validate first.

## The construct

```yaml
foreach:
  over: plan.chunks
  as: chunk
  stages: [code, review, fix]
  loop: { stages: [review, fix], until: verdict.pass, max: 3 }
  completion: { run: "{{chunk.acceptance}}", attempts: 1 }
  max: 8
```

**The kernel does not know what a chunk is.** `over` names an array, `as` binds one element, and the prompts decide entirely what that element means — `{{chunk.blueprint}}`, `{{chunk.files}}`, `{{chunk.acceptance}}` are fields this chain's own prompts invented. If expressing fan-out had required the kernel to learn a "chunk" concept, the schema would have been wrong.

## The three things worth copying from here

**Completion is per chunk.** `{{chunk.acceptance}}` is the grader command for that chunk alone, so each element gets an objective pass/fail at the moment it is built. Chain completion then catches cross-chunk integration failures.

**The element has a contract too.**

```yaml
expects:
  id: string
  files: array
  acceptance: string
  blueprint: string
```

`expects` on a stage checks one artifact; this checks the shape of **every element** before any of them is built, so a planner that renamed a field fails free instead of eight times over. `acceptance` matters most: it is rendered into completion, and an absent value would produce an empty shell command.

**The plan review has teeth.** `plan` and `plan-review` sit in the outer loop with `until: planVerdict.pass`, so a blocking critique forces a re-plan instead of being advice nobody reads. A bad plan is the most expensive artifact in the chain: it gets transcribed faithfully, chunk by chunk, at full price. Reviewing it is the cheapest money in the run.

Note `planVerdict` is **seeded with a sentinel string**. A `{{placeholder}}` with no artifact behind it is a hard error, so on round one — when no review exists yet — the render would fail. The seed makes round one legible and round two real.

## Fan-out changes the economics

The builder here is a cheap, fast model. That is viable only because the plan carries the judgment: each chunk arrives with its signatures, behaviour and boundary cases pinned, and the builder transcribes rather than designs. Spend the expensive reasoning on partitioning and reviewing; let the cheap model type.

Which means the failure mode moves. A vague blueprint does not produce a visibly confused builder — it produces a confident one, building the wrong thing, graded green by an acceptance command that was also vague.

## What the last suite is for

Three suites grade one module each, with only that module on disk. The fourth, `cli.test.js`, sees all four files and catches what per-item completion structurally cannot: modules that are individually correct and wired together wrong.
