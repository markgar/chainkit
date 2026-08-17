# Spec — todo-toggle-done

Let a todo be marked done and undone, end to end.

## Why

Creating a todo you can never complete is not a todo app. This is the first ordinary
feature: it crosses every seam the app has (domain type → store → route → API client →
component), which is exactly why it is the first item flash-chain builds here — a
single-file change would not exercise anything worth measuring.

## What exists today

- `shared/todo.ts` — `Todo { id, title, done, createdAt }`, `CreateTodoBody`, `ApiError`.
  `done` **already exists on the type** and is always `false`; nothing can change it.
- `server/store.ts` — the `TodoStore` seam (`list`, `create`) + `createMemoryStore`.
- `server/routes.ts` — `GET /api/todos`, `POST /api/todos`.
- `src/api.ts` — `todosApi.list()`, `todosApi.create()`; the only place the UI calls `fetch`.
- `src/App.tsx` — renders the list and the create form.

## Behaviour to build

**1. A todo's done state can be changed through the API.**

`PATCH /api/todos/:id` with body `{ "done": <boolean> }`:

- `200` with the **full updated todo** on success.
- `404` with an `ApiError` when no todo has that id, `reason: "not_found"`.
- `400` with an `ApiError` when `done` is missing or is not a boolean, `reason: "invalid_done"`.
  Explicitly: `"true"` (string) and `1` (number) are **400, not coerced**.
- Every non-2xx emits exactly one structured log line via `server/log.ts` naming the outcome
  and the machine reason. Exactly one — not zero, not two.

**2. The store owns the mutation.**

`TodoStore` gains `setDone(id: string, done: boolean): Todo | undefined` — returns the updated
todo, or `undefined` when the id is unknown. The route decides the HTTP shape; the store
decides nothing about HTTP. Toggling must **not** change `id`, `title` or `createdAt`, and
must not reorder the list.

**3. The list shows a checkbox that toggles, optimistically.**

- Each todo renders with an accessible checkbox whose accessible name is the todo's title and
  whose checked state is the todo's `done`.
- Clicking it updates the UI **immediately**, before the request resolves (optimistic).
- If the request fails, the UI **reverts that todo to its previous state** and shows an error
  message. Revert **only that todo** — apply it as a functional update keyed by id
  (`setTodos(prev => prev.map(...))`), never by restoring a whole-list snapshot captured before
  the request, which would silently discard any other todo that changed while it was in flight.
  A failed toggle must not leave the checkbox lying about the server's state.
- A failed toggle also logs once through `src/log.ts` (`clientLog`), like every other client
  failure path in this app. A bare `catch` that only sets error state is a swallow, and
  `console.*` is not the logging path here.
- A completed todo is visually distinguishable (e.g. line-through). Any equivalent treatment is
  fine; the test asserts a class or style, not a specific design.

## Verified change manifest

| File | Change |
| --- | --- |
| `shared/todo.ts` | add `UpdateTodoBody { done: boolean }`. Do **not** change `Todo`. |
| `server/store.ts` | add `setDone` to the `TodoStore` interface and to `createMemoryStore`. |
| `server/routes.ts` | add the `PATCH` route + its validation and logging. |
| `server/routes.test.ts` | add the API tests below. |
| `src/api.ts` | add `todosApi.setDone(id, done)`. |
| `src/log.ts` | **read only** — use `clientLog`; do not modify the logger. |
| `src/App.tsx` | render the checkbox; optimistic update + revert on failure. |
| `src/App.test.tsx` | add the component tests below. |

Nothing else. Do not touch `server/main.ts`, `server/log.ts`, the build config, or the styles
beyond what the completed-state treatment needs.

## Traps

- **`server/routes.test.ts` asserts response bodies with `toEqual({...})`.** That is an exact
  shape check: any field you add to a wire body breaks pre-existing tests that never mentioned
  it. This spec adds no field to `Todo`, so those assertions must keep passing **unchanged** —
  if one starts failing, you changed the wire shape and that is the bug, not the test.
- **`src/App.test.tsx` mocks `src/api.ts`.** Adding a method to `todosApi` means the mock must
  provide it too, or the component tests fail on an undefined call rather than on behaviour.
- **Optimistic means before, not after.** An implementation that awaits the response and then
  sets state will pass a lazy test and still be wrong. The test below asserts the checked state
  while the request is still pending, using a promise the test resolves by hand.
- **`Todo` is shared.** Do not redeclare it, or a narrowed copy of it, in `server/` or `src/`.

## Acceptance

Per chunk, the narrow gate. For the whole item, all three:

```
pnpm typecheck
pnpm test
pnpm lint
```

Concrete asserts that must exist when the item is done:

- `PATCH` an existing todo with `{done:true}` → 200, body's `done` is `true`, and `id`,
  `title`, `createdAt` are byte-identical to before.
- `PATCH` it again with `{done:false}` → 200, `done` is `false`.
- `PATCH` an unknown id → 404, `reason` is `"not_found"`, and one log line was emitted.
- `PATCH` with `{done:"true"}` → 400, `reason` is `"invalid_done"`.
- Component: clicking the checkbox shows it checked **while the request is still pending**.
- Component: when the request rejects, the checkbox returns to its previous state and an error
  is visible.

## Out of scope

Deleting todos, editing titles, filtering by done, persistence beyond memory, and any styling
work beyond marking a completed todo. Those are separate items.
