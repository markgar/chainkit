# 01 — single stage

```
code
```

One model, full tools, one shot at the whole job, judged by an objective grader.

## What this rung is for

Two things.

It is the **baseline**. Every other rung has to beat it. If a five-stage chain does not deliver more often than one stage does, the extra four stages are ceremony you are paying for.

It is also the **smallest complete exercise of the engine**: config load → prompt render → CLI call → telemetry → run record → gate, with no loop to hide behind. If this does not work, nothing above it will.

## Files

| file                                 | what it is                                       |
| ------------------------------------ | ------------------------------------------------ |
| [`chain.yaml`](chain.yaml)           | seeds, one stage, one gate                       |
| [`prompts/code.md`](prompts/code.md) | the builder's prompt; `{{spec}}` is interpolated |

That is the whole rung: a spec, a chain, and one prompt. Nothing here is a convention doc or a rubric, because with a single stage there is nobody to agree with — [rung 02](../02-review-and-fix/) adds those at the moment they start to mean something.

The job is [`../../fixtures/scaffold-duration`](../../fixtures/scaffold-duration/) — a zero-dependency duration parser/formatter, graded by `node --test`. Its spec is tight on purpose: exact error types per bad input, exact rounding, longest-first unit matching. A vague spec measures the spec, not the process.

## Run it

```bash
node prep-workdir.mjs --fixture scaffold-duration --workdir /tmp/ck-01
node run.mjs --chain examples/01-single-stage/chain.yaml --workdir /tmp/ck-01
```

`prep-workdir.mjs` creates an empty git repo containing only `acceptance/`, committed. The builder starts from nothing else.

## The one thing worth copying from here

The gate is two clauses:

```
git diff --quiet HEAD -- acceptance && node --test acceptance/*.test.js
```

The first clause is not optional. Without it, the grade is awarded by tests the run itself could have edited — and a model that cannot make the code pass can always make the tests pass. **A gate that can be modified by the thing it grades is not a gate.** Verify the grader is untouched, then trust it.

## What it cannot do

Nothing checks the work except the gate, and the gate runs once, at the end, after all the money is spent. When it fails you learn only that the whole thing is red. Rung 02 adds a second opinion before that point.
