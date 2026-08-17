# Repo invariants — fc-todo

The **repo-specific** half of the review bar for `fc-todo`. The rubric
(`review-rubric.md`) defines the dimensions, the severity labels and how to look; this file
supplies the facts that make dimensions 2, 3 and 8 concrete here.

`fc-todo` is a small React + Express todo app. It has **no tenancy, no auth (yet), no
migrations and no deploy**. Do not grade it against invariants it does not declare — if a
rule is not below, it is not an invariant in this repo, and a finding that invents one is
itself a defect.

## Dimension 2 — Security & boundaries

The genuine boundaries in this repo today:

- **Untrusted input is validated at the API edge, not in the UI.** A route that trusts
  `req.body` without checking type and emptiness is Blocking. Client-side validation is a
  convenience and never the enforcement point.
- **Failures fail closed.** A route that cannot establish what was asked returns 4xx; it never
  guesses a default and proceeds.
- **Nothing sensitive is logged.** There are no secrets in this app yet; when auth lands,
  tokens/passwords/session ids must never reach a log line or a response body.
- There is **no multi-user isolation to enforce until the auth item lands**. Until then, a
  finding that a todo is visible to "another user" is out of scope — there is one user.

## Dimension 3 — Architecture invariants

The seams this repo declares. A change that routes around one is Blocking even if it works:

- **The store seam.** `TodoStore` in `server/store.ts` is the only path to persistence. Routes
  call the store; they never touch a driver, file, or database handle directly.
- **The domain type is canonical and shared.** `shared/todo.ts` owns `Todo` and the API body
  shapes. Neither `server/` nor `src/` redeclares or duplicates them; a parallel local
  interface with the same fields is Blocking.
- **The UI's API client is the only network caller.** Components use `src/api.ts`; a component
  that calls `fetch` directly is Blocking.
- **Structured logging on failure paths, on both tiers.** The server logs via `server/log.ts`;
  the client logs via `src/log.ts` (`clientLog`). Every rejected/failed request and every
  caught client-side failure logs once with a stable `msg` token and a `reason` field. A
  failure that returns or is caught **without logging is Blocking** (a bare `catch {}` that
  only sets UI state is a swallow); `console.*` on either tier is Blocking; logging the same
  failure twice is a Should-fix.

## Dimension 8 — Docs

This repo declares **no durable as-built docs**. The `README` is the only prose, and only a
change to how the app is run or gated needs to touch it. Do not require doc updates for
ordinary feature work here.

## Risk-triggered second pass — repo surfaces

Additive to the rubric's generic triggers. Earn a focused pass when the diff touches:

- **the store seam or its backing implementation** — swapping or extending persistence;
- **an API route's shape** — the UI depends on it, so it is a public contract inside this repo;
- **auth or per-user scoping**, once that exists.
