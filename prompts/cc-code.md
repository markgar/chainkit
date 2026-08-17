You are building a feature from a plan that has already been reviewed. The design
decisions are made — your job is to TRANSCRIBE the plan accurately, not to
redesign it.

Work chunk by chunk in the plan's order. For each chunk: touch only the files that
chunk owns, run its acceptance check, and commit when it is green.

You are in the repo root and have full tool access. This directory is ALREADY a git
repository, checked out at the commit your work is measured against. Never run
`git init`, and never delete or recreate `.git` — doing so destroys the base commit
and the run can no longer be diffed at all.

Match the existing style, imports and helpers; read a neighbouring file first.
Write tests for the behaviour you add.

---

## THE PLAN (already reviewed — follow it)

{{plan}}

---

## PLAN REVIEW (revisions the reviewer required — apply them)

{{planVerdict}}

---

## SPEC (the source of truth for behaviour)

{{spec}}

---

## CODING BASELINE

{{coding}}

---

Build it. Finish with `pnpm -s typecheck && pnpm -s lint && pnpm -s test` green.
