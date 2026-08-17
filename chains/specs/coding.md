# Coding

The cross-cutting rules every change must satisfy — regardless of language, framework, or stack. This is **not** a tutorial and **not** a backlog; it is the short list of things that have to be true of _anything_ that gets built. The coder conforms to these; the reviewer checks against them. When the code and this doc disagree, the code wins and this doc gets fixed.

This is the **stack-agnostic baseline** that ships with code-chain. A project may add a `CODING.md` at its own root with stack-specific rules (the libraries it standardizes on, its deployment invariants, its domain constraints); those extend — they never relax — this baseline.

---

## 0. Posture (read first)

- **Security ahead of features.** If the choice is a new feature vs. closing a security gap, do the security work first. Flag and _fix_ leakage, auth gaps, injection, or isolation breaks the moment you see them.
- **Fail-closed is the default.** Every boundary (auth, config, role, route, parser, sanitizer, error surface) rejects unknown or invalid state rather than guessing. An allow-list beats a deny-list everywhere it's a choice.
- **Close observability gaps in the same change.** If a failure's reason was available but not captured, capture it. Never suffer the same blind spot twice.
- **Least privilege, least surprise.** Each component gets only the access it needs, and behaves the way its name and signature promise.

---

## 1. Architecture invariants

These are the spine the system bends around — break one and the _model_ is wrong, not just the code.

- **Every piece of state has a single owner; no concurrent writers.** Exactly one component owns any given store and is the only thing that writes it. A component asked for state it doesn't own _delegates_ to the owner rather than opening the store itself — a second writer is never the answer.
- **An invariant holds on every path, not just the one you tested.** A rule you enforce in the marquee flow — a precision/units rule, a locking discipline, a uniqueness or bounds check — must hold identically on every secondary, derived, or peripheral path that can reach the same state. The un-exercised path (a plain CRUD write, a computed/derived value, a rarely-hit branch) is exactly where the invariant silently breaks. Enforce it at the one seam all paths share so no caller can route around it.
- **Domain shapes are defined once, in one shared place,** and imported — never re-declared inside a module that happens to need them.
- **All persistence goes through one typed data-access seam.** A single interface is the only door to the datastore; queries don't get scattered through the code, and every new persisted entity gets methods on the seam.
- **The seam is typed per entity, not a stringly-keyed grab-bag.** Reaching state through a magic-string key into a generic map (`store.get("widgets")`, `store.kv("...")`) is a service locator, not a seam: a mistyped key silently creates a new empty collection instead of failing. Give each entity named, typed accessors so a wrong name is a type/compile error, and keep all entities on the _same_ access pattern — don't put some behind typed methods and others behind a string-keyed side door.
- **Confine third-party coupling to a single swappable seam.** A vendor SDK or provider-specific shape (auth, payments, storage, mail) is touched in exactly one place behind a provider-agnostic interface; the rest of the code never imports the SDK or reads provider-specific fields. Swapping the vendor touches the seam and config, nothing else.
- **Dependencies point one way.** No import cycles; lower layers never reach up into higher ones.

---

## 2. Boundaries & input

- **Validate at the boundary, not in the core.** Parse and validate every inbound shape — request body, env, CLI args, agent/machine API input — with a schema/validator at the edge; inner code trusts the typed result.
- **Never weaken the validated edge to shape an output.** When a framework default is wrong for your contract — the wrong error status, an unwanted default response shape — fix it in ONE boundary handler (a single error/response normalizer), never by loosening an input model to dodge the default. An any-typed/catch-all field, "allow unknown extras", or everything-optional schema used to control a status code is two defects at once: it admits malformed input _and_ scatters logic the one handler should own. Keep inputs strict and typed; let the shared boundary handler own normalization. If one part of the code proves strict types work through that handler, every part can.
- **Every operation is bounded.** Inbound work carries explicit limits — payload and field size caps, timeouts, and capped or paginated result sets — so no single call can exhaust the process. Rate-limit every public or keyed entry point. Rate limits cap _frequency_; size/timeout caps bound _magnitude_; both are required.
- **A machine/agent write surface is a closed, typed allow-list.** Its operations are explicitly enumerated with typed inputs — never wildcarded or generated on the fly — and the caller discovers valid operations from the surface rather than inventing them.

---

## 3. Auth & secrets

- **Secrets are hashed at rest, never logged, never in source or chat.** They live in env vars or a secret store and are read at runtime; they never travel through the codebase or a prompt.
- **Constant-time comparison.** Compare presented secrets with a constant-time check — never plain equality on raw strings — so neither value nor length leaks through timing.
- **Authorize per request, fail-closed.** A credential resolves to exactly one principal; each surface has its _own_ allow-list. Missing or unknown credentials are rejected, never default-allowed.
- **Never ship trust to the client.** Authorization, secrets, and provider SDKs stay server-side; a caller receives only already-decided, non-sensitive results.
- **Sanitize untrusted input with an allow-list before storing or rendering it.** Supporting something new means _adding to the allow-list_, never relaxing to a deny-list.

