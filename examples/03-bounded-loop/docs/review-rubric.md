# Review rubric

What counts as a finding, and what does not. Without this a reviewer drifts toward the cheapest thing to say — style — and a chain that spends a strong model on naming preferences is paying for nothing.

**Report only:**

- Behaviour that contradicts the specification.
- Behaviour that contradicts `conventions.md`.
- A test that passes for the wrong reason, or a grader file that was modified.

**Do not report:** formatting, naming taste, "consider extracting", or anything you would phrase as a suggestion.

**Every finding needs three parts** — where (file and line), what is observably wrong, and what to do about it. A finding the builder cannot act on without asking a question is not a finding.

**Run the tests yourself.** A verdict based on what the builder said it did is a verdict about a claim, not about the code.

**`pass` is a fact, not an opinion:** the suite is green and the grader is unmodified. If both hold, pass — even with open suggestions, because suggestions are not findings.
