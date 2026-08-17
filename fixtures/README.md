# Fixtures — the objective definition of done

Each fixture is a **greenfield job**: a spec, a grader, and a reference solution. A run starts from an empty git repo containing only the grader, and is judged by whether the grader passes with the grader itself unmodified.

Greenfield on purpose. Measuring a process against an existing codebase means the result depends on how well a model happens to know that codebase, which is a confound you cannot subtract afterwards. Here everything the run needs is in the spec, and everything it is graded on is in `acceptance/`.

| fixture | job | modules | used by |
| --- | --- | --- | --- |
| [scaffold-duration](scaffold-duration/) | duration string parse/format | 1 | examples 01, 02, 03 |
| [scaffold-calc](scaffold-calc/) | expression calculator | 4 | example 04 |
| [scaffold-router](scaffold-router/) | path-pattern router with precedence | 4 | — (a harder swap-in for example 04) |

## Layout

    <fixture>/
      spec.md            what to build — the only thing a builder is given
      acceptance/        the grader. Read-only to a run; a run that edits it fails
      base/              files placed in the workdir at the base commit
      reference/         a known-good solution, for checking the grader itself
      check-grader.mjs   runs the grader against reference/ — see below

## Preparing a working directory

```bash
node prep-workdir.mjs --fixture scaffold-duration --workdir /tmp/ck-run
```

That creates an empty git repo, copies in `acceptance/` and anything in `base/`, and commits. The commit matters: the gate compares against `HEAD` to prove the grader was not touched.

`base/` exists for files no chunk should own — a `package.json` declaring `"type": "module"`, for instance. Under per-chunk file ownership, a build that has to create it either violates its ownership rule or fails a gate for a reason that says nothing about the chunk.

## Checking the grader

```bash
node fixtures/scaffold-duration/check-grader.mjs
```

Runs `acceptance/` against `reference/`. This is not ceremony. **A grader is an instrument, and a broken instrument returns a plausible number rather than an error** — a test suite with an over-tight assertion fails every run and looks like a model that cannot code, while one with a hole passes work that is wrong. Both conclusions are confident and wrong.

Run this before trusting any result from a fixture you have edited, and before adding a new one.

## Writing a new fixture

The spec is the experiment. Two rules:

**Pin behaviour the grader checks exactly** — which error type for which bad input, exact rounding, exact precedence. A vague spec does not measure the process, it measures the spec, and the failure looks identical from the outside: a confident builder producing something reasonable that the grader rejects.

**Do not describe the implementation.** The spec says what is true of the result; how to get there is what the chain is being measured on.
