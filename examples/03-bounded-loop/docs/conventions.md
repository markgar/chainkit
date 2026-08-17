# Conventions

The standard the builder writes to and the reviewer judges against — the same document for both, which is the point. A reviewer working from its own private taste produces findings the builder had no way to anticipate, and the loop then spends rounds negotiating instead of converging.

Deliberately short. A long convention doc gets skimmed, and a rule nobody reads is not a rule.

- **Node standard library only.** No dependencies, no install step. A run that needs the network can fail for reasons that have nothing to do with the code.
- **One exported thing per file, named for the file.** `duration.js` exports `parseDuration`.
- **`TypeError` for the wrong type, `RangeError` for the wrong value.** Which error comes out is behaviour, not decoration, and the grader checks it.
- **No comment that restates the code.** Explain why a line is surprising, or write nothing.
- **No defensive branch for an input the spec rules out.** It can never be exercised, so it can never be known to work.
