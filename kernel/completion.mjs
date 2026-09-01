// One state machine for every deterministic completion contract.
//
// Scope adapters provide the work that happens before each check: an agent turn for
// a prompt stage, or configured repair stages after a composite check fails. This
// module owns the invariant parts: the command is rendered once, every attempt runs
// that exact command, judges may not mutate the repository, attempt accounting is
// uniform, and repeated failures without repair progress stop early.

import { render } from "./context.mjs";
import { runCommandStage } from "./stage.mjs";
import { repositorySnapshot, treeDelta, treeSnapshot } from "./tree.mjs";

function failureSignature(check) {
  return `${check.command}\n${check.code}\n${check.tail}`;
}

export async function runCompletion({
  spec,
  scope,
  ctx,
  workDir,
  logRoot,
  round = 0,
  iter = 0,
  ord = 999,
  timeoutMs,
  beforeAttempt,
  afterPass,
  failureContext,
  injectFailure,
  onCheck,
}) {
  const checks = [];
  let command = null;
  let previous = null;

  for (let index = 0; index < spec.attempts; index++) {
    const attempt = index + 1;
    const preparation = await beforeAttempt({ attempt, previous, command });
    if (!preparation?.ok) {
      return {
        status: "failed",
        ok: false,
        command,
        attempts: spec.attempts,
        checks,
        aborted: true,
      };
    }
    // Stage completion may reference the artifact the stage just produced. Render
    // after the first preparation, then freeze that exact command for every retry.
    if (command === null) command = render(spec.run, ctx);

    const treeBefore = treeSnapshot(workDir);
    const repoBefore = repositorySnapshot(workDir);
    const measured = await runCommandStage({
      stage: {
        id: `${scope}.completion`,
        ord,
        run: command,
        parse: "text",
        expects: null,
        produces: null,
        timeoutMs,
      },
      ctx,
      workDir,
      logRoot,
      round,
      iter,
      attempt: index,
    });
    const treeAfter = treeSnapshot(workDir);
    const repoAfter = repositorySnapshot(workDir);
    const filesChanged = treeDelta(treeBefore, treeAfter);
    const injected = injectFailure ? await injectFailure({ attempt, measured }) : null;
    const ok = injected ? false : measured.ok;
    const output = injected || measured.output || measured.raw || measured.error || "";
    const check = {
      attempt,
      attempts: spec.attempts,
      command,
      code: injected ? 1 : (measured.code ?? (ok ? 0 : null)),
      ok,
      tail: String(output).slice(-2000),
      output: String(output).slice(-12000),
      rawPath: measured.rawPath || null,
      wallMs: measured.wallMs ?? null,
      filesChanged,
    };
    checks.push(check);

    if (
      filesChanged.length ||
      repoBefore.head !== repoAfter.head ||
      repoBefore.status !== repoAfter.status
    ) {
      check.ok = false;
      check.mutated = true;
      onCheck?.(check);
      return {
        status: "failed",
        ok: false,
        command,
        attempts: spec.attempts,
        checks,
        halt: {
          stage: `${scope}.completion`,
          round,
          iter,
          kind: "completion-mutated",
          reason: filesChanged.length
            ? `${scope} completion command changed ${filesChanged.length} file(s): ${filesChanged
                .slice(0, 10)
                .join(", ")}`
            : `${scope} completion command changed the repository index or HEAD`,
          completion: check,
        },
      };
    }

    onCheck?.(check);
    if (ok) {
      const extra = attempt > 1 && afterPass ? await afterPass({ attempt, check }) : null;
      if (extra?.halt) {
        return {
          status: "failed",
          ok: false,
          command,
          attempts: spec.attempts,
          checks,
          halt: extra.halt,
        };
      }
      return {
        status: "passed",
        ok: true,
        command,
        attempts: spec.attempts,
        checks,
        ...(extra || {}),
      };
    }

    const signature = failureSignature(check);
    if (previous && previous.signature === signature && !preparation.changed) {
      return {
        status: "failed",
        ok: false,
        command,
        attempts: spec.attempts,
        checks,
        halt: {
          stage: `${scope}.completion`,
          round,
          iter,
          kind: "no-progress",
          reason: `${scope} repeated the same completion failure and its repair changed no files`,
          completion: check,
        },
      };
    }
    previous = { ...check, signature, context: failureContext };
  }

  const last = checks.at(-1);
  return {
    status: "failed",
    ok: false,
    command,
    attempts: spec.attempts,
    checks,
    halt: {
      stage: `${scope}.completion`,
      round,
      iter,
      kind: "exhausted",
      reason: `${scope} did not satisfy its completion command after ${spec.attempts} attempt(s): ${command}`,
      completion: last,
    },
  };
}
