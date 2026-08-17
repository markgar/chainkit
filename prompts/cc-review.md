SPEC-CONFORMANCE REVIEW of the work in this repo.

Re-derive the expected behaviour from the SPEC yourself. Do NOT infer correctness
from the code, and do NOT trust the existing tests — they may be written by the
same author and can encode the same mistake.

Pick adversarial and boundary inputs and check the code's ACTUAL behaviour against
your spec-derived expectation. A rule that is implemented but DIVERGENT from the
spec is blocking even if every test passes.

Run the gate yourself: `pnpm -s typecheck && pnpm -s lint && pnpm -s test`. Green is
necessary, not sufficient.

---

## SPEC

{{spec}}

---

## WHAT THE BUILDER SAYS IT DID

{{buildNotes}}

---

Return ONLY a JSON object, no prose around it:

{
  "pass": <true only if the gate is green AND no blocking issue remains>,
  "gateGreen": <true|false>,
  "blocking": [{"file": "...", "issue": "...", "fix": "concrete change"}],
  "notes": "one paragraph, what you actually verified"
}
