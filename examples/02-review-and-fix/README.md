# 02 — review and fix

```
code → review → fix
```

Same job as [rung 01](../01-single-stage/), same spec, same builder, same grader, same gate. One construct added: two more stages, and an **artifact** carrying a value between them.

## What this rung is for

Measuring whether a second opinion is worth its price, and showing how a **supporting doc** rides along with a chain.

This rung introduces `docs/conventions.md` (the standard the builder writes to) and `docs/review-rubric.md` (what counts as a finding). They arrive here rather than at rung 01 because they only mean anything once a second model is judging the first: a reviewer with no stated standard invents one, and the loop then spends its rounds negotiating taste rather than converging. There is no "docs" feature in the kernel — they are ordinary seeds, files read from disk and rendered into a prompt like the spec is.

**So this rung changes two things at once**, the stages and the docs, and a delivery-rate difference against rung 01 cannot be attributed to either alone. Said plainly because the rest of the ladder is single-variable and this rung is the exception. 02 → 03 holds everything but the loop identical.

## Files

| file | what it is |
| --- | --- |
| [`chain.yaml`](chain.yaml) | three stages; one produces a JSON artifact |
| [`prompts/code.md`](prompts/code.md) | the builder |
| [`prompts/review.md`](prompts/review.md) | asks for a verdict as JSON, in a pinned shape |
| [`prompts/fix.md`](prompts/fix.md) | repairs, reading `{{verdict}}` |
| [`docs/conventions.md`](docs/conventions.md) | the standard, seeded as `{{conventions}}` |
| [`docs/review-rubric.md`](docs/review-rubric.md) | what counts as a finding, seeded as `{{rubric}}` |

## Run it

```bash
node prep-workdir.mjs --fixture scaffold-todos --workdir /tmp/ck-02
node run.mjs --chain examples/02-review-and-fix/chain.yaml --workdir /tmp/ck-02
```

## The three things worth copying from here

**Builder and reviewer read the same standard.** One document, seeded once, rendered into both prompts. A reviewer judging against private taste raises findings the builder had no way to anticipate, and each of those costs a full fix round to discover it was never a requirement. The rubric exists for the mirror-image reason: without one, a strong reviewer drifts to the cheapest thing it can say, which is style.

**The reviewer is a different model family than the builder.** A model reviewing its own work shares its own blind spots, so it largely confirms what it already decided. Decorrelation is the entire value of the stage; a same-family reviewer is close to a no-op you pay full price for.

**`expects` pins the artifact's contract.**

```yaml
expects:
  pass: boolean
  findings: array
```

Prompts are the part of a chain people edit, and an edit is exactly how this breaks. Reword the reviewer and it may start answering `{"passed": true}` — a different key. Without `expects`, `fix` would render a verdict of the wrong shape and carry on, and the run would look normal. `expects` fails it the moment the artifact is produced, naming the field.

Note the reviewer reads the **repository**, not the builder's summary of it. A confident, wrong self-report is a common failure, and one a reviewer should not be steered by. It also runs the tests itself: a green it did not observe is not evidence.

## What it cannot do

The fix runs **once**, and it runs **whether or not the review passed** — nothing here consults `verdict.pass`. So one repair round is all you get, and a clean review still costs a pointless fix call. Rung 03 makes the repair conditional and repeatable.
