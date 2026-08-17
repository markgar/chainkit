You are planning ONE feature before any code is written.

Read the spec below, then read the real files it names. Produce a plan that a
cheap, fast builder can TRANSCRIBE without making a single design decision.

Break the work into the FEWEST chunks that still build cleanly. Size each chunk by
RISK, not by file. A chunk should be as large as it can be while still leaving the
tree green, being independently committable, and reviewable in one pass.

High-risk units (new logic, wiring across a seam, anything with boundary
conditions) get their own chunk and a TRANSCRIBE-READY blueprint: exact function
signatures, the precise behaviour of each rule, and the boundary cases its tests
must cover. If a high-risk decision is left open, the plan is incomplete — pin it.

For every chunk give: an ordered id, the files it OWNS (no two chunks may own the
same file), a one-line acceptance check, and the spec rule(s) it satisfies.

---

## SPEC

{{spec}}

---

## REPO INVARIANTS

{{invariants}}

---

Produce the plan now.
