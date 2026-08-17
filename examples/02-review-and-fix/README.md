# 02 — review and fix

```
code → review → fix
```

Same job as [rung 01](../01-single-stage/), same spec, same builder, same grader, same gate. One construct added: two more stages, and an **artifact** carrying a value between them.

## What this rung is for

Measuring whether a second opinion is worth its price. Because everything except the review and the fix is held identical to rung 01, a difference in delivery rate between the two is attributable to those two stages and to nothing else.

`prompts/code.md` here is **byte-identical** to rung 01's. If you edit one, edit both — otherwise the comparison silently starts measuring the prompt.

## Files

| file                                     | what it is                                    |
| ---------------------------------------- | --------------------------------------------- |
| [`chain.yaml`](chain.yaml)               | three stages; one produces a JSON artifact    |
| [`prompts/code.md`](prompts/code.md)     | the builder — identical to rung 01's          |
| [`prompts/review.md`](prompts/review.md) | asks for a verdict as JSON, in a pinned shape |
| [`prompts/fix.md`](prompts/fix.md)       | repairs, reading `{{verdict}}`                |

## Run it

```bash
node prep-workdir.mjs --fixture scaffold-duration --workdir /tmp/ck-02
node run.mjs --chain examples/02-review-and-fix/chain.yaml --workdir /tmp/ck-02
```

## The two things worth copying from here

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
