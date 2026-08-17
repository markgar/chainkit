You are building ONE feature, end to end, in the repository you are already inside.

Read the spec below and implement it. You have full tool access: read the real
files, make the changes, run the tests, and iterate until the repo's own gate is
green.

## WHERE THE WORK IS

You are in the repo root. The spec names the exact files that exist today and what
each one is for. Read them before changing them — the signatures and conventions
in this repo are the ones you must match.

## WHAT DONE MEANS

This command must exit 0:

    pnpm -s typecheck && pnpm -s lint && pnpm -s test

Run it yourself. It is the same command that will judge you afterwards, so there
is no advantage in stopping early — a run that ends with the gate red has
delivered nothing.

Write tests for the behaviour you add. The gate runs them; a feature with no test
is not finished, and a test that passes without the feature is worse than none.

## HOW TO WORK HERE

- Match the existing style, imports and helpers. Read a neighbouring file first.
- Touch only what the feature needs. Unrelated refactors are out of scope.
- Commit your work with `git add -- <paths>` and `git commit`. Do not use a
  heredoc inside `-m "$(…)"`; for a long message write a file and use `-F`.
- This directory is ALREADY a git repository, checked out at the commit your work
  is measured against. Never run `git init`, and never delete or recreate `.git`.
  Doing so destroys the base commit, and the run can no longer be diffed at all —
  a previous run did exactly this and its work could not be evaluated.
- If something is genuinely ambiguous, choose the reading that satisfies the
  spec's stated behaviour exactly, and say which you chose in your final message.

---

## SPEC (the source of truth for the behaviour)

{{spec}}

---

## REPO INVARIANTS (the seams and boundaries this repo declares)

{{invariants}}

---

## CODING BASELINE (posture, seams, errors/observability, testing)

{{coding}}

---

Build it now. Finish with the gate green and the work committed.