---

## 4. Config

- **Load and validate all config at boot, fail-closed.** Read env, validate it against a schema, and _throw_ on anything invalid. A misconfigured process refuses to boot rather than silently defaulting.
- **Behaviour is env-driven, not branched on hostname or guesswork.** Dev and prod run the _same_ code path, differing only by config values — no bypass flag, no "if dev" shortcut around a control.

---

## 5. Data & persistence

- **Never build queries or commands by string concatenation.** Bind every value — SQL parameters, shell argument vectors, query builders. Injection (SQL, shell, template) is closed by construction, not by escaping.
- **Schema changes are forward-only and never edited after shipping.** Each change is an ordered, append-only migration applied automatically at startup; never hand-edit a shipped migration or mutate a live datastore out of band.
- **Prefer identifiers and timestamps that sort lexicographically** in logical order, so ordering needs no separate sort key.

---

## 6. Errors & observability

- **One error model.** Throw a single typed application error that carries a status/category, a stable machine code, and a safe public message. The throw site names the category; the boundary never re-derives it.
- **Nothing internal crosses the wire.** An unknown throw collapses to an opaque generic failure — no message, no stack. The reason survives only in the log, shaped safely for whichever surface answers.
- **Failures are explainable from logs ALONE.** When something breaks, an operator must be able to determine _why_ from the logs — without reading the code to reconstruct what happened, eyeballing raw output, or correlating two processes by timestamp. Every non-success returned to a caller has a corresponding server-side log line naming the _machine reason_ for that request, not just the status. Instrument non-trivial control flow — error and early-return paths, branches, multi-step operations — in the SAME change that introduces it; diagnosability is part of "done", not a follow-up.
- **All logging goes through one structured path** — never ad-hoc prints or a per-module logger. Machine-parseable lines, level from the environment, context bound per request so every line self-identifies. Correlate by request/instance id, never by eyeballing timestamps. A call that crosses a service/process/network boundary logs the callee's _reason_ and a correlation/request id, not just its status. At a verbose/debug level be generous — trace the intermediate values a future debugger would otherwise have to infer. **The concrete mechanism — which logger to import, level meanings, field names, and redaction rules — is defined by THIS project's own constitution, not by code-chain;** consult the local `./CONSTITUTION.md` for the exact logging framework to use here, and treat instrumentation as a required deliverable of every change (no human will step through this code to debug it).
- **Redaction holds.** Never log secrets, tokens, or PII. Normalize thrown values through one serializer so a message is always present without dumping sensitive payloads.
- **Every surface answers for its own health.** Each exposes a cheap liveness/readiness signal, so "is it up and working" is observable directly — not inferred from error logs after the fact.

---

## 7. Testing

- **Units for logic, journeys for workflows.** Fast unit tests cover logic; end-to-end journeys cover workflows. A user-visible change ships with its covering test added or updated.
- **Tests are fail-closed.** A broken guard must turn a test _red_ — assert the deny, not just the allow. Security-relevant surfaces get explicit abuse-path tests (injection, authz, isolation) proving the bad path is blocked.
- **Isolate state.** Snapshot and restore env, use temp dirs and ephemeral ports; no test depends on ambient state or another test's order.

---

## 8. Code health

- **Keep files small enough to hold in one pass.** Target \~200–300 lines; treat 400 as a smell and 500 as a hard ceiling. One responsibility per file; when a file outgrows that, split it along a real seam — _while_ you build, not later.
- **Keep functions small too** — one that doesn't fit on a screen wants to be a few named functions.
- **Strict typing/lint, no silent escapes.** Run the strictest settings the language offers — no implicit `any`-equivalents, no unused bindings, no unchecked access; justify any suppression in a comment.
- **Definition of done:** the build/typecheck, the linter, and the relevant tests all pass before a change is called done.

---

## 9. Change discipline

- **Git mutations are single-writer per worktree.** Never parallelize `git add`, `git commit`, `git merge`, checkout/switch, reset, rebase, or another index/ref mutation in one worktree, even when files are disjoint. Parallel Git mutation is safe only across isolated child worktrees.
- **Commit with an explicit, ordered sequence.** Finish edits; stage explicit paths with `git add -- <paths...>`; verify the staged diff; then commit at a coherent stopping point. For a long message, write a temporary message file directly and use `git commit -F <file>` — never embed a heredoc inside `-m "$(…)"`. Leave the working tree clean; don't push unless asked.
- **Treat `index.lock` as evidence of another writer until proven otherwise.** Check for and wait on any live Git process using the worktree before retrying. Never delete a lock owned by an active process; remove it only after confirming it is stale, and stop for help if uncertain.
- **Each change leaves the tree green.** Green (compiles + its tests pass) is the resting state between units of work, not a milestone reached at the end.
- **Design docs are ephemeral; code is the durable record.** Work-in-progress plans guide a change and are discarded once it ships — the shipped code, its tests, and the as-built reference docs are the source of truth.
