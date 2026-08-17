# 03 — bounded loop

```
code → (review → fix)*        until verdict.pass, at most 3 times
```

Same job, same spec, same three prompts as [rung 02](../02-review-and-fix/). One construct added: `loop`.

## What this rung is for

Turning a single repair attempt into convergence. The reviewer's verdict now decides whether the fix runs at all and whether the pair repeats — so a clean build costs nothing extra, and a broken one gets up to three graded attempts instead of one.

The three prompts are byte-identical to rung 02's. Keep them that way.

## Files

| file                                             | what it is                                 |
| ------------------------------------------------ | ------------------------------------------ |
| [`chain.yaml`](chain.yaml)                       | the same three stages, plus a `loop` block |
| [`prompts/code.md`](prompts/code.md)             | identical to rungs 01 and 02               |
| [`prompts/review.md`](prompts/review.md)         | identical to rung 02                       |
| [`prompts/fix.md`](prompts/fix.md)               | identical to rung 02                       |
| [`docs/conventions.md`](docs/conventions.md)     | identical to rung 02                       |
| [`docs/review-rubric.md`](docs/review-rubric.md) | identical to rung 02                       |

Every file except `chain.yaml` is byte-identical to rung 02's, docs included. That is what makes the comparison between the two rungs a measurement of the loop rather than of anything else.

## Run it

```bash
node prep-workdir.mjs --fixture scaffold-duration --workdir /tmp/ck-03
node run.mjs --chain examples/03-bounded-loop/chain.yaml --workdir /tmp/ck-03
```

## The construct

```yaml
loop:
  stages: [review, fix]
  until: verdict.pass
  max: 3
```

`until` names a field on an artifact a stage in the loop produces — here the `pass` that `review`'s `expects` already guarantees exists. That coupling is deliberate: the field that ends the loop is the field the contract enforces, so a reworded reviewer cannot leave the loop with nothing to test.

**Control flow in this engine is exactly two things**: stages run in order, and one bounded loop repeats a subset until a named field is true. There is no `if`, no branch, no stage that chooses what runs next. A process that needs more than that is a process this engine will not run — and that constraint is what keeps "adding a stage is a config edit" true, because the moment the kernel branches on what a stage _means_, it stops being generic.

## `max` is not a formality

A reviewer that never passes is the failure mode that spends without limit, and it looks like progress the whole time. The bound stops it.

Hitting the bound is recorded in the run record as an **unsatisfied** loop, so a run that thrashed to its limit is distinguishable from one that converged on round two. Read that field before concluding a chain works — the gate can pass on the last round of a loop that was never really converging.

## `resume: true`

The fix stage continues the builder's own session rather than starting a fresh one, so it keeps context it has already paid for and the re-sent input is served as cache-read. Over three rounds that is the difference between one conversation and three cold starts.

## What it cannot do

Everything is still built in **one** call over the whole job. A single builder holds the entire spec at once, one review judges all of it, and a failure anywhere means the whole thing is red. That does not scale past a job one model can hold in its head. Rung 04 splits the work up first.
