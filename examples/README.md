# Examples — a ladder, not a menu

Four chains, in order. Each rung adds **exactly one construct** to the one below it, so the difference between two rungs is attributable to the thing that changed and nothing else.

| rung | shape | what it adds | job |
| --- | --- | --- | --- |
| [01-single-stage](01-single-stage/) | `code` | the whole kernel, minimally | `todos` |
| [02-review-and-fix](02-review-and-fix/) | `code → review → fix` | artifacts between stages; `expects`; supporting docs | `todos` |
| [03-bounded-loop](03-bounded-loop/) | `code → (review → fix)*` | `loop` — repeat until a field is true | `todos` |
| [04-plan-and-fan-out](04-plan-and-fan-out/) | `(plan → plan-review)* → per chunk: (code → review → fix)*` | `foreach` — run stages per array element | `todo-cli` |

Each directory is **self-contained**: its `chain.yaml`, every prompt it uses, any supporting document it seeds (`docs/`), and a README explaining what that rung is for and how to run it. Nothing is shared between rungs except the graders under [`../fixtures/`](../fixtures/), which are the objective definition of done and are shared because the whole point is that two rungs are graded identically.

Rung 01 is deliberately bare — a spec, a chain, one prompt — because everything else is easier to understand once you have seen the minimum. `docs/` appears at rung 02, where a rubric and a coding standard first mean something: there is finally a second model whose judgment has to agree with the first's.

Rung 02 is the one exception to "exactly one construct": it adds the review stages **and** the docs, so a rate difference against rung 01 is not attributable to either alone. Stated rather than hidden.

**Do not tidy these into one chain.** The redundancy is the point. `prompts/code.md` is byte-identical across rungs 01–03 precisely so that the delivery-rate difference between them measures the process and not the prompt. Consolidating them would produce one chain that demonstrates everything and proves nothing.

## Running one

Every rung scaffolds from an **empty** repo: the working directory starts with only the fixture's `acceptance/` grader, committed. Prepare one, then run:

```bash
node prep-workdir.mjs --fixture scaffold-todos --workdir /tmp/ck-01
node run.mjs --chain examples/01-single-stage/chain.yaml --workdir /tmp/ck-01
```

Validate first — it is free and catches most mistakes:

```bash
node run.mjs --chain examples/01-single-stage/chain.yaml --validate-only
```

`--tag <name>` labels a run so concurrent runs of the same chain do not collide.

## Reading the results

A run writes one JSON record per run plus per-stage raw JSONL, under `results/chain-runs/` beside the chain. Open it with the `chainkit-runs` canvas, or read the record directly: it carries the resolved roster, real AiU cost per stage, loop and fan-out rounds, completion results, and the engine's own `completed` / `verified` / `delivered` verdicts.

## Using one as a starting point

Copy the closest rung into your own repo, then change the seeds, prompts, and completion commands. See rung 01 on why a grader is verified unchanged before it is trusted.

Chains you actually run belong in **your** repo, not here. These are worked examples, and an upgrade of the engine replaces this directory wholesale.
