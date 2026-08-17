CRITIQUE ONLY — do not write code.

Review the plan below against the spec. Confirm every behaviour in the spec maps
to a chunk AND to a test inside that chunk. For every high-risk chunk, verify the
plan pins the exact signatures and boundary cases so the builder can transcribe
with zero open decisions — a high-risk chunk whose logic is left to builder
discretion is a BLOCKING gap.

Audit chunk sizing on both ends: name chunks that should be MERGED (a leaf utility
with no independent risk) and chunks that should be SPLIT (more than one
acceptance check, or two distinct risk surfaces bundled).

Check file ownership: no two chunks may own the same file.

---

## SPEC

{{spec}}

---

## PLAN UNDER REVIEW

{{plan}}

---

Return ONLY a JSON object, no prose around it:

{
  "pass": <true if the plan is buildable as written, false if anything is BLOCKING>,
  "blocking": ["..."],
  "revisions": ["concrete change to make, one per item"]
}
