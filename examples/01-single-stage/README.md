# 01 — single stage

```
code
```

One model, full tools, one shot at the whole job, judged by an objective grader.

## What this rung is for

Two things.

It is the **baseline**. Every other rung has to beat it. If a five-stage chain does not deliver more often than one stage does, the extra four stages are ceremony you are paying for.

It is also the **smallest complete exercise of the engine**: config load → prompt render → CLI call → telemetry → agent completion → run record, with no loop to hide behind.

## Files

| file                                 | what it is                                       |
| ------------------------------------ | ------------------------------------------------ |
| [`chain.yaml`](chain.yaml)           | seeds, one stage, one agent completion contract  |
| [`prompts/code.md`](prompts/code.md) | the builder's prompt; `{{spec}}` is interpolated |

That is the whole rung: a spec, a chain, and one prompt. Nothing here is a convention doc or a rubric, because with a single stage there is nobody to agree with — [rung 02](../02-review-and-fix/) adds those at the moment they start to mean something.

The job is [`../../fixtures/scaffold-todos`](../../fixtures/scaffold-todos/) — the classic todo list as one zero-dependency module, graded by `node --test`. Familiar on purpose: you can read the diff and judge it yourself, so what you are looking at is the process rather than the puzzle. Its spec is tight anyway — exact error types per bad input, which argument is validated first, and the rule that no function may modify the list it was given. A vague spec measures the spec, not the process.

## Run it

```bash
node prep-workdir.mjs --fixture scaffold-todos --workdir /tmp/ck-01
node run.mjs --chain examples/01-single-stage/chain.yaml --workdir /tmp/ck-01
```

`prep-workdir.mjs` creates an empty git repo containing only `acceptance/`, committed. The builder starts from nothing else.

## The one thing worth copying from here

The agent's completion command has two clauses:

```
git diff --quiet HEAD -- acceptance && node --test acceptance/*.test.js
```

The first clause is not optional. Without it, the grade is awarded by tests the run itself could have edited. Verify the grader is untouched, then trust it.

## What it cannot do

The completion belongs to the agent it judges. If it fails, Chainkit resumes that same agent session within the declared total attempt bound. Rung 02 adds a second opinion.
