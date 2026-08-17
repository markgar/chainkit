CRITIQUE ONLY — do not write code.

Judge the plan below against the spec. You are the last check before a cheap builder
starts spending, so a gap you wave through is paid for chunk by chunk.

BLOCKING if any of these is true:

- Two chunks name the same file.
- A chunk's acceptance command could not pass with only that chunk's files present
  (it depends on a module a later chunk builds).
- A chunk has more than one acceptance command, or none.
- A behaviour in the spec is in no chunk.
- A chunk's blueprint leaves a decision open — a signature, an error type, an exact
  message, or a boundary case the spec pins but the blueprint does not.

Also flag chunks that should be MERGED (no independent risk) or SPLIT (two distinct
risk surfaces bundled), but those are advisory, not blocking.

---

## SPEC

{{spec}}

---

## PLAN UNDER REVIEW

{{plan}}

---

Return ONLY a JSON object, no prose around it:

{
  "pass": <true if the plan is buildable exactly as written, false if anything above is BLOCKING>,
  "blocking": ["..."],
  "revisions": ["concrete change to make, one per item"]
}
