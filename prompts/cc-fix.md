A reviewer found blocking issues in the work you just did. Fix them.

Address every item in `blocking` below. Make the smallest change that genuinely
fixes the issue — do not refactor around it, and do not change a test to match
broken behaviour unless the reviewer explicitly says the test is the thing that is
wrong.

If you believe a finding is incorrect, say so explicitly in your notes and explain
why from the spec — do not silently ignore it.

When you are done, run `pnpm -s typecheck && pnpm -s lint && pnpm -s test` and commit.

---

## THE REVIEW

{{verdict}}

---

## SPEC (the source of truth if the review and the code disagree)

{{spec}}

---

Fix them now.
