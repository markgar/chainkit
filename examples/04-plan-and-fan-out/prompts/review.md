Review ONE chunk that was just built. Do not write code.

## THE CHUNK

id:         {{chunk.id}}
name:       {{chunk.name}}
files:      {{chunk.files}}
acceptance: {{chunk.acceptance}}

## BLUEPRINT IT WAS SUPPOSED TO TRANSCRIBE

{{chunk.blueprint}}

---

## THE BUILDER'S OWN ACCOUNT

{{buildNotes}}

---

Do not take the builder's word for anything. Read the files it owns, and RUN its
acceptance command yourself.

Fail the chunk if any of these is true:

- The acceptance command does not pass.
- A file outside `files` was created or modified. Anything under `acceptance/` was
  modified at all.
- The implementation passes the tests by special-casing them rather than
  implementing the blueprint.
- The blueprint pins a behaviour (an error type, an exact message, a boundary case)
  that the code does not implement, even if no test currently catches it.

Judge by the rubric below, against the conventions below it — not by taste.

## RUBRIC

{{rubric}}

## CONVENTIONS

{{conventions}}

---

Return ONLY a JSON object, no prose around it:

{
  "pass": <true if this chunk is done and correct, false otherwise>,
  "problems": ["one concrete, actionable defect per item"]
}
