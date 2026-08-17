Build ONE chunk of a larger plan. Not the whole plan — only this chunk.

You are working in a git repo that already contains the `acceptance/` grader. The
grader is the definition of done and is READ-ONLY: do not edit, delete, or add to
anything under `acceptance/`.

## THE CHUNK YOU OWN

id:         {{chunk.id}}
name:       {{chunk.name}}
files:      {{chunk.files}}
acceptance: {{chunk.acceptance}}

You may create or modify ONLY the files listed above. Files owned by other chunks
are theirs; touching one silently breaks work that was already graded green.

## BLUEPRINT

{{chunk.blueprint}}

---

## CONVENTIONS (they apply to your chunk like any other code)

{{conventions}}

---

## SPEC (for context — build only your chunk)

{{spec}}

---

Write the code, then run your own acceptance command and iterate until it passes.
When you are done, reply with a short plain-text note: what you wrote and whether
the acceptance command passed.
