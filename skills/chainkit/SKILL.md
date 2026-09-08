---
name: chainkit
description: Validate, run, inspect, and update a repository's vendored Chainkit workflows.
---

# Chainkit operator

1. Discover the selected chain, its prompts, its governing feature specification, and the consumer wrapper documented under `.chainkit/`. Do not invoke `vendor/chainkit/run.mjs` directly when the consumer provides a wrapper.
2. Keep free readiness separate from paid execution. Validate the chain and its inputs first. Before any model call, require explicit approval of the selected chain/spec and explicit consent to spend model credits.
3. Preserve run failures, checkpoints, logs, and the working tree as evidence. Diagnose the recorded failure before retrying; do not erase or silently restart failed work.
4. Never patch `vendor/chainkit/` or the installed Chainkit skill/canvas in a consumer. Portability defects belong in `markgar/chainkit`, followed by a reviewed revendor.
5. Update from a clean, committed Chainkit checkout with:

   ```sh
   node /absolute/path/to/chainkit/vendor.mjs install /absolute/path/to/consumer
   node /absolute/path/to/consumer/vendor/chainkit/vendor.mjs check /absolute/path/to/consumer
   ```

6. Open the run dashboard with canvas id `chainkit-runs`. For another worktree, pass an absolute Chainkit root and either follow the newest run or pin one exactly:

   ```js
   open_canvas({
     canvasId: 'chainkit-runs',
     instanceId: 'chainkit-run',
     input: { root: '/absolute/worktree/.chainkit', run: 'latest' },
   });

   open_canvas({
     canvasId: 'chainkit-runs',
     instanceId: 'chainkit-run',
     input: { root: '/absolute/worktree/.chainkit', run: '<full-run-id>' },
   });
   ```

Consumer-specific approval rules, feature policy, wrappers, and acceptance commands stay in the consumer's own skills and `.chainkit/` guidance.
